// 批次 4（ui-crap-debt-plan）：runApp/renderStdio/shutdown 拆出的纯决策内核钉住。
// 运行模式判定、启动横幅、退出码、stdio 事件文案逐字节等价。
import { describe, expect, it } from "vitest";
import type { HostEvent } from "../src/host/events.js";
import {
	composeInitialPrompt,
	formatStartupBanner,
	resolveExitCode,
	resolveRunMode,
} from "../src/cli/run-mode.js";
import {
	formatStdioEventLine,
	formatToolCallLine,
	formatToolResultBlock,
} from "../src/cli/stdio-render.js";

describe("composeInitialPrompt", () => {
	it("管道输入与 -p 叠加拼接", () => {
		expect(composeInitialPrompt("stdin body", "-p text", undefined)).toBe(
			"-p text\n\n[标准输入内容]:\nstdin body",
		);
	});
	it("仅管道 / 仅 -p / 皆无", () => {
		expect(composeInitialPrompt("stdin", undefined, undefined)).toBe("stdin");
		expect(composeInitialPrompt(undefined, "-p text", undefined)).toBe("-p text");
		expect(composeInitialPrompt(undefined, undefined, undefined)).toBeUndefined();
	});
	it("oneshot 环境变量压倒一切", () => {
		expect(composeInitialPrompt("stdin", "-p text", "oneshot msg")).toBe("oneshot msg");
	});
});

describe("resolveRunMode", () => {
	it("双 TTY + 初始任务 → TUI（非 print）", () => {
		const mode = resolveRunMode({ piped: undefined, prompt: "hi", stdoutTTY: true, stdinTTY: true });
		expect(mode).toEqual({ initialPrompt: "hi", isPrintMode: false, shouldRunTUI: true });
	});

	it("print 标志 / oneshot → print，即使双 TTY", () => {
		expect(resolveRunMode({ print: true, piped: undefined, stdoutTTY: true, stdinTTY: true }).isPrintMode).toBe(true);
		expect(resolveRunMode({ oneshot: "do", piped: undefined, stdoutTTY: true, stdinTTY: true }).isPrintMode).toBe(true);
	});

	it("非 TTY stdout + 有初始任务 → print；无初始任务 → 交互 nonTTY", () => {
		const print = resolveRunMode({ piped: "x", stdoutTTY: undefined, stdinTTY: undefined });
		expect(print).toEqual({ initialPrompt: "x", isPrintMode: true, shouldRunTUI: false });

		const interactive = resolveRunMode({ piped: undefined, stdoutTTY: undefined, stdinTTY: undefined });
		expect(interactive).toEqual({ initialPrompt: undefined, isPrintMode: false, shouldRunTUI: false });
	});
});

describe("formatStartupBanner", () => {
	it("TUI / print 模式无横幅", () => {
		expect(formatStartupBanner("m", 0, true, false)).toBe("");
		expect(formatStartupBanner("m", 5, false, true)).toBe("");
	});

	it("交互 nonTTY：就绪行；有会话恢复时两段以空行连接", () => {
		expect(formatStartupBanner("m1", 0, false, false)).toBe("Uina 就绪（模型：m1）— /quit 退出\n\n");
		expect(formatStartupBanner("m1", 3, false, false)).toBe(
			"Uina 就绪（模型：m1）— /quit 退出\n\n（已恢复 JSONL 会话：3 条消息）\n\n",
		);
	});
});

describe("resolveExitCode", () => {
	it("print/oneshot 且有错 → 1；交互模式有错 → 0；无错 → 0", () => {
		expect(resolveExitCode(true, true, true)).toBe(1);
		expect(resolveExitCode(true, false, true)).toBe(1);
		expect(resolveExitCode(false, true, true)).toBe(1);
		expect(resolveExitCode(false, false, true)).toBe(0);
		expect(resolveExitCode(true, true, false)).toBe(0);
	});
});

describe("formatStdioEventLine", () => {
	it("output_update：content 通道剥 ANSI 后返回，其它通道 null", () => {
		expect(formatStdioEventLine({ type: "output_update", streamId: "s", offset: 0, channel: "content", text: "\u001b[2Jhi" })).toBe("hi");
		expect(
			formatStdioEventLine({ type: "output_update", streamId: "s", offset: 0, channel: "thinking", text: "hi" }),
		).toBeNull();
	});

	it("turn_start：有/无用户回显两种文案", () => {
		expect(formatStdioEventLine({ type: "turn_start", turnNumber: 1, userText: "做任务" })).toBe("\n你 > 做任务\nUina > ");
		expect(formatStdioEventLine({ type: "turn_start", turnNumber: 1, userText: "" })).toBe("\nUina > ");
	});

	it("turn_end / notice / turn_aborted / error / session_rewind 文案", () => {
		expect(formatStdioEventLine({ type: "turn_end", turnNumber: 1 })).toBe("\n");
		expect(formatStdioEventLine({ type: "notice", text: "注意" })).toBe("\n⚠ 注意\n");
		expect(formatStdioEventLine({ type: "turn_aborted", turnNumber: 1 })).toBe("\n[已打断]\n");
		expect(formatStdioEventLine({ type: "error", text: "坏了" })).toBe("[错误] 坏了\n");
		expect(
			formatStdioEventLine({
				type: "session_rewind",
				requestId: "r",
				rewindId: "w",
				fromId: "e1",
				targetId: "e0",
				entries: [],
			}),
		).toBe("\n[会话回溯] e1 → e0；退出路径只读，外部状态未撤销。\n");
	});

	it("未注册类型（tool 事件）返回 null", () => {
		expect(formatStdioEventLine({ type: "tool_call", toolName: "t", args: {}, callId: "c1" })).toBeNull();
	});
});

describe("formatToolCallLine / formatToolResultBlock", () => {
	it("调用行带工具名与参数摘要", () => {
		expect(formatToolCallLine({ type: "tool_call", toolName: "exec", args: {}, callId: "c1" })).toBe("\n  ⏳ [工具] exec");
	});

	it("结果块：成功 ✓、失败 !、图片行、折叠结果与耗时", () => {
		const base = { type: "tool_result" as const, toolName: "exec", args: {}, callId: "c1" };
		expect(formatToolResultBlock({ ...base, result: '{"stdout":"out"}', status: "succeeded" }, 100)).toBe(
			"\n  ✓ exec\n    out\n    （100ms）",
		);
		expect(formatToolResultBlock({ ...base, result: "boom", status: "failed" }, 0)).toBe("\n  ! exec\n    boom");
		const withImage = formatToolResultBlock(
			{ ...base, result: "", status: "succeeded", images: [{ type: "image", mimeType: "image/png", data: "x", alt: "shot" }] },
			0,
		);
		expect(withImage).toContain("[图片: shot]");
	});
});

// 类型哨兵：确保 HostEvent 形状变化时此处编译报错
const _typeGuard: readonly HostEvent[] = [];
void _typeGuard;
