/**
 * loader 单测：验证工具自动发现（pi 同款机制）。
 * 用临时目录模拟工具目录：覆盖三种 default 导出形态（Tool / Tool数组 / 注册函数）、
 * 子目录 index.ts 发现、目录不存在、坏模块隔离。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBroker } from "../src/tools/broker.js";
import { loadTools } from "../src/tools/loader.js";

const dirs: string[] = [];
afterEach(() => {
	dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function makeToolDir(): string {
	const d = mkdtempSync(join(tmpdir(), "uina-tools-"));
	dirs.push(d);
	return d;
}

describe("工具自动发现（loader）", () => {
	it("发现顶层 .ts 与子目录 index.ts，三种导出形态都注册", async () => {
		const d = makeToolDir();
		// 形态 1：单个 Tool 对象
		writeFileSync(
			join(d, "a.ts"),
			`import type { Tool } from "../../src/tools/broker.js";\nconst t: Tool = { def: { type: "function", function: { name: "tool_a", description: "a", parameters: { type: "object", properties: {} } } }, run: async () => "a" };\nexport default t;\n`,
		);
		// 形态 2：Tool 数组
		writeFileSync(
			join(d, "b.ts"),
			`import type { Tool } from "../../src/tools/broker.js";\nconst mk = (n: string): Tool => ({ def: { type: "function", function: { name: n, description: n, parameters: { type: "object", properties: {} } } }, run: async () => n });\nexport default [mk("tool_b1"), mk("tool_b2")];\n`,
		);
		// 形态 3：注册函数（pi registerTool 形态）
		mkdirSync(join(d, "c"));
		writeFileSync(
			join(d, "c", "index.ts"),
			`import type { Tool } from "../../../src/tools/broker.js";\nexport default (reg: { register(t: unknown): void }) => { reg.register({ def: { type: "function", function: { name: "tool_c", description: "c", parameters: { type: "object", properties: {} } } }, run: async () => "c" } as any); };\n`,
		);
		// 坏模块：无 default 导出
		writeFileSync(join(d, "bad.ts"), `export const notATool = 42;\n`);

		const reg = new ToolBroker();
		const result = await loadTools(d, reg);
		expect(result.loaded).toBe(3);
		expect(result.failed.length).toBe(1);
		expect(result.failed[0].file).toBe("bad.ts");
		const names = reg.defs().map((t) => t.function.name).sort();
		expect(names).toEqual(["tool_a", "tool_b1", "tool_b2", "tool_c"]);
	});

	it("目录不存在：空结果不报错", async () => {
		const reg = new ToolBroker();
		const result = await loadTools(join(tmpdir(), "uina-no-such-dir-xyz"), reg);
		expect(result.loaded).toBe(0);
		expect(result.failed).toEqual([]);
	});

	it("重名冲突：失败进 failed 不影响其他已加载工具", async () => {
		const d = makeToolDir();
		const body = (name: string) =>
			`import type { Tool } from "../../src/tools/broker.js";\nconst t: Tool = { def: { type: "function", function: { name: "${name}", description: "x", parameters: { type: "object", properties: {} } } }, run: async () => "x" };\nexport default t;\n`;
		writeFileSync(join(d, "x1.ts"), body("dup"));
		writeFileSync(join(d, "x2.ts"), body("dup"));
		writeFileSync(join(d, "y.ts"), body("ok_tool"));
		const reg = new ToolBroker();
		const result = await loadTools(d, reg);
		expect(result.loaded).toBe(2);
		expect(result.failed.length).toBe(1);
		expect(result.failed[0].error).toContain("工具重名");
	});
});