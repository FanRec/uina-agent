/**
 * 重构回归测试：锁定本轮重构修复的行为契约。
 * 每个用例对应一个曾被手工变异验证过"现有测试杀不死"的缺口。
 */

import { describe, it, expect } from "vitest";
import { computeLineDiff, computeWordDiff } from "../src/ui/components/transcript/diff-view.js";
import { panelWindow, panelTailSlice } from "../src/ui/components/primitives/panel.js";
import { abortableDelay } from "../src/ai/gateway.js";
import { errorMessage } from "../src/core/errors.js";

describe("computeLineDiff：LCS 帽外内容不得静默丢失", () => {
	const BIG = 1200;

	it("旧文件远超帽、新文件为空：所有旧行都必须以 del 出现，计数完整", () => {
		const oldText = Array.from({ length: BIG }, (_, i) => `old-${i}`).join("\n");
		const diff = computeLineDiff(oldText, "");
		expect(diff.items.length).toBe(BIG);
		expect(diff.delCount).toBe(BIG);
		expect(diff.addCount).toBe(0);
		// 帽外尾段的第一行也必须在场（旧实现会把它丢掉）
		expect(diff.items.some((it) => it.type === "del" && it.line === "old-1000")).toBe(true);
		expect(diff.items.some((it) => it.type === "del" && it.line === `old-${BIG - 1}`)).toBe(true);
	});

	it("两侧都超帽：del/add 计数与内容行数精确守恒", () => {
		const oldText = Array.from({ length: BIG }, (_, i) => `a-${i}`).join("\n");
		const newText = Array.from({ length: BIG + 5 }, (_, i) => `b-${i}`).join("\n");
		const diff = computeLineDiff(oldText, newText);
		// 所有内容都出现（同段配对 + 尾段整段补录），不重不漏
		expect(diff.delCount + diff.addCount).toBe(diff.items.filter((it) => it.type !== "same").length);
		expect(diff.delCount).toBe(BIG);
		expect(diff.addCount).toBe(BIG + 5);
	});

	it("小文件行为不变：逐行插删仍然准确", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nx\nc");
		const kinds = diff.items.map((it) => it.type).join(",");
		expect(kinds).toBe("same,del,add,same");
		expect(diff.addCount).toBe(1);
		expect(diff.delCount).toBe(1);
	});
});

describe("computeWordDiff：超 token 帽降级为整行着色", () => {
	it("完全相同的超长行不得被标成变更词", () => {
		const line = Array.from({ length: 300 }, (_, i) => `tok${i}`).join(" ");
		const { oldFormatted, newFormatted } = computeWordDiff(line, line);
		// 整行只应携带红/绿底色，不应出现"变更词高亮"的加粗序列
		expect(oldFormatted).not.toContain("\x1b[1m");
		expect(newFormatted).not.toContain("\x1b[1m");
		// 文本内容完整保留
		expect(oldFormatted).toContain("tok299");
	});

	it("帽内的普通变更仍然词级高亮", () => {
		const { oldFormatted, newFormatted } = computeWordDiff("hello world", "hello there");
		expect(oldFormatted).toContain("\x1b[1m");
		expect(newFormatted).toContain("\x1b[1m");
	});
});

describe("panelWindow：居中滑动窗口契约", () => {
	it("选中项尽量居中且窗口不越界", () => {
		expect(panelWindow(100, 0, 4)).toEqual({ start: 0, end: 4 });
		expect(panelWindow(100, 50, 4)).toEqual({ start: 48, end: 52 });
		expect(panelWindow(100, 99, 4)).toEqual({ start: 96, end: 100 });
	});

	it("列表比窗口短时全量展示", () => {
		expect(panelWindow(2, 0, 4)).toEqual({ start: 0, end: 2 });
		expect(panelWindow(0, 0, 4)).toEqual({ start: 0, end: 0 });
	});
});

describe("panelTailSlice：尾部分片与补空", () => {
	it("无内容时给占位行", () => {
		const out = panelTailSlice([], 3, 0);
		expect(out.length).toBe(1);
		expect(out[0]).toContain("暂无输出日志");
	});

	it("从尾部取，不足补空，offset 上卷", () => {
		const lines = ["1", "2", "3", "4", "5"];
		expect(panelTailSlice(lines, 2, 0)).toEqual(["4", "5"]);
		expect(panelTailSlice(lines, 2, 3)).toEqual(["1", "2"]);
		expect(panelTailSlice(lines, 4, 10)).toEqual(["", "", "", ""]);
	});
});

describe("abortableDelay：正常 resolve 后不得残留 abort 监听器", () => {
	it("多次完成后监听器数量回到 0（重试风暴不累积）", async () => {
		const controller = new AbortController();
		const signal = controller.signal;
		// AbortSignal 无公开 listenerCount：包一层 add/removeEventListener 统计活跃数
		let active = 0;
		const rawAdd = signal.addEventListener.bind(signal);
		const rawRemove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((t: any, l: any, o?: any) => {
			active++;
			return rawAdd(t, l, o);
		}) as typeof signal.addEventListener;
		signal.removeEventListener = ((t: any, l: any, o?: any) => {
			active--;
			return rawRemove(t, l, o);
		}) as typeof signal.removeEventListener;

		for (let i = 0; i < 25; i++) {
			await abortableDelay(1, signal);
		}
		expect(active).toBe(0);
	});

	it("abort 路径仍然即时拒绝", async () => {
		const controller = new AbortController();
		const p = abortableDelay(10_000, controller.signal);
		setTimeout(() => controller.abort(), 5);
		await expect(p).rejects.toThrow();
	});
});

describe("errorMessage", () => {
	it("Error 取 message，非 Error 字符串化", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("raw")).toBe("raw");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});
