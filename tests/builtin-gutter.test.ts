// 批次 2（ui-crap-debt-plan）：/gutter 命令决策内核 resolveGutterAction 全分支钉住。
// 覆盖三类决策：样式首词、模式首词（含次词）、无参切换，以及消息文案逐字节等价。
import { describe, expect, it } from "vitest";
import { resolveGutterAction } from "../src/extensions/builtin.js";

describe("resolveGutterAction", () => {
	it("样式首词：切到 scrollbar 并设样式，三种样式文案逐字等价", () => {
		expect(resolveGutterAction("slim", "timeline")).toEqual({
			mode: "scrollbar",
			style: "slim",
			message: "已切换滚动条滑块样式为: 纤细优雅 ( ▐)",
		});
		expect(resolveGutterAction("block", "timeline")).toEqual({
			mode: "scrollbar",
			style: "block",
			message: "已切换滚动条滑块样式为: 单列方块 ( █)",
		});
		expect(resolveGutterAction("wide", "scrollbar")).toEqual({
			mode: "scrollbar",
			style: "wide",
			message: "已切换滚动条滑块样式为: 双列宽方块 (██)",
		});
	});

	it("大小写与首尾空白归一", () => {
		const action = resolveGutterAction("  SLIM  ", "timeline");
		expect(action.style).toBe("slim");
		expect(action.mode).toBe("scrollbar");
	});

	it("模式首词：scrollbar 无次词，不设样式", () => {
		expect(resolveGutterAction("scrollbar", "timeline")).toEqual({
			mode: "scrollbar",
			style: undefined,
			message: "已切换右侧导航轨为: 视口比例滚动条 (Scrollbar)",
		});
	});

	it("模式首词：timeline 带次词——消息携带后缀，但不设样式", () => {
		expect(resolveGutterAction("timeline slim", "scrollbar")).toEqual({
			mode: "timeline",
			style: undefined,
			message: "已切换右侧导航轨为: 时间线轮次轨 (Timeline) [slim]",
		});
	});

	it("scrollbar + 合法次词：设样式且消息带后缀", () => {
		expect(resolveGutterAction("scrollbar wide", "timeline")).toEqual({
			mode: "scrollbar",
			style: "wide",
			message: "已切换右侧导航轨为: 视口比例滚动条 (Scrollbar) [wide]",
		});
	});

	it("scrollbar + 非法次词：不设样式，但消息仍携带原始次词后缀（对齐旧语义不校验）", () => {
		expect(resolveGutterAction("scrollbar foo", "timeline")).toEqual({
			mode: "scrollbar",
			style: undefined,
			message: "已切换右侧导航轨为: 视口比例滚动条 (Scrollbar) [foo]",
		});
	});

	it("无参：在当前模式间切换", () => {
		expect(resolveGutterAction(undefined, "scrollbar")).toEqual({
			mode: "timeline",
			style: undefined,
			message: "已切换右侧导航轨为: 时间线轮次轨 (Timeline)",
		});
		expect(resolveGutterAction(undefined, "timeline")).toEqual({
			mode: "scrollbar",
			style: undefined,
			message: "已切换右侧导航轨为: 视口比例滚动条 (Scrollbar)",
		});
	});

	it("空串与未识别首词同样走切换", () => {
		expect(resolveGutterAction("", "scrollbar")?.mode).toBe("timeline");
		expect(resolveGutterAction("xyz", "timeline")?.mode).toBe("scrollbar");
		expect(resolveGutterAction("   ", "timeline")?.mode).toBe("scrollbar");
	});

	it("多空格分隔仍解析出次词", () => {
		expect(resolveGutterAction("scrollbar    block", "timeline")?.style).toBe("block");
	});
});
