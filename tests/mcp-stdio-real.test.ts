/** S5 真实进程验证：Windows 上真实 spawn stdio 子进程，走 StdioClientTransport 全链路。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpCatalog } from "../.uina/extensions/mcp/catalog.js";
import { createMcpProxyTool } from "../.uina/extensions/mcp/proxy-tool.js";
import { McpServerManager } from "../.uina/extensions/mcp/server-manager.js";
import type { ExtensionAPI, Tool } from "../src/extensions/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));

interface RunResult {
	result: string;
	status: string;
	details?: Record<string, unknown>;
}

let home: string;
let projectDir: string;
let manager: McpServerManager;
const errors: string[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "uina-mcp-stdio-"));
	projectDir = mkdtempSync(join(tmpdir(), "uina-mcp-stdio-cwd-"));
	process.env.UINA_HOME = home;
	errors.length = 0;
});

afterEach(async () => {
	await manager.dispose();
	delete process.env.UINA_HOME;
	rmSync(home, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

function makeTool(cwd: string, hasUI = false): Tool {
	const api = {
		cwd,
		reportError: (error: unknown) => {
			errors.push(String(error));
		},
		ui: { hasUI: () => hasUI, confirm: async () => true },
	} as unknown as ExtensionAPI;
	const catalog = new McpCatalog(join(home, "mcp-catalog.json"));
	manager = new McpServerManager({
		catalog,
		version: "0.1.0",
		onError: (message) => errors.push(message),
	});
	const outDir = join(home, "mcp-out");
	mkdirSync(outDir, { recursive: true });
	return createMcpProxyTool({ api, catalog, manager, tmpDir: outDir });
}

describe("真实 stdio 子进程（StdioClientTransport）", () => {
	it("发现 → 调用 → status 全链路", async () => {
		mkdirSync(join(home, ".uina"), { recursive: true });
		writeFileSync(
			join(home, ".uina", "mcp.json"),
			JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixturePath] } } }),
		);
		const tool = makeTool(projectDir);

		const listed = (await tool.run({ action: "list", server: "fixture" })) as unknown as RunResult;
		expect(listed.status).toBe("succeeded");
		expect(listed.result).toContain("fixture.echo");
		expect(listed.result).toContain("untrusted server metadata");

		const called = (await tool.run({
			action: "call",
			tool: "fixture.echo",
			args: { text: "hello" },
		})) as unknown as RunResult;
		expect(called.status).toBe("succeeded");
		expect(called.result).toBe("echo:hello");

		const status = (await tool.run({ action: "status" })) as unknown as RunResult;
		expect(status.result).toContain("connection=running");
		expect(errors).toEqual([]);
	});

	it("不存在的命令 → 启动失败（not_started，请求未发出）", async () => {
		mkdirSync(join(home, ".uina"), { recursive: true });
		writeFileSync(
			join(home, ".uina", "mcp.json"),
			JSON.stringify({
				mcpServers: { broken: { command: "definitely-not-a-real-command-xyz", args: ["--version"] } },
			}),
		);
		const tool = makeTool(projectDir);
		const out = (await tool.run({ action: "list", server: "broken" })) as unknown as RunResult;
		// list 是发现操作而非 dispatch：建连失败按 failed 报告（call 的未发出请求才是 not_started）。
		expect(out.status).toBe("failed");
		expect(out.result).toContain("启动失败");
	});

	it("真实 stdio 项目 server 经过 UI 信任确认后才能启动", async () => {
		mkdirSync(join(projectDir, ".uina"), { recursive: true });
		writeFileSync(
			join(projectDir, ".uina", "mcp.json"),
			JSON.stringify({ mcpServers: { projectFixture: { command: process.execPath, args: [fixturePath] } } }),
		);
		const tool = makeTool(projectDir, true);
		const listed = (await tool.run({ action: "list", server: "projectFixture" })) as unknown as RunResult;
		expect(listed.status).toBe("succeeded");
		expect(listed.result).toContain("projectFixture.echo");
	});

	it("Windows npx 命令映射可真实启动本地 MCP fixture", async () => {
		mkdirSync(join(home, ".uina"), { recursive: true });
		writeFileSync(
			join(home, ".uina", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					npxFixture: { command: "npx", args: ["--no-install", "tsx", fixturePath] },
				},
			}),
		);
		const tool = makeTool(projectDir);
		const listed = (await tool.run({ action: "list", server: "npxFixture" })) as unknown as RunResult;
		expect(listed.status).toBe("succeeded");
		expect(listed.result).toContain("npxFixture.echo");
	});
});
