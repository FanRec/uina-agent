// 批次 5（ui-crap-debt-plan）：覆盖层按键决策与渲染切片的纯内核钉住。
// detailKeyAction / formatDetailTabBar / sliceContentWindow（subagent-dashboard）
// 与 isMouseReport / isToggleKey / confirmChoice（extension-ui-context）。
import { describe, expect, it } from "vitest";
import {
	detailKeyAction,
	flattenLines,
	formatDetailTabBar,
	isInterruptible,
	nextDetailTab,
	sliceContentWindow,
} from "../src/ui/components/overlays/subagent-dashboard.js";
import {
	confirmChoice,
	isMouseReport,
	isToggleKey,
} from "../src/ui/extension-ui-context.js";

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const ENTER = "\r";
const ESCAPE = "\x1b";

describe("detailKeyAction", () => {
	it("导航键 → 对应动作", () => {
		expect(detailKeyAction(ESCAPE, "running")).toBe("close");
		expect(detailKeyAction("\t", "running")).toBe("toggleTab");
		expect(detailKeyAction(ARROW_UP, "running")).toBe("scrollUp");
		expect(detailKeyAction(ARROW_DOWN, "running")).toBe("scrollDown");
	});

	it("I/i 仅在可中断状态生效", () => {
		expect(detailKeyAction("i", "running")).toBe("interrupt");
		expect(detailKeyAction("I", "accepted")).toBe("interrupt");
		expect(detailKeyAction("i", "settled")).toBe("none");
		expect(detailKeyAction("i", "failed")).toBe("none");
	});

	it("未识别输入 → none", () => {
		expect(detailKeyAction("x", "running")).toBe("none");
	});
});

describe("isInterruptible", () => {
	it("running/accepted 可中断，其余不可", () => {
		expect(isInterruptible("running")).toBe(true);
		expect(isInterruptible("accepted")).toBe(true);
		expect(isInterruptible("waiting")).toBe(false);
		expect(isInterruptible("settled")).toBe(false);
		expect(isInterruptible("interrupted")).toBe(false);
		expect(isInterruptible("failed")).toBe(false);
	});

	it("nextDetailTab 来回切换", () => {
		expect(nextDetailTab("logs")).toBe("transcript");
		expect(nextDetailTab("transcript")).toBe("logs");
	});
});

describe("flattenLines", () => {
	it("\\r\\n 归一，逐行加前缀", () => {
		expect(flattenLines("[out] ", "a\r\nb\nc")).toEqual(["[out] a", "[out] b", "[out] c"]);
	});
});

describe("formatDetailTabBar", () => {
	it("激活 Tab 反显（ANSI 7）", () => {
		const bar = formatDetailTabBar("logs", 60);
		expect(bar).toContain("\x1b[7m 输出流 (Logs) \x1b[0m");
		expect(bar).not.toContain("\x1b[7m 对话历史");
		expect(formatDetailTabBar("transcript", 60)).toContain("\x1b[7m 对话历史 (Transcript) \x1b[0m");
	});

	it("按内宽补齐尾随空格（宽度确定，不含激活项反显差）", () => {
		const narrow = formatDetailTabBar("logs", 40);
		const wide = formatDetailTabBar("logs", 80);
		expect(narrow.length).toBeLessThan(wide.length);
		expect(narrow.startsWith("[Tab] ")).toBe(true);
	});
});

describe("sliceContentWindow", () => {
	const lines = ["1", "2", "3", "4", "5"];

	it("从尾部取 maxRows 行", () => {
		expect(sliceContentWindow(lines, 0, 3)).toEqual(["3", "4", "5"]);
		expect(sliceContentWindow(lines, 2, 3)).toEqual(["1", "2", "3"]);
	});

	it("offset 超出长度时返回空切片并补空行", () => {
		expect(sliceContentWindow(lines, 99, 2)).toEqual(["", ""]);
	});

	it("内容不足 maxRows 时补空行到定高", () => {
		expect(sliceContentWindow(["a"], 0, 3)).toEqual(["a", "", ""]);
	});
});

describe("isMouseReport / isToggleKey", () => {
	it("鼠标上报前缀", () => {
		expect(isMouseReport("\x1b[<0;1;1M")).toBe(true);
		expect(isMouseReport("\x1b[M !!")).toBe(true);
		expect(isMouseReport("a")).toBe(false);
	});

	it("←/→/Tab 为切换键", () => {
		expect(isToggleKey(ARROW_LEFT)).toBe(true);
		expect(isToggleKey(ARROW_RIGHT)).toBe(true);
		expect(isToggleKey("\t")).toBe(true);
		expect(isToggleKey("y")).toBe(false);
		expect(isToggleKey(ENTER)).toBe(false);
	});
});

describe("confirmChoice", () => {
	it("y/Y 恒真，n/N 恒假（无视焦点）", () => {
		expect(confirmChoice("y", false)).toBe(true);
		expect(confirmChoice("Y", false)).toBe(true);
		expect(confirmChoice("n", true)).toBe(false);
		expect(confirmChoice("N", true)).toBe(false);
	});

	it("Enter 随当前焦点，Esc 取消为假", () => {
		expect(confirmChoice(ENTER, true)).toBe(true);
		expect(confirmChoice(ENTER, false)).toBe(false);
		expect(confirmChoice(ESCAPE, true)).toBe(false);
	});

	it("其余输入 undefined = 无动作", () => {
		expect(confirmChoice("x", true)).toBeUndefined();
		expect(confirmChoice(ARROW_LEFT, true)).toBeUndefined();
	});
});
