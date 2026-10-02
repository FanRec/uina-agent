/**
 * 终端真实尺寸回执的解析与可信性：帧高/行宽完全依赖这个值，
 * 偏大就会把帧写进可视区之外，终端每帧滚动、整屏行映射错位。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessTerminal, isPlausibleSize, parseSizeReport } from "../src/ui/core/terminal.js";

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

describe("acceptSize：回执采纳与输入剥除（经 handleStdinData 驱动）", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("可信开关关闭：只记录不采纳，布局尺寸不被改写", () => {
		const term = new ProcessTerminal();
		let resizes = 0;
		(term as unknown as { onResizeHandler?: () => void }).onResizeHandler = () => resizes++;
		(term as unknown as { handleStdinData: (s: string) => void }).handleStdinData("\x1b[8;30;120t");
		expect(term.columns).not.toBe(120);
		expect(resizes).toBe(0);
	});

	it("可信开关打开：采纳可信尺寸、尺寸变化才通知重绘", () => {
		vi.stubEnv("UINA_TUI_TRUST_SIZE", "1");
		const term = new ProcessTerminal();
		let resizes = 0;
		const inner = term as unknown as { onResizeHandler?: () => void; handleStdinData: (s: string) => void };
		inner.onResizeHandler = () => resizes++;
		inner.handleStdinData("\x1b[8;30;120t");
		expect(term.columns).toBe(120);
		expect(term.rows).toBe(30);
		expect(resizes).toBe(1);
		// 相同尺寸重复回执：不重复通知
		inner.handleStdinData("\x1b[8;30;120t");
		expect(resizes).toBe(1);
		// 畸形尺寸被拒绝
		inner.handleStdinData("\x1b[8;3;9999t");
		expect(term.rows).toBe(30);
		expect(resizes).toBe(1);
	});

	it("回执字节从输入流剥除后，剩余字节照常交给输入处理器", () => {
		const term = new ProcessTerminal();
		const seen: string[] = [];
		const inner = term as unknown as { onInputHandler?: (d: string) => void; handleStdinData: (s: string) => void };
		inner.onInputHandler = (d) => seen.push(d);
		inner.handleStdinData("前缀\x1b[8;26;150t后缀");
		expect(seen).toEqual(["前缀后缀"]);
		// 纯回执：剥除后为空，不产生输入回调
		seen.length = 0;
		inner.handleStdinData("\x1b[8;26;150t");
		expect(seen).toEqual([]);
	});
});
