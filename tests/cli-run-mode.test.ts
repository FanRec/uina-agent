// 批次 4（ui-crap-debt-plan）：runApp/renderStdio/shutdown 拆出的纯决策内核钉住。
// 运行模式判定、启动横幅、退出码、stdio 事件文案逐字节等价。
import { describe, expect, it } from "vitest";
import { composeInitialPrompt, formatStartupBanner, resolveExitCode, resolveRunMode } from "../src/cli/run-mode.js";
import { formatStdioEventLine, formatToolCallLine, formatToolResultBlock } from "../src/cli/stdio-render.js";
import type { HostEvent } from "../src/host/events.js";
import { PresentationController } from "../src/presentation/controller.js";
import type { ToolNode } from "../src/presentation/projection.js";

describe("composeInitialPrompt", () => {
	it("管道输入与 -p 叠加拼接", () => {
		expect(composeInitialPrompt("stdin body", "-p text", undefined)).toBe("-p text\n\n[标准输入内容]:\nstdin body");
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
	it("expression：text 语义事件剥 ANSI 后返回，marker/block 与原始 delta 均 null", () => {
		expect(
			formatStdioEventLine({
				type: "expression",
				streamId: "s",
				event: { kind: "text", streamId: "s", text: "\u001b[2Jhi", rawRange: [0, 4] },
			}),
		).toBe("hi");
		expect(
			formatStdioEventLine({
				type: "expression",
				streamId: "s",
				event: { kind: "marker", streamId: "s", name: "cue", attributes: { id: "nod" }, rawRange: [0, 14] },
			}),
		).toBeNull();
		expect(
			formatStdioEventLine({ type: "output_update", streamId: "s", offset: 0, channel: "content", text: "hi" }),
		).toBeNull();
	});

	it("turn_start：有/无用户回显两种文案", () => {
		expect(formatStdioEventLine({ type: "turn_start", turnNumber: 1, userText: "做任务" })).toBe(
			"\n你 > 做任务\nUina > ",
		);
		expect(formatStdioEventLine({ type: "turn_start", turnNumber: 1, userText: "" })).toBe("\nUina > ");
	});

	it("turn_end / notice / turn_aborted / error / session_rewind 文案", () => {
		expect(formatStdioEventLine({ type: "turn_end", turnNumber: 1 })).toBe("\n");
		expect(formatStdioEventLine({ type: "notice", text: "注意" })).toBe("\n⚠ 注意\n");
		expect(
			formatStdioEventLine({
				type: "provider_retry",
				provider: "vanyo",
				attempt: 3,
				delayMs: 4000,
				status: 503,
				reason: "HTTP 503",
			}),
		).toContain("第 3 次");
		expect(formatStdioEventLine({ type: "provider_recovered", provider: "vanyo", attempt: 3 })).toContain("已恢复连接");
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

describe("formatToolCallLine / formatToolResultBlock（G6 与 TUI 同源）", () => {
	const strip = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");
	it("调用行来自共享 renderToolBlock：状态点 + 工具名 + 运行占位", () => {
		const line = strip(formatToolCallLine({ type: "tool_call", toolName: "exec", args: {}, callId: "c1" }));
		expect(line).toContain("Exec");
		expect(line).toContain("执行中");
	});

	it("结果块：成功 ✓、失败 ✗、图片行、stdout 与耗时——与 TUI 卡片同构", () => {
		const base = { type: "tool_result" as const, toolName: "exec", args: {}, callId: "c1" };
		const ok = strip(
			formatToolResultBlock({ ...base, result: JSON.stringify({ stdout: "out" }), status: "succeeded" }, 100),
		);
		expect(ok).toContain("✓");
		expect(ok).toContain("Exec");
		expect(ok).toContain("完成");
		expect(ok).toContain("out");
		expect(ok).toContain("100ms");

		const fail = strip(formatToolResultBlock({ ...base, result: "boom", status: "failed" }, 0));
		expect(fail).toContain("✗");
		expect(fail).toContain("boom");

		const withImage = formatToolResultBlock(
			{
				...base,
				result: "",
				status: "succeeded",
				images: [{ type: "image", mimeType: "image/png", data: "x", alt: "shot" }],
			},
			0,
		);
		expect(strip(withImage)).toContain("[图片: 1 张]");
	});

	it("耗时由 PresentationController 结算：两端 record.at 差值直达 stdio 输出", () => {
		const controller = new PresentationController();
		controller.ingest({
			at: 1000,
			event: { type: "tool_call", toolName: "exec", args: {}, callId: "c1" },
		});
		const nodes = controller.ingest({
			at: 1250,
			event: { type: "tool_result", toolName: "exec", args: {}, callId: "c1", result: "ok", status: "succeeded" },
		});
		const node = nodes.find((item): item is ToolNode => item.kind === "tool" && item.callId === "c1");
		expect(node?.durationMs).toBe(250);
		const block = strip(
			formatToolResultBlock(
				{ type: "tool_result", toolName: "exec", args: {}, callId: "c1", result: "ok", status: "succeeded" },
				node?.durationMs,
			),
		);
		expect(block).toContain("250ms");
	});
});

// 类型哨兵：确保 HostEvent 形状变化时此处编译报错
const _typeGuard: readonly HostEvent[] = [];
void _typeGuard;
