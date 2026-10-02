/**
 * CRAP 存量债务 C1：copyToClipboardUnified 与 EffortSlider.formatLines 的覆盖补齐。
 * 两者此前 comp≥8 且 0% 覆盖：剪贴板分支含平台/SSH 判别，formatLines 含盒宽夹取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../src/ui/core/utils.js";
import { EffortSlider } from "../src/ui/features/overlays/effort-slider.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

beforeEach(() => {
	spawn.mockReset();
	spawn.mockImplementation(() => ({ on: () => {}, stdin: { end: () => {} }, unref: () => {} }));
	delete process.env["SSH_CONNECTION"];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("copyToClipboardUnified", () => {
	it("空文本零动作：不写 OSC52 也不起子进程", async () => {
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		copyToClipboardUnified("");
		expect(write).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("非 SSH 的 Windows：OSC52 直写 stdout，并起 clip 子进程携 UTF-8 内容", async () => {
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		copyToClipboardUnified("你好 clip");
		// OSC 52：base64(utf-8) 包在 \x1b]52;c;..\x07
		const b64 = Buffer.from("你好 clip", "utf-8").toString("base64");
		expect(write).toHaveBeenCalledWith(`\x1b]52;c;${b64}\x07`);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawn.mock.calls[0]!;
		expect(cmd).toBe("cmd.exe");
		expect(args).toEqual(["/c", "chcp 65001 >nul && clip"]);
		expect(opts).toMatchObject({ windowsHide: true });
	});

	it("SSH 会话不起本地子进程（OSC52 仍照发，跨宿主直达）", async () => {
		process.env["SSH_CONNECTION"] = "1";
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		copyToClipboardUnified("over ssh");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("子进程错误被吞掉，不影响调用方", async () => {
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		let errorHandler: (() => void) | undefined;
		spawn.mockImplementation(() => ({
			on: (_event: string, cb: () => void) => {
				errorHandler = cb;
			},
			stdin: { end: () => {} },
			unref: () => {},
		}));
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		expect(() => copyToClipboardUnified("oops")).not.toThrow();
		expect(() => errorHandler?.()).not.toThrow();
	});
});

describe("EffortSlider.formatLines", () => {
	it("默认档位下渲染完整盒体：标题、滑条与当前档位描述", () => {
		const slider = new EffortSlider("high");
		const lines = slider.formatLines(100);
		expect(lines.length).toBeGreaterThan(3);
		const plain = lines.join("\n");
		expect(plain).toContain("推理强度");
		expect(plain).toContain("XHigh");
		// focus 落在 high：反显高亮；current 也有 ✓
		expect(plain).toContain("\x1b[7m");
		expect(plain).toContain("✓");
	});

	it("盒体行宽自洽：所有行同宽 = boxWidth+2（前导缩进独立于盒宽），盒宽夹取 [56,76]", () => {
		const slider = new EffortSlider("medium");
		// [终端宽, 期望盒体总宽]：boxWidth=max(56,min(w-6,76))，行宽=boxWidth+2
		const cases: [number, number][] = [
			[40, 58], // 下限夹取 56
			[60, 58], // min(54,76)=54 → 下限夹取 56
			[64, 60], // min(58,76)=58 → 恰好 58+2
			[100, 78], // min(94,76)=76 → 上限夹取
			[200, 78],
		];
		for (const [terminalWidth, expected] of cases) {
			const lines = slider.formatLines(terminalWidth);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(expected);
			}
		}
	});
});
