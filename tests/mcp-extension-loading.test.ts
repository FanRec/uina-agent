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

	it("MCP 配置不再常驻注入 Context Source；用途经 mcp list 按次读取（description 优先）", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-prompt-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "uina-mcp-prompt-home-"));
		tempRoots.push(cwd, home);
		const previousHome = process.env.UINA_HOME;
		process.env.UINA_HOME = home;
		mkdirSync(join(home, ".uina"), { recursive: true });
		const writeConfig = (description?: string) =>
			writeFileSync(
				globalConfigPath(),
				JSON.stringify({
					mcpServers: {
						tavily: {
							url: "https://example.test/mcp?token=fixture-secret",
							autoStart: false,
							...(description ? { description } : {}),
						},
						other: { command: "fixture-server", env: { API_KEY: "fixture-secret" } },
						constructor: { command: "fixture-server" },
					},
					// 过渡期兼容：无 description 的 Server 回退读取旧用途映射。
					...(description ? {} : { uina: { mcpPurposes: { tavily: "旧用途映射", missing: "未配置服务" } } }),
				}),
			);
		const tools = new ToolBroker();
		const runner = new ExtensionRunner({
			cwd,
			extensionPaths: [resolve(process.cwd(), ".uina", "extensions", "mcp")],
			tools,
		});
		const listViaProxy = async (): Promise<string> => {
			const prepared = tools.prepare("mcp", { action: "list" });
			const outcome = await tools.executePipeline({
				callId: "c1",
				invocationId: "i1",
				name: "mcp",
				args: { action: "list" },
				prepared,
			});
			expect(outcome.status).toBe("succeeded");
			return outcome.result;
		};
		try {
			await runner.load();
			// 发现不常驻注入（S6）：collect 不产生任何 MCP 贡献；Server 信息按次读取配置。
			const collection = await runner.runtimeHooks().context.collect({
				modelKey: "m",
				signal: new AbortController().signal,
			});
			expect(collection.contributions).toHaveLength(0);

			writeConfig("网页搜索与内容提取；用于获取最新信息、调查话题及核验事实。");
			const first = await listViaProxy();
			expect(first).toContain("tavily");
			expect(first).toContain("网页搜索与内容提取；用于获取最新信息、调查话题及核验事实。");
			// 无 description 的 Server 只列名称；过渡期 purposes 不适用于已有 description 的 Server。
			expect(first).toContain("other");
			expect(first).not.toContain("fixture-secret");
			expect(first).not.toContain("example.test");

			// MCP 配置按次解析：改描述即时生效于下一次 list，不要求 runtime_reload(resources)。
			writeConfig("网页搜索与正文提取；用于核验近期事件。");
			const reloaded = await listViaProxy();
			expect(reloaded).toContain("网页搜索与正文提取；用于核验近期事件。");
			expect(reloaded).not.toContain("用于获取最新信息");

			// 过渡期回退：Server 无 description 时读取旧 mcpPurposes（仅全局作用域）；
			// purposes 里未配置的 Server 不产生 Server 候选。
			writeConfig(undefined);
			const fallback = await listViaProxy();
			expect(fallback).toContain("— 旧用途映射");
		} finally {
			await runner.dispose();
			if (previousHome === undefined) delete process.env.UINA_HOME;
			else process.env.UINA_HOME = previousHome;
		}
	});

	it("没有全局 MCP 配置时不注入任何 Source；项目级未信任配置只作为候选名出现在 list 中", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-empty-prompt-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "uina-mcp-empty-prompt-home-"));
		tempRoots.push(cwd, home);
		const previousHome = process.env.UINA_HOME;
		process.env.UINA_HOME = home;
		mkdirSync(join(cwd, ".uina"), { recursive: true });
		writeFileSync(
			join(cwd, ".uina", "mcp.json"),
			JSON.stringify({
				mcpServers: { project: { command: "fixture-server", description: "项目用途" } },
			}),
		);
		const tools = new ToolBroker();
		const runner = new ExtensionRunner({
			cwd,
			extensionPaths: [resolve(process.cwd(), ".uina", "extensions", "mcp")],
			tools,
		});
		try {
			await runner.load();
			const result = await runner.runtimeHooks().context.collect({
				modelKey: "m",
				signal: new AbortController().signal,
			});
			expect(result.contributions).toHaveLength(0);
			// 项目级未信任配置在显式 list 中可显示候选名与用途（非敏感发现元数据），
			// 但被列出不代表获得执行许可。
			const prepared = tools.prepare("mcp", { action: "list" });
			const outcome = await tools.executePipeline({
				callId: "c2",
				invocationId: "i2",
				name: "mcp",
				args: { action: "list" },
				prepared,
			});
			expect(outcome.status).toBe("succeeded");
			expect(outcome.result).toContain("project");
			expect(outcome.result).toContain("项目用途");
		} finally {
			await runner.dispose();
			if (previousHome === undefined) delete process.env.UINA_HOME;
			else process.env.UINA_HOME = previousHome;
		}
	});
});
