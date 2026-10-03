/** mcp 代理工具：五个 action（list/search/describe/call/status）、三元组精确路由、
 * stale 前置校准断路、五态映射、CallToolResult 保真降级投影与 Output Guard。 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ImageContent, Tool, ToolResultStatus } from "../../../src/extensions/index.js";
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

// Output Guard：数值对齐 Pi 基线；计量窗口 P0 暂按 activation（扩展层尚无 session 生命周期接缝）。
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_BINARY_FILES = 10_000;
const SEARCH_LIMIT = 12;
const INSTRUCTIONS_PREVIEW_LENGTH = 300;
const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

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
	"Actions: list (no server: overview from local catalog; with server: discover/recalibrate that server's tools), " +
	"search (query keyword across catalog), describe (full schema of serverName.toolName), " +
	"call (execute serverName.toolName with args), status (connection/trust/freshness). " +
	"Discover with list(server) before calling; tools are named serverName.toolName. " +
	'call never cold-discovers unknown tools — run list(server="<name>") first.';

export function createMcpProxyTool(deps: McpProxyDeps): Tool {
	const { api, catalog, manager, tmpDir } = deps;
	// 计量窗口计数：P0 按 activation 生命周期（reload/重启即重置）。
	let binaryTotalBytes = 0;
	let binaryFileCount = 0;
	manager.configuredNames = () => {
		try {
			return new Set(resolveMcpConfig(api.cwd).servers.keys());
		} catch {
			return new Set();
		}
	};

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

	async function executeList(args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ProxyToolResult> {
		const snapshot = resolveMcpConfig(api.cwd);
		const serverName = typeof args.server === "string" ? args.server : undefined;
		if (serverName === undefined) {
			const lines: string[] = [];
			for (const [name, resolved] of snapshot.servers) {
				if (resolved.kind === "invalid") {
					lines.push(`- ${name}: invalid (${resolved.error})`);
					continue;
				}
				const entry = catalog.get(name);
				if (!entry) {
					lines.push(`- ${name}: missing (未发现)`);
					continue;
				}
				const status = classifyEntry(entry, snapshot, name);
				if (status.kind === "unconfigured") continue;
				lines.push(`- ${name}: ${statusLabel(entry, snapshot, name)}`);
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
		if (matches.length === 0) {
			return {
				result: `未检索到匹配 "${query}" 的工具。可通过 list 查看已配置的 server 或通过 list(server="<name>") 发现更多工具。`,
				status: "succeeded",
				details: { mode: "search", query, matches: [] },
			};
		}
		const shown = matches.slice(0, SEARCH_LIMIT);
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
		return {
			result: text.trim(),
			status: "succeeded",
			details: { mode: "search", query, matches: shown.map(({ name }) => name), total: matches.length },
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

	async function executeCall(args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ProxyToolResult> {
		const snapshot = resolveMcpConfig(api.cwd);
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
		const projected = projectCallResult(result, toolName, tmpDir, binaryTotalBytes, binaryFileCount);
		binaryTotalBytes = projected.binaryBytesUsed;
		binaryFileCount = projected.binaryFilesUsed;

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
			lines.push(
				`- ${name}: trust=${trust} · catalog=${freshness} · connection=${connectionLabel} · endpoint=${describeServerForDisplay(resolved.config.definition)} · source=${resolved.config.source} (${resolved.config.sourcePath})`,
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
					return executeList(args, signal);
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
					return executeCall(args, signal);
				}
				default:
					return fail("config", `未知 action: ${action}。可用值: list, search, describe, call, status`);
			}
		},
	};
}

// ── CallToolResult 保真降级投影（§8.2）与 Output Guard（D13）──────────────

type McpContentBlock = Record<string, unknown> & { type: string };

interface ProjectionResult {
	text: string;
	images: ImageContent[];
	detailsExtra?: Record<string, unknown>;
	mcpResult?: unknown;
	binaryBytesUsed: number;
	binaryFilesUsed: number;
}

function projectCallResult(
	result: Record<string, unknown>,
	toolName: string,
	tmpDir: string,
	usedBinaryBytes: number,
	usedBinaryFiles: number,
): ProjectionResult {
	let binaryBytesUsed = usedBinaryBytes;
	let binaryFilesUsed = usedBinaryFiles;
	const images: ImageContent[] = [];
	const resourceLinks: Record<string, unknown>[] = [];
	const placeholders: Record<string, unknown>[] = [];
	const textParts: string[] = [];

	const content = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
			continue;
		}
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			if (SUPPORTED_IMAGE_MIMES.includes(block.mimeType)) {
				images.push({
					type: "image",
					mimeType: block.mimeType as ImageContent["mimeType"],
					data: block.data,
					alt: toolName,
				});
			} else {
				textParts.push(`[图片 ${block.mimeType} 未受支持，原始数据见 details]`);
				placeholders.push({ kind: "unsupported_image", mimeType: block.mimeType, base64Bytes: block.data.length });
			}
			continue;
		}
		if (block.type === "audio") {
			const bytes = typeof block.data === "string" ? block.data.length : 0;
			textParts.push(`[音频 ${bytes} base64 字符]`);
			placeholders.push({ kind: "audio", mimeType: block.mimeType, base64Bytes: bytes });
			continue;
		}
		if (block.type === "resource_link" && typeof block.uri === "string") {
			const label = typeof block.name === "string" ? block.name : block.uri;
			const mime = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
			textParts.push(`Resource link: ${label} (${block.uri})${mime}`);
			resourceLinks.push({ ...block });
			continue;
		}
		if (block.type === "resource" && typeof block.resource === "object" && block.resource !== null) {
			const resource = block.resource as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
			if (typeof resource.text === "string") {
				textParts.push(resource.text);
				continue;
			}
			if (typeof resource.blob === "string") {
				const decodedBytes = Math.floor((resource.blob.length * 3) / 4);
				const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
				if (decodedBytes > MAX_BINARY_FILE_BYTES) {
					textParts.push(
						`[二进制资源 ${mime} (${decodedBytes} 字节) 超过单文件 ${MAX_BINARY_FILE_BYTES} 字节上限，未落盘]`,
					);
					placeholders.push({ kind: "binary_oversized", uri: resource.uri, mimeType: mime, bytes: decodedBytes });
					continue;
				}
				if (binaryBytesUsed + decodedBytes > MAX_BINARY_TOTAL_BYTES || binaryFilesUsed + 1 > MAX_BINARY_FILES) {
					textParts.push(
						`[二进制资源累计配额已用尽（${MAX_BINARY_TOTAL_BYTES / (1024 * 1024)} MiB / ${MAX_BINARY_FILES} files），本次资源写入被拒绝。可通过 reload 重置（P1 起随 session 重置）]`,
					);
					placeholders.push({ kind: "binary_quota_exhausted", uri: resource.uri, mimeType: mime, bytes: decodedBytes });
					continue;
				}
				const path = join(tmpDir, `resource-${randomBytes(4).toString("hex")}.bin`);
				writeFileSync(path, Buffer.from(resource.blob, "base64"));
				binaryBytesUsed += decodedBytes;
				binaryFilesUsed += 1;
				textParts.push(`[二进制资源 ${mime} (${decodedBytes} 字节) 已保存到 ${path}]`);
				placeholders.push({ kind: "binary_saved", uri: resource.uri, mimeType: mime, bytes: decodedBytes, path });
				continue;
			}
			textParts.push(`[资源内容块（${String(resource.uri ?? "未知 URI")}）]`);
			placeholders.push({ kind: "resource", ...block });
			continue;
		}
		textParts.push(`[未知内容块类型: ${block.type}]`);
		placeholders.push({ kind: "unknown_block", ...block });
	}

	let text = textParts.length > 0 ? textParts.join("\n") : "(empty result)";

	// 文本 Output Guard：50 KiB / 2000 行截断，完整文本落临时文件。
	const truncated = truncateText(text);
	if (truncated.truncated) {
		const path = join(tmpDir, `output-${randomBytes(4).toString("hex")}.txt`);
		try {
			writeFileSync(path, text, "utf-8");
			text = `${truncated.text}\n\n[Output truncated. Full output saved to ${path}]`;
		} catch (error) {
			text = `${truncated.text}\n\n[Output truncated. Full output could not be saved: ${errorMessage(error)}]`;
		}
	}

	let detailsExtra: Record<string, unknown> | undefined;
	const structuredContent =
		result.structuredContent !== undefined ? boundStructuredContent(result.structuredContent) : undefined;
	if (resourceLinks.length > 0 || placeholders.length > 0 || structuredContent !== undefined) {
		detailsExtra = {
			...(resourceLinks.length > 0 ? { resourceLinks } : {}),
			...(placeholders.length > 0 ? { unrenderedContent: placeholders } : {}),
			...(structuredContent !== undefined ? { structuredContent } : {}),
		};
		// details 有界保护：摘要性 extra 超限则收缩为标记。
		if (Buffer.byteLength(JSON.stringify(detailsExtra)!, "utf-8") > MAX_DETAILS_BYTES) {
			detailsExtra = {
				...(structuredContent !== undefined
					? { structuredContent: boundStructuredContent(result.structuredContent, 4 * 1024) }
					: {}),
				detailsSummaryOmitted: { reason: "details 附加内容超过 16 KiB 上限", blocks: content.length },
			};
		}
	}

	// 原始 MCP result 绑定（boundMcpResult 模式）：16 KiB 内保留，超出换摘要并落盘。
	const rawJson = safeStringify(result);
	const mcpResult = Buffer.byteLength(rawJson, "utf-8") <= MAX_DETAILS_BYTES ? result : boundRawResult(rawJson, tmpDir);

	return {
		text,
		images,
		...(detailsExtra !== undefined ? { detailsExtra } : {}),
		...(mcpResult !== undefined ? { mcpResult } : {}),
		binaryBytesUsed,
		binaryFilesUsed,
	};
}

/** structuredContent 是外部 server 数据：完整保留时受 details 总预算约束，超限只留有界摘要。 */
function boundStructuredContent(value: unknown, budget = MAX_DETAILS_BYTES): unknown {
	const raw = safeStringify(value);
	if (Buffer.byteLength(raw, "utf-8") <= budget) return value;
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	const summary: Record<string, unknown> = {
		omitted: true,
		rawBytes: Buffer.byteLength(raw, "utf-8"),
		type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
	};
	if (record) summary.keys = Object.keys(record).slice(0, 32);
	return Buffer.byteLength(JSON.stringify(summary), "utf-8") <= budget ? summary : { omitted: true };
}

function boundRawResult(rawJson: string, tmpDir: string): Record<string, unknown> {
	const path = join(tmpDir, `mcp-result-${randomBytes(4).toString("hex")}.json`);
	let fullResultPath: string | undefined;
	try {
		writeFileSync(path, rawJson, "utf-8");
		fullResultPath = path;
	} catch {
		// 落盘失败时摘要也必须有界。
	}
	return {
		omitted: true,
		reason: "原始 MCP result 超过 details 16 KiB 上限，替换为本摘要以保护会话上下文。",
		rawResultBytes: Buffer.byteLength(rawJson, "utf-8"),
		...(fullResultPath !== undefined ? { fullResultPath } : {}),
	};
}

function truncateText(text: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES && text.split("\n").length <= MAX_OUTPUT_LINES) {
		return { text, truncated: false };
	}
	const lines = text.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (kept.length >= MAX_OUTPUT_LINES || bytes + lineBytes > MAX_OUTPUT_BYTES) break;
		kept.push(line);
		bytes += lineBytes;
	}
	return { text: kept.join("\n"), truncated: true };
}

function truncateAtWord(text: string, target: number): string {
	if (!text || text.length <= target) return text;
	const truncated = text.slice(0, target);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > target * 0.6 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
