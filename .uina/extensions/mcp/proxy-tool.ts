/** mcp 代理工具：五个 action（list/search/describe/call/status）、三元组精确路由、
 * stale 前置校准断路、五态映射、CallToolResult 保真降级投影与 Output Guard。 */
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { ExtensionAPI, ImageContent, Tool, ToolResultStatus } from "../../../src/extensions/index.js";
import { formatValidationErrors } from "../../../src/tools/validation-errors.js";
import type { CatalogEntry, CatalogTool } from "./catalog.js";
import { classifyEntry, fullName } from "./catalog.js";
import {
	approveProjectServer,
	canonicalProjectRoot,
	describeServerForDisplay,
	globalConfigPath,
	isProjectServerTrusted,
	resolveMcpConfig,
	type McpConfigSnapshot,
	type ResolvedServerConfig,
} from "./config.js";
import {
	isToolCapabilityMismatchError,
	McpServerManager,
	McpSupersededError,
	type ServerConnection,
} from "./server-manager.js";
import { McpOutputGuard } from "./output-guard.js";

const SEARCH_LIMIT = 12;
const INSTRUCTIONS_PREVIEW_LENGTH = 300;

interface AjvLike {
	compile(schema: object): { (data: unknown): boolean; errors: ErrorObject[] | null };
}
type AjvCtor = new (options: { strict: boolean; allErrors: boolean }) => AjvLike;
const Ajv = createRequire(import.meta.url)("ajv") as AjvCtor;
// 远端 MCP server 自报的 inputSchema 草稿版本与关键词不可控，strict 必须关闭。
const ajv = new Ajv({ strict: false, allErrors: true });

interface ProxyToolResult {
	result: string;
	status: ToolResultStatus;
	images?: ImageContent[];
	details?: Record<string, unknown>;
}

export interface McpProxyDeps {
	api: ExtensionAPI;
	catalog: McpProxyCatalogView;
	manager: McpServerManager;
	tmpDir: string;
}

/** proxy-tool 对 catalog 的消费面（McpCatalog 满足此形状）。 */
export interface McpProxyCatalogView {
	get(serverName: string): CatalogEntry | undefined;
	entries(): Array<[string, CatalogEntry]>;
}

const PROXY_SCHEMA = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["list", "search", "describe", "call", "status"] },
		server: { type: "string", description: "list 时可选：定向发现该 server（缓存缺失/过期则启动并拉取目录）" },
		query: { type: "string", description: "search 必填：关键词，匹配工具名或描述" },
		tool: { type: "string", description: "describe/call 必填：工具全名 serverName.toolName" },
		args: { type: "object", description: "call 时传入：工具参数对象（若工具无需入参可缺省，默认为 {}）" },
	},
	required: ["action"],
	additionalProperties: false,
};

const PROXY_DESCRIPTION =
	"Interact with configured MCP servers through a single proxy. " +
	"Actions: list (no server: configured servers with purposes and catalog status, zero connections; " +
	"with server: discover/recalibrate that server's tools), " +
	"search (query matches configured server names/purposes AND discovered tools; never starts servers), " +
	"describe (full schema of serverName.toolName), " +
	"call (execute serverName.toolName with args), status (connection/trust/freshness). " +
	"Discover with list(server) before calling; tools are named serverName.toolName. " +
	'call never cold-discovers unknown tools — run list(server="<name>") first.';

/** Server 用途（S6.1）：优先 Server 自带 description；无 description 时过渡期读取旧
 * uina.mcpPurposes（仅全局作用域，parseConfigFile 已保证）。二者都无则缺省。 */
function serverDescription(snapshot: McpConfigSnapshot, serverName: string): string | undefined {
	const resolved = snapshot.servers.get(serverName);
	const declared = resolved?.kind === "valid" ? resolved.config.definition.description?.trim() : undefined;
	if (declared) return declared;
	const purposes = snapshot.mcpPurposes;
	if (purposes && Object.hasOwn(purposes, serverName)) {
		const purpose = purposes[serverName]!.replace(/\s+/g, " ").trim();
		if (purpose) return purpose;
	}
	return undefined;
}

export function createMcpProxyTool(deps: McpProxyDeps): Tool {
	const { api, catalog, manager, tmpDir } = deps;
	const outputGuard = new McpOutputGuard(tmpDir);

	// ── 通用结果构造 ─────────────────────────────────────────────────────

	function fail(mode: string, message: string, details: Record<string, unknown> = {}): ProxyToolResult {
		return { result: message, status: "failed", details: { mode, ...details } };
	}

	function notStarted(mode: string, message: string, details: Record<string, unknown> = {}): ProxyToolResult {
		return { result: message, status: "not_started", details: { mode, ...details } };
	}

	function cancelled(mode: string, message: string): ProxyToolResult {
		return { result: message, status: "cancelled", details: { mode } };
	}

	/** 项目级 server 首次启动前必须过信任门；无 UI 保持 blocked（not_started）。 */
	async function ensureTrusted(config: ResolvedServerConfig): Promise<{ ok: true } | { ok: false; message: string }> {
		if (config.source === "global") return { ok: true };
		if (isProjectServerTrusted(api.cwd, config.name, config.fingerprint)) return { ok: true };
		const endpoint = describeServerForDisplay(config.definition);
		if (!api.ui.hasUI()) {
			return {
				ok: false,
				message:
					`项目 server "${config.name}" 未获信任（当前无 UI 可确认）。来源: ${config.sourcePath} · 端点: ${endpoint}。` +
					`请在交互式会话中重新发起以确认信任，或将定义移入全局配置 ${globalConfigPath()}（全局配置受信任）。`,
			};
		}
		const approved = await api.ui.confirm(
			`允许项目 MCP server "${config.name}"？`,
			`配置来源: ${config.sourcePath}\n端点: ${endpoint}\n\n该 server 可以在本机执行命令，或以你的用户权限发起网络请求。`,
		);
		if (!approved) return { ok: false, message: `项目 server "${config.name}" 被拒绝。再次调用时会重新询问。` };
		approveProjectServer(canonicalProjectRoot(api.cwd), config.name, config.fingerprint);
		return { ok: true };
	}

	// ── list ─────────────────────────────────────────────────────────────

	async function executeList(
		snapshot: McpConfigSnapshot,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<ProxyToolResult> {
		const serverName = typeof args.server === "string" ? args.server : undefined;
		if (serverName === undefined) {
			// 本地概览：已配置 Server 名称、用途简述与信任/目录状态；零连接、零工具调用。
			// 未信任的项目 Server 也显示候选名与用途（非敏感发现元数据）——被列出不代表
			// 获得执行许可，信任门归 list(server)/call。
			const lines: string[] = [];
			for (const [name, resolved] of snapshot.servers) {
				if (resolved.kind === "invalid") {
					lines.push(`- ${name}: invalid (${resolved.error})`);
					continue;
				}
				const desc = serverDescription(snapshot, name);
				const descPart = desc ? ` — ${desc}` : "";
				const entry = catalog.get(name);
				if (!entry) {
					lines.push(`- ${name}: missing (未发现)${descPart}`);
					continue;
				}
				const status = classifyEntry(entry, snapshot, name);
				if (status.kind === "unconfigured") continue;
				lines.push(`- ${name}: ${statusLabel(entry, snapshot, name)}${descPart}`);
			}
			return {
				result:
					lines.length > 0
						? `MCP servers:\n${lines.join("\n")}\n\n可通过 list(server="<name>") 定向发现或重新校准工具`
						: "尚未配置任何 MCP server。将定义写入 .uina/mcp.json、.mcp.json 或 ~/.uina/mcp.json 后即可使用。",
				status: "succeeded",
				details: { mode: "list" },
			};
		}

		const resolved = snapshot.servers.get(serverName);
		if (!resolved) {
			return fail(
				"list",
				`server "${serverName}" 未在配置中。可用: ${[...snapshot.servers.keys()].join(", ") || "(无)"}`,
			);
		}
		if (resolved.kind === "invalid") return fail("list", `server "${serverName}" 配置非法: ${resolved.error}`);
		if (signal?.aborted) return cancelled("list", "发现已取消（请求未发出）");
		const trust = await ensureTrusted(resolved.config);
		if (!trust.ok) return notStarted("list", trust.message);
		let connection: ServerConnection;
		try {
			connection = await manager.ensureClient(resolved.config, snapshot.idleTimeoutMs, snapshot.startupTimeoutMs);
		} catch (error) {
			if (error instanceof McpSupersededError)
				return fail("list", `MCP 配置在操作执行期间已变更，请重新发起发现: ${error.message}`);
			if (signal?.aborted) return cancelled("list", "发现已取消");
			return fail("list", `server "${serverName}" 启动失败: ${errorMessage(error)}`);
		}
		let outcome: Awaited<ReturnType<McpServerManager["refreshCatalog"]>>;
		try {
			outcome = await manager.refreshCatalog(resolved.config, connection);
		} catch (error) {
			if (signal?.aborted) return cancelled("list", "发现已取消");
			return fail("list", `server "${serverName}" 目录刷新失败: ${errorMessage(error)}`);
		}
		if (outcome.status === "superseded") {
			// 旧连接上已拉取到的结果可作有界展示，但不 commit（守卫已跳过落盘）。
			if (outcome.entry)
				return renderServerTools(
					serverName,
					resolved.config,
					connection,
					outcome.entry.tools,
					"(配置已变更，此结果未写入目录)",
				);
			return fail("list", "MCP 配置在操作执行期间已变更，请重新发起发现");
		}
		const entry = catalog.get(serverName);
		if (!entry) return fail("list", `server "${serverName}" 目录为空`);
		return renderServerTools(serverName, resolved.config, connection, entry.tools);
	}

	function statusLabel(entry: CatalogEntry, snapshot: McpConfigSnapshot, serverName: string): string {
		const status = classifyEntry(entry, snapshot, serverName);
		if (status.kind === "fresh") return `fresh (${entry.tools.length} tools)`;
		if (status.kind === "stale") return `stale (${entry.tools.length} tools) [${status.reason}]`;
		return "unconfigured";
	}

	function renderServerTools(
		serverName: string,
		config: ResolvedServerConfig,
		connection: ServerConnection,
		tools: CatalogTool[],
		note?: string,
	): ProxyToolResult {
		const lines = tools.map(
			(tool) =>
				`- ${fullName(serverName, tool.name)}${tool.description ? `: ${truncateAtWord(tool.description, 80)}` : ""}`,
		);
		let text = `${serverName} (${tools.length} tools)${note ? ` — ${note}` : ""}:\n${lines.join("\n")}`;
		if (connection.instructions) {
			text += `\n\nServer instructions (untrusted server metadata):\n${truncateAtWord(connection.instructions, INSTRUCTIONS_PREVIEW_LENGTH)}`;
		}
		text += `\n\n可通过 describe(tool="...") 查看参数，或通过 call(tool="...", args={...}) 执行`;
		return {
			result: text.trim(),
			status: "succeeded",
			details: {
				mode: "list",
				server: serverName,
				source: config.source,
				sourcePath: config.sourcePath,
				transport: connection.transportKind,
				tools: tools.map((tool) => fullName(serverName, tool.name)),
			},
		};
	}

	// ── search ───────────────────────────────────────────────────────────

	function executeSearch(snapshot: McpConfigSnapshot, query: string): ProxyToolResult {
		const needle = query.toLowerCase();
		// 两级发现（S6.2）：第一级检索配置级 Server 名称与 description（零连接、零启动）；
		// 第二级检索已缓存目录中的工具名/title/description。search 永不启动 Server。
		const serverMatches: Array<{ name: string; description?: string; trusted: boolean }> = [];
		for (const [serverName, resolved] of snapshot.servers) {
			if (resolved.kind === "invalid") continue;
			const description = serverDescription(snapshot, serverName);
			const haystack = `${serverName} ${description ?? ""}`.toLowerCase();
			if (!haystack.includes(needle)) continue;
			const trusted =
				resolved.config.source === "global" || isProjectServerTrusted(api.cwd, serverName, resolved.config.fingerprint);
			serverMatches.push({ name: serverName, description, trusted });
		}
		const matches: Array<{ name: string; tool: CatalogTool; serverName: string; entry: CatalogEntry }> = [];
		for (const [serverName, resolved] of snapshot.servers) {
			if (resolved.kind === "invalid") continue;
			const entry = catalog.get(serverName);
			if (!entry) continue;
			if (classifyEntry(entry, snapshot, serverName).kind === "unconfigured") continue;
			for (const tool of entry.tools) {
				const name = fullName(serverName, tool.name);
				const haystack = `${name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
				if (haystack.includes(needle)) matches.push({ name, tool, serverName, entry });
			}
		}
		if (matches.length === 0 && serverMatches.length === 0) {
			return {
				result: `未检索到匹配 "${query}" 的工具或 Server。可通过 list 查看已配置的 server 或通过 list(server="<name>") 发现更多工具。`,
				status: "succeeded",
				details: { mode: "search", query, matches: [], servers: [] },
			};
		}
		const sections: string[] = [];
		const shown = matches.slice(0, SEARCH_LIMIT);
		if (matches.length > 0) {
			const lines = shown.map(({ name, tool, entry, serverName }) => {
				const status = classifyEntry(entry, snapshot, serverName);
				const staleMark = status.kind === "stale" ? ` [stale: ${status.reason}]` : "";
				return `- ${name}${staleMark}${tool.description ? ` - ${truncateAtWord(tool.description, 60)}` : ""}`;
			});
			let text = `找到 ${matches.length} 个匹配 "${query}" 的工具:\n${lines.join("\n")}`;
			if (matches.length > SEARCH_LIMIT) {
				text += `\n\n(仅显示前 ${SEARCH_LIMIT} 条，省略 ${matches.length - SEARCH_LIMIT} 条；请用更具体的关键词)`;
			}
			text += `\n\n可通过 describe(tool="...") 查看参数，或通过 call(tool="...", args={...}) 执行`;
			sections.push(text);
		}
		if (serverMatches.length > 0) {
			const serverLines = serverMatches.map(({ name, description, trusted }) => {
				const desc = description ? ` — ${description}` : "";
				const trustMark = trusted ? "" : " [blocked: 项目 server 未获信任，不能因被搜到而执行]";
				return `- ${name}${desc}${trustMark}`;
			});
			sections.push(
				`匹配到 ${serverMatches.length} 个配置中的 Server（尚未发现工具；可通过 list(server="<name>") 按需发现）:\n${serverLines.join("\n")}`,
			);
		}
		return {
			result: sections.join("\n\n"),
			status: "succeeded",
			details: {
				mode: "search",
				query,
				matches: shown.map(({ name }) => name),
				total: matches.length,
				servers: serverMatches.map(({ name, trusted }) => ({ name, trusted })),
			},
		};
	}

	// ── describe / call 共用的精确匹配（不 split 字符串，D6）───────────────

	interface ToolMatch {
		serverName: string;
		config: ResolvedServerConfig;
		entry: CatalogEntry;
		tool: CatalogTool;
	}

	function matchTool(snapshot: McpConfigSnapshot, toolName: string): ToolMatch[] {
		const matches: ToolMatch[] = [];
		for (const [serverName, resolved] of snapshot.servers) {
			if (resolved.kind === "invalid") continue;
			const entry = catalog.get(serverName);
			if (!entry) continue;
			const tool = entry.tools.find((candidate) => fullName(serverName, candidate.name) === toolName);
			if (tool) matches.push({ serverName, config: resolved.config, entry, tool });
		}
		return matches;
	}

	/** 相近候选（前缀/关键词匹配），绝不自动猜测 serverName 做冷发现。 */
	function candidates(snapshot: McpConfigSnapshot, toolName: string): string[] {
		const needle = toolName.toLowerCase();
		const found: string[] = [];
		for (const [serverName, resolved] of snapshot.servers) {
			if (resolved.kind === "invalid") continue;
			const entry = catalog.get(serverName);
			if (!entry) continue;
			for (const tool of entry.tools) {
				const name = fullName(serverName, tool.name);
				if (name.toLowerCase().includes(needle) || needle.includes(serverName.toLowerCase())) found.push(name);
			}
		}
		return found.slice(0, 5);
	}

	/** 未配置 server 的历史条目：如实报告"已从配置中移除"，绝不指引去校准不存在的 server。 */
	function findUnconfiguredMatch(snapshot: McpConfigSnapshot, toolName: string): string | undefined {
		for (const [serverName, entry] of catalog.entries()) {
			if (snapshot.servers.has(serverName)) continue;
			if (entry.tools.some((tool) => fullName(serverName, tool.name) === toolName)) return serverName;
		}
		return undefined;
	}

	function executeDescribe(snapshot: McpConfigSnapshot, toolName: string): ProxyToolResult {
		const matches = matchTool(snapshot, toolName);
		if (matches.length === 0) {
			const unconfigured = findUnconfiguredMatch(snapshot, toolName);
			if (unconfigured) return fail("describe", `server '${unconfigured}' 已从配置中移除`);
			const hints = candidates(snapshot, toolName);
			return fail(
				"describe",
				`工具 '${toolName}' 未在目录中，请先通过 list(server) 发现或 search 检索。${hints.length > 0 ? ` 相近候选: ${hints.join(", ")}` : ""}`,
			);
		}
		if (matches.length > 1) {
			return fail(
				"describe",
				`工具 '${toolName}' 匹配到多个 server，请指定完整全名。候选: ${matches.map((match) => fullName(match.serverName, match.tool.name)).join(", ")}`,
			);
		}
		const match = matches[0]!;
		const status = classifyEntry(match.entry, snapshot, match.serverName);
		if (status.kind === "unconfigured") return fail("describe", `server '${match.serverName}' 已从配置中移除`);
		let text = `${toolName}\nServer: ${match.serverName}\n\n${match.tool.description || "(no description)"}\n`;
		text +=
			match.tool.inputSchema !== undefined
				? `\nParameters:\n${JSON.stringify(match.tool.inputSchema, null, 2)}\n`
				: "\nNo parameters defined.\n";
		if (match.tool.outputSchema !== undefined)
			text += `\nOutput schema:\n${JSON.stringify(match.tool.outputSchema, null, 2)}\n`;
		if (match.tool.annotations !== undefined) {
			text += `\nAnnotations (server 自报、未经验证):\n${JSON.stringify(match.tool.annotations, null, 2)}\n`;
		}
		if (status.kind === "stale") {
			text += `\n[stale: ${status.reason}，请通过 list(server="${match.serverName}") 重新校准]`;
		}
		return {
			result: text.trim(),
			status: "succeeded",
			details: { mode: "describe", tool: toolName, server: match.serverName, entryStatus: status.kind },
		};
	}

	// ── call ─────────────────────────────────────────────────────────────

	async function executeCall(
		snapshot: McpConfigSnapshot,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<ProxyToolResult> {
		const toolName = String(args.tool);
		const toolArgs = (args.args as Record<string, unknown> | undefined) ?? {};
		if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) {
			return fail("call", "args 必须是对象");
		}

		const matches = matchTool(snapshot, toolName);
		if (matches.length === 0) {
			const unconfigured = findUnconfiguredMatch(snapshot, toolName);
			if (unconfigured) return fail("call", `server '${unconfigured}' 已从配置中移除`);
			const hints = candidates(snapshot, toolName);
			return fail(
				"call",
				`工具尚未发现或未在目录中，请先通过 list(server) 发现或 search 检索。${hints.length > 0 ? ` 相近候选: ${hints.join(", ")}` : ""}`,
			);
		}
		if (matches.length > 1) {
			return fail(
				"call",
				`工具 '${toolName}' 匹配到多个 server，请指定完整全名。候选: ${matches.map((match) => fullName(match.serverName, match.tool.name)).join(", ")}`,
			);
		}
		const match = matches[0]!;
		const status = classifyEntry(match.entry, snapshot, match.serverName);
		if (status.kind === "unconfigured") return fail("call", `server '${match.serverName}' 已从配置中移除`);

		// dispatch 前的取消是可确认事实：cancelled（请求从未离开本机）。
		if (signal?.aborted) return cancelled("call", "工具调用已取消（请求未发出）");

		// 远端调用前的本地 schema 校验：错参在冷启动 server 之前拦截，一轮拿到精确字段错误。
		// 第三方 schema 本身非法（编译失败）时不拦截，交由远端返回原始错误。
		const inputSchema = match.tool.inputSchema;
		if (typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)) {
			try {
				const validate = ajv.compile(inputSchema);
				if (!validate(toolArgs)) {
					const validationErrors = structuredClone(validate.errors ?? []);
					return fail(
						"call",
						`工具 ${toolName} 参数未通过其 inputSchema 校验：${formatValidationErrors(inputSchema, toolArgs, validationErrors)}。可用 describe 查看完整 schema。`,
						{ server: match.serverName, tool: toolName, reason: "invalid_args", validationErrors },
					);
				}
			} catch {
				// schema 编译失败：跳过本地校验。
			}
		}

		const trust = await ensureTrusted(match.config);
		if (!trust.ok) return notStarted("call", trust.message);
		if (signal?.aborted) return cancelled("call", "工具调用已取消（请求未发出）");

		let connection: ServerConnection;
		try {
			connection = await manager.ensureClient(match.config, snapshot.idleTimeoutMs, snapshot.startupTimeoutMs);
		} catch (error) {
			if (error instanceof McpSupersededError)
				return fail("call", `MCP server 配置在调用期间已变更，请重新发起调用: ${error.message}`);
			if (signal?.aborted) return cancelled("call", "工具调用已取消（请求未发出）");
			return notStarted("call", `server "${match.serverName}" 启动失败（请求未发出）: ${errorMessage(error)}`);
		}

		let activeTool = match.tool;
		if (status.kind === "stale") {
			// 前置校准断路：refresh 失败立即终止，绝不带旧缓存条目 dispatch。
			let outcome: Awaited<ReturnType<McpServerManager["refreshCatalog"]>>;
			try {
				outcome = await manager.refreshCatalog(match.config, connection);
			} catch (error) {
				return fail("call", `目录重新校准失败: ${errorMessage(error)}`);
			}
			if (outcome.status === "superseded") return fail("call", "MCP server 配置在调用期间已变更，请重新发起调用");
			const refreshed = matchTool(snapshot, toolName).find((candidate) => candidate.serverName === match.serverName);
			if (!refreshed) {
				const hints = candidates(snapshot, toolName);
				return fail(
					"call",
					`工具已失效（重新校准后未在 server "${match.serverName}" 中找到）。${hints.length > 0 ? ` 相近候选: ${hints.join(", ")}` : ""}`,
				);
			}
			activeTool = refreshed.tool;
		}

		const identity = { server: match.serverName, tool: toolName, transport: connection.transportKind };
		const effects = [
			{
				effectType: "mcp.call",
				externalOperationId: `${match.serverName}.${activeTool.name}`,
				label: `MCP ${match.serverName}.${activeTool.name}`,
			},
		];

		let result: Awaited<ReturnType<McpServerManager["callTool"]>>;
		try {
			result = await manager.callTool(connection, activeTool.name, toolArgs, snapshot.callTimeoutMs, signal);
		} catch (error) {
			// dispatch 已发出：abort 异常自然抛出交给 broker 归 unknown，不得吞。
			if (signal?.aborted) throw error;
			if (isToolCapabilityMismatchError(error)) {
				manager.markCatalogStale(match.serverName, connection);
				try {
					await manager.refreshCatalog(match.config, connection);
				} catch {
					// 原始能力失配事实优先；刷新失败只保留 stale，下一次调用再校准。
				}
			}
			return fail("call", `MCP 调用失败: ${errorMessage(error)}`, { ...identity, effects });
		}

		const isError = result.isError === true;
		const projected = outputGuard.project(result, toolName);

		return {
			result: projected.text,
			status: isError ? "failed" : "succeeded",
			...(projected.images.length > 0 ? { images: projected.images } : {}),
			details: {
				mode: "call",
				...identity,
				effects,
				...(activeTool.annotations !== undefined ? { annotations: activeTool.annotations } : {}),
				...(projected.detailsExtra ?? {}),
				...(projected.mcpResult !== undefined ? { mcpResult: projected.mcpResult } : {}),
			},
		};
	}

	// ── status ───────────────────────────────────────────────────────────

	function executeStatus(snapshot: McpConfigSnapshot): ProxyToolResult {
		const lines: string[] = ["MCP status:"];
		for (const [name, resolved] of snapshot.servers) {
			if (resolved.kind === "invalid") {
				lines.push(`- ${name}: invalid — ${resolved.error} (${resolved.sourcePath})`);
				continue;
			}
			const trust =
				resolved.config.source === "global" || isProjectServerTrusted(api.cwd, name, resolved.config.fingerprint)
					? "trusted"
					: "blocked (需确认)";
			const entry = catalog.get(name);
			const freshness = entry ? statusLabel(entry, snapshot, name) : "missing (未发现)";
			const connection = manager.connectionState(name);
			const connectionLabel =
				connection.state === "running"
					? `running [inFlight: ${connection.inFlight ?? 0}]`
					: connection.state === "starting"
						? "starting"
						: connection.state === "draining"
							? "draining"
							: manager.lastError(name)
								? `failed (${manager.lastError(name)})`
								: "stopped";
			const desc = serverDescription(snapshot, name);
			lines.push(
				`- ${name}${desc ? ` (${desc})` : ""}: trust=${trust} · catalog=${freshness} · connection=${connectionLabel} · endpoint=${describeServerForDisplay(resolved.config.definition)} · source=${resolved.config.source} (${resolved.config.sourcePath})`,
			);
		}
		if (snapshot.servers.size === 0) lines.push("  (无已配置 server)");
		return { result: lines.join("\n"), status: "succeeded", details: { mode: "status" } };
	}

	// ── run 入口 ─────────────────────────────────────────────────────────

	return {
		def: {
			type: "function",
			function: {
				name: "mcp",
				description: PROXY_DESCRIPTION,
				parameters: PROXY_SCHEMA,
			},
		},
		run: async (args, signal) => {
			const action = String(args.action);
			if (action === "status") return executeStatus(resolveMcpConfig(api.cwd));
			let snapshot: McpConfigSnapshot;
			try {
				snapshot = resolveMcpConfig(api.cwd);
			} catch (error) {
				return fail("config", `MCP 配置解析失败（能力不可用，绝不静默降级）: ${errorMessage(error)}`);
			}
			switch (action) {
				case "list":
					return executeList(snapshot, args, signal);
				case "search": {
					if (typeof args.query !== "string" || args.query.trim() === "") {
						return fail("search", "search 需要 query 字段（字符串）");
					}
					return executeSearch(snapshot, args.query);
				}
				case "describe": {
					if (typeof args.tool !== "string" || args.tool === "")
						return fail("describe", "describe 需要 tool 字段（serverName.toolName）");
					return executeDescribe(snapshot, args.tool);
				}
				case "call": {
					if (typeof args.tool !== "string" || args.tool === "")
						return fail("call", "call 需要 tool 字段（serverName.toolName）");
					return executeCall(snapshot, args, signal);
				}
				default:
					return fail("config", `未知 action: ${action}。可用值: list, search, describe, call, status`);
			}
		},
	};
}

function truncateAtWord(text: string, target: number): string {
	if (!text || text.length <= target) return text;
	const truncated = text.slice(0, target);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > target * 0.6 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
