import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
