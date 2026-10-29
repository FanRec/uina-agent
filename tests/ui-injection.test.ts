/**
 * W7 注入安全：外部文本在 Fact 入口经 sanitizeExternal 清洗，任何注入向量
 * 都不能改变帧结构（OSC/DCS/CSI/裸 ESC/CR/DEL/bidi/零宽/孤立代理项）。
 */

import { describe, expect, it } from "vitest";
import type { HostEventRecord } from "../src/host/events.js";
import { ingestLive } from "../src/presentation/ingest-live.js";
import { sanitizeExternal } from "../src/presentation/sanitize.js";
import { visibleWidth } from "../src/ui/core/utils.js";

/** 审计 I2 的注入向量全集。 */
const VECTORS: readonly [string, string][] = [
	["OSC 8 超链接", "恶意\x1b]8;;https://evil.example\x07链接\x1b]8;;\x07"],
	["OSC 52 剪贴板", "清空\x1b]52;c;aGVsbG8=\x07剪贴板"],
	["CSI 改标题", "标题\x1b]0;pwned\x07注入"],
	["CSI 定位/擦除", "光标\x1b[2J\x1b[H\x1b[3;5H清屏"],
	["DCS", "设备\x1bP0$r\x1b\\控制"],
	["裸 ESC", "孤立\x1bESC"],
	["CR 覆盖", "前段\r后段覆盖"],
	["DEL 与 C1", "可见\x7f\x9b31m文本"],
	["U+202E 反向", "正常\u202egnitcaM文本"],
	["零宽与连接符", "可见\u200b\u200d隐藏"],
	["半个代理对", "完整🙂然后\uD83D孤立"],
	["全部混合", "\x1b]8;;https://x\x07a\x1b[31mb\u202ec\x7f\r\x1bPq\x1b\\\uD83D结尾"],
];

describe("sanitizeExternal：注入向量", () => {
	it.each(VECTORS)("%s：输出无控制序列且宽度不膨胀", (_name, vector) => {
		const clean = sanitizeExternal(vector);
		// 不含任何 ESC/C0（除 \n）/C1/DEL/bidi/零宽/孤立代理项
		expect(clean).not.toMatch(/\x1b/);
		expect(clean).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
		expect(clean).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\ufeff]/);
		expect([...clean].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(true);
		// 宽度有限：清洗输出不会超过输入的显示宽度（不可信文本不再藏零宽字符）
		expect(visibleWidth(clean)).toBeLessThanOrEqual(visibleWidth(vector) + 4);
	});

	it("保留换行与普通文本", () => {
		expect(sanitizeExternal("第一行\n第二行")).toBe("第一行\n第二行");
		expect(sanitizeExternal("")).toBe("");
	});
});

describe("事实入口：live/replay 均经 sanitizeExternal", () => {
	it("output_update 携带 OSC 注入时，assistant delta Fact 已清洗", () => {
		const record: HostEventRecord = {
			at: 1_700_000_000_000,
			event: {
				type: "output_update" as const,
				streamId: "s1",
				offset: 0,
				channel: "content" as const,
				text: "正文\x1b]52;c;zzz\x07注入\u202e反转",
			},
		};
		const facts = ingestLive(record);
		const delta = facts.find((f) => f.kind === "assistant.delta");
		expect(delta !== undefined && delta.kind === "assistant.delta").toBe(true);
		if (delta?.kind === "assistant.delta") {
			expect(delta.text).not.toMatch(/\x1b|\u202e/);
			expect(delta.text).toContain("正文");
			expect(delta.text).toContain("注入");
		}
	});
});

describe("帧级注入（审计 I2）：注入内容不改变帧结构", () => {
	const MIXED = VECTORS[VECTORS.length - 1]![1].repeat(3);

	it("经 controller 事实入口驱动时，帧仍满足行宽与转义不变量", async () => {
		const { createTestTUI } = await import("./harness/ui/ui-harness.js");
		const { record } = await import("./harness/ui/nodes.js");
		const tui = createTestTUI({ columns: 80, rows: 24 });
		try {
			tui.tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "用户输入" }));
			tui.tui.consume(
				record({
					type: "output_update",
					streamId: "s1",
					offset: 0,
					channel: "content",
					text: `正常内容 ${MIXED} 结尾`,
				}),
			);
			tui.tui.consume(record({ type: "tool_call", callId: "c1", toolName: "exec_command", args: { command: MIXED } }));
			tui.tui.consume(
				record({
					type: "tool_result",
					callId: "c1",
					toolName: "exec_command",
					status: "failed",
					result: MIXED,
					args: { command: MIXED },
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			const frame = tui.terminal.frames.at(-1) ?? "";

			// 帧（去掉渲染器自身的定位/SGR 控制序列后）不含任何残留 ESC 载荷
			const contentOnly = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\[\?[0-9]+[hl]/g, "");
			expect(contentOnly).not.toMatch(/\x1b\]/);
			expect(contentOnly).not.toMatch(/\x1bP/);
			expect(contentOnly).not.toContain("\u202e");
			expect(contentOnly).not.toContain("\u200b");
			expect(contentOnly).not.toMatch(/[\u0000-\u0008\u000b-\u001f\x7f]/);
			// 行宽不变量由 tests/ui-frame-invariants.test.ts 的 INJECTION fixture 覆盖（20–200 列），此处不重复弱化口径。
		} finally {
			tui.dispose();
		}
	});
});
