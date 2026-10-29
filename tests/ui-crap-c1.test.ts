/**
 * CRAP 存量债务 C1：copyToClipboardUnified 与 EffortSlider.formatLines 的覆盖补齐。
 * 两者此前 comp≥8 且 0% 覆盖：剪贴板分支含平台/SSH 判别，formatLines 含盒宽夹取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../src/ui/core/utils.js";
import { EffortSlider } from "../src/ui/features/overlays/effort-slider.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

let spawnHandlers: { spawn?: () => void; error?: (error: Error) => void } = {};

beforeEach(() => {
	spawn.mockReset();
	spawnHandlers = {};
	spawn.mockImplementation(() => ({
		once: (event: string, cb: (arg?: Error) => void) => {
			if (event === "spawn") spawnHandlers.spawn = cb as () => void;
			if (event === "error") spawnHandlers.error = cb as (error: Error) => void;
		},
		stdin: { end: () => {} },
		unref: () => {},
	}));
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
		await expect(copyToClipboardUnified("")).resolves.toEqual({ ok: false, method: "none" });
		expect(write).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("非 SSH 的 Windows：OSC52 直写 stdout，clip 子进程启动后回执成功", async () => {
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const pending = copyToClipboardUnified("你好 clip");
		// OSC 52：base64(utf-8) 包在 \x1b]52;c;..\x07
		const b64 = Buffer.from("你好 clip", "utf-8").toString("base64");
		expect(write).toHaveBeenCalledWith(`\x1b]52;c;${b64}\x07`);
		expect(spawn).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawn.mock.calls[0]!;
		expect(cmd).toBe("cmd.exe");
		expect(args).toEqual(["/c", "chcp 65001 >nul && clip"]);
		expect(opts).toMatchObject({ windowsHide: true });
		spawnHandlers.spawn?.();
		await expect(pending).resolves.toEqual({ ok: true, method: "clip" });
	});

	it("SSH 会话不起本地子进程（OSC52 仍照发，跨宿主直达）", async () => {
		process.env["SSH_CONNECTION"] = "1";
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await expect(copyToClipboardUnified("over ssh")).resolves.toEqual({ ok: true, method: "osc52" });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("子进程错误作为失败回执返回，不再静默吞掉", async () => {
		const { copyToClipboardUnified } = await import("../src/ui/core/utils.js");
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const pending = copyToClipboardUnified("oops");
		spawnHandlers.error?.(new Error("clip missing"));
		await expect(pending).resolves.toEqual({ ok: false, method: "clip", reason: "clip missing" });
	});
});

describe("EffortSlider.formatLines", () => {
	it("默认档位下渲染完整盒体：标题、滑条与当前档位描述", () => {
		const slider = new EffortSlider("high", ["off", "medium", "high", "max"]);
		const lines = slider.formatLines(100);
		expect(lines.length).toBeGreaterThan(3);
		const plain = lines.join("\n");
		expect(plain).toContain("思考强度");
		expect(plain).toContain("Max");
		// focus 落在 high：反显高亮；current 也有 ✓
		expect(plain).toContain("\x1b[7m");
		expect(plain).toContain("✓");
	});

	it("窄屏面板填满可用宽度，宽屏面板夹取到最大宽度", () => {
		const slider = new EffortSlider("medium", ["off", "medium", "high", "max"]);
		// 紧凑布局与宽屏布局共享一套行宽合同：窄屏填满，高于最大宽度后居中收窄。
		const cases: [number, number][] = [
			[40, 40],
			[50, 50],
			[60, 60],
			[64, 64],
			[100, 78],
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
