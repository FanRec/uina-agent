// 批次 1（ui-crap-debt-plan）：toolResultLines 拆分后的纯内核全分支钉住。
// parseToolResult（解析/分类）与 renderToolResult（样式渲染）分开验证，
// toolResultLines 保持旧签名的端到端行为由最后一段覆盖。
import { describe, expect, it } from "vitest";
import {
	parseToolResult,
	renderToolResult,
	toolResultLines,
	type ToolResultStyle,
} from "../src/ui/format.js";

const tag = (prefix: string) => (s: string) => `<${prefix}>${s}</${prefix}>`;
const style: ToolResultStyle = {
	ok: tag("ok"),
	err: tag("err"),
	warn: tag("warn"),
	dim: tag("dim"),
};

describe("parseToolResult", () => {
	it("非 JSON 文本走 text 分支", () => {
		expect(parseToolResult("hello\nworld")).toEqual({
			kind: "text",
			text: "hello\nworld",
		});
	});

	it("非对象 JSON（裸数字）也走 text 分支", () => {
		expect(parseToolResult("42")).toEqual({ kind: "text", text: "42" });
	});

	it("解析前剥掉 ANSI 转义", () => {
		const esc = "\u001b[2J\u001b[HCLEAN OUTPUT";
		expect(parseToolResult(esc)).toEqual({ kind: "text", text: "CLEAN OUTPUT" });
	});

	it("obj.cancelled 真值即命中 cancelled（对齐旧语义）", () => {
		expect(parseToolResult('{"cancelled":1}')).toEqual({ kind: "cancelled" });
		expect(parseToolResult('{"status":"cancelled"}')).toEqual({ kind: "cancelled" });
	});

	it("status unknown / not_started 分类", () => {
		expect(parseToolResult('{"status":"unknown"}')).toEqual({ kind: "unknown" });
		expect(parseToolResult('{"status":"not_started"}')).toEqual({ kind: "not_started" });
	});

	it("结构化返回抽取 string 字段；error 非字符串时为空串", () => {
		const view = parseToolResult('{"error":42,"stdout":"out","stderr":"err","x":1}');
		expect(view).toEqual({
			kind: "structured",
			obj: { error: 42, stdout: "out", stderr: "err", x: 1 },
			error: "",
			stderr: "err",
			stdout: "out",
		});
	});

	it("JSON null 走 text 分支", () => {
		expect(parseToolResult("null")).toEqual({ kind: "text", text: "null" });
	});
});

describe("renderToolResult / toolResultLines", () => {
	it("终态行使用 warn 样式与耗时格式（250ms / 1.5s）", () => {
		expect(renderToolResult({ kind: "cancelled" }, 250, style)).toEqual([
			"<warn>⚠ 已取消（250ms）</warn>",
		]);
		expect(renderToolResult({ kind: "unknown" }, 1500, style)).toEqual([
			"<warn>⚠ 结果未知（1.5s）</warn>",
		]);
		expect(renderToolResult({ kind: "not_started" }, 0, style)).toEqual([
			"<warn>⚠ 未执行（0ms）</warn>",
		]);
	});

	it("纯文本缩进展示，dim 样式", () => {
		expect(toolResultLines("a\nb", 100, style)).toEqual([
			"<dim>a</dim>",
			"<dim>b</dim>",
		]);
	});

	it("空文本回退耗时行", () => {
		expect(toolResultLines("   ", 100, style)).toEqual(["<dim>↳ 100ms</dim>"]);
	});

	it("文本超过 6 行截断并加标记；单行超 200 宽截断", () => {
		const many = toolResultLines("1\n2\n3\n4\n5\n6\n7\n8", 100, style);
		expect(many).toHaveLength(7);
		expect(many[6]).toBe("<dim>… 还有 2 行未显示</dim>");

		const long = toolResultLines("x".repeat(250), 100, style);
		// truncateToWidth 截断时在省略号前插入 0 宽的 ANSI 复位（\x1b[0m）
		expect(long[0]).toBe(`<dim>${"x".repeat(199)}\u001b[0m…</dim>`);
	});

	it("error 单独存在：err 样式一行，超 120 字符截断", () => {
		const lines = toolResultLines(JSON.stringify({ error: "E".repeat(200) }), 1000, style);
		expect(lines).toEqual([`<err>✗ ${"E".repeat(120)}（1.0s）</err>`]);
	});

	it("error + stderr + stdout：err 头行、stderr 无标头直接 err 缩进、stdout 加分隔线且整体 err 样式、尾部耗时", () => {
		const lines = toolResultLines(
			JSON.stringify({ error: "boom", stderr: "warn-warn", stdout: "out1\nout2" }),
			500,
			style,
		);
		expect(lines).toEqual([
			"<err>✗ boom（500ms）</err>",
			"<err>warn-warn</err>",
			"<err>── stdout ──</err>",
			"<err>out1</err>",
			"<err>out2</err>",
			"<dim>（500ms）</dim>",
		]);
	});

	it("stderr 无 error：warn 标头 + warn 缩进", () => {
		const lines = toolResultLines(JSON.stringify({ stderr: "s1\ns2" }), 100, style);
		expect(lines).toEqual([
			"<warn>stderr</warn>",
			"<warn>s1</warn>",
			"<warn>s2</warn>",
		]);
	});

	it("stdout 无 error：dim 缩进 + 尾部耗时行", () => {
		const lines = toolResultLines(JSON.stringify({ stdout: "hello" }), 100, style);
		expect(lines).toEqual(["<dim>hello</dim>", "<dim>（100ms）</dim>"]);
	});

	it("无 error/stdout/stderr 正文：前 3 个键值摘要", () => {
		const lines = toolResultLines(
			JSON.stringify({ a: 1, b: "text", c: { deep: true }, d: 4 }),
			100,
			style,
		);
		expect(lines).toEqual(['<dim>↳ a: 1, b: "text", c: {"deep":true}</dim>']);
	});

	it("stderr/stdout 键存在但正文空白：不得走键值摘要，退到耗时行", () => {
		const lines = toolResultLines(JSON.stringify({ stderr: "   " }), 100, style);
		expect(lines).toEqual(["<dim>↳ 100ms</dim>"]);
	});

	it("stdout 键非 string 类型：不进 stdout 段，键值摘要被存在性判断挡住，退到耗时行", () => {
		const lines = toolResultLines(JSON.stringify({ stdout: 7 }), 100, style);
		expect(lines).toEqual(["<dim>↳ 100ms</dim>"]);
	});
});
