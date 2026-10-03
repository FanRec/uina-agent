import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, Tool } from "../src/extensions/index.js";
import { McpCatalog, type CatalogTool } from "../.uina/extensions/mcp/catalog.js";
import { createMcpProxyTool } from "../.uina/extensions/mcp/proxy-tool.js";
import { definitionFingerprint } from "../.uina/extensions/mcp/config.js";
import { McpServerManager } from "../.uina/extensions/mcp/server-manager.js";
import { FakeMcpServer } from "./mcp-helpers.js";

interface RunResult {
	result: string;
	status: string;
	images?: Array<{ type: string; mimeType: string; data: string }>;
	details?: Record<string, unknown>;
}

let home: string;
let cwd: string;
let outDir: string;
let catalog: McpCatalog;
let manager: McpServerManager;
let fake: FakeMcpServer;
let tool: Tool;
const errors: string[] = [];

const apiState: { hasUI: boolean; confirmResult: boolean; prompts: Array<{ title: string; body: string }> } = {
	hasUI: false,
	confirmResult: true,
	prompts: [],
};

function makeApi(cwdDir: string): ExtensionAPI {
	return {
		cwd: cwdDir,
		reportError: (error: unknown) => {
			errors.push(String(error));
		},
		ui: {
			hasUI: () => apiState.hasUI,
			confirm: async (title: string, body: string) => {
				apiState.prompts.push({ title, body });
				return apiState.confirmResult;
			},
		},
	} as unknown as ExtensionAPI;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "uina-mcp-proxy-home-"));
	cwd = mkdtempSync(join(tmpdir(), "uina-mcp-proxy-cwd-"));
	outDir = join(home, "mcp-out");
	mkdirSync(outDir, { recursive: true });
	process.env.UINA_HOME = home;
	apiState.hasUI = false;
	apiState.confirmResult = true;
	apiState.prompts.length = 0;
	errors.length = 0;
	catalog = new McpCatalog(join(home, "mcp-catalog.json"));
	fake = new FakeMcpServer();
	manager = new McpServerManager({
		catalog,
		version: "0.1.0",
		onError: (message) => errors.push(message),
		createTransport: () => ({ transport: fake.clientTransport, kind: "in-memory" }),
	});
	tool = createMcpProxyTool({ api: makeApi(cwd), catalog, manager, tmpDir: outDir });
});

afterEach(async () => {
	await manager.dispose();
	delete process.env.UINA_HOME;
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

async function run(args: Record<string, unknown>, signal?: AbortSignal): Promise<RunResult> {
	return (await tool.run(args, signal)) as unknown as RunResult;
}

function writeGlobalConfig(config: unknown): void {
	mkdirSync(join(home, ".uina"), { recursive: true });
	writeFileSync(join(home, ".uina", "mcp.json"), JSON.stringify(config));
}

function writeProjectConfig(config: unknown): void {
	mkdirSync(join(cwd, ".uina"), { recursive: true });
	writeFileSync(join(cwd, ".uina", "mcp.json"), JSON.stringify(config));
}

const GLOBAL_FP = definitionFingerprint({ command: "unused" });

function seedCatalog(serverName: string, fingerprint: string, tools: CatalogTool[]): void {
	catalog.commit(serverName, { serverFingerprint: fingerprint, fetchedAt: Date.now(), tools }, new Set([serverName]));
}

function toolNamed(name: string, extra: Partial<CatalogTool> = {}): CatalogTool {
	return {
		name,
		description: `tool ${name} for tests`,
		inputSchema: { type: "object", properties: {} },
		...extra,
	};
}

describe("list 概览与定向发现", () => {
	it("未配置任何 server 时给出指引", async () => {
		const out = await run({ action: "list" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toContain("尚未配置任何 MCP server");
	});

	it("概览如实报告 missing / fresh / invalid", async () => {
		writeGlobalConfig({ mcpServers: { fresh: { command: "unused" }, ghost: { command: "unused" }, bad: {} } });
		seedCatalog("fresh", GLOBAL_FP, [toolNamed("echo")]);
		const out = await run({ action: "list" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toContain("- fresh: fresh (1 tools)");
		expect(out.result).toContain("- ghost: missing (未发现)");
		expect(out.result).toContain("- bad: invalid");
	});

	it("list(server) 全链路：建连 → 拉目录 → 渲染 fullName 与 instructions 预览", async () => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
		fake.tools = [
			{
				name: "echo",
				description: "Echo text back to the caller for verification",
				inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			},
		];
		fake.instructions = "You can echo things.";
		const out = await run({ action: "list", server: "srv" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toContain("srv.echo");
		expect(out.result).toContain("untrusted server metadata");
		expect(out.details?.transport).toBe("in-memory");
		expect(out.details?.tools).toEqual(["srv.echo"]);
		expect(catalog.get("srv")?.serverFingerprint).toBe(GLOBAL_FP);
	});

	it("list 未配置的 server → failed 并列出可用项", async () => {
		writeGlobalConfig({ mcpServers: { known: { command: "unused" } } });
		const out = await run({ action: "list", server: "unknown" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("未在配置中");
		expect(out.result).toContain("known");
	});

	it("list 非法 server → failed 并保留遮蔽错误", async () => {
		writeGlobalConfig({ mcpServers: { bad: {} } });
		const out = await run({ action: "list", server: "bad" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("配置非法");
	});
});

describe("项目信任门（list/server 入口）", () => {
	it("无 UI 且未信任 → not_started（blocked），绝不静默放行", async () => {
		writeProjectConfig({ mcpServers: { psrv: { command: "unused" } } });
		const out = await run({ action: "list", server: "psrv" });
		expect(out.status).toBe("not_started");
		expect(out.result).toContain("未获信任");
		expect(out.result).toContain("无 UI");
	});

	it("有 UI 被拒绝 → not_started，可重新询问", async () => {
		writeProjectConfig({ mcpServers: { psrv: { command: "unused" } } });
		apiState.hasUI = true;
		apiState.confirmResult = false;
		const out = await run({ action: "list", server: "psrv" });
		expect(out.status).toBe("not_started");
		expect(out.result).toContain("被拒绝");
		expect(apiState.prompts).toHaveLength(1);
		expect(apiState.prompts[0]?.body).toContain("可以在本机执行命令");
	});

	it("确认通过 → 信任落盘，后续操作不再询问", async () => {
		writeProjectConfig({ mcpServers: { psrv: { command: "unused" } } });
		apiState.hasUI = true;
		const first = await run({ action: "list", server: "psrv" });
		expect(first.status).toBe("succeeded");
		expect(apiState.prompts).toHaveLength(1);
		const second = await run({ action: "list", server: "psrv" });
		expect(second.status).toBe("succeeded");
		expect(apiState.prompts).toHaveLength(1);
	});
});

describe("search", () => {
	beforeEach(() => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
	});

	it("按名称与描述大小写不敏感匹配", async () => {
		seedCatalog("srv", GLOBAL_FP, [toolNamed("get_weather"), { ...toolNamed("calc"), description: "MATH tool" }]);
		const byName = await run({ action: "search", query: "WEATHER" });
		expect(byName.status).toBe("succeeded");
		expect(byName.result).toContain("srv.get_weather");
		const byDescription = await run({ action: "search", query: "math" });
		expect(byDescription.result).toContain("srv.calc");
	});

	it("0 命中给出发现指引", async () => {
		seedCatalog("srv", GLOBAL_FP, [toolNamed("echo")]);
		const out = await run({ action: "search", query: "zzz-nothing" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toContain("未检索到匹配");
		expect(out.result).toContain("list");
	});

	it("最多 12 条并提示省略数", async () => {
		const tools = Array.from({ length: 15 }, (_, index) => toolNamed(`bulk_${index}`));
		seedCatalog("srv", GLOBAL_FP, tools);
		const out = await run({ action: "search", query: "bulk_" });
		expect(out.status).toBe("succeeded");
		expect(out.details?.total).toBe(15);
		expect(out.details?.matches).toHaveLength(12);
		expect(out.result).toContain("仅显示前 12 条，省略 3 条");
	});

	it("stale 命中如实标注原因", async () => {
		seedCatalog("srv", "fp-outdated", [toolNamed("echo")]);
		const out = await run({ action: "search", query: "echo" });
		expect(out.result).toContain("[stale: 配置已变更]");
	});

	it("缺 query → failed", async () => {
		const out = await run({ action: "search" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("query");
	});
});

describe("describe", () => {
	beforeEach(() => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
	});

	it("完整展示描述、schema 与 annotations", async () => {
		seedCatalog("srv", GLOBAL_FP, [
			{
				...toolNamed("echo"),
				annotations: { readOnlyHint: true },
				outputSchema: { type: "object" },
			},
		]);
		const out = await run({ action: "describe", tool: "srv.echo" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toContain("srv.echo");
		expect(out.result).toContain('"type": "object"');
		expect(out.result).toContain("readOnlyHint");
		expect(out.details?.entryStatus).toBe("fresh");
	});

	it("未知工具 → failed 并给出相近候选", async () => {
		seedCatalog("srv", GLOBAL_FP, [toolNamed("echo")]);
		const out = await run({ action: "describe", tool: "srv.ec" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("未在目录中");
		expect(out.result).toContain("srv.echo");
	});

	it("server 已从配置移除 → 如实报告，绝不指引校准", async () => {
		seedCatalog("ghost", "fp-ghost", [toolNamed("echo")]);
		const out = await run({ action: "describe", tool: "ghost.echo" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("已从配置中移除");
	});

	it("stale 条目提示重新校准", async () => {
		seedCatalog("srv", "fp-outdated", [toolNamed("echo")]);
		const out = await run({ action: "describe", tool: "srv.echo" });
		expect(out.details?.entryStatus).toBe("stale");
		expect(out.result).toContain("[stale: 配置已变更");
		expect(out.result).toContain('list(server="srv")');
	});

	it("缺 tool 字段 → failed", async () => {
		const out = await run({ action: "describe" });
		expect(out.status).toBe("failed");
	});
});

describe("call 投影与 Output Guard", () => {
	beforeEach(() => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
		seedCatalog("srv", GLOBAL_FP, [toolNamed("echo"), toolNamed("multi")]);
	});

	it("文本结果保真投影，details 携带 effects", async () => {
		fake.callResult = { content: [{ type: "text", text: "hello" }] };
		const out = await run({ action: "call", tool: "srv.echo", args: { text: "x" } });
		expect(out.status).toBe("succeeded");
		expect(out.result).toBe("hello");
		const effects = out.details?.effects as Array<{ effectType: string; externalOperationId: string }>;
		expect(effects[0]?.effectType).toBe("mcp.call");
		expect(effects[0]?.externalOperationId).toBe("srv.echo");
		expect(out.details?.server).toBe("srv");
		expect(out.details?.transport).toBe("in-memory");
	});

	it("零入参兜底为 {}（工具无需入参可缺省）", async () => {
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("succeeded");
	});

	it("isError:true → failed", async () => {
		fake.callResult = { content: [{ type: "text", text: "boom" }], isError: true };
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("failed");
		expect(out.result).toBe("boom");
	});

	it("unknown tool 协议错误 → 标记 stale 并刷新 catalog", async () => {
		fake.callError = { code: -32602, message: "Unknown tool: echo" };
		fake.tools = [{ name: "replacement", inputSchema: { type: "object" } }];
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("MCP 调用失败");
		expect(catalog.get("srv")?.tools.map((entry) => entry.name)).toEqual(["replacement"]);
	});

	it("支持 mime 的 image 进 images，不支持的进占位与 details", async () => {
		fake.callResult = {
			content: [
				{ type: "image", data: "aGk=", mimeType: "image/png" },
				{ type: "image", data: "aGk=", mimeType: "image/tiff" },
			],
		};
		const out = await run({ action: "call", tool: "srv.multi" });
		expect(out.images).toHaveLength(1);
		expect(out.images?.[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "aGk=" });
		const unrendered = out.details?.unrenderedContent as Array<{ kind: string; mimeType: string }>;
		expect(unrendered[0]).toMatchObject({ kind: "unsupported_image", mimeType: "image/tiff" });
		expect(out.result).toContain("image/tiff");
	});

	it("audio 只保留占位摘要", async () => {
		fake.callResult = { content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] };
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.result).toContain("[音频 4 base64 字符]");
		const unrendered = out.details?.unrenderedContent as Array<{ kind: string; base64Bytes: number }>;
		expect(unrendered[0]).toMatchObject({ kind: "audio", base64Bytes: 4 });
	});

	it("structuredContent 保留在 details 且受有界预算保护", async () => {
		fake.callResult = {
			content: [{ type: "text", text: "structured" }],
			structuredContent: { answer: 42, source: "fixture" },
		};
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.details?.structuredContent).toEqual({ answer: 42, source: "fixture" });

		fake.callResult = {
			content: [{ type: "text", text: "large structured" }],
			structuredContent: { payload: "z".repeat(20_000) },
		};
		const bounded = await run({ action: "call", tool: "srv.echo" });
		const structured = bounded.details?.structuredContent as { omitted?: boolean; rawBytes?: number };
		expect(structured.omitted).toBe(true);
		expect(structured.rawBytes).toBeGreaterThan(16 * 1024);
	});

	it("resource_link 渲染为链接行并进 details", async () => {
		fake.callResult = {
			content: [{ type: "resource_link", uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain" }],
		};
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.result).toContain("Resource link: a.txt (file:///a.txt) (text/plain)");
		expect(out.details?.resourceLinks).toHaveLength(1);
	});

	it("resource.text 直接进文本；resource.blob 落盘临时文件", async () => {
		const blob = Buffer.from("hello binary").toString("base64");
		fake.callResult = {
			content: [
				{ type: "resource", resource: { uri: "file:///t.txt", text: "plain contents" } },
				{ type: "resource", resource: { uri: "file:///b.bin", blob, mimeType: "application/octet-stream" } },
			],
		};
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.result).toContain("plain contents");
		const unrendered = out.details?.unrenderedContent as Array<{ kind: string; path?: string; bytes?: number }>;
		const saved = unrendered.find((entry) => entry.kind === "binary_saved");
		expect(saved?.path).toBeDefined();
		expect(existsSync(saved!.path!)).toBe(true);
		expect(saved?.bytes).toBe(12);
	});

	it("超限二进制资源拒绝写入（单文件 10 MiB 上限）", async () => {
		fake.callResult = {
			content: [{ type: "resource", resource: { uri: "file:///big.bin", blob: "A".repeat(14_000_000) } }],
		};
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.result).toContain("超过单文件");
		expect(out.result).toContain("未落盘");
	});

	it("文本超 50 KiB 截断并落盘完整输出", async () => {
		fake.callResult = { content: [{ type: "text", text: "x".repeat(60_000) }] };
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.result).toContain("[Output truncated. Full output saved to ");
		const path = out.result.split("[Output truncated. Full output saved to ")[1]?.trimEnd().replace("]", "");
		expect(existsSync(path!)).toBe(true);
		expect(readFileSync(path!, "utf-8")).toHaveLength(60_000);
	});

	it("原始 result 超 16 KiB → details.mcpResult 换摘要并落盘全文", async () => {
		fake.callResult = { content: [{ type: "text", text: "y".repeat(20_000) }] };
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toBe("y".repeat(20_000));
		const mcpResult = out.details?.mcpResult as { omitted: boolean; fullResultPath?: string };
		expect(mcpResult.omitted).toBe(true);
		expect(existsSync(mcpResult.fullResultPath!)).toBe(true);
	});

	it("未发现的工具绝不冷调用 → failed 并指引 list(server)", async () => {
		const out = await run({ action: "call", tool: "srv.nope" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("工具尚未发现或未在目录中");
		expect(out.result).toContain("list");
	});

	it("server 已从配置移除 → 如实报告", async () => {
		seedCatalog("ghost", "fp-ghost", [toolNamed("echo")]);
		const out = await run({ action: "call", tool: "ghost.echo" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("已从配置中移除");
	});
});

describe("call 的 stale 前置校准断路", () => {
	beforeEach(() => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
	});

	it("stale 先重校准再 dispatch（成功路径）", async () => {
		seedCatalog("srv", "fp-outdated", [toolNamed("echo")]);
		fake.tools = [{ name: "echo", inputSchema: { type: "object", properties: {} } }];
		fake.callResult = { content: [{ type: "text", text: "fresh call" }] };
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toBe("fresh call");
		expect(catalog.get("srv")?.serverFingerprint).toBe(GLOBAL_FP);
	});

	it("重校准失败立即断路，绝不带旧缓存 dispatch", async () => {
		seedCatalog("srv", "fp-outdated", [toolNamed("echo")]);
		fake.listError = { code: -32603, message: "list boom" };
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("目录重新校准失败");
	});

	it("重校准后工具消失 → failed（工具已失效）", async () => {
		seedCatalog("srv", "fp-outdated", [toolNamed("echo")]);
		fake.tools = [];
		const out = await run({ action: "call", tool: "srv.echo" });
		expect(out.status).toBe("failed");
		expect(out.result).toContain("工具已失效");
	});
});

describe("取消与配置阻断", () => {
	it("dispatch 前的取消 → cancelled（请求未发出）", async () => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
		seedCatalog("srv", GLOBAL_FP, [toolNamed("echo")]);
		const controller = new AbortController();
		controller.abort();
		const out = await run({ action: "call", tool: "srv.echo" }, controller.signal);
		expect(out.status).toBe("cancelled");
		expect(out.result).toContain("请求未发出");
	});

	it("list 带 pre-abort 信号 → cancelled", async () => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
		const controller = new AbortController();
		controller.abort();
		const out = await run({ action: "list", server: "srv" }, controller.signal);
		expect(out.status).toBe("cancelled");
	});

	it("配置解析失败 → list/search/describe/call 整体阻断为 failed", async () => {
		writeGlobalConfig({ mcpServers: "broken" });
		for (const action of ["list", "search", "describe", "call"]) {
			const out = await run({ action, query: "x", tool: "srv.echo" });
			expect(out.status).toBe("failed");
			expect(out.result).toContain("MCP 配置解析失败");
		}
	});
});

describe("status", () => {
	it("报告 trust / catalog / connection / endpoint / source", async () => {
		writeGlobalConfig({ mcpServers: { srv: { command: "unused" } } });
		const out = await run({ action: "status" });
		expect(out.status).toBe("succeeded");
		expect(out.result).toContain("- srv: trust=trusted");
		expect(out.result).toContain("catalog=missing (未发现)");
		expect(out.result).toContain("connection=stopped");
		expect(out.result).toContain("source=global");
	});

	it("非法 server 行如实报告错误与路径", async () => {
		writeGlobalConfig({ mcpServers: { bad: {} } });
		const out = await run({ action: "status" });
		expect(out.result).toContain("- bad: invalid");
		expect(out.result).toContain("mcp.json");
	});

	it("status 不吞配置解析错误（快照自身即输出）", async () => {
		writeGlobalConfig({ mcpServers: "broken" });
		await expect(run({ action: "status" })).rejects.toThrow();
	});
});
