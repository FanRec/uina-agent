/** MCP 扩展配置层：两层发现、单次操作不可变快照、指纹、项目信任门与脱敏。
 * 本模块是扩展内唯一读盘者（两层 mcp.json + mcp-trust.json）。 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 全局 Uina 主目录：UINA_HOME 是用户主目录的测试替身，".uina" 由代码追加。 */
export function getGlobalUinaDir(): string {
	return join(process.env.UINA_HOME ?? homedir(), ".uina");
}

export function globalConfigPath(): string {
	return join(getGlobalUinaDir(), "mcp.json");
}

export function trustRecordPath(): string {
	return join(getGlobalUinaDir(), "mcp-trust.json");
}

export function catalogRecordPath(): string {
	return join(getGlobalUinaDir(), "mcp-catalog.json");
}

export interface McpServerDefinition {
	/** stdio：可执行命令与参数。 */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** 缺省 true：继承宿主进程环境；false：仅 SDK 平台最小默认环境 + env。 */
	inheritEnv?: boolean;
	/** 全局配置中显式开启时，扩展激活阶段自动建连并发现工具。 */
	autoStart?: boolean;
	/** streamable HTTP / SSE 端点。 */
	url?: string;
	headers?: Record<string, string>;
	/** 缺省 "auto"：优先 streamable-http，兼容错误才退避 SSE。 */
	httpTransport?: "auto" | "streamable-http" | "sse";
}

export interface ResolvedServerConfig {
	name: string;
	definition: McpServerDefinition;
	source: "project" | "global";
	sourcePath: string;
	/** = 定义规范化（键排序、去 undefined）后 sha256；配置/凭据变化即变。 */
	fingerprint: string;
}

/** 非法 server：保留遮蔽（绝不 fallback 到低优先级同名 server）。 */
export interface InvalidServerConfig {
	kind: "invalid";
	name: string;
	source: "project" | "global";
	sourcePath: string;
	error: string;
}

/** 快照联合：valid 携带解析后的配置，invalid 保留遮蔽（绝不 fallback 到低优先级同名 server）。 */
export type ResolvedServer = { kind: "valid"; config: ResolvedServerConfig } | InvalidServerConfig;

export interface McpConfigSnapshot {
	servers: Map<string, ResolvedServer>;
	/** 用户级 Uina 专属用途说明；与 MCP server 定义及其指纹分离。 */
	mcpPurposes?: Record<string, string>;
	/** 无活动协议交互持续闲置的倒计时预算，默认 10 分钟。 */
	idleTimeoutMs: number;
	/** 默认不设置：交 SDK 默认 request timeout（60s）。 */
	callTimeoutMs?: number;
	/** 默认不设置：connect/握手与请求同走 SDK 默认。 */
	startupTimeoutMs?: number;
}

export class McpConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function positiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
	return value;
}

function parseMcpPurposes(raw: Record<string, unknown>): Record<string, string> | undefined {
	if (!isRecord(raw.uina) || !isRecord(raw.uina.mcpPurposes)) return undefined;
	const purposes = Object.fromEntries(
		Object.entries(raw.uina.mcpPurposes)
			.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
			.map(([name, purpose]) => [name, purpose.trim()]),
	);
	return Object.keys(purposes).length > 0 ? purposes : undefined;
}

/** 校验单个 server 定义；非法返回错误原因（不抛）。 */
export function validateServerDefinition(_name: string, value: unknown): McpServerDefinition | string {
	if (!isRecord(value)) return "必须是对象";
	const { command, args, env, inheritEnv, autoStart, url, headers, httpTransport, ...rest } = value;
	const unknownKeys = Object.keys(rest);
	const extra = unknownKeys.length > 0 ? `（忽略未知字段: ${unknownKeys.join(", ")}）` : "";
	if (typeof command === "string") {
		if (url !== undefined) return `command 与 url 不能同时声明${extra}`;
		if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string")))
			return `args 必须是字符串数组${extra}`;
		if (env !== undefined && !isStringRecord(env)) return `env 必须是字符串映射${extra}`;
		if (inheritEnv !== undefined && typeof inheritEnv !== "boolean") return `inheritEnv 必须是布尔值${extra}`;
		if (autoStart !== undefined && typeof autoStart !== "boolean") return `autoStart 必须是布尔值${extra}`;
		return {
			command,
			...(Array.isArray(args) ? { args: args as string[] } : {}),
			...(isStringRecord(env) ? { env } : {}),
			...(typeof inheritEnv === "boolean" ? { inheritEnv } : {}),
			...(typeof autoStart === "boolean" ? { autoStart } : {}),
		};
	}
	if (typeof url === "string") {
		if (command !== undefined || args !== undefined || env !== undefined || inheritEnv !== undefined)
			return `url 与 stdio 字段不能同时声明${extra}`;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return `url 不是合法 URL${extra}`;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `url 必须是 http/https${extra}`;
		if (headers !== undefined && !isStringRecord(headers)) return `headers 必须是字符串映射${extra}`;
		if (httpTransport !== undefined && !["auto", "streamable-http", "sse"].includes(httpTransport as string))
			return `httpTransport 必须是 auto / streamable-http / sse${extra}`;
		if (autoStart !== undefined && typeof autoStart !== "boolean") return `autoStart 必须是布尔值${extra}`;
		return {
			url,
			...(typeof autoStart === "boolean" ? { autoStart } : {}),
			...(isStringRecord(headers) ? { headers } : {}),
			...(typeof httpTransport === "string"
				? { httpTransport: httpTransport as McpServerDefinition["httpTransport"] }
				: {}),
		};
	}
	return `需要 command（stdio）或 url（streamable HTTP）${extra}`;
}

/** Pi hashProjectServerDefinition 同法：键排序、去 undefined，sha256。 */
export function definitionFingerprint(definition: McpServerDefinition): string {
	const canonicalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonicalize);
		if (!value || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalize(entry)]),
		);
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(definition)))
		.digest("hex");
}

function parseConfigFile(
	path: string,
	label: string,
): {
	mcpServers: Record<string, unknown>;
	mcpPurposes?: Record<string, string>;
	tuning: Partial<Pick<McpConfigSnapshot, "idleTimeoutMs" | "callTimeoutMs" | "startupTimeoutMs">>;
} {
	let raw: unknown;
	try {
		const text = readFileSync(path, "utf-8");
		if (text.trim() === "") return { mcpServers: {}, tuning: {} };
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new McpConfigError(`${label} 解析失败: ${path}: ${message}`);
	}
	if (!isRecord(raw)) throw new McpConfigError(`${label} 顶层必须是对象: ${path}`);
	const servers = raw.mcpServers ?? {};
	if (!isRecord(servers)) throw new McpConfigError(`${label} 的 mcpServers 必须是对象: ${path}`);
	const tuning: Partial<Pick<McpConfigSnapshot, "idleTimeoutMs" | "callTimeoutMs" | "startupTimeoutMs">> = {};
	const idleTimeoutMs = positiveInt(raw.idleTimeoutMs);
	if (raw.idleTimeoutMs !== undefined && idleTimeoutMs === undefined)
		throw new McpConfigError(`${label} 的 idleTimeoutMs 必须是正整数: ${path}`);
	if (idleTimeoutMs !== undefined) tuning.idleTimeoutMs = idleTimeoutMs;
	for (const key of ["callTimeoutMs", "startupTimeoutMs"] as const) {
		const parsed = positiveInt(raw[key]);
		if (raw[key] !== undefined && parsed === undefined)
			throw new McpConfigError(`${label} 的 ${key} 必须是正整数: ${path}`);
		if (parsed !== undefined) tuning[key] = parsed;
	}
	const mcpPurposes = parseMcpPurposes(raw);
	return { mcpServers: servers, ...(mcpPurposes ? { mcpPurposes } : {}), tuning };
}

function resolveLayer(
	layer: { source: "project" | "global"; path: string; label: string },
	servers: Record<string, unknown>,
	merged: Map<string, ResolvedServer>,
): Partial<Pick<McpConfigSnapshot, "idleTimeoutMs" | "callTimeoutMs" | "startupTimeoutMs">> {
	const tuning: Partial<Pick<McpConfigSnapshot, "idleTimeoutMs" | "callTimeoutMs" | "startupTimeoutMs">> = {};
	for (const [name, value] of Object.entries(servers)) {
		const validated = validateServerDefinition(name, value);
		if (typeof validated === "string") {
			// 非法定义依然遮蔽低优先级同名 server——配置错误导致能力不可用，而非静默换一个同名能力。
			merged.set(name, { kind: "invalid", name, source: layer.source, sourcePath: layer.path, error: validated });
		} else {
			// 同名 server = 整个定义原子替换，绝不 deep merge（防跨层凭据拼接）。
			merged.set(name, {
				kind: "valid",
				config: {
					name,
					definition: validated,
					source: layer.source,
					sourcePath: layer.path,
					fingerprint: definitionFingerprint(validated),
				},
			});
		}
	}
	return tuning;
}

/** 项目级配置路径：首选 ./.uina/mcp.json，兼容回退 ./.mcp.json；两者都不存在为空。
 * 仅选定唯一一个存在的项目配置文件，不做项目内交叉合并。 */
export function projectConfigPath(cwd: string): { path: string; exists: boolean } | undefined {
	const preferred = resolve(cwd, ".uina", "mcp.json");
	if (existsSync(preferred)) return { path: preferred, exists: true };
	const fallback = resolve(cwd, ".mcp.json");
	if (existsSync(fallback)) return { path: fallback, exists: true };
	return undefined;
}

/** 解析两层配置为单次操作不可变快照；解析失败抛 McpConfigError（整体阻断，不静默降级）。 */
export function resolveMcpConfig(cwd: string): McpConfigSnapshot {
	const servers = new Map<string, ResolvedServer>();
	let idleTimeoutMs = 600_000;
	let callTimeoutMs: number | undefined;
	let startupTimeoutMs: number | undefined;
	let mcpPurposes: Record<string, string> | undefined;

	const globalPath = globalConfigPath();
	if (existsSync(globalPath)) {
		const loaded = parseConfigFile(globalPath, "全局 MCP 配置");
		resolveLayer({ source: "global", path: globalPath, label: "全局 MCP 配置" }, loaded.mcpServers, servers);
		mcpPurposes = loaded.mcpPurposes;
		if (loaded.tuning.idleTimeoutMs !== undefined) idleTimeoutMs = loaded.tuning.idleTimeoutMs;
		if (loaded.tuning.callTimeoutMs !== undefined) callTimeoutMs = loaded.tuning.callTimeoutMs;
		if (loaded.tuning.startupTimeoutMs !== undefined) startupTimeoutMs = loaded.tuning.startupTimeoutMs;
	}

	const project = projectConfigPath(cwd);
	if (project) {
		const loaded = parseConfigFile(project.path, "项目 MCP 配置");
		resolveLayer({ source: "project", path: project.path, label: "项目 MCP 配置" }, loaded.mcpServers, servers);
		// 项目级调优覆盖全局（同名原子替换的同一纪律）。
		if (loaded.tuning.idleTimeoutMs !== undefined) idleTimeoutMs = loaded.tuning.idleTimeoutMs;
		if (loaded.tuning.callTimeoutMs !== undefined) callTimeoutMs = loaded.tuning.callTimeoutMs;
		if (loaded.tuning.startupTimeoutMs !== undefined) startupTimeoutMs = loaded.tuning.startupTimeoutMs;
	}

	return {
		servers,
		...(mcpPurposes ? { mcpPurposes } : {}),
		idleTimeoutMs,
		...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
		...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
	};
}

// ── 项目信任（D12，机制采 Pi project-server-trust.ts 简化版）──────────────

const TRUST_VERSION = 1;

export interface TrustRecord {
	projectRoot: string;
	serverName: string;
	definitionHash: string;
	approvedAt: string;
}

interface TrustStore {
	version: number;
	approvals: TrustRecord[];
}

function loadTrustStore(): TrustStore {
	const path = trustRecordPath();
	if (!existsSync(path)) return { version: TRUST_VERSION, approvals: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TrustStore>;
		if (parsed.version !== TRUST_VERSION || !Array.isArray(parsed.approvals)) throw new Error("invalid format");
		const approvals = parsed.approvals.filter(
			(entry): entry is TrustRecord =>
				!!entry &&
				typeof entry.projectRoot === "string" &&
				typeof entry.serverName === "string" &&
				typeof entry.definitionHash === "string" &&
				typeof entry.approvedAt === "string",
		);
		return { version: TRUST_VERSION, approvals };
	} catch {
		// 信任记录损坏不阻断启动：回到"全部待确认"的保守状态。
		return { version: TRUST_VERSION, approvals: [] };
	}
}

export function canonicalProjectRoot(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

export function isProjectServerTrusted(cwd: string, serverName: string, fingerprint: string): boolean {
	const store = loadTrustStore();
	const projectRoot = canonicalProjectRoot(cwd);
	return store.approvals.some(
		(entry) =>
			entry.projectRoot === projectRoot && entry.serverName === serverName && entry.definitionHash === fingerprint,
	);
}

/** 原子写（temp + rename），非 Windows 补 0600。 */
export function approveProjectServer(cwd: string, serverName: string, fingerprint: string): void {
	const path = trustRecordPath();
	const store = loadTrustStore();
	const projectRoot = canonicalProjectRoot(cwd);
	store.approvals = store.approvals.filter(
		(entry) => entry.projectRoot !== projectRoot || entry.serverName !== serverName,
	);
	store.approvals.push({ projectRoot, serverName, definitionHash: fingerprint, approvedAt: new Date().toISOString() });
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	if (process.platform !== "win32") chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	if (process.platform !== "win32") chmodSync(path, 0o600);
}

// ── 敏感信息脱敏 ─────────────────────────────────────────────────────────

/** 屏蔽 userinfo（password → <redacted>）、全部 query value 与 fragment。
 * 不可解析的 URL 按 fail-closed 处理：只返回 <redacted>。 */
export function sanitizeEndpointForDisplay(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return "<redacted>";
	}
	let out = `${url.protocol}//`;
	if (url.password) out += `${url.username ? `${url.username}:` : ""}<redacted>@`;
	else if (url.username) out += `${url.username}@`;
	out += url.host + url.pathname;
	if (url.search) {
		const keys = [...new Set([...url.searchParams.keys()])];
		if (keys.length > 0) out += `?${keys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}`;
	}
	return out;
}

/** URL 携带凭据：userinfo 非空，或存在任意 query 参数（tavily 式 key-in-query 生态常态，保守处理）。 */
export function urlCarriesCredentials(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		return url.username !== "" || url.password !== "" || [...url.searchParams.keys()].length > 0;
	} catch {
		return true;
	}
}

/** 敏感凭据：配置了 headers，或 URL 携带凭据 → 拒绝一切 HTTP 重定向（含 same-origin）。 */
export function hasSensitiveCredentials(definition: McpServerDefinition): boolean {
	if (definition.headers && Object.keys(definition.headers).length > 0) return true;
	if (definition.url && urlCarriesCredentials(definition.url)) return true;
	return false;
}

/** 信任弹窗 / status / 错误信息用：绝不回显 env 值、header 值或未脱敏 URL。 */
export function describeServerForDisplay(definition: McpServerDefinition): string {
	if (definition.command) {
		const envKeys = definition.env ? Object.keys(definition.env) : [];
		const envNote = envKeys.length > 0 ? ` (env: ${envKeys.join(", ")})` : "";
		return `${[definition.command, ...(definition.args ?? [])].map((value) => JSON.stringify(value)).join(" ")}${envNote}`;
	}
	if (definition.url) return sanitizeEndpointForDisplay(definition.url);
	return "(无命令或端点)";
}
