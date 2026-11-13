import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalConfigPath } from "../.uina/extensions/mcp/config.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP 外部扩展装载", () => {
	it("通过项目扩展 loader 注册 mcp，并在 teardown 时释放工具", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-extension-loader-"));
		tempRoots.push(cwd);
		const tools = new ToolBroker();
		const runner = new ExtensionRunner({
			cwd,
			extensionPaths: [resolve(process.cwd(), ".uina", "extensions", "mcp")],
			tools,
		});

		await runner.load();
		expect(tools.has("mcp")).toBe(true);
		await runner.dispose();
		expect(tools.has("mcp")).toBe(false);
	});

	it("把全局用途索引注入 system prompt，并在扩展 reload 后更新", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-prompt-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "uina-mcp-prompt-home-"));
		tempRoots.push(cwd, home);
		const previousHome = process.env.UINA_HOME;
		process.env.UINA_HOME = home;
		mkdirSync(join(home, ".uina"), { recursive: true });
		const writeConfig = (purpose: string) =>
			writeFileSync(
				globalConfigPath(),
				JSON.stringify({
					mcpServers: {
						tavily: { url: "https://example.test/mcp?token=fixture-secret", autoStart: false },
						other: { command: "fixture-server", env: { API_KEY: "fixture-secret" } },
						constructor: { command: "fixture-server" },
					},
					uina: { mcpPurposes: { tavily: purpose, missing: "未配置服务" } },
				}),
			);
		writeConfig("网页搜索与内容提取；用于获取最新信息、调查话题及核验事实。");

		const runner = new ExtensionRunner({
			cwd,
			extensionPaths: [resolve(process.cwd(), ".uina", "extensions", "mcp")],
			tools: new ToolBroker(),
		});
		try {
			await runner.load();
			const collect = async () => {
				const result = await runner.runtimeHooks().context.collect({
					modelKey: "m",
					signal: new AbortController().signal,
				});
				return result.contributions.find((c) => c.kind === "capability");
			};
			const read = async () => {
				const capability = await collect();
				expect(capability).toBeDefined();
				return (capability!.value as { text: string }).text;
			};
			const first = await read();
			expect(first).toContain("以下 MCP 服务已配置");
			expect(first).toContain("已配置不等于已在线或已发现工具");
			expect(first).toContain("- tavily：网页搜索与内容提取；用于获取最新信息、调查话题及核验事实。");
			expect(first).toContain("- other：用途未说明，可通过 MCP 工具探索。");
			expect(first).toContain("- constructor：用途未说明，可通过 MCP 工具探索。");
			expect(first).not.toContain("fixture-secret");
			expect(first).not.toContain("example.test");
			expect(first).not.toContain("missing");

			writeConfig("网页搜索与正文提取；用于核验近期事件。");
			await runner.reload();
			const reloaded = await read();
			expect(reloaded).toContain("- tavily：网页搜索与正文提取；用于核验近期事件。");
			expect(reloaded).not.toContain("用于获取最新信息");
		} finally {
			await runner.dispose();
			if (previousHome === undefined) delete process.env.UINA_HOME;
			else process.env.UINA_HOME = previousHome;
		}
	});

	it("没有全局 MCP 配置时不注入用途索引", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-empty-prompt-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "uina-mcp-empty-prompt-home-"));
		tempRoots.push(cwd, home);
		const previousHome = process.env.UINA_HOME;
		process.env.UINA_HOME = home;
		mkdirSync(join(cwd, ".uina"), { recursive: true });
		writeFileSync(
			join(cwd, ".uina", "mcp.json"),
			JSON.stringify({
				mcpServers: { project: { command: "fixture-server" } },
				uina: { mcpPurposes: { project: "项目用途" } },
			}),
		);
		const runner = new ExtensionRunner({
			cwd,
			extensionPaths: [resolve(process.cwd(), ".uina", "extensions", "mcp")],
			tools: new ToolBroker(),
		});
		try {
			await runner.load();
			// 没有全局有效配置时不注册 capability Source：项目级未信任配置不进常驻目录。
			const result = await runner.runtimeHooks().context.collect({
				modelKey: "m",
				signal: new AbortController().signal,
			});
			expect(result.contributions.filter((c) => c.kind === "capability")).toHaveLength(0);
		} finally {
			await runner.dispose();
			if (previousHome === undefined) delete process.env.UINA_HOME;
			else process.env.UINA_HOME = previousHome;
		}
	});
});
