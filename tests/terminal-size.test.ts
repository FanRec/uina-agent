/**
 * 终端真实尺寸回执的解析与可信性：帧高/行宽完全依赖这个值，
 * 偏大就会把帧写进可视区之外，终端每帧滚动、整屏行映射错位。
 */
import { describe, expect, it } from "vitest";
import { isPlausibleSize, parseSizeReport } from "../src/ui/core/terminal.js";

describe("终端尺寸回执（CSI 18t）", () => {
	it("解析 CSI 8 ; rows ; cols t", () => {
		expect(parseSizeReport("\x1b[8;30;171t")).toEqual({ rows: 30, cols: 171 });
		expect(parseSizeReport("前缀\x1b[8;26;150t后缀")).toEqual({ rows: 26, cols: 150 });
		expect(parseSizeReport("\x1b[8;30;171u")).toBeNull();
		expect(parseSizeReport("普通按键 a")).toBeNull();
	});

	it("拒绝畸形尺寸，避免把坏值写进布局", () => {
		expect(isPlausibleSize({ cols: 171, rows: 30 })).toBe(true);
		expect(isPlausibleSize({ cols: 20, rows: 5 })).toBe(true);
		expect(isPlausibleSize({ cols: 5, rows: 30 })).toBe(false);
		expect(isPlausibleSize({ cols: 171, rows: 0 })).toBe(false);
		expect(isPlausibleSize({ cols: 9999, rows: 30 })).toBe(false);
	});

	it("回执里的尺寸与 Node 自报不同就是可疑点（真机残留片段的候选根因）", () => {
		const node = { cols: 171, rows: 30 };
		const reported = parseSizeReport("\x1b[8;26;150t")!;
		expect(reported.rows === node.rows && reported.cols === node.cols).toBe(false);
	});
});
