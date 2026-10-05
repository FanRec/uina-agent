/** 连接 supervisor：ensureClient 状态机、inFlight ticket（含目录刷新）、idle 停止、
 * draining 优雅过渡、指纹绑定与 superseded 丢弃。本模块是扩展内唯一碰 SDK 的地方。 */
import {
	Client,
	SdkHttpError,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { extname } from "node:path";
import type { McpCatalog, CatalogTool } from "./catalog.js";
import { hasSensitiveCredentials, type McpServerDefinition, type ResolvedServerConfig } from "./config.js";

/** 兼容回退守门谓词：仅协议层不兼容（404/405/Content-Type 不匹配）允许退避 SSE；
 * 认证错误、TLS、超时、网络不可达、5xx 一律 false，防止认证失败被误诊为协议不兼容。 */
export function isLegacyTransportCompatibilityError(error: unknown): boolean {
	return error instanceof SdkHttpError && [404, 405, 406, 415].includes(error.status);
}

export type ConnectionState = "running" | "starting" | "stopped" | "draining";

export interface ServerConnection {
	generation: number;
	serverConfig: ResolvedServerConfig;
	serverFingerprint: string;
	client: Client;
	transport: Transport;
	transportKind: "stdio" | "streamable-http" | "sse" | "in-memory";
	/** 就绪时抓取的 server instructions（untrusted metadata，D14）。 */
	instructions?: string;
	inFlight: number;
	lastUsedAt: number;
	idleTimeoutMs: number;
	idleTimer?: NodeJS.Timeout;
	draining: boolean;
}

/** 前台操作触发的刷新/建连被配置变更拦截：绝不跨代跳跃，返回 failed 由模型重发。 */
export class McpSupersededError extends Error {}

export interface RefreshOutcome {
	status: "ok" | "superseded";
	entry?: { tools: CatalogTool[] };
}

export interface ServerManagerOptions {
	catalog: McpCatalog;
	version: string;
	onError: (message: string) => void;
	/** 目录持久化时清理已从当前配置移除的 server；管理器不自行读取配置。 */
	configuredNames?: () => ReadonlySet<string> | undefined;
	/** 测试接缝：注入后绕过 stdio/http transport 创建（协议测试用 InMemoryTransport）。 */
	createTransport?: (server: ResolvedServerConfig) => { transport: Transport; kind: ServerConnection["transportKind"] };
}

export class McpServerManager {
	private connections = new Map<string, ServerConnection>();
	private starting = new Map<string, { fingerprint: string; promise: Promise<ServerConnection> }>();
	private starts = new Set<Promise<ServerConnection>>();
	private refreshPromises = new Map<string, Promise<RefreshOutcome>>();
	private lastErrors = new Map<string, string>();
	private connectSeq = 0;
	private disposed = false;

	constructor(private readonly options: ServerManagerOptions) {}

	private get catalog(): McpCatalog {
		return this.options.catalog;
	}

	connectionState(name: string): { state: ConnectionState; inFlight?: number } {
		const pending = this.starting.get(name);
		if (pending) return { state: "starting" };
		const connection = this.connections.get(name);
		if (!connection) return { state: "stopped" };
		if (connection.draining) return { state: "draining" };
		return { state: "running", inFlight: connection.inFlight };
	}

	lastError(name: string): string | undefined {
		return this.lastErrors.get(name);
	}

	/** 扩展的唯一连接入口：显式接收不可变快照的配置与指纹，自身不读磁盘配置。 */
	async ensureClient(
		server: ResolvedServerConfig,
		idleTimeoutMs: number,
		startupTimeoutMs: number | undefined,
	): Promise<ServerConnection> {
		if (this.disposed) throw new McpSupersededError("MCP 扩展已卸载");
		const name = server.name;
		const existing = this.connections.get(name);
		if (existing && !existing.draining) {
			if (existing.serverFingerprint === server.fingerprint) return existing;
			// 配置突变：旧连接转 draining，保护在途调用与目录刷新自然结算。
			this.startDraining(name, existing);
		}
		const pending = this.starting.get(name);
		if (pending) {
			if (pending.fingerprint === server.fingerprint) return pending.promise;
			this.starting.delete(name);
		}
		const generation = ++this.connectSeq;
		const promise = this.connect(server, generation, idleTimeoutMs, startupTimeoutMs)
			.then(async (connection) => {
				const current = this.connections.get(name);
				const pendingAfterConnect = this.starting.get(name);
				if (
					this.disposed ||
					pendingAfterConnect?.promise !== promise ||
					(current && current.generation >= connection.generation && current !== connection)
				) {
					await this.closeConnection(connection);
					throw new McpSupersededError(`MCP server "${name}" 配置在连接期间已变更`);
				}
				this.connections.set(name, connection);
				this.lastErrors.delete(name);
				this.armIdleTimer(connection);
				return connection;
			})
			.finally(() => {
				this.starts.delete(promise);
				if (this.starting.get(name)?.promise === promise) this.starting.delete(name);
			});
		this.starts.add(promise);
		this.starting.set(name, { fingerprint: server.fingerprint, promise });
		return promise;
	}

	/** 启动并发现一组已获授权的配置；单个 server 失败不阻断其余 server 或宿主启动。 */
	async warmConfigured(
		servers: readonly ResolvedServerConfig[],
		idleTimeoutMs: number,
		startupTimeoutMs: number | undefined,
	): Promise<void> {
		await Promise.all(
			servers.map(async (server) => {
				try {
					const connection = await this.ensureClient(server, idleTimeoutMs, startupTimeoutMs);
					const outcome = await this.refreshCatalog(server, connection);
					if (outcome.status === "superseded")
						throw new McpSupersededError(`MCP server "${server.name}" 自动启动期间配置已变更`);
				} catch (error) {
					if (this.disposed) return;
					const message = errorMessage(error);
					this.lastErrors.set(server.name, message);
					this.options.onError(`MCP server "${server.name}" 自动启动失败: ${message}`);
				}
			}),
		);
	}

	private async connect(
		server: ResolvedServerConfig,
		generation: number,
		idleTimeoutMs: number,
		startupTimeoutMs: number | undefined,
	): Promise<ServerConnection> {
		const name = server.name;
		const definition = server.definition;
		const httpKinds: Array<"streamable-http" | "sse"> | undefined = definition.url
			? definition.httpTransport === "sse"
				? ["sse"]
				: definition.httpTransport === "streamable-http"
					? ["streamable-http"]
					: ["streamable-http", "sse"]
			: undefined;
		const kinds = httpKinds ?? [definition.command ? "stdio" : "streamable-http"];
		let lastError: unknown;

		for (const kind of kinds) {
			let transport: Transport;
			let transportKind: ServerConnection["transportKind"];
			if (this.options.createTransport) {
				const injected = this.options.createTransport(server);
				transport = injected.transport;
				transportKind = injected.kind;
			} else if (kind === "stdio") {
				transportKind = "stdio";
				transport = this.createStdioTransport(definition);
			} else {
				transportKind = kind;
				transport = this.createHttpTransport(server, kind);
			}

			let client!: Client;
			client = new Client(
				{ name: "uina-mcp", version: this.options.version },
				{
					// 优先探测现代 era（ttlMs/cacheScope 提示与现代订阅），自动 fallback legacy（D10）。
					versionNegotiation: { mode: "auto" },
					listChanged: {
						tools: {
							autoRefresh: true,
							onChanged: (error, tools) => {
								this.handleToolsChanged(server.fingerprint, client, error, tools);
							},
						},
					},
				},
			);
			try {
				// 握手细节、能力协商全部归 SDK；不设独立 startup 预算时交 SDK 默认 request timeout。
				await client.connect(transport, startupTimeoutMs !== undefined ? { timeout: startupTimeoutMs } : undefined);
				return {
					generation,
					serverConfig: server,
					serverFingerprint: server.fingerprint,
					client,
					transport,
					transportKind,
					instructions: client.getInstructions(),
					inFlight: 0,
					lastUsedAt: Date.now(),
					idleTimeoutMs,
					draining: false,
				};
			} catch (error) {
				lastError = error;
				this.lastErrors.set(name, errorMessage(error));
				try {
					await client.close();
				} catch {
					try {
						await transport.close();
					} catch {
						// transport 清理失败不掩盖原始建连错误。
					}
				}
				const canFallback =
					httpKinds?.length === 2 && kind === "streamable-http" && isLegacyTransportCompatibilityError(error);
				if (canFallback) continue;
				throw error;
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private createStdioTransport(definition: McpServerDefinition): Transport {
		const env: Record<string, string> =
			definition.inheritEnv === false
				? { ...getDefaultEnvironment(), ...(definition.env ?? {}) }
				: ({ ...process.env, ...(definition.env ?? {}) } as Record<string, string>);
		// Windows 下无后缀的包管理器命令映射 .cmd（spawn 不走 shell，防 ENOENT）。
		const command =
			process.platform === "win32" &&
			!extname(definition.command!) &&
			["npx", "npm", "pnpm", "yarn", "uvx"].includes(definition.command!)
				? `${definition.command}.cmd`
				: definition.command!;
		return new StdioClientTransport({ command, ...(definition.args ? { args: [...definition.args] } : {}), env });
	}

	private createHttpTransport(server: ResolvedServerConfig, kind: "streamable-http" | "sse"): Transport {
		const url = new URL(server.definition.url!);
		const headers = server.definition.headers ? { ...server.definition.headers } : undefined;
		// 凭据请求拒绝一切重定向（含 same-origin）；无凭据交 transport/SDK 正常处理。
		const requestInit = {
			...(headers ? { headers } : {}),
			...(hasSensitiveCredentials(server.definition) ? { redirect: "error" as const } : {}),
		};
		const options = Object.keys(requestInit).length > 0 ? { requestInit } : undefined;
		if (kind === "sse") return new SSEClientTransport(url, options);
		return new StreamableHTTPClientTransport(url, options);
	}

	// ── inFlight ticket：call 与 refreshCatalog（listTools）都计入 ──────────

	private acquire(connection: ServerConnection): void {
		connection.inFlight++;
		connection.lastUsedAt = Date.now();
	}

	private release(connection: ServerConnection): void {
		connection.inFlight--;
		connection.lastUsedAt = Date.now();
		if (connection.draining) this.settleDraining(connection);
	}

	// ── 目录刷新 ─────────────────────────────────────────────────────────

	/** SDK 跨页聚合（无参 listTools 自动拉全部分页）；同一 (server, fingerprint) 的
	 * 在途刷新共享同一 refreshPromise。 */
	async refreshCatalog(server: ResolvedServerConfig, connection: ServerConnection): Promise<RefreshOutcome> {
		const key = `${server.name}:${server.fingerprint}`;
		const existing = this.refreshPromises.get(key);
		if (existing) return existing;
		const promise = this.doRefresh(server, connection).finally(() => {
			if (this.refreshPromises.get(key) === promise) this.refreshPromises.delete(key);
		});
		this.refreshPromises.set(key, promise);
		return promise;
	}

	private async doRefresh(server: ResolvedServerConfig, connection: ServerConnection): Promise<RefreshOutcome> {
		this.acquire(connection);
		let result: Awaited<ReturnType<Client["listTools"]>>;
		try {
			result = await connection.client.listTools();
		} finally {
			this.release(connection);
		}
		const tools = serializeTools(result.tools ?? [], server.name);
		// 权威连接守卫：提交前校验，draining/disposed/换代的刷新结果一律丢弃。
		if (this.disposed) return { status: "superseded" };
		const current = this.connections.get(server.name);
		if (current !== connection || connection.draining || connection.serverFingerprint !== server.fingerprint) {
			return { status: "superseded", entry: { tools } };
		}
		const ttlMs =
			typeof result.ttlMs === "number" && Number.isSafeInteger(result.ttlMs) && result.ttlMs >= 0
				? result.ttlMs
				: undefined;
		const cacheScope =
			result.cacheScope === "public" || result.cacheScope === "private" ? result.cacheScope : undefined;
		this.catalog.commit(
			server.name,
			{
				serverFingerprint: server.fingerprint,
				...(cacheScope ? { cacheScope } : {}),
				fetchedAt: Date.now(),
				...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
				tools,
			},
			this.options.configuredNames?.(),
		);
		return { status: "ok", entry: { tools } };
	}

	/** 连接期间主动通知（tools/list_changed）：SDK 统一抽象 legacy 通知与现代订阅。 */
	private handleToolsChanged(
		fingerprint: string,
		client: Client,
		error: Error | null,
		tools: Awaited<ReturnType<Client["listTools"]>>["tools"] | null,
	): void {
		if (this.disposed) return;
		let owner: { name: string; connection: ServerConnection } | undefined;
		for (const [name, entry] of this.connections) {
			if (entry.client === client) {
				owner = { name, connection: entry };
				break;
			}
		}
		if (!owner || owner.connection.draining || owner.connection.serverFingerprint !== fingerprint) return;
		// 通知本身已经否定旧快照；刷新失败时也必须留下 stale，不能继续伪装 fresh。
		this.markCatalogStale(owner.name, owner.connection);
		if (error) {
			this.options.onError(`MCP tools/list_changed 刷新失败: ${errorMessage(error)}`);
			return;
		}
		if (!tools) return;
		void this.refreshCatalog(owner.connection.serverConfig, owner.connection).catch((refreshError) => {
			this.options.onError(`MCP tools/list_changed 刷新失败: ${errorMessage(refreshError)}`);
		});
	}

	/** 已发出的调用明确命中不存在的能力：保留旧快照但阻断下一次盲调。 */
	markCatalogStale(serverName: string, connection: ServerConnection): void {
		if (this.disposed || connection.draining || this.connections.get(serverName) !== connection) return;
		this.catalog.markStale(serverName, this.options.configuredNames?.());
	}

	// ── 工具调用 ─────────────────────────────────────────────────────────

	async callTool(
		connection: ServerConnection,
		toolName: string,
		args: Record<string, unknown>,
		callTimeoutMs: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<Awaited<ReturnType<Client["callTool"]>>> {
		this.acquire(connection);
		try {
			return await connection.client.callTool(
				{ name: toolName, arguments: args },
				{
					...(callTimeoutMs !== undefined ? { timeout: callTimeoutMs } : {}),
					...(signal ? { signal } : {}),
				},
			);
		} finally {
			this.release(connection);
		}
	}

	// ── idle 停止 / draining / 关闭序列 ──────────────────────────────────

	private armIdleTimer(connection: ServerConnection): void {
		if (connection.idleTimer) clearTimeout(connection.idleTimer);
		const rearm = (delay: number): void => {
			connection.idleTimer = setTimeout(() => this.onIdleCheck(connection), delay);
			connection.idleTimer.unref?.();
		};
		const remaining = connection.lastUsedAt + connection.idleTimeoutMs - Date.now();
		rearm(Math.max(remaining, 0));
	}

	private onIdleCheck(connection: ServerConnection): void {
		if (this.disposed || connection.draining) return;
		if (connection.inFlight > 0) {
			// 在途协议交互阻止关闭；touch 会在结算时刷新 lastUsedAt。
			this.armIdleTimer(connection);
			return;
		}
		const remaining = connection.lastUsedAt + connection.idleTimeoutMs - Date.now();
		if (remaining > 0) {
			this.armIdleTimer(connection);
			return;
		}
		const name = this.findName(connection);
		if (name !== undefined) this.connections.delete(name);
		void this.closeConnection(connection);
	}

	private startDraining(name: string, connection: ServerConnection): void {
		connection.draining = true;
		if (connection.idleTimer) clearTimeout(connection.idleTimer);
		connection.idleTimer = undefined;
		this.connections.delete(name);
		this.settleDraining(connection);
	}

	private settleDraining(connection: ServerConnection): void {
		if (!connection.draining || connection.inFlight > 0) return;
		void this.closeConnection(connection);
	}

	/** 统一关闭序列：Streamable HTTP 先 best-effort terminateSession，再 client.close()。 */
	private async closeConnection(connection: ServerConnection): Promise<void> {
		if (connection.idleTimer) clearTimeout(connection.idleTimer);
		connection.idleTimer = undefined;
		try {
			if (connection.transportKind === "streamable-http") {
				const httpTransport = connection.transport as StreamableHTTPClientTransport;
				if (typeof httpTransport.terminateSession === "function") {
					await httpTransport.terminateSession().catch(() => {});
				}
			}
			await connection.client.close();
		} catch (error) {
			this.options.onError(`MCP 连接关闭失败: ${errorMessage(error)}`);
		}
	}

	private findName(connection: ServerConnection): string | undefined {
		for (const [name, entry] of this.connections) if (entry === connection) return name;
		return undefined;
	}

	/** teardown：封锁状态落盘，关闭全部连接（含 draining），清空 timer 与在途刷新。 */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.refreshPromises.clear();
		const starts = [...this.starts];
		this.starting.clear();
		const connections = [...this.connections.values()];
		this.connections.clear();
		for (const connection of connections) {
			if (connection.idleTimer) clearTimeout(connection.idleTimer);
			connection.idleTimer = undefined;
		}
		await Promise.allSettled(starts);
		await Promise.all(connections.map((connection) => this.closeConnection(connection)));
	}
}

function serializeTool(tool: { name: string } & Record<string, unknown>): CatalogTool {
	return {
		name: tool.name,
		...(typeof tool.title === "string" ? { title: tool.title } : {}),
		...(typeof tool.description === "string" ? { description: tool.description } : {}),
		...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
		...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
		...(typeof tool.annotations === "object" && tool.annotations !== null
			? { annotations: tool.annotations as Record<string, unknown> }
			: {}),
	};
}

function serializeTools(tools: Array<{ name: string } & Record<string, unknown>>, serverName: string): CatalogTool[] {
	const seen = new Set<string>();
	return tools.map((tool) => {
		if (seen.has(tool.name)) throw new Error(`MCP server "${serverName}" 返回重复工具名: ${tool.name}`);
		seen.add(tool.name);
		return serializeTool(tool);
	});
}

/** 协议层明确表示工具能力不存在，区别于普通业务失败。 */
export function isToolCapabilityMismatchError(error: unknown): boolean {
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	if (code === -32601) return true;
	const message = errorMessage(error).toLowerCase();
	return /unknown tool|tool\s+['"`]?.+?['"`]?\s+(?:not found|does not exist)|method\s+not found/.test(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
