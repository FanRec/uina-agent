import { describe, expect, it, vi } from "vitest";
import { calculateContextSegments } from "../src/agent/context.js";
import { combineQueuedDraft } from "../src/cli/draft.js";
import { ExtensionRegistry } from "../src/extensions/renderer-registry.js";
import { ingestReplay } from "../src/presentation/ingest-replay.js";
import { PresentationProjection, type ThinkingNode } from "../src/presentation/projection.js";
import { TOOL_STATUS_SPEC } from "../src/presentation/tool-status.js";
import { type TrajectoryNode, TrajectoryProjection } from "../src/presentation/trajectory.js";
import type { SessionEntry, SessionEventRecord } from "../src/session/types.js";
import { InputLine, segmentWithMarkers, snapCursorToMarkerBoundary } from "../src/ui/components/editor/index.js";
import { getStartupBanner } from "../src/ui/components/primitives/banner.js";
import {
	alignSplitDiff,
	applyCardBackground,
	BLACK_CIRCLE,
	CustomMessageComponent,
	computeWordDiff,
	displayName,
	extractSummaryArgs,
	foldTerminalCommand,
	formatDiffCardLines,
	formatDuration,
	formatErrorCardLines,
	formatSplitDiffCardLines,
	formatToolCardLines,
	GUTTER_FIRST,
	GUTTER_REST,
	getToolCategory,
	getToolCategoryColor,
	TranscriptContainer,
	type TurnItem,
} from "../src/ui/components/transcript/index.js";
import { revealStep, SmoothRevealController, safeSliceEnd } from "../src/ui/components/transcript/smooth-reveal.js";
import { formatFullMarkdown, StreamMarkdownFormatter } from "../src/ui/components/transcript/stream-markdown.js";
import {
	allocateBarColumns,
	ContextBarComponent,
	renderSegmentedBar,
} from "../src/ui/components/widgets/context-bar.js";
import {
	ActivityLineComponent,
	formatActivityHeader,
	formatTpsGauge,
	formatTpsSparkline,
	PendingQueueComponent,
} from "../src/ui/components/widgets/index.js";
import { ScrollbarGutterComponent } from "../src/ui/components/widgets/scrollbar-gutter.js";
import { TimelineRailComponent } from "../src/ui/components/widgets/timeline-rail.js";
import { Container } from "../src/ui/core/container.js";
import { FocusManager } from "../src/ui/core/focus.js";
import { Key, matchesKey } from "../src/ui/core/keys.js";
import { OverlayStack } from "../src/ui/core/overlay.js";
import { C, countGraphemes, stripAnsi, visibleWidth } from "../src/ui/core/utils.js";
import { createExtensionUIContext } from "../src/ui/extension-ui-context.js";
import { EffortSlider, HelpMenu, ModelPicker, TrajectoryScene } from "../src/ui/features/overlays/index.js";
import { installUIFeatures } from "../src/ui/features.js";
import { fitLine, wrapLine } from "../src/ui/layout/fit.js";
import { createInteractiveUI, InteractiveTUI } from "../src/ui/tui.js";
import { UIHost } from "../src/ui/ui-host.js";
import {
	createSilentTerminal,
	createTestTUI,
	dispatchUIHostInput,
	getTestTrajectoryProjection,
	getTestUIHost,
	isHeartbeatActive,
	mockModelGroups,
	record,
	renderWidget,
	toolDoneNode,
	toolStartNode,
	turnNode,
} from "./harness/index.js";

describe("UI Core: Utils", () => {
	it("正确计算包含中文与 ANSI 样式的可见字符宽度", () => {
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("你好世界")).toBe(8);
		expect(visibleWidth("\x1b[31m你好\x1b[0m world")).toBe(10);
	});

	it("按字形簇计数，不把 emoji ZWJ 组合与代理对算成多个字符", () => {
		expect(countGraphemes("你好")).toBe(2);
		expect(countGraphemes("👨‍👩‍👧‍👦")).toBe(1);
		expect(countGraphemes("a👍🏽b")).toBe(3);
	});

	it("ANSI 安全截断：不截断转义码且正确补齐闭合", () => {
		const text = "\x1b[36m这是一个很长的句子需要截断\x1b[0m";
		const truncated = fitLine(text, 10);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(10);
		expect(truncated).toContain("\x1b[0m");
	});

	it("带 ANSI 样式的文本折行", () => {
		const text = "第一行测试很长需要折行的一句话\n第二行短";
		const lines = wrapLine(text, 12);
		expect(lines.length).toBeGreaterThan(1);
	});
});

describe("UI Core: Container & Focus & Overlay & Slots", () => {
	it("Container 组合模式正确聚合子组件的 render 输出与 invalidate", () => {
		const container = new Container();
		let invalidatedA = false;
		let invalidatedB = false;

		const compA = {
			render: () => ["lineA1", "lineA2"],
			invalidate: () => {
				invalidatedA = true;
			},
		};
		const compB = {
			render: () => ["lineB1"],
			invalidate: () => {
				invalidatedB = true;
			},
		};

		container.addChild(compA);
		container.addChild(compB);

		const rendered = container.render(80);
		expect(rendered).toEqual(["lineA1", "lineA2", "lineB1"]);

		container.invalidate();
		expect(invalidatedA).toBe(true);
		expect(invalidatedB).toBe(true);

		container.removeChild(compA);
		expect(container.render(80)).toEqual(["lineB1"]);
	});

	it("FocusManager 在焦点转移时更新组件焦点状态", () => {
		const focusManager = new FocusManager();
		const comp1 = { focused: false, render: () => [] };
		const comp2 = { focused: false, render: () => [] };

		focusManager.setFocus(comp1);
		expect(comp1.focused).toBe(true);

		focusManager.setFocus(comp2);
		expect(comp1.focused).toBe(false);
		expect(comp2.focused).toBe(true);
	});

	it("OverlayStack 覆盖层管理：堆叠、焦点返还与 renderAbove", () => {
		const focusManager = new FocusManager();
		const renderSpy = vi.fn();
		const stack = new OverlayStack(focusManager, renderSpy);

		const baseComp = { focused: false, render: () => ["base"] };
		focusManager.setFocus(baseComp);

		const overlayComp = {
			focused: false,
			render: () => ["overlay-line-1", "overlay-line-2"],
		};

		const handle = stack.showOverlay(overlayComp);
		expect(stack.hasVisible).toBe(true);
		expect(overlayComp.focused).toBe(true);
		expect(baseComp.focused).toBe(false);

		const above = stack.renderAbove(80, 10);
		// Geometry is applied to every overlay: content is preserved and each row
		// is padded/clamped to the terminal width.
		expect(above).toHaveLength(2);
		expect(above[0]!.trimEnd()).toBe("overlay-line-1");
		expect(above[1]!.trimEnd()).toBe("overlay-line-2");
		expect(above.every((line) => visibleWidth(line) <= 80)).toBe(true);

		handle.hide();
		expect(stack.hasVisible).toBe(false);
		expect(baseComp.focused).toBe(true);
	});
});

describe("UI Extensions: ExtensionRegistry & ExtensionUIContext", () => {
	it("LocalCommand keybinding 仅在 capturing overlay 之后通用分发", () => {
		const registry = new ExtensionRegistry();
		let commandCalls = 0;
		let overlayInput = "";
		registry.registerCommand({
			name: "keybinding-probe",
			description: "test",
			keybinding: "alt+j",
			handler: () => {
				commandCalls++;
			},
		} as any);
		const harness = createTestTUI({ registry });
		try {
			harness.host.showOverlay({
				render: () => [],
				handleInput: (data) => {
					overlayInput = data;
				},
			});
			dispatchUIHostInput(harness.host, "\x1bj");
			expect(overlayInput).toBe("\x1bj");
			expect(commandCalls).toBe(0);
			harness.host.overlayStack.clear();
			dispatchUIHostInput(harness.host, "\x1bj");
			expect(commandCalls).toBe(1);
		} finally {
			harness.dispose();
		}
	});

	it("CustomMessageComponent 支持动态注册的 MessageRenderer 与默认兜底", () => {
		const registry = new ExtensionRegistry();

		// 未注册渲染器时，采用默认卡片
		const compDefault = new CustomMessageComponent({
			customType: "test:demo",
			content: "hello custom message",
		});
		const renderedDefault = compDefault.render(80);
		expect(renderedDefault.join("\n")).toContain("[test:demo]");
		expect(renderedDefault.join("\n")).toContain("hello custom message");

		// 注册专用渲染器
		registry.registerMessageRenderer("test:custom", (msg) => ({
			render: () => [`>>> VIP [${msg.customType}]: ${msg.content}`],
		}));

		const compCustom = new CustomMessageComponent(
			{ customType: "test:custom", content: "special content" },
			registry.getMessageRenderer("test:custom"),
		);
		const renderedCustom = compCustom.render(80);
		expect(renderedCustom).toEqual([">>> VIP [test:custom]: special content"]);
	});

	it("renders a dedicated rewind card with reason, effects and the read-only exit path", () => {
		const comp = new CustomMessageComponent({
			customType: "session-rewind",
			content: "[会话回溯 r1] 从 aaaaaaa 回溯至 bbbbbbb",
			details: {
				record: { fromId: "aaaaaaa1", targetId: "bbbbbbb2", source: "model", reason: "前期假设错误" },
				effects: {
					modifiedFiles: ["src/config.ts"],
					executedCommands: ["pnpm build"],
					dispatchedTasks: [{ id: "job-102", type: "job" }],
				},
			},
		});
		const rendered = comp.render(80).join("\n");
		expect(rendered).toContain("会话回溯");
		expect(rendered).toContain("前期假设错误");
		expect(rendered).toContain("src/config.ts");
		expect(rendered).toContain("pnpm build");
		expect(rendered).toContain("job-102");
		expect(rendered).toContain("/history");
	});

	it("从单一 session entry 流按原顺序恢复消息与扩展内容", () => {
		const transcript = new TranscriptContainer();
		transcript.loadSession(
			[
				{ kind: "message", message: { role: "user", content: "ORDER_A" } },
				{ kind: "custom_message", customType: "probe", content: "ORDER_C" },
				{ kind: "message", message: { role: "assistant", content: "ORDER_B" } },
				{ kind: "custom_message", customType: "hidden", content: "MUST_NOT_RENDER", display: false },
			],
			[],
		);

		const rendered = stripAnsi(transcript.render(80).join("\n"));
		const positions = ["ORDER_A", "ORDER_C", "ORDER_B"].map((text) => rendered.indexOf(text));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(rendered).not.toContain("MUST_NOT_RENDER");
	});

	it("恢复正文/思考由投影节点供文（sourceSeq 配对），而非 entry 直读", () => {
		const T1 = "2026-10-29T10:00:02.000Z";
		const entries: SessionEntry[] = [
			{ kind: "message", id: "u1", seq: 1, timestamp: T1, message: { role: "user", content: "问题" } },
			{
				kind: "message",
				id: "a1",
				seq: 2,
				timestamp: T1,
				message: { role: "assistant", thinking: "推理", content: "回答正文", status: "complete" },
			},
		];
		const projection = new PresentationProjection();
		projection.applyAll(ingestReplay({ entries }));
		// 证明 item 文本来自节点而非 entry：改写节点文本，渲染应跟随节点。
		for (const node of projection.list()) {
			if (node.kind === "assistant") node.text = "NODE_SOURCE_PROSE";
			if (node.kind === "thinking") node.text = "NODE_SOURCE_THINKING";
		}
		const transcript = new TranscriptContainer();
		transcript.loadSession(entries, projection.list());
		const rendered = stripAnsi(transcript.render(80).join("\n"));
		expect(rendered).toContain("NODE_SOURCE_PROSE");
		expect(rendered).toContain("NODE_SOURCE_THINKING");
		expect(rendered).not.toContain("回答正文");
	});

	it("恢复转录只消费展示节点：工具状态与耗时取自 journal 投影，容器不再自行解析", () => {
		const T1 = "2026-10-29T10:00:02.000Z";
		const T2 = "2026-10-29T10:00:05.000Z";
		const entries: SessionEntry[] = [
			{ kind: "message", id: "u1", seq: 1, timestamp: T1, message: { role: "user", content: "检查目录" } },
			{
				kind: "message",
				id: "a1",
				seq: 2,
				timestamp: T1,
				message: {
					role: "assistant",
					content: "执行",
					tool_calls: [{ id: "c1", name: "exec", args: { command: "dir" } }],
				},
			},
			// 消息的 status 只是模型可见投影；journal 的终态才是权威。
			{
				kind: "message",
				id: "r1",
				seq: 3,
				timestamp: T2,
				message: { role: "tool", tool_call_id: "c1", name: "exec", content: "ok", status: "succeeded" },
			},
		];
		const auxiliary: SessionEventRecord[] = [
			{
				kind: "event",
				id: "e1",
				seq: 2,
				timestamp: T1,
				event: "tool_started",
				data: { callId: "c1", name: "exec", args: { command: "dir" } },
			},
			{
				kind: "event",
				id: "e2",
				seq: 3,
				timestamp: T2,
				event: "tool_finished",
				data: { callId: "c1", name: "exec", status: "failed" },
			},
		];

		const projection = new PresentationProjection();
		projection.applyAll(ingestReplay({ entries, auxiliary }));

		const transcript = new TranscriptContainer();
		transcript.loadSession(entries, projection.list());
		const tool = transcript
			.getHistory()[0]!
			.items.find((item): item is Extract<TurnItem, { kind: "tool" }> => item.kind === "tool");
		if (!tool) throw new Error("恢复转录缺少工具卡");
		expect(tool.status).toBe("failed");
		expect(tool.elapsedMs).toBe(Date.parse(T2) - Date.parse(T1));
		expect(tool.startedAt).toBe(Date.parse(T1));
	});

	it("live custom_message：轮内到达归入当前轮保时间序，轮外到达为独立卡片，display:false 不渲染", () => {
		const transcript = new TranscriptContainer();

		// 轮内：startTurn → custom_message → 助手增量，三者按时间序渲染。
		// 不能先 commit 当前轮再插卡片：流式/工具追加依赖现存 currentTurn。
		transcript.startTurn(1, "开始任务");
		transcript.addCustomMessage({ customType: "embodiment", content: "LIVE_IN_TURN" });
		transcript.appendToken("任务进行中");
		const liveInTurn = stripAnsi(transcript.render(80).join("\n"));
		const inTurnPositions = ["开始任务", "LIVE_IN_TURN", "任务进行中"].map((text) => liveInTurn.indexOf(text));
		expect(inTurnPositions.every((position) => position >= 0)).toBe(true);
		expect(inTurnPositions).toEqual([...inTurnPositions].sort((a, b) => a - b));
		transcript.finishTurn();

		// 轮外：无当前轮时作为轮间独立卡片（与回放路径同形状）。
		transcript.addCustomMessage({ customType: "embodiment", content: "LIVE_IDLE" });
		expect(stripAnsi(transcript.render(80).join("\n"))).toContain("LIVE_IDLE");

		// display:false 按纪律不渲染。
		transcript.addCustomMessage({ customType: "hidden", content: "MUST_NOT_RENDER_LIVE", display: false });
		expect(stripAnsi(transcript.render(80).join("\n"))).not.toContain("MUST_NOT_RENDER_LIVE");
	});

	it("createExtensionUIContext 调度宿主接口", () => {
		const hostPort = {
			notify: vi.fn(),
			setWorking: vi.fn(),
			setHeader: vi.fn(),
			setFooter: vi.fn(),
			showOverlay: vi.fn(),
			pasteToEditor: vi.fn(),
			setEditorText: vi.fn(),
			getEditorText: vi.fn(() => "current-text"),
			requestRender: vi.fn(),
		};

		const ctx = createExtensionUIContext(hostPort);

		ctx.notify("test message", "warning");
		expect(hostPort.notify).toHaveBeenCalledWith("test message", "warning");

		ctx.setWorking("search", "searching...");
		expect(hostPort.setWorking).toHaveBeenCalledWith("search", "searching...");

		expect(ctx.terminal!.getEditorText()).toBe("current-text");
	});
});

describe("UI Adapters: Trajectory", () => {
	it("TrajectoryProjection 只消费展示节点：稳定 ID 更新、聚合与热点看板无假数据", () => {
		const proj = new TrajectoryProjection();
		expect(proj.list()).toEqual([]);

		const turn = turnNode(1, "请排查死锁");
		proj.apply(turn);
		expect(proj.list().map((node) => node.kind)).toEqual(["turn_start"]);

		const thinking: ThinkingNode = {
			kind: "thinking",
			id: "turn:1:thinking:1",
			turn: 1,
			text: "推演完成：锁顺序颠倒",
			status: "completed",
			startedAt: 10,
			endedAt: 20,
			durationMs: 10,
		};
		proj.apply(thinking);
		proj.apply(toolDoneNode("run_command", "exit code 0", 120, "succeeded", "call-1", { CommandLine: "pnpm test" }));
		expect(proj.list().map((node) => node.kind)).toEqual(["turn_start", "thinking", "tool_call"]);

		const hotspots = proj.aggregate("duration");
		expect(hotspots.some((row) => row.name === "run_command")).toBe(true);
		expect(hotspots.every((row) => !row.name.includes("Turn #"))).toBe(true);

		const scene = new TrajectoryScene(proj);
		scene.handleInput("\t");
		const lines = stripAnsi(scene.formatLines(80).join("\n"));
		expect(lines).toContain("全屏事件时序与审计轨迹");
		expect(lines).toContain("run_command");

		// 回合终态补出 model_stream：时间来自回合节点，不新增时钟。
		proj.apply({ ...turn, status: "completed", endedAt: 200, usage: { callId: "call-1", totalTokens: 500 } });
		expect(proj.list().find((node) => node.kind === "model_stream")).toMatchObject({
			startedAt: turn.startedAt,
			endedAt: 200,
			tokens: { total: 500 },
		});
	});

	it("轨迹终态图标与文案来自同一状态矩阵", () => {
		const cases = [
			["completed", "succeeded"],
			["failed", "failed"],
			["cancelled", "cancelled"],
			["unknown", "unknown"],
			["not_started", "not_started"],
		] as const;
		for (const [status, specKey] of cases) {
			const node: TrajectoryNode = { id: `node:${status}`, kind: "tool_call", name: status, label: status, status };
			const scene = new TrajectoryScene({ list: () => [node], aggregate: () => [] });
			const rendered = stripAnsi(scene.formatLines(40, 10).join("\n"));
			expect(rendered).toContain(TOOL_STATUS_SPEC[specKey].icon);
			expect(rendered).toContain(TOOL_STATUS_SPEC[specKey].label);
		}

		const running: TrajectoryNode = {
			id: "node:running",
			kind: "tool_call",
			name: "running",
			label: "running",
			status: "running",
		};
		const runningScene = new TrajectoryScene({ list: () => [running], aggregate: () => [] });
		expect(stripAnsi(runningScene.formatLines(40, 10).join("\n"))).toContain("进行中");
	});
});

describe("UI Components & Visual Rendering", () => {
	it("流式 Markdown 格式化代码块与行内元素", () => {
		const formatter = new StreamMarkdownFormatter();
		const line1 = formatter.formatLine("```typescript");
		expect(line1).toContain("typescript");
		const line2 = formatter.formatLine("const x = 1;");
		expect(line2).toContain("│");
		const line3 = formatter.formatLine("```");
		expect(line3).toContain("└");

		const header = formatter.formatLine("# 标题测试");
		expect(header).toContain("标题测试");

		const bullet = formatter.formatLine("- 列表项 `code`");
		expect(bullet).toContain("•");
		expect(bullet).toContain("code");
	});

	it("InputLine 经典圆角盒与状态行渲染", () => {
		const box = new InputLine();
		box.setStatusHeader("⠋ 思考中");
		box.setContextStats("deepseek-chat", 1000, 65536);
		box.setCacheRate("85.0%");
		const lines = box.render(80);
		expect(lines.length).toBe(3);
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("思考中");
		expect(lines[1]).not.toContain("│");
		expect(lines[1]).toContain("❯");
		expect(lines[2]).toContain("╰");
		expect(stripAnsi(lines[0]!)).toMatch(/╮$/);
		expect(stripAnsi(lines[2]!)).toMatch(/╯$/);
		expect(lines[2]).toContain("deepseek-chat");
		expect(stripAnsi(lines[2]!)).toContain("缓存 85.0%");
	});

	it("InputLine 对未知模型能力显示未知而不是默认模型和上下文数值", () => {
		const box = new InputLine();
		box.setContextStats(undefined, 0, undefined, false);
		const line = stripAnsi(box.render(80)[2]!);
		expect(line).toContain("模型未知");
		expect(line).toContain("思考:未知");
		expect(line).toContain("~0/未知");
		expect(line).not.toContain("deepseek");
		expect(line).not.toContain("65.5k");
	});

	it("ActivityLine 流光动画与状态文本", () => {
		const act = new ActivityLineComponent();
		act.update("streaming", "流式生成中");
		const str = act.getHeaderString(60);
		expect(stripAnsi(str)).toContain("流式生成中");
	});

	it("扩展后台工作从空闲态开始时启动独立墙钟计时", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const terminal = createSilentTerminal();
		const host = new UIHost({ terminal: terminal.terminal });
		try {
			host.start();
			host.setWorking("compaction", "正在压缩上下文：生成历史摘要");
			await vi.advanceTimersByTimeAsync(1_500);

			const header = terminal.getVisibleText();
			expect(header).toContain("正在压缩上下文：生成历史摘要");
			expect(header).toContain("1.5s");
		} finally {
			host.stop();
			vi.useRealTimers();
		}
	});

	it("压缩仍在运行时普通回合结束不能停止压缩心跳", () => {
		const host = new UIHost();
		try {
			host.setWorking("compaction", "正在压缩上下文：验证压缩后上下文");
			expect(isHeartbeatActive(host)).toBe(true);
			host.setBusy(false);
			expect(isHeartbeatActive(host)).toBe(true);
		} finally {
			host.setWorking("compaction", undefined);
		}
	});

	it("后台压缩无需鼠标输入也会持续刷新画面上的耗时", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const terminal = createSilentTerminal();
		const host = new UIHost({ terminal: terminal.terminal });
		try {
			host.start();
			host.setWorking("compaction", "正在压缩上下文：写入检查点");
			host.setBusy(false);
			await vi.advanceTimersByTimeAsync(1_200);
			expect(terminal.getVisibleText()).toContain("1.2s");
		} finally {
			host.stop();
			vi.useRealTimers();
		}
	});

	it("压缩期间活动行被重置后，显示耗时仍从压缩开始计算", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const terminal = createSilentTerminal();
		const host = new UIHost({ terminal: terminal.terminal });
		try {
			host.start();
			host.setWorking("compaction", "正在压缩上下文：生成摘要");
			await vi.advanceTimersByTimeAsync(50);
			vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
			host.activityLine.reset();
			host.setWorking("compaction", "正在压缩上下文：写入检查点");
			await vi.advanceTimersByTimeAsync(50);
			expect(terminal.getVisibleText()).toContain("60.0s");
		} finally {
			host.stop();
			vi.useRealTimers();
		}
	});

	it("Provider 重试状态持续显示在状态行，不依赖短时 toast", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const terminal = createSilentTerminal();
		const host = new UIHost({ terminal: terminal.terminal });
		try {
			host.start();
			host.setBusy(true);
			// 回合已跑了 3 秒；重试提示自己的耗时必须从提示起点算，而不是整轮。
			await vi.advanceTimersByTimeAsync(3_000);
			host.setProviderRetryMessage("vanyo 连接失败（HTTP 503），16.0 秒后重试，第 8 次", Date.now());
			await vi.advanceTimersByTimeAsync(1_200);
			expect(terminal.getVisibleText()).toContain("vanyo 连接失败");
			expect(terminal.getVisibleText()).toContain("第 8 次");
			expect(terminal.getVisibleText()).toContain("1.2s");
			expect(terminal.getVisibleText()).not.toContain("4.2s");
			host.setProviderRetryMessage();
			await vi.advanceTimersByTimeAsync(50);
			expect(terminal.getVisibleText()).not.toContain("vanyo 连接失败");
		} finally {
			host.stop();
			vi.useRealTimers();
		}
	});

	it("压缩完成后不留下静止的正在压缩状态", () => {
		const host = new UIHost();
		host.setWorking("compaction", "正在压缩上下文：写入检查点");
		host.setWorking("compaction", undefined);
		expect(isHeartbeatActive(host)).toBe(false);
		expect(host.activityLine.getHeaderString()).toBe("");
	});

	it("压缩覆盖提示结束后保留已完成回合的耗时与输出指标", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const terminal = createSilentTerminal();
		const host = new UIHost({ terminal: terminal.terminal });
		try {
			host.start();
			host.activityLine.start("streaming", "正在输出回复...");
			host.activityLine.addStreamText("hello world");
			host.activityLine.finish("本轮已完成", 1_234);
			const before = stripAnsi(host.activityLine.getHeaderString(80));
			host.setWorking("compaction", "正在压缩上下文：生成摘要");
			await vi.advanceTimersByTimeAsync(1_500);
			expect(terminal.getVisibleText()).toContain("正在压缩上下文：生成摘要");
			expect(terminal.getVisibleText()).toContain("1.5s");
			host.setWorking("compaction", undefined);
			await vi.advanceTimersByTimeAsync(50);
			expect(stripAnsi(host.activityLine.getHeaderString(80))).toBe(before);
			expect(terminal.getVisibleText()).toContain("本轮已完成");
			expect(terminal.getVisibleText()).not.toContain("正在压缩上下文");
		} finally {
			host.stop();
			vi.useRealTimers();
		}
	});

	it("压缩期间回合活动变化不夺走压缩提示，结束后恢复原工具状态", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const terminal = createSilentTerminal();
		const host = new UIHost({ terminal: terminal.terminal });
		try {
			host.start();
			host.setBusy(true);
			host.activityLine.start("thinking", "正在思考与生成回复...");
			host.setWorking("compaction", "正在压缩上下文：重建请求");
			host.activityLine.update("tool", "正在执行工具: echo");
			await vi.advanceTimersByTimeAsync(1_200);
			// C6 并列语义：工作指示占独立行，回合活动行不再被单槽抢占，两者同屏
			expect(terminal.getVisibleText()).toContain("正在压缩上下文：重建请求");
			expect(terminal.getVisibleText()).toContain("正在执行工具: echo");
			host.setWorking("compaction", undefined);
			await vi.advanceTimersByTimeAsync(50);
			// 工作指示撤回后行消失，回合活动行仍在
			expect(terminal.getVisibleText()).not.toContain("正在压缩上下文：重建请求");
			expect(terminal.getVisibleText()).toContain("正在执行工具: echo");
		} finally {
			host.stop();
			vi.useRealTimers();
		}
	});

	it("活动回合中的自动压缩结束后恢复回合提示", () => {
		const host = new UIHost();
		try {
			host.setBusy(true);
			host.activityLine.start("thinking", "正在思考与生成回复...");
			host.setWorking("compaction", "正在压缩上下文：写入检查点");
			host.setWorking("compaction", undefined);
			expect(stripAnsi(host.activityLine.getHeaderString())).toContain("正在思考与生成回复");
			expect(isHeartbeatActive(host)).toBe(true);
		} finally {
			host.setBusy(false);
		}
	});

	it("当前流式思考立即可见，并注册鼠标展开目标", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "正在处理的问题");
		transcript.appendThinking("这是尚未进入工具阶段的实时思考内容");

		expect(transcript.render(60).join("\n")).toContain("实时思考内容");
		expect(transcript.getThinkingLineIndices(60).map(({ turnN, lineIndex }) => ({ turnN, lineIndex }))).toEqual([
			{ turnN: 1, lineIndex: 3 },
		]);
	});

	it("鼠标折叠当前 thinking 时按块对象定位，不会误切同编号的历史轮次", () => {
		const transcript = new TranscriptContainer();
		transcript.loadSession(
			[
				{ kind: "message", message: { role: "user", content: "旧问题" } },
				{ kind: "message", message: { role: "assistant", content: "", thinking: "旧思考" } },
			],
			[],
		);
		transcript.startTurn(1, "当前问题"); // 模拟重载历史后新 Subject 从 1 重新计数
		transcript.appendThinking("当前思考");

		const locations = transcript.getThinkingLineIndices(60);
		const current = locations.find((location) => location.turn === transcript.getCurrentTurn());
		expect(current).toBeDefined();
		transcript.toggleThinking(current!.item, 60);

		expect(current!.item.collapsed).toBe(false);
		const historical = locations.find((location) => location.turn === transcript.getHistory()[0]);
		expect(historical!.item.collapsed).not.toBe(false);
	});

	it("ContextBar 上下文隐藏信息行与 Hover 展开", () => {
		const bar = new ContextBarComponent();
		bar.update({ usedTokens: 32000, contextWindow: 64000, cwd: "E:\\Uina\\Uina" });
		const normalLines = bar.render(80);
		// 未展开时仍显示有数据可读的键盘入口。
		expect(normalLines.length).toBe(1);
		expect(stripAnsi(normalLines[0]!)).toContain("Ctrl+L");

		// hover 时在该行内展开隐藏信息（目录 + 剩余空间，且绝不重复显示百分比）
		bar.setHovered(true);
		const expandedLines = bar.render(80);
		expect(expandedLines.length).toBe(1);
		expect(expandedLines[0]).not.toContain("50.0%");
		expect(expandedLines[0]).toContain("剩余");
		expect(expandedLines[0]).toContain("E:\\Uina\\Uina");
	});

	it("ContextBar 不会把未知上限显示成默认 1M", () => {
		const bar = new ContextBarComponent();
		bar.update({ usedTokens: 1234, contextWindow: undefined, cwd: "E:\\Uina\\Uina" });
		bar.setHovered(true);
		const line = stripAnsi(bar.render(100)[0]!);
		expect(line).toContain("上下文上限未知");
		expect(line).not.toContain("1.0m");
	});

	it("模型选择器和 Banner 在没有真实数据时保持空或明确未知", () => {
		const picker = stripAnsi(new ModelPicker().render(80).join("\n"));
		expect(picker).toContain("没有来自配置、Provider 或可信目录的可选模型");
		expect(picker).not.toContain("deepseek-chat");
		expect(picker).not.toContain("gpt-4o");

		const banner = stripAnsi(getStartupBanner(undefined, 60).join("\n"));
		expect(banner).not.toContain("模型未知");
		expect(banner).not.toContain("Latency <");
		expect(banner).not.toContain("tools ready");
	});

	it("模型选择器两级展示：第一级为服务商，Enter展开第二级模型列表，Enter选择，Esc返回", () => {
		const groups = mockModelGroups();

		const picker = new ModelPicker("deepseek-v4-flash", groups);
		let pickedModel = "";
		let closed = false;
		picker.onPick = (id) => {
			pickedModel = id;
		};
		picker.onClose = () => {
			closed = true;
		};

		// 第一级视图：展示 Provider 列表，含模型数量统计与展开提示
		let lines = stripAnsi(picker.render(80).join("\n"));
		expect(lines).toContain("切换模型服务商 (Providers)");
		expect(lines).toContain("[deepseek]");
		expect(lines).toContain("(1 个模型)");
		expect(lines).toContain("[anthropic]");
		expect(lines).toContain("(2 个模型)");
		expect(lines).toContain("Enter 展开");

		// Enter 展开选中的 deepseek
		picker.handleInput("\r");
		lines = stripAnsi(picker.render(80).join("\n"));
		expect(lines).toContain("选择模型 (deepseek)");
		expect(lines).toContain("deepseek-v4-flash");
		expect(lines).toContain("Enter 确认切换 · Esc 返回");

		// Esc 返回第一级
		picker.handleInput("\x1b");
		lines = stripAnsi(picker.render(80).join("\n"));
		expect(lines).toContain("切换模型服务商 (Providers)");

		// 向下移动选择 anthropic 并展开
		picker.handleInput("\x1b[B"); // down arrow
		picker.handleInput("\r");
		lines = stripAnsi(picker.render(80).join("\n"));
		expect(lines).toContain("选择模型 (anthropic)");
		expect(lines).toContain("claude-3-7-sonnet");
		expect(lines).toContain("claude-3-5-haiku");

		// Enter 选择当前选中的 claude-3-7-sonnet
		picker.handleInput("\r");
		expect(pickedModel).toBe("claude-3-7-sonnet");

		// 在第一级按 Esc 关闭选择器
		const picker2 = new ModelPicker("deepseek-v4-flash", groups);
		picker2.onClose = () => {
			closed = true;
		};
		picker2.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	it("同 id 模型跨 provider 时 ✓ 只标当前项，选中项回传复合键", () => {
		const groups = [
			{
				id: "providerA",
				name: "providerA",
				description: "A",
				models: [{ id: "providerA/gpt-x", name: "gpt-x", description: "A 注册模型", provider: "providerA" }],
			},
			{
				id: "providerB",
				name: "providerB",
				description: "B",
				models: [{ id: "providerB/gpt-x", name: "gpt-x", description: "B 注册模型", provider: "providerB" }],
			},
		];

		// 当前模型是 providerA/gpt-x：只有 providerA 组打 ✓
		const picker = new ModelPicker("providerA/gpt-x", groups);
		const groupLines = stripAnsi(picker.render(80).join("\n"));
		expect(groupLines).toContain("[providerA]");
		expect(groupLines).toContain("✓");
		const checkedGroupBlock = groupLines.split("\n").filter((l) => l.includes("✓"));
		expect(checkedGroupBlock).toHaveLength(1);
		expect(checkedGroupBlock[0]).toContain("[providerA]");

		// 下钻 providerB，其 gpt-x 不得打 ✓（防假切换）
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		const modelLines = stripAnsi(picker.render(80).join("\n"));
		expect(modelLines).toContain("gpt-x");
		expect(modelLines).not.toContain("✓");

		// 确认选择后回传复合键，精确指向 providerB
		let picked = "";
		picker.onPick = (id) => {
			picked = id;
		};
		picker.handleInput("\r");
		expect(picked).toBe("providerB/gpt-x");
	});

	it("Shift+Tab 只请求 runtime 切换 thinking，不直接改写 UI 权威状态", () => {
		const host = new UIHost({ modelName: "model", thinkingLevels: ["off", "high"], thinkingLevel: "off" });
		const requested = vi.fn();
		host.onThinkingLevelCycle = requested;
		dispatchUIHostInput(host, "\x1b[Z");
		expect(requested).toHaveBeenCalledOnce();
		expect(host.getReasoningEffort()).toBe("off");
	});

	it("Git Unified Diff 逐行差异计算与卡片渲染", async () => {
		const { computeLineDiff, formatUnifiedDiffCardLines } = await import(
			"../src/ui/components/transcript/diff-view.js"
		);

		const oldText = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
		const newText = "const a = 1;\nconst b = 3;\nconst c = 4;\nconsole.log(a + b);";

		const diff = computeLineDiff(oldText, newText);
		expect(diff.addCount).toBe(2);
		expect(diff.delCount).toBe(1);

		const cardLines = formatUnifiedDiffCardLines(oldText, newText, "demo.ts", false, 70);
		expect(cardLines[0]).toContain("┌─ 📄 demo.ts (diff)");
		expect(cardLines.join("\n")).toContain("- const b = 2;");
		expect(cardLines.join("\n")).toContain("+ const b = 3;");
		expect(cardLines.join("\n")).toContain("+ const c = 4;");
		expect(stripAnsi(cardLines[cardLines.length - 1]!)).toContain("+2 / -1");

		const widths = cardLines.map((l) => visibleWidth(l));
		const firstW = widths[0]!;
		expect(widths.every((w) => w === firstW)).toBe(true);
	});

	it("CompactionCardData 格式化渲染与折叠双态像素对齐", async () => {
		const { formatCompactionCardLines } = await import("../src/ui/components/transcript/cards.js");

		const record = {
			summary: "1. 讨论系统架构\n2. 落地输入联想与差异卡片\n3. 优化文件发现机制",
			retainedTailEntries: 3,
			tokensBefore: 18500,
			collapsed: true,
		};

		const collapsedLines = formatCompactionCardLines(record, 70);
		expect(collapsedLines.length).toBe(3);
		expect(collapsedLines[0]).toContain("会话已压缩");
		expect(stripAnsi(collapsedLines[1]!)).toContain("∴ 摘要已折叠");
		expect(collapsedLines[1]).toContain("ctrl+o / 点击展开");
		const cWidths = collapsedLines.map((l) => visibleWidth(l));
		expect(cWidths.every((w) => w === cWidths[0])).toBe(true);

		record.collapsed = false;
		const expandedLines = formatCompactionCardLines(record, 70);
		expect(expandedLines.length).toBeGreaterThan(3);
		expect(expandedLines[0]).toContain("完整摘要");
		expect(expandedLines.join("\n")).toContain("讨论系统架构");
		expect(expandedLines.join("\n")).toContain("18.5k");
		expect(expandedLines.join("\n")).toContain("ctrl+o / 点击收起");
		const eWidths = expandedLines.map((l) => visibleWidth(l));
		expect(eWidths.every((w) => w === eWidths[0])).toBe(true);
	});

	it("失败的压缩记录不显示为已压缩摘要", async () => {
		const { formatCompactionCardLines } = await import("../src/ui/components/transcript/cards.js");
		const rendered = stripAnsi(
			formatCompactionCardLines(
				{
					status: "failed",
					summary: "摘要模型请求终止",
					retainedTailEntries: 0,
					tokensBefore: 0,
					collapsed: false,
				},
				80,
			).join("\n"),
		);
		expect(rendered).toContain("压缩失败");
		expect(rendered).not.toContain("会话已压缩");
		expect(rendered).not.toContain("完整摘要");
	});

	it("SyntaxText: 语言名称规范化与轻量语法高亮及降级", async () => {
		const { normalizeLanguage, highlightCode, highlightLines } = await import(
			"../src/ui/components/primitives/syntax-text.js"
		);

		expect(normalizeLanguage("ts")).toBe("typescript");
		expect(normalizeLanguage("PY")).toBe("python");
		expect(normalizeLanguage("")).toBeUndefined();

		const code = "const val = 123;";
		const highlighted = highlightCode(code, "typescript");
		expect(highlighted).toContain("val");

		const lines = highlightLines("const a = 1;\nconst b = 2;", "ts");
		expect(lines.length).toBe(2);

		const unknown = highlightCode("unknown code", "unknown_lang_xyz");
		expect(unknown).toContain("unknown code");
	});

	it("MarkdownTable: 解析表格结构与全封闭自适应网格对齐", async () => {
		const { parseMarkdownTable, formatMarkdownTableLines, isMarkdownTableLine } = await import(
			"../src/ui/components/primitives/markdown-table.js"
		);

		const rawTable = [
			"| 模块名 | 状态 | 耗时 |",
			"| :--- | :---: | ---: |",
			"| UI 内核 | 稳定 | 12ms |",
			"| 语法高亮 | 正常 | 8ms |",
		];

		expect(isMarkdownTableLine(rawTable[0]!)).toBe(true);

		const parsed = parseMarkdownTable(rawTable);
		expect(parsed).not.toBeNull();
		expect(parsed!.headers).toEqual(["模块名", "状态", "耗时"]);
		expect(parsed!.alignments).toEqual(["left", "center", "right"]);
		expect(parsed!.rows.length).toBe(2);

		const lines = formatMarkdownTableLines(parsed!, 70);
		expect(lines[0]).toContain("┌");
		expect(lines[1]).toContain("模块名");
		expect(lines[lines.length - 1]).toContain("┘");
	});

	it("MarkdownTable: 长单元格默认软换行显示全文，不用 … 截断", async () => {
		const { parseMarkdownTable, formatMarkdownTableLines } = await import(
			"../src/ui/components/primitives/markdown-table.js"
		);

		const longText = "这是一段特别长的判断文本用来验证表格单元格在列宽不足时会换行而不是被省略号截断掉";
		const rawTable = ["| 方案 | 判断 |", "| --- | --- |", `| 方案甲 | 短判断 |`, `| 方案乙 | ${longText} |`];
		const parsed = parseMarkdownTable(rawTable);
		expect(parsed).not.toBeNull();

		const lines = formatMarkdownTableLines(parsed!, 70);
		const stripped = lines.map(stripAnsi).join("\n");

		// 全文可见：长文本软换行为多物理行，每个片段都完整出现，无省略号
		const mid = Math.floor(longText.length / 2);
		expect(stripped).toContain(longText.slice(0, mid));
		expect(stripped.replace(/[│\s]/g, "")).toContain(longText.slice(mid).replace(/\s/g, ""));
		expect(stripped).not.toContain("…");
	});

	it("MarkdownTable: 响应式视口自适应、短列优先保全与大峡谷防御", async () => {
		const { parseMarkdownTable, formatMarkdownTableLines, solveColumnWidths } = await import(
			"../src/ui/components/primitives/markdown-table.js"
		);

		const rawTable = [
			"| ID | 状态 | 详细描述 |",
			"| --- | --- | --- |",
			"| 1 | 运行中 | 正在执行长时间异步分析任务并持续监听输出队列 |",
			"| 2 | 已完成 | 任务执行完毕 |",
		];
		const parsed = parseMarkdownTable(rawTable)!;

		// 1. 宽屏舒适态（120 列）：长文本列得到充分舒展，短列（ID、状态）保持紧凑自然宽
		const wideLines = formatMarkdownTableLines(parsed, 120);
		for (const line of wideLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
		// 宽屏下总宽度不会无脑填充到 120 列（大峡谷防御）：自然展开的总宽约为 57 列
		expect(visibleWidth(wideLines[0]!)).toBeLessThan(80);

		// 2. 窄屏受限态（50 列）：短列（ID、状态）完整保留不折行，长描述列在剩余预算内弹性软换行
		const narrowLines = formatMarkdownTableLines(parsed, 50);
		for (const line of narrowLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(50);
		}
		const narrowStripped = narrowLines.map(stripAnsi).join("\n");
		expect(narrowStripped).toContain("运行中");
		expect(narrowStripped).toContain("已完成");

		// 3. 算法纯函数测试：solveColumnWidths 数学求和严格等于预算 35，短列完美单行保全
		const widths = solveColumnWidths(parsed.headers, parsed.rows, 35);
		const sumWidths = widths.reduce((a, b) => a + b, 0);
		expect(sumWidths).toBe(35);
		// 短列完全按自然宽保全（ID=2, 状态=6），绝无冗余拉扯，剩余 27 列全额赋给详细描述
		expect(widths[0]).toBe(2);
		expect(widths[1]).toBe(6);
		expect(widths[2]).toBe(27);

		// 4. 超窄屏幕（20 列）：列数过多时平滑降级为垂直条目模式，绝对 <= 20 列
		const extremeNarrow = formatMarkdownTableLines(parsed, 20);
		expect(extremeNarrow.length).toBeGreaterThan(0);
		for (const line of extremeNarrow) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
		expect(extremeNarrow.some((l) => l.includes("表格条目 #1"))).toBe(true);
	});

	it("MarkdownTable: 4列受限水位线分配与降级超长表头分行防御", async () => {
		const { parseMarkdownTable, formatMarkdownTableLines, solveColumnWidths } = await import(
			"../src/ui/components/primitives/markdown-table.js"
		);

		// 1. 4 列全长文本表格在极限受限预算下（budget = 16，4 列平均每列仅 4 格）
		const rawHeaders = ["模块A", "任务详情B", "状态指标C", "结果记录D"];
		const rawRows = [
			["非常长的模块名字A", "这是一个很长的任务详情内容B", "正在运行中且耗时很长C", "最终输出结果很长D"],
		];
		const widths = solveColumnWidths(rawHeaders, rawRows, 16);
		// 数学证明：求和必须严格等于 16，绝对不突破预算
		expect(widths.reduce((a, b) => a + b, 0)).toBe(16);
		// 每一列均分 4 格，无负数，无 0
		for (const w of widths) expect(w).toBe(4);

		// 2. 超长表头在降级条目下的响应式换行（终端仅 14 列，平均预算不足进入降级）
		const longHeaderTable = ["| 极长表头字段名称描述 | 简单值 |", "| --- | --- |", "| 核心架构逻辑实现 | 通过 |"];
		const parsedLong = parseMarkdownTable(longHeaderTable)!;
		const fallbackLines = formatMarkdownTableLines(parsedLong, 14);
		expect(fallbackLines.length).toBeGreaterThan(0);
		// 每一行必须严格 <= 14 列（绝对零溢出、零破损）
		for (const line of fallbackLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(14);
		}
		// 包含降级条目标记与表头内容
		expect(fallbackLines.some((l) => l.includes("[#1]"))).toBe(true);
		expect(fallbackLines.some((l) => l.includes("通过"))).toBe(true);
	});

	it("MarkdownTable: 转义竖线保护、极小预算水位线守恒、<br>与行内高亮", async () => {
		const { parseMarkdownTable, formatMarkdownTableLines, solveColumnWidths, splitMarkdownCells } = await import(
			"../src/ui/components/primitives/markdown-table.js"
		);

		// 1. 转义竖线 \| 与代码块 `a | b` 不被误炸开
		const cells = splitMarkdownCells("| 命令 | `cat | grep` | 管道 \\| 或操作 |");
		expect(cells).toEqual(["命令", "`cat | grep`", "管道 | 或操作"]);

		const escapedTable = [
			"| 规则 | 表达式 | 说明 |",
			"| --- | --- | --- |",
			"| 逻辑或 | A \\| B | 或运算 |",
			"| 管道 | `echo 1 | cat` | 代码管道 |",
		];
		const parsedEscaped = parseMarkdownTable(escapedTable);
		expect(parsedEscaped).not.toBeNull();
		expect(parsedEscaped!.rows.length).toBe(2);
		expect(parsedEscaped!.rows[0]).toEqual(["逻辑或", "A | B", "或运算"]);
		expect(parsedEscaped!.rows[1]).toEqual(["管道", "`echo 1 | cat`", "代码管道"]);

		// 2. 极端小预算下的水位线分配数学守恒（绝对无负数，sum 严格 <= budget）
		// 3 列表格，各列自然需求较大，但预算仅给 5
		const smallBudgetWidths = solveColumnWidths(["A", "B", "C"], [["long text 1", "long text 2", "long text 3"]], 5);
		expect(smallBudgetWidths.reduce((a, b) => a + b, 0)).toBe(5);
		for (const w of smallBudgetWidths) {
			expect(w).toBeGreaterThan(0);
		}

		// 预算小于列数（3 列表格，预算给 2）
		const tinyBudgetWidths = solveColumnWidths(["A", "B", "C"], [["foo", "bar", "baz"]], 2);
		expect(tinyBudgetWidths.reduce((a, b) => a + b, 0)).toBe(2);
		for (const w of tinyBudgetWidths) {
			expect(w).toBeGreaterThanOrEqual(0);
		}

		// 3. 支持 <br> 显式换行与行内 Markdown 高亮
		const richTable = ["| 特性 | 说明 |", "| --- | --- |", "| **核心** | 第一行<br>第二行 |"];
		const parsedRich = parseMarkdownTable(richTable)!;
		const richLines = formatMarkdownTableLines(parsedRich, 60);
		const richStripped = richLines.map(stripAnsi).join("\n");
		expect(richStripped).toContain("第一行");
		expect(richStripped).toContain("第二行");
		// 原始 ANSI 行中包含高亮转义码
		expect(richLines.some((l) => l.includes("\x1b["))).toBe(true);
	});

	it("SuggestionCard 格式化渲染与像素级对齐", async () => {
		const { formatSuggestionCardLines } = await import("../src/ui/components/editor/suggestions.js");

		const commands = [
			{ name: "model", description: "切换模型" },
			{ name: "clear", description: "清空屏幕" },
			{ name: "help", description: "查看帮助" },
		];

		const lines = formatSuggestionCardLines({
			type: "command",
			title: "命令",
			query: "m",
			columns: 60,
			selectedIndex: 0,
			items: commands,
		});

		expect(lines.length).toBeGreaterThan(3);
		expect(lines[0]).toContain("╭─ 命令 · 共 3 项");
		expect(lines[1]).toContain("❯");
		expect(lines[1]).toContain("model");
		expect(lines[lines.length - 1]).toContain("╰");

		for (const line of lines) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	it("InputLine 自动探测 / 与 @ 联想并支持原子替换", () => {
		const box = new InputLine();

		box.setText("/mod");
		const q1 = box.detectSuggestionQuery();
		expect(q1).toEqual({ type: "command", query: "mod", start: 0, end: 4 });

		box.setText("/model deepseek");
		const q2 = box.detectSuggestionQuery();
		expect(q2).toBeNull();

		box.setText("请帮我查看 @src/tui");
		const q3 = box.detectSuggestionQuery();
		expect(q3).toEqual({ type: "file", query: "src/tui", start: 6, end: 14 });

		if (q3) {
			box.replaceRange(q3.start, q3.end, "@src/ui/tui.ts ");
		}
		expect(box.getRawText()).toBe("请帮我查看 @src/ui/tui.ts ");
	});
});

describe("InteractiveTUI & UIHost Lifecycle", () => {
	it("createInteractiveUI 启动、消息分发与安全关闭", () => {
		const harness = createTestTUI({
			modelName: "deepseek-chat",
			cwd: "e:/Uina/test",
			columns: 80,
			rows: 24,
		});
		try {
			harness.host.registry.registerCommand({ name: "model", description: "切换模型", hasArgs: true });

			expect(harness.host.isBusy()).toBe(false);

			harness.tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "测试提问" }));
			expect(harness.host.isBusy()).toBe(true);

			harness.tui.consume(
				record({
					type: "output_update",
					streamId: "s1",
					offset: 0,
					channel: "content",
					text: "模型正在分析...",
				}),
			);
			harness.tui.consume(record({ type: "tool_call", toolName: "list_dir", args: {}, callId: "tool-1" }));
			harness.tui.consume(
				record({
					type: "tool_result",
					toolName: "list_dir",
					args: {},
					result: "dir output",
					status: "succeeded",
					callId: "tool-1",
				}),
			);

			harness.tui.consume(
				record({ type: "turn_end", turnNumber: 1, requestUsage: { callId: "call-1", totalTokens: 2048 } }),
			);
			expect(harness.host.isBusy()).toBe(false);
		} finally {
			harness.dispose();
		}
	});

	it("正确捕获终端输入并在按下 Enter 时提交用户行", () => {
		const harness = createTestTUI({
			modelName: "test-model",
			columns: 80,
			rows: 24,
		});
		try {
			const submittedLines: string[] = [];
			harness.tui.onIntent((intent) => {
				if (intent.type === "input.submit") submittedLines.push(intent.text);
			});

			// 1. 模拟输入 "2222" 并按回车 (\r)
			harness.type("2222").press("enter");
			expect(submittedLines).toEqual(["2222"]);

			// 2. 模拟输入 "3333" 并按回车 (\n)
			harness.type("3333").feedInput("\n");
			expect(submittedLines).toEqual(["2222", "3333"]);
		} finally {
			harness.dispose();
		}
	});

	it("通过 TUI 门面恢复历史会话消息到转录流中", () => {
		const harness = createTestTUI({
			modelName: "test-model",
			columns: 80,
			rows: 24,
		});
		try {
			harness.tui.restoreSession([
				{ kind: "message", message: { role: "user", content: "之前问的问题" } },
				{ kind: "message", message: { role: "assistant", content: "之前回答的答案", thinking: "思考过程" } },
			]);

			const history = harness.host.transcript.getHistory();
			expect(history.length).toBe(1);
			expect(history[0]?.userText).toBe("之前问的问题");
			expect(history[0]?.assistantMarkdown).toBe("之前回答的答案");
			expect(history[0]?.thinkingText).toBe("思考过程");

			const rendered = harness.host.transcript.render(80);
			expect(rendered.some((l) => l.includes("之前问的问题"))).toBe(true);
			expect(rendered.some((l) => l.includes("之前回答的答案"))).toBe(true);
		} finally {
			harness.dispose();
		}
	});

	it("支持鼠标滚轮与键盘 (PageUp/PageDown) 视口滚动", () => {
		const harness = createTestTUI({
			modelName: "test-model",
			columns: 80,
			rows: 24,
		});
		try {
			expect(harness.host.getScrollOffset()).toBe(0);

			// 1. 模拟按下 PageUp (\x1b[5~)
			harness.press("pageup");
			expect(harness.host.getScrollOffset()).toBeGreaterThan(0);

			// 2. 模拟按下 PageDown (\x1b[6~)
			harness.press("pagedown");
			expect(harness.host.getScrollOffset()).toBe(0);

			// 3. 模拟 SGR 鼠标滚轮向上滚动 (\x1b[<64;20;10M)
			harness.feedInput("\x1b[<64;20;10M");
			expect(harness.host.getScrollOffset()).toBe(3);

			// 4. 模拟 SGR 鼠标滚轮向下滚动 (\x1b[<65;20;10M)
			harness.feedInput("\x1b[<65;20;10M");
			expect(harness.host.getScrollOffset()).toBe(0);

			// 5. 模拟滚上去后发送新消息，视口保持用户位置（不强制回底）；
			// 新内容追加由 computeLayout 锚定机制补偿，offset 随 totalPerm 同步增长。
			harness.feedInput("\x1b[<64;20;10M");
			expect(harness.host.getScrollOffset()).toBe(3);
			harness.type("hi").press("enter");
			expect(harness.host.getScrollOffset()).toBeGreaterThan(0);
		} finally {
			harness.dispose();
		}
	});

	it("高频与粘包 SGR 鼠标事件被彻底拦截隔离，绝不泄漏至 InputLine 产生伪造粘贴标记", () => {
		const harness = createTestTUI({
			modelName: "test-model",
			columns: 80,
			rows: 24,
		});
		try {
			// 模拟高频移动产生的大量粘包 SGR 鼠标事件 (35 号 hover/move 事件连发)
			const packetChunk = "\x1b[<35;54;39M\x1b[<35;53;39M\x1b[<35;52;39M\x1b[<35;51;39M\x1b[<35;50;40M".repeat(5);
			harness.feedInput(packetChunk);

			// 模拟拆包时遗失了开头的 ESC 导致的残片
			harness.feedInput("[<35;54;39M[<35;53;39M");

			// 验证输入框中绝对没有任何内容，更无 [已粘贴] 胶囊
			const text = harness.host.getEditorText();
			expect(text).toBe("");
			expect(text.includes("已粘贴")).toBe(false);
			expect(text.includes("[<35;")).toBe(false);
		} finally {
			harness.dispose();
		}
	});

	it("Agent 流式输出追加内容时，离开底部的视口保持绝对行号锚定，绝不被新内容顶跑", () => {
		const harness = createTestTUI({
			modelName: "test-model",
			columns: 80,
			rows: 20,
		});
		try {
			// 初始化 50 行历史，形成可滚动视口
			harness.host.transcript.startTurn(1, "初次提问");
			for (let i = 0; i < 50; i++) {
				harness.host.transcript.appendToken(`历史数据行 ${i}\n`);
			}
			harness.host.transcript.smoothReveal.setEnabled(false);

			// 触发一次初始全帧渲染
			(harness.host as any).renderCurrentFrame();
			const initialLayout = (harness.host as any).layoutFrame();
			const initialScrollStart = initialLayout.scrollStart;

			// 用户向上滚动查看历史
			harness.feedInput("\x1b[<64;20;10M"); // 滚轮向上滚 3 行
			harness.feedInput("\x1b[<64;20;10M"); // 滚轮向上滚 3 行
			(harness.host as any).renderCurrentFrame();

			const userScrolledLayout = (harness.host as any).layoutFrame();
			const anchoredScrollStart = userScrolledLayout.scrollStart;
			expect(anchoredScrollStart).toBeLessThan(initialScrollStart);

			// 模拟 Agent 正在工作流式吐字，连续追加 30 行新内容
			for (let i = 0; i < 30; i++) {
				harness.host.transcript.appendToken(`流式新增行 ${i}\n`);
			}

			// 再次渲染，验证用户的视口顶部绝对行号纹丝不动，绝对没有被新行顶跑
			(harness.host as any).renderCurrentFrame();
			const streamedLayout = (harness.host as any).layoutFrame();
			expect(streamedLayout.scrollStart).toBe(anchoredScrollStart);
		} finally {
			harness.dispose();
		}
	});

	it("支持 / 命令与 @ 文件输入联想浮层与 Tab 补全", async () => {
		const harness = createTestTUI({
			modelName: "test-model",
			cwd: process.cwd(),
			columns: 80,
			rows: 24,
		});
		try {
			harness.host.registry.registerCommand({ name: "model", description: "切换模型", hasArgs: true });

			// 1. 输入 / 触发斜杠命令联想
			harness.type("/mod");

			// 验证输入框文本为 /mod
			expect(harness.host.inputLine.getText()).toBe("/mod");

			// 按 Tab 自动补全为 /model
			harness.press("tab");
			expect(harness.host.inputLine.getText()).toBe("/model ");

			// 清空输入框
			harness.host.inputLine.clear();

			// 2. 输入 @ 触发文件路径联想
			harness.type("@pack");

			expect(harness.host.inputLine.getText()).toBe("@pack");
			await vi.waitFor(() => expect(harness.visibleText).toContain("package.json"));

			// 按 Tab 自动补全
			harness.press("tab");
			expect(harness.host.inputLine.getText()).toContain("@package.json");
		} finally {
			harness.dispose();
		}
	});

	it("助手回复展示带有实心绿点 ● 前缀与优化的视觉呼吸层次", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "1+1等于几？");
		transcript.appendToken("等于 2。");
		transcript.finishTurn();

		const rendered = renderWidget(transcript, { width: 80 });
		expect(rendered.some((l: string) => l.includes("●") && l.includes("等于 2。"))).toBe(true);
	});

	it("用户输入展示为金色 ❯ 标记且助手段落折行采用零边距左对齐（无多余前导空格）", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "你好世界");
		// 输入超过行宽的长文本测试自动折行
		transcript.appendToken("这是一段非常长的助手回答内容用于测试换行功能确保换行后严格左对齐杜绝多余空格污染复制。");
		transcript.finishTurn();

		const rendered = renderWidget(transcript, { width: 30 });
		// 校验用户前缀
		expect(rendered.some((l: string) => l.includes("❯") && l.includes("你好世界"))).toBe(true);

		// 校验助手首行带 ● 且后续折行严格零边距左对齐（不包含多余前导空格）
		const assistantLines = rendered.filter((l: string) => l.includes("这是一段") || l.includes("用于测试换行"));
		expect(assistantLines.length).toBeGreaterThan(1);
		expect(assistantLines[0]).toContain("●");
		expect(assistantLines[1]!.startsWith("  ")).toBe(false);
	});
});

describe("UI Core: Mouse Selection & Wheel", () => {
	it("MouseSelectionTracker 正确解析滚轮事件并返回滚动增量", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		// 滚轮向上：btn=64
		const up = tracker.handleInput("\x1b[<64;10;5M", ["line1", "line2"]);
		expect(up.handled).toBe(true);
		expect(up.wheelDelta).toBe(-3);

		// 滚轮向下：btn=65
		const down = tracker.handleInput("\x1b[<65;10;5M", ["line1", "line2"]);
		expect(down.handled).toBe(true);
		expect(down.wheelDelta).toBe(3);
	});

	it("MouseSelectionTracker 拖拽划选并松开时自动触发复制回调并提取纯文本", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		const screenRows = ["Hello World Beautiful Day", "Second Line Text"];

		let copiedText = "";
		const onCopy = (text: string) => {
			copiedText = text;
		};

		// 鼠标左键在 (6, 0) 按下 (1-based: col 7, row 1) -> "World"
		const press = tracker.handleInput("\x1b[<0;7;1M", screenRows, onCopy);
		expect(press.handled).toBe(true);

		// 拖拽到 (11, 0) (1-based: col 12, row 1)
		const drag = tracker.handleInput("\x1b[<32;12;1M", screenRows, onCopy);
		expect(drag.handled).toBe(true);

		// 鼠标左键释放
		const release = tracker.handleInput("\x1b[<0;12;1m", screenRows, onCopy);
		expect(release.handled).toBe(true);

		expect(copiedText).toBe("World");
	});

	it("划词复制输入框中的粘贴芯片时，剪贴板拿到展开后的原始内容而非芯片标记", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		// 模拟输入框渲染帧：芯片在屏上就是标记原文（渲染层不做隐藏）
		const screenRows = ["│ 检查这段代码 [已粘贴 #1 +20行] 谢谢 │"];
		// 区域判定：整个屏幕第 0 行视作 input 区域（colStart=0, colEnd=行尾）
		tracker.setSelectableRegions([{ id: "input", startRow: 0, endRow: 0, colStart: 0, colEnd: 60 }]);

		let copied = "";
		const onCopy = (text: string) => {
			copied = text;
		};
		// 与 ui-host 接线同构：变换按区域分派，芯片语义不在 tracker 里
		const copyTransform = (regionId: string, text: string) =>
			regionId === "input"
				? text.replace(/\[已粘贴 #(\d+) (\+\d+行|\d+字)\]/g, (_, id) =>
						id === "1" ? "const a = 1;\nconst b = 2;" : "",
					)
				: text;

		tracker.handleInput("\x1b[<0;1;1M", screenRows, onCopy, undefined, copyTransform);
		tracker.handleInput("\x1b[<32;40;1M", screenRows, onCopy, undefined, copyTransform);
		tracker.handleInput("\x1b[<0;40;1m", screenRows, onCopy, undefined, copyTransform);

		expect(copied).toContain("const a = 1;");
		expect(copied).toContain("const b = 2;");
		expect(copied).not.toContain("[已粘贴");
	});

	it("expandForCopy 屏上芯片形态（无 #id 带 ▾）按 spec 一致 + id 升序消解为原始内容", async () => {
		const { InputLine } = await import("../src/ui/components/editor/input-line.js");
		const box = new InputLine();

		// 两次真实粘贴注册：#1 是多行、#2 是单行长文本（>80 字符才会折叠成芯片）
		box.insertText("alpha\nbeta\ngamma");
		const longSingle = "x".repeat(90);
		box.insertText(longSingle);

		// 模拟从帧缓冲抠出的文本：屏上形态无 #id、带 ▾
		const extracted = "检查 [已粘贴 +3行 ▾] 与 [已粘贴 90字 ▾]";
		const expanded = box.expandForCopy(extracted);

		expect(expanded).toBe("检查 alpha\nbeta\ngamma 与 " + longSingle);
		// 逻辑形态同样可展开
		expect(box.expandForCopy("前缀 [已粘贴 #2 90字]")).toBe("前缀 " + longSingle);
		// 无匹配 spec 的芯片（如已删除）不回填
		expect(box.expandForCopy("孤 [已粘贴 +9行 ▾]")).toBe("孤 ");
	});

	it("MouseSelectionTracker noSelect 保护：智能剥离 ● 符号与输入框外框 │", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		const screenRows = ["● 这是回答内容", "│› 输入框文字      │"];

		// 1. 划选包含 ● 的行，提取时剥离 ●
		let copied1 = "";
		tracker.handleInput("\x1b[<0;1;1M", screenRows, (t) => {
			copied1 = t;
		});
		tracker.handleInput("\x1b[<32;14;1M", screenRows);
		tracker.handleInput("\x1b[<0;14;1m", screenRows, (t) => {
			copied1 = t;
		});
		expect(copied1).toBe("这是回答内容");

		// 2. 划选输入框，提取时隔离外框 │
		let copied2 = "";
		tracker.handleInput("\x1b[<0;1;2M", screenRows, (t) => {
			copied2 = t;
		});
		tracker.handleInput("\x1b[<32;20;2M", screenRows);
		tracker.handleInput("\x1b[<0;20;2m", screenRows, (t) => {
			copied2 = t;
		});
		expect(copied2).not.toContain("│");
		expect(copied2).toContain("输入框文字");
	});

	it("划选包含右侧导航轨的行时精准截断至文本终点，绝不高亮右侧大片空白或导航轨刻度（图一）", async () => {
		const { MouseSelectionTracker, getLineContentWidth } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		// 模拟终端第 0 行：实际正文占 20 列，中间补 60 个空格，最右 2 列为导航轨刻度 ─
		const text = "这是一段很短的正文回答"; // 22 可见列宽
		const pad = " ".repeat(56);
		const rail = " ─";
		const fullRow = `${text}${pad}${rail}`; // 总宽 80 列

		expect(getLineContentWidth(fullRow)).toBe(22);

		const screenRows = [fullRow, "第二行正常内容" + " ".repeat(64) + " ─"];
		// 划选整行范围：从第 0 列到第 79 列
		tracker.handleInput("\x1b[<0;1;1M", screenRows);
		tracker.handleInput("\x1b[<32;80;1M", screenRows);

		const highlighted = tracker.applyHighlight(screenRows);
		// 校验：高亮背景色仅包裹正文，高亮标签在正文末尾退出，右侧空格与导航轨 ─ 均无反色
		expect(highlighted[0]).toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[0]).toContain("\x1b[49m");
		// 导航轨刻度 ─ 与填充空格必须未被选区背景包含
		expect(highlighted[0]!.endsWith(" ─")).toBe(true);
		expect(highlighted[0]!.includes("这是一段很短的正文回答\x1b[49m")).toBe(true);
	});

	it("划选行严格被 minSelectableRow 与 maxSelectableRow 限制，绝不向下污染输入框底边框与状态栏（图二）", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		const screenRows = [
			"第一行转录流正文",
			"第二行转录流正文",
			"╭── 输入框顶框 ──╮",
			"│ sssssssssss... │",
			"╰── 输入框底框 ──╯",
			"deepseek-v4-flash · medium · 缓存 -",
		];

		// 限制选区仅在第 0-1 行（即转录流可视区域）有效
		tracker.setSelectableRowRange(0, 1);

		// 1. 如果在输入框（第 3 行，1-indexed: 4）试图划选拖拽
		tracker.handleInput("\x1b[<0;5;4M", screenRows);
		// 不应启动划选
		expect(tracker.hasSelection()).toBe(false);

		// 拖拽到状态栏（第 5 行，1-indexed: 6）
		tracker.handleInput("\x1b[<32;20;6M", screenRows);
		expect(tracker.hasSelection()).toBe(false);

		// 2. 如果在第 0 行开始划选并一路拖拽到状态栏（第 5 行）
		tracker.handleInput("\x1b[<0;1;1M", screenRows);
		tracker.handleInput("\x1b[<32;20;6M", screenRows);
		expect(tracker.hasSelection()).toBe(true);

		const highlighted = tracker.applyHighlight(screenRows);
		// 第 0 行与第 1 行正常高亮
		expect(highlighted[0]).toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[1]).toContain("\x1b[48;2;59;74;102m");
		// 第 2、3、4、5 行（输入框边框与状态栏）绝对不受任何高亮污染！
		expect(highlighted[2]).not.toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[3]).not.toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[4]).not.toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[5]).not.toContain("\x1b[48;2;59;74;102m");
	});

	it("支持在聊天栏（输入框）中自由拖拽划选并自动复制文本，且选区严密隔离外边框与底部状态条", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		const screenRows = [
			"第一行转录流正文",
			"╭── 输入框顶框 ──╮",
			"│ sssssssssssssssss │",
			"╰── 输入框底框 ──╯",
			"deepseek-v4-flash · medium · 缓存 -",
		];

		// 注册独立区域：转录流（第 0 行）与输入框内容区（第 2 行）
		tracker.setSelectableRegions([
			{ id: "transcript", startRow: 0, endRow: 0, colStart: 0, colEnd: 50 },
			{ id: "input", startRow: 2, endRow: 2, colStart: 2, colEnd: 18 },
		]);

		let copiedText = "";
		// 在输入框第 2 行（1-indexed: 3），从 col 2（1-indexed: 3）拖拽划选到 col 10（1-indexed: 11）
		tracker.handleInput("\x1b[<0;3;3M", screenRows, (t) => {
			copiedText = t;
		});
		tracker.handleInput("\x1b[<32;11;3M", screenRows);

		expect(tracker.hasSelection()).toBe(true);

		const highlighted = tracker.applyHighlight(screenRows);
		// 第 2 行输入框内容被高亮包裹
		expect(highlighted[2]).toContain("\x1b[48;2;59;74;102m");
		// 边框行与状态栏绝不受污染
		expect(highlighted[1]).not.toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[3]).not.toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[4]).not.toContain("\x1b[48;2;59;74;102m");

		// 释放鼠标，触发复制
		tracker.handleInput("\x1b[<0;11;3m", screenRows, (t) => {
			copiedText = t;
		});
		expect(copiedText).toBe("ssssssss");
		expect(copiedText).not.toContain("│");
	});

	it("拖拽划选到上下边界时触发 dragEdge 信号，支持跨屏无损选区与文本复制", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		tracker.setSelectableRegions([
			{ id: "transcript", startRow: 0, endRow: 10, colStart: 0, colEnd: 60 },
			{ id: "input", startRow: 12, endRow: 14, colStart: 0, colEnd: 60 },
		]);

		const permanentLines = Array.from({ length: 30 }, (_, i) => `这是第 ${i} 行长长长长长的转录历史正文内容`);
		const screenRows = permanentLines.slice(10, 21);

		tracker.setScrollContext(10, 11);

		// 1. 在第 5 行（对应 contentRow 15）按下鼠标左键
		// col 5 (1-indexed: 6), row 5 (1-indexed: 6)
		const pressRes = tracker.handleInput("\x1b[<0;6;6M", screenRows, undefined, permanentLines);
		expect(pressRes.handled).toBe(true);

		// 2. 向上拖拽到第 1 行（边界区域 <= startRow + 1）
		const dragTopRes = tracker.handleInput("\x1b[<32;6;2M", screenRows, undefined, permanentLines);
		expect(dragTopRes.handled).toBe(true);
		expect(dragTopRes.dragEdge).toBe("top");

		// 3. 拖拽到中间第 5 行（安全非边缘区）
		const dragMidRes = tracker.handleInput("\x1b[<32;6;6M", screenRows, undefined, permanentLines);
		expect(dragMidRes.handled).toBe(true);
		expect(dragMidRes.dragEdge).toBeNull();

		// 4. 向下拖拽到第 10 行（边界区域 >= endRow - 1）
		const dragBottomRes = tracker.handleInput("\x1b[<32;6;11M", screenRows, undefined, permanentLines);
		expect(dragBottomRes.handled).toBe(true);
		expect(dragBottomRes.dragEdge).toBe("bottom");

		// 5. 模拟自动滚动向上滚到顶部（scrollStart 从 10 滚动到 0）
		tracker.setScrollContext(0, 11);
		tracker.updateFocusContent(0, 0, 0);

		// 此时 Anchor 在 contentRow 15，Focus 在 contentRow 0
		// 验证当前屏幕帧基于 contentRow 的高亮是否生效
		const currentScreenRows = permanentLines.slice(0, 11);
		const highlighted = tracker.applyHighlight(currentScreenRows, 0);
		// 第 0 行到第 10 行都在选区内（0 到 15）
		expect(highlighted[0]).toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[5]).toContain("\x1b[48;2;59;74;102m");
		expect(highlighted[10]).toContain("\x1b[48;2;59;74;102m");

		// 6. 松开鼠标左键，验证跨越了多页（0 到 15 行，共 16 行）的全量文本提取与复制
		let copiedText = "";
		const releaseRes = tracker.handleInput(
			"\x1b[<0;1;1m",
			currentScreenRows,
			(t) => {
				copiedText = t;
			},
			permanentLines,
		);
		expect(releaseRes.handled).toBe(true);
		expect(copiedText).toContain("这是第 0 行长长长长长的转录历史正文内容");
		// 起始点击在 col 5，向上选中到第 0 行时，终点行第 15 行精准截断至 anchor col
		expect(copiedText).toContain("这是第");
		const copiedLineCount = copiedText.split("\n").length;
		expect(copiedLineCount).toBe(16);
	});

	it("自动滚动后按新 viewport 更新拖选 focus 的 content row", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();
		const permanentLines = Array.from({ length: 30 }, (_, i) => `row ${i} contents`);
		tracker.setSelectableRegions([{ id: "transcript", startRow: 0, endRow: 9, colStart: 0, colEnd: 60 }]);
		tracker.setScrollContext(10);
		tracker.handleInput("\x1b[<0;1;6M", permanentLines.slice(10, 20));
		tracker.handleInput("\x1b[<32;4;10M", permanentLines.slice(10, 20));

		tracker.setScrollContext(11);
		tracker.updateFocusForScroll(11);
		const highlighted = tracker.applyHighlight(permanentLines.slice(11, 21), 11);
		expect(highlighted[9]).toContain("\x1b[48;2;59;74;102m");
	});

	it("TimelineRail 导航轨刻度与 Hover 气泡卡片生成", async () => {
		const { TimelineRailComponent } = await import("../src/ui/components/widgets/timeline-rail.js");
		const rail = new TimelineRailComponent();
		rail.updateTurns(
			[
				{ uid: 1, n: 1, userText: "第一轮用户问题" },
				{ uid: 2, n: 2, userText: "第二轮长问题" },
			],
			1,
		);

		const geo = rail.getGeometry(10)!;
		expect(geo).toBeDefined();
		const { railGlyphs } = rail.renderRailRows(10);
		expect(railGlyphs.length).toBe(10);
		expect(railGlyphs[geo.upRow]).toContain("▴");
		expect(railGlyphs[geo.downRow]).toContain("▾");
		expect(railGlyphs.some((g) => g.includes("━━"))).toBe(true);

		// 设置 hover 到第一个刻度所在行
		rail.setHover(geo.tickTop);
		const hovered = rail.renderRailRows(10);
		expect(hovered.previewCard).toBeDefined();
		expect(hovered.previewCard?.lines[1]).toContain("第一轮");
	});

	it("formatCacheHitRate 算法符合 dsh-TUI 规范", async () => {
		const { formatCacheHitRate } = await import("../src/ui/components/widgets/context-bar.js");
		// 1000 input, 9000 cacheRead, 0 cacheWrite -> total 10000, hit 90.0%
		const rate = formatCacheHitRate(9000, 1000, 0);
		expect(rate).toBe("90.0%");

		// Provider 报回 0 是事实（命中 0.0%）；只有字段缺省才是“未报告”。
		expect(formatCacheHitRate(0, 1000, 0)).toBe("0.0%");
		expect(formatCacheHitRate(undefined, 1000, 0)).toBeUndefined();
	});

	it("Ctrl+C 在输入框有内容时清空内容而不触发退出流程", () => {
		const harness = createTestTUI({
			modelName: "deepseek-chat",
			cwd: "e:/Uina/test",
			columns: 100,
			rows: 30,
		});
		try {
			let cancelCalled = false;
			harness.host.onCancel = () => {
				cancelCalled = true;
			};

			// 输入文字
			dispatchUIHostInput(harness.host, "hello world");
			expect(harness.host.inputLine.getText()).toBe("hello world");

			// 按 Ctrl+C：应清空输入框内容，不应退出也不应触发退出确认
			dispatchUIHostInput(harness.host, "\x03"); // Ctrl+C
			expect(harness.host.inputLine.getText()).toBe("");
			expect(cancelCalled).toBe(false);

			// 输入框已清空后，UI 将 Ctrl+C 意图发送给组合根。
			dispatchUIHostInput(harness.host, "\x03");
			expect(cancelCalled).toBe(true);
		} finally {
			harness.dispose();
		}
	});

	describe("UI Architecture & Component Integrity Fixes", () => {
		it("truncateToWidth 当 maxWidth 小于省略号长度时安全降级不超宽", () => {
			expect(visibleWidth(fitLine("hello", 1, "clip"))).toBeLessThanOrEqual(1);
			expect(visibleWidth(fitLine("hello", 0, "clip"))).toBe(0);
			expect(visibleWidth(fitLine("hello", 2, "clip"))).toBeLessThanOrEqual(2);
		});

		it("EffortSlider 在只有少量或单个档位时安全初始化不发生越界崩溃", () => {
			const slider1 = new EffortSlider("high", [{ id: "high", name: "High", description: "Deep" }]);
			expect(slider1.getFocusedTier()?.id).toBe("high");
			slider1.handleInput("[C"); // Key.right：单档位无处可去
			slider1.handleInput("[D"); // Key.left
			expect(slider1.getFocusedTier()?.id).toBe("high");

			const slider2 = new EffortSlider("unknown", [{ id: "low", name: "Low", description: "Fast" }]);
			// A5：未声明档位不预选（✓ 不亮），焦点停在第一档用于导航
			expect(slider2.getActiveTierId()).toBeUndefined();
			expect(slider2.getFocusedTier()?.id).toBe("low");
		});

		it("EffortSlider 预览/提交分离（F4）：←/→ 只动焦点，Enter 才写回", () => {
			const changedLevels: string[] = [];
			const slider = new EffortSlider("off", ["off", "high", "max"]);
			slider.onChange = (level) => changedLevels.push(level);

			expect(slider.getFocusedTier()?.id).toBe("off");

			slider.handleInput("\x1b[C"); // Key.right：预览，不写回
			expect(slider.getFocusedTier()?.id).toBe("high");
			expect(slider.getActiveTierId()).toBe("off");
			expect(changedLevels).toEqual([]);

			slider.handleInput("\x1b[C"); // Key.right
			expect(slider.getFocusedTier()?.id).toBe("max");

			slider.handleInput("\r"); // Enter 提交
			expect(slider.getActiveTierId()).toBe("max");
			expect(changedLevels).toEqual(["max"]);

			slider.handleInput("\x1b[D"); // Key.left 预览回 high
			slider.handleInput("\x1b"); // Esc 回滚：不写回
			expect(slider.getFocusedTier()?.id).toBe("high");
			expect(slider.getActiveTierId()).toBe("max");
			expect(changedLevels).toEqual(["max"]);
		});

		it("UIHost: openEffortSlider 传入 ThinkingLevel[] 字符串并在按右箭头时不发生 toLowerCase 崩溃", () => {
			const host = new UIHost({
				modelName: "deepseek-test",
				thinkingLevels: ["off", "high", "max"],
				thinkingLevel: "off",
				terminal: {
					columns: 80,
					rows: 24,
					start: () => {},
					stop: () => {},
					write: () => {},
					onResize: () => {},
				} as any,
			});
			installUIFeatures(host, new TrajectoryProjection());

			let changed: string = "";
			// 模拟 builtin.ts 中执行 /effort 打开滑块传入 declaredLevels 字符串数组
			installUIFeatures(host, new TrajectoryProjection());
			host.openFeature({
				name: "effort-slider",
				payload: {
					currentLevel: "off",
					tiers: ["off", "high", "max"],
					onChange: (level: string) => {
						changed = level;
					},
				},
			});

			expect(() => dispatchUIHostInput(host, "\x1b[C")).not.toThrow();
			expect(changed).toBe("");
			dispatchUIHostInput(host, "\r");
			expect(host.getReasoningEffort()).toBe("high");
			expect(() => host.setReasoningEffort(undefined)).not.toThrow();
		});

		it("openFeature signal 只关闭所属面板并在普通关闭时移除监听", () => {
			const harness = createTestTUI();
			try {
				const signal = new AbortController();
				expect(harness.host.openFeature({ name: "prompt", signal: signal.signal })).toBe(true);
				expect(harness.hasOverlay).toBe(true);

				harness.host.closeModal();
				expect(harness.hasOverlay).toBe(false);
				expect(harness.host.openFeature({ name: "prompt" })).toBe(true);
				signal.abort();
				expect(harness.hasOverlay).toBe(true);
				harness.host.closeModal();
				expect(harness.hasOverlay).toBe(false);
			} finally {
				harness.dispose();
			}
		});

		it("InteractiveTUI 从 RuntimeEvent 投影模型、思考档位和压缩事实", () => {
			const tui = new InteractiveTUI({ thinkingLevels: ["high"] });
			tui.consume(record({ type: "model_select", model: "provider/new-model" }));
			tui.consume(record({ type: "thinking_level_select", level: "high" }));
			tui.consume(
				record({
					type: "session_compact",
					operationId: "compact-1",
					status: "completed",
					summary: "compacted summary",
					retainedTailEntries: 2,
					tokensBefore: 5000,
				}),
			);

			expect(getTestUIHost(tui).modelName).toBe("provider/new-model");
			expect(getTestUIHost(tui).getReasoningEffort()).toBe("high");
			expect(getTestUIHost(tui).transcript.render(80).join("\n")).toContain("compacted summary");
			expect(
				getTestTrajectoryProjection(tui)
					.list()
					.some((node) => node.kind === "compaction"),
			).toBe(true);
			tui.close();
		});

		it("压缩进度单一写入者（C5）：工作指示经槽位层并列显示，终态清除并出卡", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const tui = createTestTUI({ columns: 120, rows: 30 });
			try {
				// 进度的唯一写入者是 builtin 扩展（pi.ui.setWorking）；这里从同一入口驱动。
				tui.tui.extensionUI.setWorking("compaction", "正在压缩上下文：生成历史摘要（已接收 12000 字）");
				await vi.advanceTimersByTimeAsync(50);
				expect(tui.visibleText).toContain("正在压缩上下文：生成历史摘要（已接收 12000 字）");
				expect(isHeartbeatActive(tui.host)).toBe(true);

				// 第二条工作指示并列可见（C6），不是互相覆盖
				tui.tui.extensionUI.setWorking("world", "正在等待世界回复");
				await vi.advanceTimersByTimeAsync(50);
				expect(tui.visibleText).toContain("正在等待世界回复");
				expect(tui.visibleText).toContain("正在压缩上下文：生成历史摘要（已接收 12000 字）");

				tui.tui.extensionUI.setWorking("compaction", undefined);
				tui.tui.consume(
					record({ type: "session_compact", operationId: "compact-1", status: "failed", error: "摘要模型请求终止" }),
				);
				await vi.advanceTimersByTimeAsync(50);
				expect(tui.visibleText).not.toContain("正在压缩上下文");
				// 失败原因作为终态卡片留在转录里；即时 toast 同步提示（W4 收口）。
				expect(tui.visibleText).toContain("压缩失败");
				expect(tui.visibleText).toContain("摘要模型请求终止");
				tui.tui.extensionUI.setWorking("world", undefined);
				await vi.advanceTimersByTimeAsync(50);
				expect(isHeartbeatActive(tui.host)).toBe(false);
			} finally {
				tui.dispose();
				vi.useRealTimers();
			}
		});

		it("TranscriptContainer 严格保证思考、文本、运行中工具与完成工具的时间序节点流", () => {
			const transcript = new TranscriptContainer();
			transcript.startTurn(1, "用户输入");
			transcript.appendThinking("开始推理");
			transcript.appendToken("第一段文本回复");
			transcript.startTool(toolStartNode("bash", { command: "ls" }, "call-1"));

			let lines = transcript.render(80).join("\n");
			expect(lines).toContain("开始推理");
			expect(lines).toContain("第一段文本回复");
			expect(lines).toContain("Bash");
			expect(lines).toContain("执行中…");

			transcript.addToolDone(toolDoneNode("bash", "file1.txt\nfile2.txt", 120, "succeeded", "call-1"));
			transcript.appendToken("工具完成后的后续回复");

			lines = transcript.render(80).join("\n");
			expect(lines).toContain("file1.txt");
			expect(lines).toContain("工具完成后的后续回复");

			const idx1 = lines.indexOf("第一段文本回复");
			const idxTool = lines.indexOf("file1.txt");
			const idx2 = lines.indexOf("工具完成后的后续回复");
			expect(idx1).toBeLessThan(idxTool);
			expect(idxTool).toBeLessThan(idx2);
		});

		it("TranscriptContainer 遇到带 ANSI 样式的代码块边框时不误判为嵌套框", () => {
			const transcript = new TranscriptContainer();
			transcript.startTurn(1, "写个函数");
			transcript.appendToken("```ts\n\x1b[36mconst a = 1;\x1b[0m\n```");
			const rendered = transcript.render(80).join("\n");
			expect(rendered).toContain("const a = 1;");
		});

		it("InputLine Ctrl+A 仅标记全选状态，不篡改系统剪贴板", () => {
			const box = new InputLine();
			box.handleInput("重要数据文本");
			expect(box.hasSelection()).toBe(false);

			box.handleInput("\x01");
			expect(box.hasSelection()).toBe(true);
			expect(box.getText()).toBe("重要数据文本");

			box.handleInput("x");
			expect(box.getText()).toBe("x");
			expect(box.hasSelection()).toBe(false);
		});

		it("Banner 启动徽标鲸鱼图案采用 Uina 雾蓝主题色", () => {
			const banner = getStartupBanner({ cwd: process.cwd() }, 100);
			const text = banner.join("\n");
			expect(text).toContain("Local · Open · Extensible");
			expect(text).toContain("38;2;74;138;212m");
		});

		it("segmentWithMarkers 将粘贴标记合并为单一原子片段且正常分词", () => {
			const text = "前缀 [已粘贴 #1 +10行] 后缀";
			const validIds = new Set([1]);
			const segments = segmentWithMarkers(text, validIds);

			const chipSeg = segments.find((s) => s.segment === "[已粘贴 #1 +10行]");
			expect(chipSeg).toBeDefined();
			expect(chipSeg?.index).toBe(3);

			// 验证标记内部字符不会被拆分成单独字形
			expect(segments.some((s) => s.segment === "已" && s.index > 3 && s.index < 18)).toBe(false);

			// snapCursorToMarkerBoundary 验证：落在标记中间的光标吸附到边缘
			expect(snapCursorToMarkerBoundary(5, text, validIds)).toBe(3); // 靠近 start
			expect(snapCursorToMarkerBoundary(15, text, validIds)).toBe(16); // 靠近 end (3 + 13)
			expect(snapCursorToMarkerBoundary(1, text, validIds)).toBe(1); // 标记外不受影响
		});

		it("InputLine 退格与方向键原子化操作粘贴标记", () => {
			const box = new InputLine();
			box.insertText("func main() {\n\tprintln(1)\n}\n");
			const textWithChip = box.getRawText();
			expect(textWithChip).toContain("[已粘贴 #1 +4行]");

			// 光标在标记末尾，按退格原子删除整块标记
			box.handleInput("\x7f");
			expect(box.getRawText()).toBe("");

			// 重新插入，测试移到标记前按 Delete 原子删除
			box.insertText("func main() {\n\tprintln(1)\n}\n");
			expect(box.getRawText()).toContain("[已粘贴 #2 +4行]");
			box.handleInput("\x1b[D"); // 左移：整块跳至 start (0)
			expect(box.hasChipAtCursor()).toBe(true);
			box.handleInput("\x1b[3~"); // Delete
			expect(box.getRawText()).toBe("");
		});

		it("allocateBarColumns 最大余数算法精确分配各段宽度", () => {
			const values = [100, 200, 300, 400, 0, 1000]; // 最后一项为 free
			const width = 20;
			const allocated = allocateBarColumns(values, width);

			expect(allocated.length).toBe(values.length);
			expect(allocated.reduce((a, b) => a + b, 0)).toBe(width);
			// 0 tokens 的段分配 0 列
			expect(allocated[4]).toBe(0);
			// 非 0 的段至少分配 1 列
			expect(allocated[0]).toBeGreaterThanOrEqual(1);
			expect(allocated[1]).toBeGreaterThanOrEqual(1);
			expect(allocated[2]).toBeGreaterThanOrEqual(1);
			expect(allocated[3]).toBeGreaterThanOrEqual(1);
			expect(allocated[5]).toBeGreaterThanOrEqual(1);
		});

		it("renderSegmentedBar 渲染带有多段色彩规范的进度条", () => {
			const segments = {
				system: 1000,
				prompt: 2000,
				assistant: 3000,
				thinking: 1500,
				tools: 500,
			};
			const bar = renderSegmentedBar(segments, 8000, 16000, 20);
			// 包含各分段色彩 ANSI 码
			expect(bar).toContain("38;2;70;95;145m"); // system
			expect(bar).toContain("38;2;90;125;190m"); // prompt
			expect(bar).toContain("38;2;74;138;212m"); // assistant
			expect(bar).toContain("38;2;155;114;207m"); // thinking
			expect(bar).toContain("38;2;46;184;138m"); // tools
			expect(bar).toContain("░"); // 空闲空间

			// 无 segments 时平滑降级
			const fallbackBar = renderSegmentedBar(undefined, 8000, 16000, 10);
			expect(fallbackBar).toContain("█");
			expect(fallbackBar).toContain("░");
		});

		it("formatTpsGauge 正确映射 1/8 字符精度与高低速颜色", () => {
			const fastGauge = formatTpsGauge(65, 60, 8);
			expect(fastGauge).toContain(C.success);
			expect(fastGauge).toContain("▕");
			expect(fastGauge).toContain("▏");

			const medGauge = formatTpsGauge(35, 60, 8);
			expect(medGauge).toContain(C.warning);

			const slowGauge = formatTpsGauge(10, 60, 8);
			expect(slowGauge).toContain(C.inactive);
			expect(slowGauge).not.toContain(C.error);

			const slowHeader = formatActivityHeader(
				{
					phase: "streaming",
					message: "生成中",
					elapsedMs: 1000,
					outputTokens: 10,
					tps: 10,
					tokensEstimated: true,
					tpsEstimated: true,
				},
				80,
			);
			expect(slowHeader).toContain(C.inactive);
			expect(slowHeader).not.toContain(C.error);
		});

		it("formatTpsSparkline 正确将多段采样归一化为火花线字符", () => {
			const samples = [10, 25, 40, 60, 80];
			const spark = formatTpsSparkline(samples);
			expect(spark.length).toBe(5);
			expect(spark[0]).toBe(" ");
			expect(spark[spark.length - 1]).toBe("█");
		});

		it("ActivityLineComponent 在完成时输出耗时、Token数与火花线趋势图", () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(1_700_000_000_000);
				const act = new ActivityLineComponent();
				act.start("streaming", "正在生成回复...");
				act.addStreamText("先想一下"); // 字符估算占位
				vi.setSystemTime(1_700_000_001_000);
				act.addRealOutputTokens(80); // 收尾真值：它取代估算
				act.finish("生成结束", 1000);

				const header = act.getHeaderString(100);
				expect(header).toContain("生成结束");
				expect(header).toContain("耗时 1.0s");
				// 服务端报回的 80 是事实：不带估算标记。
				expect(header).toContain("80 tok");
				expect(header).not.toContain("~80 tok");
				expect(header).toContain("tps");
			} finally {
				vi.useRealTimers();
			}
		});

		it("ActivityLineComponent 运行态秒表分期、实时Token计数与响应式TPS仪表盘", () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(1_700_000_000_000);
				const act = new ActivityLineComponent();

				// 1. 初始阶段：尚未收到首个 token，展示等待响应与真实秒表
				act.start("thinking", "正在思考与生成回复...");
				vi.setSystemTime(1_700_000_001_500); // 1.5 秒后
				const waitingHeader = stripAnsi(act.getHeaderString(80));
				expect(waitingHeader).toContain("1.5s");
				expect(waitingHeader).toContain("等待响应");

				// 2. 流式吐字阶段：收到字符，实时展示估算 token
				act.addStreamText("这里是一段测试文本包含中文和English混合字符用来计算Token");
				vi.setSystemTime(1_700_000_002_500); // 1 秒解码耗时（跨越 500ms 门控）
				act.addStreamText("继续吐出更多内容");

				const liveHeader = stripAnsi(act.getHeaderString(100));
				expect(liveHeader).toContain("2.5s");
				expect(liveHeader).toContain("tok"); // 实时 token 计数
				expect(liveHeader).toContain("tps"); // 实时 TPS
				expect(liveHeader).toContain("▕"); // 包含仪表盘符号

				// 3. 窄屏自适应排版：在 45 列窄屏下自适应紧凑数字 TPS，且绝对不超宽
				const compactHeader = stripAnsi(act.getHeaderString(45));
				expect(visibleWidth(compactHeader)).toBeLessThanOrEqual(45);
				expect(compactHeader).toContain("2.5s");

				// 3.1 极限窄屏排版（20 列）：优先保全核心文案与秒表，且绝对 <= 20 列
				const extremeNarrow = stripAnsi(act.getHeaderString(20));
				expect(visibleWidth(extremeNarrow)).toBeLessThanOrEqual(20);

				// 4. 工具阶段：秒表展示为该工具的独立执行耗时；同时保留已结算的上一步解码流速（不被工具耗时稀释）
				act.endStep();
				act.update("tool", "正在执行工具: grep");
				vi.setSystemTime(1_700_000_005_700); // 工具跑了 3.2 秒
				const toolHeader = stripAnsi(act.getHeaderString(80));
				expect(toolHeader).toContain("3.2s");
				expect(toolHeader).toContain("正在执行工具: grep");
				expect(toolHeader).toContain("~29 tps"); // 保留上一 step 的真实解码流速
			} finally {
				vi.useRealTimers();
			}
		});

		it("formatActivityHeader 纯函数排版分级与数学无溢出闭环验证", async () => {
			const { formatActivityHeader } = await import("../src/ui/components/widgets/activity-line.js");

			// 1. 宽屏充裕模式（100 列）：完整展现 8 格仪表盘、Token 与秒表
			const wide = stripAnsi(
				formatActivityHeader(
					{
						phase: "streaming",
						message: "正在输出回复...",
						elapsedMs: 3500,
						outputTokens: 140,
						tps: 40,
						tpsSamples: [30, 40],
						tokensEstimated: true,
						tpsEstimated: true,
					},
					100,
				),
			);
			expect(visibleWidth(wide)).toBeLessThanOrEqual(100);
			expect(wide).toContain("3.5s");
			expect(wide).toContain("~140 tok");
			expect(wide).toContain("~40 tps");
			expect(wide).toContain("▕");

			// 2. 中屏模式（60 列）：4 格紧凑图形仪表盘
			const mid = stripAnsi(
				formatActivityHeader(
					{
						phase: "streaming",
						message: "正在输出回复...",
						elapsedMs: 3500,
						outputTokens: 140,
						tps: 40,
						tokensEstimated: true,
						tpsEstimated: true,
					},
					60,
				),
			);
			expect(visibleWidth(mid)).toBeLessThanOrEqual(60);
			expect(mid).toContain("~40 tps");

			// 3. 窄屏模式（45 列）：纯数字流速
			const narrow = stripAnsi(
				formatActivityHeader(
					{
						phase: "streaming",
						message: "正在输出回复...",
						elapsedMs: 3500,
						outputTokens: 140,
						tps: 40,
						tokensEstimated: true,
						tpsEstimated: true,
					},
					45,
				),
			);
			expect(visibleWidth(narrow)).toBeLessThanOrEqual(45);
			expect(narrow).toContain("~40 tps");

			// 4. 极窄模式（25 列）：自动舍弃后缀，优先保全核心文案与秒表
			const extreme = stripAnsi(
				formatActivityHeader(
					{
						phase: "streaming",
						message: "正在输出回复...",
						elapsedMs: 3500,
						outputTokens: 140,
						tps: 40,
						tokensEstimated: true,
						tpsEstimated: true,
					},
					25,
				),
			);
			expect(visibleWidth(extreme)).toBeLessThanOrEqual(25);
			expect(extreme).toContain("3.5s");

			// 5. 工具执行模式：保留已结算的上一步解码生成流速（不被工具执行耗时稀释）
			const toolLine = stripAnsi(
				formatActivityHeader(
					{
						phase: "tool",
						message: "正在执行工具: bash",
						elapsedMs: 2400,
						outputTokens: 140,
						tps: 40,
						tokensEstimated: true,
						tpsEstimated: true,
					},
					80,
				),
			);
			expect(toolLine).toContain("2.4s");
			expect(toolLine).toContain("正在执行工具: bash");
			expect(toolLine).toContain("~40 tps");

			// 6. 无解码记录时：不渲染虚假的 tps（未知不是 0）
			const noTpsLine = stripAnsi(
				formatActivityHeader(
					{
						phase: "tool",
						message: "正在执行工具: bash",
						elapsedMs: 2400,
						outputTokens: 0,
						tokensEstimated: false,
						tpsEstimated: false,
					},
					80,
				),
			);
			expect(noTpsLine).not.toContain("tps");
		});

		it("calculateContextSegments 从消息历史与工具定义中计算多段分布并支持比例对齐", () => {
			const messages = [
				{ role: "system" as const, content: "系统提示词设定" },
				{ role: "user" as const, content: "请写一段代码" },
				{ role: "assistant" as const, content: "代码如下：", thinking: "先思考算法" },
				{ role: "tool" as const, content: "tool output result", tool_call_id: "c1" },
			];
			const tools = [
				{ type: "function" as const, function: { name: "test_tool", description: "test", parameters: {} } },
			];
			const rawSegments = calculateContextSegments(messages, tools);
			expect(rawSegments.system).toBeGreaterThan(0);
			expect(rawSegments.prompt).toBeGreaterThan(0);
			expect(rawSegments.assistant).toBeGreaterThan(0);
			expect(rawSegments.thinking).toBeGreaterThan(0);
			expect(rawSegments.tools).toBeGreaterThan(0);

			// 验证传入 totalScaleTokens 时的精确归一化
			const scaled = calculateContextSegments(messages, tools, 1000);
			const sum = scaled.system + scaled.prompt + scaled.assistant + scaled.thinking + scaled.tools;
			expect(sum).toBe(1000);
		});

		it("ContextBar 展开时展示剩余容量、各分段分布与缓存明细且无冗余百分比", () => {
			const bar = new ContextBarComponent();
			bar.update({
				usedTokens: 9500,
				contextWindow: 124000,
				cwd: "E:\\Uina\\Uina",
				cacheRead: 8800,
				cacheWrite: 0,
				inputTokens: 192,
				segments: {
					system: 1200,
					prompt: 3400,
					assistant: 2100,
					thinking: 1800,
					tools: 1000,
				},
			});
			bar.setHovered(true);
			const line = bar.render(120)[0]!;
			expect(line).toContain("剩余 114.5k");
			expect(line).toContain("系统 1.2k");
			expect(line).toContain("提示 3.4k");
			expect(line).toContain("助手 2.1k");
			expect(line).toContain("思考 1.8k");
			expect(line).toContain("工具 1.0k");
			expect(line).toContain("缓存读 8.8k");
			expect(line).toContain("输入 192");
			// 彻底去除底边框已有的冗余重复数据
			expect(line).not.toContain("7.7%");
			expect(line).not.toContain("9.5k/124.0k");
		});

		it("ContextBar 对估算用量在剩余容量前加 ~", () => {
			const bar = new ContextBarComponent();
			bar.update({ usedTokens: 1000, contextWindow: 65536, estimated: true });
			bar.setHovered(true);
			expect(bar.render(80)[0]).toContain("剩余 ~64.5k");
		});

		it("InputLine 光标移动到前部输入字符、换行或删除时，光标精准跟随就地编辑，绝不跳到行尾", async () => {
			const { InputLine } = await import("../src/ui/components/editor/input-line.js");
			const box = new InputLine();

			// 1. 输入基础内容 "hello world"
			box.handleInput("hello world");
			expect(box.getText()).toBe("hello world");
			expect(box.getCursorIndex()).toBe(11);

			// 2. 将光标向左移动 5 次，定位到 "hello " 与 "world" 之间（索引 6）
			for (let i = 0; i < 5; i++) {
				box.handleInput("\x1b[D");
			}
			expect(box.getCursorIndex()).toBe(6);

			// 3. 在中间输入字符 "x"：文本变为 "hello xworld"，光标应前进一步到达 7，绝不能跳回末尾 12
			box.handleInput("x");
			expect(box.getText()).toBe("hello xworld");
			expect(box.getCursorIndex()).toBe(7);

			// 4. 再次连续输入 "yz"：光标平滑跟进至 9
			box.handleInput("y");
			box.handleInput("z");
			expect(box.getText()).toBe("hello xyzworld");
			expect(box.getCursorIndex()).toBe(9);

			// 5. 按 Delete 键：删除光标后面的 "w"，光标保持在 9，绝不跳到行尾
			box.handleInput("\x1b[3~");
			expect(box.getText()).toBe("hello xyzorld");
			expect(box.getCursorIndex()).toBe(9);

			// 6. 按 Shift+Enter 换行：插入 \n，光标跳到新行首（索引 10），绝不跳到全文末尾
			box.handleInput("\x1b[13;2u");
			expect(box.getText()).toBe("hello xyz\norld");
			expect(box.getCursorIndex()).toBe(10);
		});

		it("TextBuffer: 核心文本与光标缓冲区深模块原子契约", async () => {
			const { TextBuffer } = await import("../src/ui/core/text-buffer.js");
			const buf = new TextBuffer();

			// 1. 初始化
			expect(buf.text).toBe("");
			expect(buf.cursor).toBe(0);
			expect(buf.length).toBe(0);

			// 2. 插入文本
			buf.insert("hello world");
			expect(buf.text).toBe("hello world");
			expect(buf.cursor).toBe(11);
			expect(buf.length).toBe(11);

			// 3. 移动光标并就地插入
			buf.setCursor(5);
			expect(buf.cursor).toBe(5);
			buf.insert(" amazing");
			expect(buf.text).toBe("hello amazing world");
			expect(buf.cursor).toBe(13);

			// 4. deleteBackward 与 deleteForward
			buf.deleteBackward(); // 删掉 'g'
			expect(buf.text).toBe("hello amazin world");
			expect(buf.cursor).toBe(12);

			buf.deleteForward(); // 删掉 ' '
			expect(buf.text).toBe("hello amazinworld");
			expect(buf.cursor).toBe(12);

			// 5. deleteRange 原子范围删除
			buf.deleteRange(6, 12); // 删掉 'amazin'
			expect(buf.text).toBe("hello world");
			expect(buf.cursor).toBe(6);

			// 6. replaceRange 原子范围替换
			buf.replaceRange(6, 11, "Antigravity");
			expect(buf.text).toBe("hello Antigravity");
			expect(buf.cursor).toBe(17);

			// 7. setText 默认保持当前合法光标位置并 clamp
			buf.setText("hello");
			expect(buf.text).toBe("hello");
			expect(buf.cursor).toBe(5); // 17 clamp 到 5

			buf.setCursor(2);
			buf.setText("hello uina");
			expect(buf.cursor).toBe(2); // 未超出时保持 2

			// 8. clear 清空
			buf.clear();
			expect(buf.text).toBe("");
			expect(buf.cursor).toBe(0);
			expect(buf.length).toBe(0);
		});
	});

	describe("Phase 2: Scrollbar Gutter, Smooth Reveal, and Split Diff", () => {
		it("ScrollbarGutterComponent 正确映射比例几何与滑块高度", () => {
			const gutter = new ScrollbarGutterComponent();
			// viewport: 20, content: 100, scrollTop: 0 (顶部)
			const geoTop = gutter.computeGeometry(20, 100, 0);
			expect(geoTop).not.toBeNull();
			// thumbH = round(20*20 / 100) = 4
			expect(geoTop!.thumbH).toBe(4);
			expect(geoTop!.thumbTop).toBe(0);
			expect(geoTop!.thumbBottom).toBe(4);
			expect(geoTop!.maxScroll).toBe(80);

			// scrollTop 滚到底部 (80)
			const geoBottom = gutter.computeGeometry(20, 100, 80);
			expect(geoBottom!.thumbBottom).toBe(20);
			expect(geoBottom!.thumbTop).toBe(16); // 20 - 4

			// 点击行映射回 scrollTop
			expect(gutter.mapRowToScrollTop(0, geoTop!)).toBe(0);
			expect(gutter.mapRowToScrollTop(16, geoTop!)).toBe(80);
		});

		it("ScrollbarGutterComponent 渲染纤细雅致滑块与悬停位置气泡片", () => {
			const gutter = new ScrollbarGutterComponent();
			expect(gutter.getThumbStyle()).toBe("slim");
			const res = gutter.renderGutterRows(20, 100, 40);
			expect(res.gutterGlyphs.length).toBe(20);
			// 默认 thumb 字符为纤细右半方块 ▐，闲置色为 C.subtle
			const thumbRows = res.gutterGlyphs.filter((g) => g.includes("▐"));
			expect(thumbRows.length).toBe(4);
			expect(thumbRows.some((g) => g.includes("\x1b[38;2;94;102;115m"))).toBe(true);

			// 支持切换为 wide 宽幅模式
			gutter.setThumbStyle("wide");
			const wideRes = gutter.renderGutterRows(20, 100, 40);
			expect(wideRes.gutterGlyphs.filter((g) => g.includes("██")).length).toBe(4);

			// 悬停时生成位置卡片气泡并点亮 claude 色
			gutter.setThumbStyle("slim");
			gutter.setHover(10);
			const hoveredRes = gutter.renderGutterRows(20, 100, 40);
			expect(hoveredRes.hoverChip).toBeDefined();
			expect(hoveredRes.hoverChip!.lines[0]).toContain("%");
			expect(hoveredRes.hoverChip!.lines[0]).toContain("/100");
			expect(hoveredRes.gutterGlyphs[10]).toContain("\x1b[38;2;125;161;222m"); // C.claude
		});

		it("UIHost 默认使用 timeline 模式，并支持与 scrollbar 相互切换", () => {
			const host = new UIHost();
			expect(host.getGutterMode()).toBe("timeline");
			host.setGutterMode("scrollbar");
			expect(host.getGutterMode()).toBe("scrollbar");
			host.toggleGutterMode();
			expect(host.getGutterMode()).toBe("timeline");
		});

		it("UIHost 自动滚屏定时器驱动与平稳停止", () => {
			const host = new UIHost();
			// 默认 maxScroll 为 0，此时 startAutoScroll 不会无故起动计时器
			host.startAutoScroll("up");
			expect(host.scroll.isAutoScrolling()).toBe(false);
			// 构造可滚动内容规模（totalPerm=70, transcriptH=20 → maxScroll=50）
			host.scroll.markContent(70, 20);

			host.startAutoScroll("up");
			expect(host.scroll.isAutoScrolling("up")).toBe(true);

			// 停止自动滚屏
			host.stopAutoScroll();
			expect(host.scroll.isAutoScrolling()).toBe(false);

			// 键盘输入应当立刻打断自动滚屏
			host.startAutoScroll("up");
			expect(host.scroll.isAutoScrolling()).toBe(true);
			dispatchUIHostInput(host, "a");
			expect(host.scroll.isAutoScrolling()).toBe(false);
		});

		it("ScrollbarGutterComponent 非滑块轨道保持纯净空格，绝无杂乱竖线 │", () => {
			const gutter = new ScrollbarGutterComponent();
			gutter.setHover(5);
			const res = gutter.renderGutterRows(20, 100, 40);
			// 确保没有任何行包含 │
			for (const g of res.gutterGlyphs) {
				expect(g.includes("│")).toBe(false);
			}
		});

		it("TimelineRailComponent 严格使用 TrueColor，无纯黑或 dim 字符，正确呈现 ▴ / ▾ 与刻度线", () => {
			const rail = new TimelineRailComponent();
			rail.updateTurns(
				[
					{ uid: 1, n: 1, userText: "问题一" },
					{ uid: 2, n: 2, userText: "问题二" },
				],
				2,
			);
			const res = rail.renderRailRows(20, true, true, false);
			// 包含顶底小三角 ▴ / ▾
			expect(res.railGlyphs.some((g) => g.includes("▴"))).toBe(true);
			expect(res.railGlyphs.some((g) => g.includes("▾"))).toBe(true);
			// 包含活跃粗刻度 ━━ 与闲置刻度 ─
			expect(res.railGlyphs.some((g) => g.includes("━━"))).toBe(true);
			expect(res.railGlyphs.some((g) => g.includes("─"))).toBe(true);
			// 严格绝不出现 C.dim (\x1b[2m) 或 C.gray (\x1b[90m)，防止在深色终端黑屏不可见
			for (const g of res.railGlyphs) {
				expect(g.includes("\x1b[2m")).toBe(false);
				expect(g.includes("\x1b[90m")).toBe(false);
			}
		});

		it("TimelineRailComponent 刻度密度随视口高度自适应，并可用 maxTicks 收紧", () => {
			const rail = new TimelineRailComponent();
			const turns = Array.from({ length: 50 }, (_, i) => ({ uid: i + 1, n: i + 1, userText: `用户轮次 ${i + 1}` }));
			rail.updateTurns(turns, 50);

			// 46 行终端：可用刻度 = height - 6 = 40（保留顶底呼吸留白），不再有固定 24 上限
			const geo = rail.getGeometry(46, true);
			expect(geo).not.toBeNull();
			expect(geo!.shown).toBe(40);
			expect(geo!.upRow).toBe(2);
			expect(geo!.tickTop).toBe(3);
			expect(geo!.downRow).toBe(43);

			// 调用方可用 maxTicks 收紧到 24：blockTop = (46 - 26) / 2 = 10
			const capped = new TimelineRailComponent({ maxTicks: 24 });
			capped.updateTurns(turns, 50);
			const cappedGeo = capped.getGeometry(46, true);
			expect(cappedGeo!.shown).toBe(24);
			expect(cappedGeo!.upRow).toBe(10);
			expect(cappedGeo!.tickTop).toBe(11);
			expect(cappedGeo!.downRow).toBe(35);

			const res = rail.renderRailRows(46, true, true, false, 80);
			// 闲置刻度严格使用 C.subtle (\x1b[38;2;94;102;115m)
			expect(res.railGlyphs.some((g) => g.includes("\x1b[38;2;94;102;115m ─"))).toBe(true);
			// 活跃刻度使用 C.bold + C.text
			expect(res.railGlyphs.some((g) => g.includes("━━"))).toBe(true);
			// 顶底空隙应为纯空白占位
			expect(res.railGlyphs[0]).toBe("  ");
			expect(res.railGlyphs[1]).toBe("  ");
			expect(res.railGlyphs[44]).toBe("  ");
			expect(res.railGlyphs[45]).toBe("  ");
		});

		it("TimelineRailComponent 预览卡宽度随内容宽度伸缩", () => {
			const rail = new TimelineRailComponent();
			const turns = [{ uid: 1, n: 1, userText: "这是一个相当长的轮次标题用于测试预览卡宽度自适应" }];
			rail.updateTurns(turns, 1);
			rail.setHoverTurnUid(1);
			const narrow = rail.renderRailRows(12, true, true, true, 40).previewCard;
			const wide = rail.renderRailRows(12, true, true, true, 200).previewCard;
			expect(narrow).toBeDefined();
			expect(wide).toBeDefined();
			expect(visibleWidth(narrow!.lines[1]!)).toBeLessThan(visibleWidth(wide!.lines[1]!));
			expect(visibleWidth(wide!.lines[1]!)).toBeLessThanOrEqual(48 + 6);
		});

		it("TimelineRailComponent 在轮次编号撞号时按 uid 区分刻度", () => {
			const rail = new TimelineRailComponent();
			rail.updateTurns(
				[
					{ uid: 11, n: 1, userText: "第一轮" },
					{ uid: 12, n: 1, userText: "撞号的第七轮" },
				],
				12,
			);
			const geo = rail.getGeometry(10)!;
			const active = rail.renderRailRows(10);
			// 活跃刻度只能是 uid=12 那一行；按 n 查找会命中第 0 行。
			expect(active.railGlyphs[geo.tickTop]!.includes("━━")).toBe(false);
			expect(active.railGlyphs[geo.tickTop + 1]!.includes("━━")).toBe(true);

			rail.setHoverTurnUid(11);
			const hovered = rail.renderRailRows(10);
			expect(hovered.railGlyphs[geo.tickTop]!.includes("──")).toBe(true);
			expect(hovered.railGlyphs[geo.tickTop + 1]!.includes("──")).toBe(false);
			expect(hovered.previewCard?.lines[1]).toContain("第一轮");

			// 点击目标必须带 uid，否则调用方只能拿撞号的 n 去定位。
			expect(rail.getClickTarget(geo.tickTop, 10)?.turnUid).toBe(11);
			expect(rail.getClickTarget(geo.tickTop + 1, 10)?.turnUid).toBe(12);
		});

		it("SmoothReveal revealStep 算法严格按照指数级追赶", () => {
			expect(revealStep(0)).toBe(3); // MIN_STEP
			expect(revealStep(8)).toBe(3); // ceil(8/8) = 1, min = 3
			expect(revealStep(32)).toBe(4); // ceil(32/8) = 4
			expect(revealStep(80)).toBe(10); // ceil(80/8) = 10
			expect(revealStep(800)).toBe(100);
		});

		it("SmoothReveal safeSliceEnd 正确保护 UTF-16 代理对不被撕裂", () => {
			const text = "你好👋世界";
			// 👋 的 unicode 范围是代理对 (high surrogate + low surrogate)
			// '你好'.length = 2, '👋'.length = 2 ('你好👋'.length = 4)
			// 如果尝试切在第 3 个 code unit (在代理对中间)
			const safe = safeSliceEnd(text, 3);
			// 代理对高位在 index 2，低位在 index 3，safeSliceEnd 应包含整对 (4)
			expect(safe).toBe(4);
			expect(text.slice(0, safe)).toBe("你好👋");
		});

		it("SmoothRevealController 流式渐进揭示与 snapToLatest 快进", () => {
			const controller = new SmoothRevealController({ enabled: true });
			const key = "test-turn";
			const fullText = "这是一段很长的大模型回复文本，用于测试流式平滑揭示效果。";

			controller.feed(key, fullText);
			const step1 = controller.getRevealedText(key, fullText, true);
			expect(step1.length).toBeLessThan(fullText.length);
			expect(step1.length).toBeGreaterThan(0);

			// 快进
			controller.snapToLatest(key);
			const finalStep = controller.getRevealedText(key, fullText, true);
			expect(finalStep).toBe(fullText);
			expect(controller.isSettled(key)).toBe(true);
		});

		it("computeWordDiff 正确提取公共缩进并高亮变更词段", () => {
			const oldLine = "  const foo = 123;";
			const newLine = "  const foo = 456;";
			const diff = computeWordDiff(oldLine, newLine);
			expect(diff.oldFormatted).toContain("  "); // 保留前导空格
			expect(diff.oldFormatted).toContain("123");
			expect(diff.newFormatted).toContain("456");
		});

		it("alignSplitDiff 将增删块配对为并排双栏行数组", () => {
			const oldText = "line1\nline2_old\nline3";
			const newText = "line1\nline2_new\nline3";
			const { rows, addCount, delCount } = alignSplitDiff(oldText, newText);
			expect(addCount).toBe(1);
			expect(delCount).toBe(1);
			expect(rows.length).toBe(3);
			expect(rows[0]!.kind).toBe("same");
			expect(rows[1]!.kind).toBe("change");
			expect(rows[1]!.oldLine).toBe("line2_old");
			expect(rows[1]!.newLine).toBe("line2_new");
			expect(rows[2]!.kind).toBe("same");
		});

		it("formatSplitDiffCardLines 在 >=80 宽时生成对称双栏并排视图，<80 宽时自动降级", () => {
			const oldText = "function test() {\n  return 1;\n}";
			const newText = "function test() {\n  return 2;\n}";
			// 宽屏 (100 列)：双栏视图
			const splitLines = formatSplitDiffCardLines(oldText, newText, "test.ts", false, 100);
			expect(splitLines.some((l) => l.includes("split diff"))).toBe(true);
			expect(splitLines.some((l) => l.includes("│"))).toBe(true);

			// 窄屏 (60 列)：自动降级为 unified diff
			const narrowLines = formatDiffCardLines(oldText, newText, "test.ts", false, 60);
			expect(narrowLines.some((l) => l.includes("(diff)"))).toBe(true);
			expect(narrowLines.some((l) => l.includes("(split diff)"))).toBe(false);
		});

		it("InputLine 字形簇安全退格、删除与方向键穿梭", () => {
			const box = new InputLine();
			box.handleInput("Hello👋🏻");
			expect(box.getText()).toBe("Hello👋🏻");

			// 退格应一次性完整删除字形簇 "👋🏻"
			box.handleInput("\x7f");
			expect(box.getText()).toBe("Hello");

			// 测试 Delete
			box.clear();
			box.handleInput("👋🏻World");
			box.handleInput("\x1b[H"); // Home
			box.handleInput("\x1b[3~"); // Delete
			expect(box.getText()).toBe("World");

			// 测试 Left / Right 跨越完整 emoji
			box.clear();
			box.handleInput("A👋🏻B");
			box.handleInput("\x1b[H"); // Home
			box.handleInput("\x1b[C"); // Right 穿过 'A'
			box.handleInput("\x1b[C"); // Right 应跨越整个 "👋🏻"
			box.handleInput("X");
			expect(box.getText()).toBe("A👋🏻XB");
		});

		it("InputLine 多行视觉行穿梭与历史记录回退", () => {
			const box = new InputLine();
			box.handleInput("line 1\nline 2");

			// 渲染一次记录宽度
			box.render(80);

			// 当前光标位于 line 2 末尾，按 Up 应移动到 line 1，而不是触发历史
			box.handleInput("\x1b[A"); // Up
			expect(box.getRawText()).toBe("line 1\nline 2");

			// 再次按 Up 到达顶行，由于历史为空，保持现状
			box.handleInput("\x1b[A");
			expect(box.getRawText()).toBe("line 1\nline 2");

			// 按 Down 应移动回 line 2
			box.handleInput("\x1b[B"); // Down
			expect(box.getRawText()).toBe("line 1\nline 2");
		});

		it("HelpMenu 过滤鼠标报告序列并不包含虚构的 /diff 命令", () => {
			const menu = new HelpMenu();
			let closed = false;
			menu.onClose = () => {
				closed = true;
			};

			// 鼠标移动与点击事件不应关闭菜单
			menu.handleInput("\x1b[<35;10;20M");
			expect(closed).toBe(false);
			menu.handleInput("\x1b[M 12");
			expect(closed).toBe(false);

			// 验证渲染中无虚构的 /diff 指令
			const lines = menu.render(80).join("\n");
			expect(lines).not.toContain("/diff");

			// F5：关闭键限定 Esc/?；q 不再关闭
			menu.handleInput("q");
			expect(closed).toBe(false);
			menu.handleInput("");
			expect(closed).toBe(true);
		});

		it("HelpMenu 严防超长描述撑破边框，所有渲染行宽度严格一致且包含核心快捷键", () => {
			const longCommand = {
				name: "extremely_long_command_name_that_should_not_break_the_ui",
				description:
					"这是一个极其漫长并且没有任何换行的超长命令描述，用来测试排版引擎的截断与边界防护能力，绝对不能破坏右侧边框！".repeat(
						3,
					),
			};
			const menu = new HelpMenu([longCommand]);

			for (const width of [60, 75, 80, 100]) {
				const lines = menu.render(width);
				expect(lines.length).toBeGreaterThan(5);
				const widths = lines.map((l) => visibleWidth(l));
				const expectedW = widths[0]!;
				// 每一行宽度必须绝对严格相等，绝无溢出或锯齿
				expect(widths.every((w) => w === expectedW)).toBe(true);
			}

			const defaultMenu = new HelpMenu();
			const rendered = defaultMenu.render(80).join("\n");
			// 验证收录核心交互快捷键与默认斜杠指令
			expect(rendered).toContain("Alt+↑ / Alt+Q");
			expect(rendered).toContain("Ctrl+Enter");
			expect(rendered).toContain("Shift+Tab");
			expect(rendered).toContain("Ctrl+O");
			expect(rendered).toContain("/model");
			expect(rendered).toContain("/effort");
			expect(rendered).toContain("/compact");
		});

		it("HelpMenu 只展示分发表里真实存在的命令，不虚构别名", () => {
			// CommandRouter 无别名机制：/exit、/agents、/traj、/branches
			// 都不是注册表里的名字，面板不得把它们渲染成可用命令。
			const registered = [
				{ name: "help", description: "查看所有可用命令与快捷键" },
				{ name: "model", description: "切换模型或打开模型选择面板" },
				{ name: "history", description: "会话历史分支检视" },
				{ name: "trajectory", description: "全屏审计轨迹时序看板" },
				{ name: "quit", description: "退出控制台" },
			];
			const lines = new HelpMenu(registered).render(80).join("\n");
			expect(lines).toContain("/quit");
			expect(lines).toContain("/trajectory");
			// 注意 /trajectory 包含子串 /traj，必须按整词匹配（前后非字母）
			const stripAnsi = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, "");
			const plain = stripAnsi(lines);
			for (const ghost of ["/exit", "/agents", "/jobs", "/traj", "/think", "/compact"]) {
				const re = new RegExp(ghost.replace("/", "/") + "(?![a-zA-Z])");
				expect(re.test(plain)).toBe(false);
			}
		});

		it("HelpMenu: 按 '?' 优先触发 onConvertToInput，未提供则回退至 onClose", () => {
			const menu = new HelpMenu();
			let convertedText = "";
			let closed = false;

			menu.onConvertToInput = (t) => {
				convertedText = t;
			};
			menu.onClose = () => {
				closed = true;
			};

			menu.handleInput("?");
			expect(convertedText).toBe("?");
			expect(closed).toBe(false);

			const menu2 = new HelpMenu();
			let closed2 = false;
			menu2.onClose = () => {
				closed2 = true;
			};
			menu2.handleInput("?");
			expect(closed2).toBe(true);
		});

		it("UIHost: 严格空行按 '?' 唤起帮助看板，有前置空格时不拦截，看板打开时再按 '?' 转换为输入", () => {
			const host = new UIHost({
				modelName: "Uina",
				terminal: {
					columns: 80,
					rows: 24,
					start: () => {},
					stop: () => {},
					write: () => {},
					onResize: () => {},
				} as any,
			});
			installUIFeatures(host, new TrajectoryProjection());

			// 1. 空行按 '?' -> 唤起 HelpMenu 浮层
			expect((host as any).inputLine.getText()).toBe("");
			dispatchUIHostInput(host, "?");
			expect((host as any).activeModalId).toBe("help");

			// 2. 帮助浮层处于打开状态时，再次按 '?' -> 转换为普通输入，关闭浮层，输入框内容变为 '?'
			dispatchUIHostInput(host, "?");
			expect((host as any).activeModalId).toBeNull();
			expect((host as any).inputLine.getText()).toBe("?");

			// 3. 清空输入框，输入前置空格再敲 '?' -> 不唤起帮助看板，作为普通字符追加
			(host as any).inputLine.clear();
			dispatchUIHostInput(host, " ");
			expect((host as any).inputLine.getText()).toBe(" ");
			dispatchUIHostInput(host, "?");
			expect((host as any).activeModalId).toBeNull();
			expect((host as any).inputLine.getText()).toBe(" ?");

			// 4. 清空输入框，唤起帮助看板后按 Esc / q -> 正常收起看板，输入框仍为空
			(host as any).inputLine.clear();
			dispatchUIHostInput(host, "?");
			expect((host as any).activeModalId).toBe("help");
			dispatchUIHostInput(host, "\x1b"); // Esc
			expect((host as any).activeModalId).toBeNull();
			expect((host as any).inputLine.getText()).toBe("");
		});

		it("TranscriptContainer 使用已结算行缓存并支持 toggleCompaction", () => {
			const tc = new TranscriptContainer();
			tc.startTurn(1, "用户输入 1");
			tc.appendToken("助手回复 1");
			tc.finishTurn();

			const lines1 = tc.render(80);
			const lines2 = tc.render(80);
			expect(lines1).toEqual(lines2);

			const startMap1 = tc.getTurnStartLinesByUid(80);
			const startMap2 = tc.getTurnStartLinesByUid(80);
			expect(startMap1.get(1)).toBe(startMap2.get(1));

			// 添加压缩卡片
			tc.addCompaction({
				summary: "会话已压缩摘要",
				retainedTailEntries: 1,
				tokensBefore: 5000,
				collapsed: true,
			});

			const compactedLines1 = tc.render(80).join("\n");
			expect(compactedLines1).toContain("ctrl+o / 点击展开");

			// 展开压缩卡片
			const toggled = tc.toggleCompaction();
			expect(toggled).toBe(true);

			const compactedLines2 = tc.render(80).join("\n");
			expect(compactedLines2).toContain("ctrl+o / 点击收起");
		});

		it("InteractiveTUI 真实事件联动：轨迹收集与 Token 逼真计算", () => {
			const tui = new InteractiveTUI();
			tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "你好" }));
			tui.consume(
				record({
					type: "output_update",
					streamId: "s1",
					offset: 0,
					channel: "thinking",
					text: "正在思考哲学问题...",
				}),
			);
			tui.consume(
				record({
					type: "output_update",
					streamId: "s1",
					offset: 1,
					channel: "content",
					text: "这是一段长度为 30 个字符的回复文本用于测试",
				}),
			);
			tui.consume(record({ type: "tool_call", toolName: "bash", args: { cmd: "ls" }, callId: "tool-1" }));
			tui.consume(
				record({
					type: "tool_result",
					toolName: "bash",
					args: { cmd: "ls" },
					result: "file.txt",
					status: "succeeded",
					callId: "tool-1",
				}),
			);
			tui.consume(
				record({
					type: "turn_end",
					turnNumber: 1,
					requestUsage: { callId: "call-1", totalTokens: 500 },
				}),
			);

			const nodes = getTestTrajectoryProjection(tui).list();
			expect(nodes.some((n) => n.kind === "turn_start")).toBe(true);
			expect(nodes.some((n) => n.kind === "thinking" && n.status === "completed")).toBe(true);
			expect(nodes.some((n) => n.kind === "tool_call" && n.status === "completed")).toBe(true);
			expect(nodes.some((n) => n.kind === "model_stream" && n.status === "completed")).toBe(true);

			// 测试压缩时轨迹同步
			tui.consume(
				record({
					type: "session_compact",
					operationId: "compact-test",
					status: "completed",
					summary: "历史压缩摘要",
					retainedTailEntries: 1,
					tokensBefore: 3000,
				}),
			);
			const compNode = getTestTrajectoryProjection(tui)
				.list()
				.find((n) => n.kind === "compaction");
			expect(compNode).toBeDefined();
			expect(compNode?.tokens?.total).toBe(3000);

			tui.close();
		});

		it("UIHost: notify() 零高度瞬态 Toast 呈现于呼吸空隙末行，不污染 transcript 历史", () => {
			const tui = new InteractiveTUI();
			const host = getTestUIHost(tui);
			const initialTranscriptLen = host.transcript.render(80).length;

			// 发送瞬态通知
			host.notify("正在压缩会话…", "info", 0);

			// 检查未污染永久 transcript
			expect(host.transcript.render(80).length).toBe(initialTranscriptLen);
			expect(host.getNotificationToast()).toEqual({ message: "正在压缩会话…", type: "info" });

			// 清除通知
			host.clearNotification();
			expect(host.getNotificationToast()).toBeNull();
			tui.close();
		});

		it("UIHost: 思考等级变化通过 notify() 呈现于对话框右侧上方，且在重复切换时平滑更新", () => {
			const tui = new InteractiveTUI();
			const host = getTestUIHost(tui);
			const initialTranscriptLen = host.transcript.render(80).length;

			// 模拟切换思考等级
			host.notify("思考等级: high", "info", 2000);
			expect(host.transcript.render(80).length).toBe(initialTranscriptLen);
			expect(host.getNotificationToast()).toEqual({ message: "思考等级: high", type: "info" });

			// 再次快速切换
			host.notify("思考等级: max", "info", 2000);
			expect(host.transcript.render(80).length).toBe(initialTranscriptLen);
			expect(host.getNotificationToast()).toEqual({ message: "思考等级: max", type: "info" });

			tui.close();
		});

		it("UIHost: 会话压缩卡片全域鼠标交互（热区注册、悬停高亮与点击折叠切换）", () => {
			const tui = new InteractiveTUI();
			const host = getTestUIHost(tui);

			host.addCompaction({
				summary: "第 1 轮到第 3 轮的压缩总结",
				retainedTailEntries: 3,
				tokensBefore: 12000,
				collapsed: true,
			});

			// 获取压缩卡片位置
			const compactionLocs = host.transcript.getCompactionLineIndices(76);
			expect(compactionLocs.length).toBe(1);
			expect(compactionLocs[0]!.lineCount).toBe(3);

			// 模拟强制帧渲染，获取注册的鼠标热区
			(host as any).running = true;
			(host as any).renderCurrentFrame();
			const targets = (host as any).mouseTracker.targets as Array<{ id: string; onClick?: () => void }>;
			const compactionTargets = targets.filter((t) => t.id.startsWith("compaction:0:"));
			expect(compactionTargets.length).toBe(3); // 顶部分割线、中间折叠行、底部分割线全部注册

			// 悬停测试
			expect(host.transcript.getHoveredCompaction()).toBeNull();
			host.transcript.setHoveredCompaction(0);
			expect(host.transcript.getHoveredCompaction()).toBe(0);
			const hoveredRender = host.transcript.render(76).join("\n");
			expect(hoveredRender).toContain("点击 / ctrl+o 展开");

			// 点击任意行切换折叠态
			compactionTargets[1]!.onClick!();
			expect(compactionLocs[0]!.record.collapsed).toBe(false);
			const expandedRender = host.transcript.render(76).join("\n");
			expect(expandedRender).toContain("完整摘要");
			expect(expandedRender).toContain("第 1 轮到第 3 轮的压缩总结");

			// 再次点击收起
			(host as any).renderCurrentFrame();
			const newTargets = (host as any).mouseTracker.targets as Array<{ id: string; onClick?: () => void }>;
			const newCompactionTarget = newTargets.find((t) => t.id.startsWith("compaction:0:"));
			newCompactionTarget!.onClick!();
			expect(compactionLocs[0]!.record.collapsed).toBe(true);

			tui.close();
		});

		it("Builtin Commands: 监听 session 压缩生命周期并驱动 Toast 与 UIHost", async () => {
			const { activateBuiltinCommands } = await import("../src/extensions/builtin.js");
			const mockNotify = vi.fn();
			const mockClear = vi.fn();
			const mockSetEffort = vi.fn();
			const mockSetThinkingLevel = vi.fn();
			const setUsageCalls: unknown[] = [];

			const handlers = new Map<string, Function>();
			// 官方命令已并入 pi 单一 API 面（P2）：不再有 BuiltinServices 特权束。
			const mockPi: any = {
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: Function) => {
					handlers.set(event, handler);
					return () => handlers.delete(event);
				}),
				onHook: vi.fn((hook: string, handler: Function) => {
					handlers.set(hook, handler);
					return () => handlers.delete(hook);
				}),
				ui: {
					notify: mockNotify,
					clearNotification: mockClear,
					setReasoningEffort: mockSetEffort,
					setWorking: vi.fn(),
					setUsage: (snapshot: unknown) => {
						setUsageCalls.push(snapshot);
					},
				},
				models: {
					current: () => ({
						name: "mock-model",
						providerId: "mock",
						id: "mock-model",
						thinkingLevels: ["off", "high", "max"],
					}),
					thinkingLevel: () => "off",
					setThinkingLevel: mockSetThinkingLevel,
				},
				usage: () => ({
					used: 4200,
					contextWindow: 124000,
					segments: { system: 900, prompt: 300, assistant: 1200, thinking: 400, tools: 1400 },
				}),
				isBusy: () => false,
			};

			activateBuiltinCommands(mockPi);

			// 触发 session_compact
			const compactHandler = handlers.get("session_compact");
			expect(compactHandler).toBeDefined();
			compactHandler!({
				type: "session_compact",
				status: "completed",
				summary: "完成测试总结",
				tokensBefore: 15000,
				retainedTailEntries: 2,
			});
			expect(mockNotify).toHaveBeenCalledWith("会话已压缩", "info", 2500);

			// 压缩只裁剪请求上下文，不替换 Subject 历史：session_compact 不触发
			// 用量刷新——usage 缓存仍是上一次请求的真实测量，等下一次 Provider
			// usage_update 自然更新（用旧真值标"估算"才是误导）。
			expect(setUsageCalls.length).toBe(0);

			// 3. 失败也由统一 session_compact 终态事件表达
			compactHandler!({ type: "session_compact", status: "failed", error: "Token limit" });
			expect(mockNotify).toHaveBeenCalledWith("会话压缩失败：Token limit", "warning", 3000);
			// 失败/取消/noop 只保留 toast，不污染永久转录卡片。

			// 4. 触发 thinking_level_select 驱动 Toast 与底栏状态联动
			const thinkingHandler = handlers.get("thinking_level_select");
			expect(thinkingHandler).toBeDefined();
			thinkingHandler!({ type: "thinking_level_select", level: "high" });
		});

		describe("dsh-TUI Tool Use Parity & Lifecycle", () => {
			it("正确映射工具四维语义类别与主题色彩", () => {
				expect(getToolCategory("replace_file_content")).toBe("write");
				expect(getToolCategory("write_to_file")).toBe("write");
				expect(getToolCategory("run_command")).toBe("exec");
				expect(getToolCategory("bash")).toBe("exec");
				expect(getToolCategory("view_file")).toBe("read");
				expect(getToolCategory("grep_search")).toBe("read");
				expect(getToolCategory("search_web")).toBe("web");
				expect(getToolCategory("unknown_tool")).toBe("default");

				expect(getToolCategoryColor("write")).toBeDefined();
				expect(getToolCategoryColor("exec")).toBeDefined();
				expect(getToolCategoryColor("read")).toBeDefined();
				expect(getToolCategoryColor("web")).toBeDefined();
			});

			it("工具类别颜色属于名称，状态颜色单独表达结果", () => {
				const success = formatToolCardLines("bash", "ok", 1, 80, "succeeded")[0]!;
				const failure = formatToolCardLines("bash", "failed", 1, 80, "failed")[0]!;
				expect(success.startsWith(`${C.success}${TOOL_STATUS_SPEC.succeeded.icon}`)).toBe(true);
				expect(success).toContain(C.toolDotExec);
				expect(failure.startsWith(`${C.error}${TOOL_STATUS_SPEC.failed.icon}`)).toBe(true);
				expect(failure).toContain(C.toolDotExec);
			});

			it("displayName 规范化大驼峰工具名称", () => {
				expect(displayName("bash")).toBe("Bash");
				expect(displayName("run_command")).toBe("RunCommand");
				expect(displayName("exec_command")).toBe("Exec");
				expect(displayName("execute_command")).toBe("Exec");
				expect(displayName("exec")).toBe("Exec");
				expect(displayName("replace_file_content")).toBe("Edit");
				expect(displayName("write_to_file")).toBe("Write");
				expect(displayName("view_file")).toBe("ViewFile");
				expect(displayName("search_web")).toBe("WebSearch");
			});

			it("getToolCategory 正确识别 exec 命令别名", () => {
				expect(getToolCategory("exec_command")).toBe("exec");
				expect(getToolCategory("execute_command")).toBe("exec");
				expect(getToolCategory("exec")).toBe("exec");
				expect(getToolCategory("run_command")).toBe("exec");
			});

			it("Uina 自有工具必须有显式类别与显示名，不得依赖兜底", () => {
				// 回归点：类别表与显示名表是从 Claude Code / dsh-TUI 抄来的别名表，
				// 长期只覆盖 exec_command / read_file。其余本地工具（write_file、read_image、
				// get_time、session_*）全部落到兜底分支：显示成
				// "Write_file" / "Get_time" 这类带下划线的名字，颜色也退回 default。
				// 删掉下表任意一行，都应当因为映射缺失而失败。
				const expected: Array<[name: string, display: string, category: string]> = [
					["exec_command", "Exec", "exec"],
					["get_time", "GetTime", "read"],
					["session_list", "SessionList", "read"],
					["session_read", "SessionRead", "read"],
					["session_rewind", "SessionRewind", "default"],
					["read_file", "Read", "read"],
					["read_image", "ReadImage", "read"],
					["write_file", "Write", "write"],
				];
				for (const [name, display, category] of expected) {
					expect({ name, display: displayName(name), category: getToolCategory(name) }).toEqual({
						name,
						display,
						category,
					});
				}
			});

			it("displayName 兜底把分隔符切成大驼峰（新工具不再显示成 Get_time）", () => {
				expect(displayName("brand_new_tool")).toBe("BrandNewTool");
				expect(displayName("kebab-tool")).toBe("KebabTool");
				expect(displayName("alreadyCamel")).toBe("AlreadyCamel");
			});

			it("结构化结果（数组 / 嵌套对象）不再渲染成 [object Object]", () => {
				// session_list 这类结构化结果是 JSON 数组
				const listText = stripAnsi(
					formatToolCardLines(
						"session_list",
						JSON.stringify([
							{ id: "a", source: "main" },
							{ id: "b", source: "main" },
						]),
						10,
						100,
						"succeeded",
					).join("\n"),
				);
				expect(listText).not.toContain("[object Object]");
				expect(listText).toContain(`"id":"a"`);
				expect(listText).toContain(`"id":"b"`);

				// 嵌套对象结果：字段本身是对象，旧代码会渲染成 [object Object]
				const nestedText = stripAnsi(
					formatToolCardLines(
						"process_stop",
						JSON.stringify({ outcome: "cancellation-requested", job: { id: "j1", status: "killed" } }),
						10,
						100,
						"succeeded",
					).join("\n"),
				);
				expect(nestedText).not.toContain("[object Object]");
				expect(nestedText).toContain("cancellation-requested");

				// 空数组有明确表示，不退化成「执行完成，无输出」
				const emptyText = stripAnsi(
					formatToolCardLines("task_list", JSON.stringify([]), 10, 100, "succeeded").join("\n"),
				);
				expect(emptyText).toContain("[]");
				expect(emptyText).not.toContain("无输出");
			});

			it("extractSummaryArgs 兼容 JSON 字符串与多样化参数对象", () => {
				expect(extractSummaryArgs("exec_command", JSON.stringify({ command: "Get-Date" })).summary).toBe("Get-Date");
				expect(extractSummaryArgs("exec", { cmd: "dir" }).summary).toBe("dir");
				expect(extractSummaryArgs("view", { file_path: "src/tui.ts" }).summary).toBe("src/tui.ts");
				expect(extractSummaryArgs("task", { prompt: "run check" }).summary).toBe("run check");
			});

			it("applyCardBackground 铺满整行宽度并阻止 ANSI Reset 色块断裂", () => {
				const line = `${C.toolDotExec}•${C.reset} ${C.bold}Exec${C.reset}(echo 1)`;
				const bg = C.toolCardBackground; // \x1b[48;2;36;43;58m
				const result = applyCardBackground(line, bg, 40);

				// 1. 起始注入背景
				expect(result.startsWith(bg)).toBe(true);
				// 2. 结束安全重置
				expect(result.endsWith(C.reset)).toBe(true);
				// 3. 所有 reset 序列后均重新注入了 bg，绝不产生中断
				expect(result).toContain(`${C.reset}${bg}`);
				// 4. 行尾自动对齐补足到 40 可视列
				expect(visibleWidth(result)).toBe(40);
			});

			it("悬停高亮 (isHovered) 为整张卡片提供连贯背景色与角标指示", () => {
				const lines = formatToolCardLines(
					"exec_command",
					JSON.stringify({ code: 0, stdout: "ok" }),
					100,
					60,
					"succeeded",
					{ command: "Get-Process" },
					{ isHovered: true },
				);
				expect(lines[0]).toContain(C.toolCardBackground);
				expect(lines[0]).toContain("▾"); // 悬停折叠角标
				expect(stripAnsi(lines[0]!)).toContain("Exec(Get-Process)");
				// 所有非空卡片行均被完整铺底
				for (let i = 0; i < lines.length - 1; i++) {
					expect(visibleWidth(lines[i]!)).toBe(60);
					expect(lines[i]!).toContain(C.toolCardBackground);
				}
				// 卡片末尾空行作为呼吸边距，hover 时同样铺底（否则卡下方出现
				// 默认背景黑条，视觉上像卡片被切断）；非 hover 时仍为裸空行
				expect(stripAnsi(lines[lines.length - 1]!)).toBe(" ".repeat(60));
				expect(lines[lines.length - 1]!).toContain(C.toolCardBackground);
			});

			it("formatDuration 精确处理毫秒与秒数", () => {
				expect(formatDuration(0)).toBe("0ms");
				expect(formatDuration(350)).toBe("350ms");
				expect(formatDuration(1200)).toBe("1.2s");
				expect(formatDuration(65000)).toBe("1m 5s");
			});

			it("foldTerminalCommand 正确折叠多行脚本命令", () => {
				expect(foldTerminalCommand("single line cmd")).toBeUndefined();
				const multi = foldTerminalCommand("echo hello\npnpm test\ngit status");
				expect(multi).toBeDefined();
				expect(multi?.first).toBe("echo hello");
				expect(multi?.hidden).toBe(2);
			});

			it("运行态 (Running)：600ms 呼吸圆点与实时秒表累加", () => {
				// now=2400 为偶数周期 (2400/600=4)，显示实心圆
				const linesEven = formatToolCardLines(
					"bash",
					"",
					0,
					80,
					"running",
					{ command: "ls" },
					{
						startedAt: 1200,
						now: 2400, // runMs = 1200ms -> 1.2s
					},
				);
				const renderedEven = linesEven.join("\n");
				expect(renderedEven).toContain(BLACK_CIRCLE);
				expect(stripAnsi(renderedEven)).toContain("Bash(ls)");
				expect(renderedEven).toContain("· 1.2s");
				expect(renderedEven).toContain("执行中… (1.2s)");

				// now=1800 为奇数周期 (1800/600=3)，闪烁隐藏
				const linesOdd = formatToolCardLines(
					"bash",
					"",
					0,
					80,
					"running",
					{ command: "ls" },
					{
						startedAt: 1000,
						now: 1800,
					},
				);
				const renderedOdd = linesOdd.join("\n");
				expect(renderedOdd).not.toContain(BLACK_CIRCLE);
			});

			it("已结算态 (Completed)：小圆点 • 与 ⎿ 悬挂缩进，隐去 exitCode: 0", () => {
				const lines = formatToolCardLines(
					"run_command",
					JSON.stringify({ code: 0, stdout: "line 1\nline 2" }),
					240,
					80,
					"succeeded",
					{ CommandLine: "pnpm test" },
				);
				const rendered = lines.join("\n");
				expect(rendered).toContain(TOOL_STATUS_SPEC.succeeded.icon);
				expect(stripAnsi(rendered)).toContain("RunCommand(pnpm test)");
				expect(rendered).toContain("· 240ms");
				expect(rendered).toContain(GUTTER_FIRST);
				expect(rendered).toContain(GUTTER_REST);
				expect(rendered).toContain("line 1");
				expect(rendered).toContain("line 2");
				expect(rendered).not.toContain("exitCode: 0");
				expect(rendered).not.toContain("Exit code 0");
			});

			it("失败态 (Failed)：红色 ✗ 与 Exit code 标红，单例轨迹指针", () => {
				const linesFailure = formatToolCardLines(
					"bash",
					JSON.stringify({ code: 1, error: "Command not found" }),
					50,
					80,
					"failed",
					{ command: "fake-cmd" },
					{ isNewestFailure: true },
				);
				const rendered = linesFailure.join("\n");
				expect(rendered).toContain(TOOL_STATUS_SPEC.failed.icon);
				expect(rendered).toContain("Command not found");
				expect(rendered).toContain("Alt+T 查看轨迹");

				// 非最新失败不追加轨迹指针
				const linesOldFailure = formatToolCardLines(
					"bash",
					JSON.stringify({ code: 1, error: "Command not found" }),
					50,
					80,
					"failed",
					{ command: "fake-cmd" },
					{ isNewestFailure: false },
				);
				expect(linesOldFailure.join("\n")).not.toContain("Alt+T 查看轨迹");
			});

			it("行数预算与折叠截断（3行预算，1行容差直显，Ctrl+O 展开）", () => {
				// 4 行（溢出 1 行）：容差直接完整显示
				const fourLines = formatToolCardLines(
					"run_command",
					JSON.stringify({ exitCode: 0, stdout: "a\nb\nc\nd" }),
					100,
					80,
					"succeeded",
				);
				expect(fourLines.join("\n")).toContain("d");
				expect(fourLines.join("\n")).not.toContain("行 (Ctrl+O 展开)");

				// 5 行：折叠保留 3 行 + 折叠提示
				const fiveLines = formatToolCardLines(
					"run_command",
					JSON.stringify({ exitCode: 0, stdout: "a\nb\nc\nd\ne" }),
					100,
					80,
					"succeeded",
					undefined,
					{ isExpanded: false },
				);
				const strippedLines = fiveLines.map(stripAnsi);
				// Assert the actual body rows, not any line that happens to contain the letter.
				expect(strippedLines.some((l) => l.trimEnd().endsWith("a"))).toBe(true);
				expect(strippedLines.some((l) => l.trimEnd().endsWith("b"))).toBe(true);
				expect(strippedLines.some((l) => l.trimEnd().endsWith("c"))).toBe(true);
				// d 和 e 应该被折叠进 +2 行
				expect(strippedLines.some((l) => l.endsWith("   d"))).toBe(false);
				expect(strippedLines.some((l) => l.endsWith("   e"))).toBe(false);
				expect(strippedLines.some((l) => l.includes("… 还有 2 行 (Ctrl+O 展开)"))).toBe(true);

				// isExpanded: true：展开全部
				const expanded = formatToolCardLines(
					"run_command",
					JSON.stringify({ stdout: "a\nb\nc\nd\ne" }),
					100,
					80,
					"succeeded",
					undefined,
					{ isExpanded: true },
				);
				const strippedExpanded = expanded.map(stripAnsi);
				expect(strippedExpanded.some((l) => l.endsWith("   d"))).toBe(true);
				expect(strippedExpanded.some((l) => l.endsWith("   e"))).toBe(true);
				expect(strippedExpanded.some((l) => l.includes("(ctrl+o to expand)"))).toBe(false);
			});

			it("展开态显示完整命令：超 120 字符的单行命令与多行命令全文可见", () => {
				const longCmd =
					'cd E:\\Uina\\Uina; npx vitest run tests/ui.test.ts -t "划词复制输入框中的粘贴芯片" 2>&1 | Select-String -Pattern "Tests " | Select-Object -First 4';
				expect(longCmd.length).toBeGreaterThan(120);
				const expanded = formatToolCardLines(
					"run_command",
					"",
					0,
					200,
					"failed",
					{ command: longCmd },
					{ isExpanded: true },
				);
				const stripped = expanded.map(stripAnsi).join("\n");
				// 完整命令（含尾部）在展开态可见
				expect(stripped).toContain("Select-Object -First 4");

				// 多行命令：展开态下第 2..N 行也要可见（修复假出口）
				const multi = formatToolCardLines(
					"run_command",
					"",
					0,
					200,
					"succeeded",
					{ command: "first-line-cmd\nsecond-line-cmd\nthird-line-cmd" },
					{ isExpanded: true },
				);
				const strippedMulti = multi.map(stripAnsi).join("\n");
				expect(strippedMulti).toContain("second-line-cmd");
				expect(strippedMulti).toContain("third-line-cmd");
			});

			it("内嵌 Diff 视图与双模折叠", () => {
				const lines = formatToolCardLines(
					"replace_file_content",
					JSON.stringify({ success: true }),
					80,
					120, // 宽屏
					"succeeded",
					{
						TargetFile: "src/index.ts",
						TargetContent: "const a = 1;",
						ReplacementContent: "const a = 2;",
					},
					{ isExpanded: false },
				);
				const clean = stripAnsi(lines.join("\n"));
				expect(clean).toContain("Edit");
				expect(clean).toContain("src/index.ts");
				expect(clean).toContain("const a = 1;");
				expect(clean).toContain("const a = 2;");
			});

			it("TranscriptContainer 工具单卡与全局展开交互控制", () => {
				const transcript = new TranscriptContainer();
				transcript.startTurn(1, "执行批处理");
				transcript.startTool(toolStartNode("bash", { command: "test1" }, "call-1"));
				transcript.addToolDone(
					toolDoneNode("bash", JSON.stringify({ stdout: "1\n2\n3\n4\n5" }), 100, "succeeded", "call-1"),
				);
				transcript.startTool(toolStartNode("bash", { command: "test2" }, "call-2"));
				transcript.addToolDone(
					toolDoneNode("bash", JSON.stringify({ stdout: "a\nb\nc\nd\ne" }), 100, "succeeded", "call-2"),
				);

				// 默认折叠
				let locs = transcript.getToolLineIndices(80);
				expect(locs.length).toBe(2);
				expect(locs[0]!.isExpanded).toBe(false);
				expect(locs[1]!.isExpanded).toBe(false);

				// 单卡切换展开
				const res = transcript.toggleTool("call-1");
				expect(res.toggled).toBe(true);
				locs = transcript.getToolLineIndices(80);
				expect(locs[0]!.isExpanded).toBe(true);
				expect(locs[1]!.isExpanded).toBe(false);

				// 全局展开
				transcript.toggleAllTools(false);
				locs = transcript.getToolLineIndices(80);
				expect(locs[0]!.isExpanded).toBe(true);
				expect(locs[1]!.isExpanded).toBe(true);

				// 悬停检测
				expect(transcript.setHoveredToolId("call-1")).toBe(true);
				expect(transcript.getHoveredToolId()).toBe("call-1");
				expect(transcript.setHoveredToolId("call-1")).toBe(false); // 同一状态不触发重流
			});

			it("UIHost 将多行工具卡片的每一行正文注册为交互热区，支持点击卡片任意行切换折叠且悬停任意行触发整卡高亮", () => {
				const term = createSilentTerminal({ columns: 100, rows: 30, isTTY: true });
				const host = new UIHost({
					modelName: "deepseek-chat",
					cwd: "e:/Uina/test",
					terminal: term.terminal,
				});
				host.start();
				try {
					// 开启一轮对话并添加一个多行输出的工具调用
					host.transcript.startTurn(1, "运行测试脚本");
					host.transcript.startTool(toolStartNode("bash", { command: "npm test" }, "call-test-123"));
					host.transcript.addToolDone(
						toolDoneNode(
							"bash",
							JSON.stringify({ stdout: "line 1\nline 2\nline 3\nline 4" }),
							150,
							"succeeded",
							"call-test-123",
						),
					);

					// 触发首帧渲染以构建交互目标
					(host as any).renderCurrentFrame();

					const targets: any[] = (host as any).mouseTracker.targets;
					const toolTargets = targets.filter((t) => t.id.startsWith("tool:call-test-123:"));

					// 卡片包含首行标题 + 3行正文 + 1行折叠提示，共 5 行内容行，必须每一行都被注册为交互目标
					expect(toolTargets.length).toBeGreaterThanOrEqual(4);

					// 1. 悬停在工具卡片正文第 2 行（非首行标题行）
					const bodyTarget = toolTargets[1]!;
					const hoverSeq = `\x1b[<35;10;${bodyTarget.row + 1}M`; // SGR 移动悬停（1-indexed）
					dispatchUIHostInput(host, hoverSeq);

					// 验证 transcript 成功捕获 hoveredToolId
					expect(host.transcript.getHoveredToolId()).toBe("call-test-123");

					// 2. 验证悬停时，整张卡片的行均包含 C.toolCardBackground 高亮底色
					(host as any).renderCurrentFrame();
					const screenLines: string[] = (host as any).lastRenderedRows;
					const hoveredHeaderLine = screenLines[toolTargets[0]!.row]!;
					const hoveredBodyLine = screenLines[bodyTarget.row]!;
					expect(hoveredHeaderLine).toContain(C.toolCardBackground);
					expect(hoveredBodyLine).toContain(C.toolCardBackground);

					// 3. 在工具卡片正文行（第 2 行）点击鼠标左键并松开（非首行）
					const clickDownSeq = `\x1b[<0;10;${bodyTarget.row + 1}M`;
					const clickUpSeq = `\x1b[<0;10;${bodyTarget.row + 1}m`;
					dispatchUIHostInput(host, clickDownSeq);
					dispatchUIHostInput(host, clickUpSeq);

					// 验证工具卡片被成功切换为展开状态（isExpanded = true）
					const locs = host.transcript.getToolLineIndices(100);
					expect(locs.find((l) => l.callId === "call-test-123")?.isExpanded).toBe(true);
				} finally {
					host.stop();
				}
			});

			it("展开与收起思考内容时保持画面原位置绝对稳定（锚点固定，鼠标点击与 Ctrl+O 均不跳屏）", () => {
				const term = createSilentTerminal({ columns: 80, rows: 24, isTTY: true });
				const host = new UIHost({
					modelName: "deepseek-chat",
					cwd: "e:/Uina/test",
					terminal: term.terminal,
				});
				host.start();
				try {
					// 填充若干轮次历史记录，使总行数超出视口高度
					for (let t = 1; t <= 5; t++) {
						host.transcript.startTurn(t, `这是历史提问 ${t}`);
						host.transcript.appendToken(`历史回复第 1 行\n历史回复第 2 行\n历史回复第 3 行`);
						host.transcript.finishTurn();
					}

					// 当前轮次：包含 40 行深度思考
					host.transcript.startTurn(6, "请详细分析");
					host.transcript.appendThinking(
						"开始分析思考。\n" + Array.from({ length: 40 }, (_, i) => `思考推导步骤 ${i + 1}`).join("\n"),
					);
					host.transcript.appendToken("这是最终结论。");
					host.transcript.finishTurn();

					// 初始渲染
					(host as any).renderCurrentFrame();
					const initTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetBefore = initTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetBefore).toBeDefined();
					const initThinkingRow = thinkingTargetBefore!.row;

					// 1. 模拟鼠标点击展开思考内容
					const clickDown = `\x1b[<0;10;${initThinkingRow + 1}M`;
					const clickUp = `\x1b[<0;10;${initThinkingRow + 1}m`;
					dispatchUIHostInput(host, clickDown);
					dispatchUIHostInput(host, clickUp);
					(host as any).renderCurrentFrame();

					// 校验：展开后，思考块标题行必须严格锁定在同一个屏幕行（画面绝对不跳动）
					const expandedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetExpanded = expandedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetExpanded?.row).toBe(initThinkingRow);

					// 2. 模拟鼠标点击收起思考内容
					dispatchUIHostInput(host, clickDown);
					dispatchUIHostInput(host, clickUp);
					(host as any).renderCurrentFrame();

					// 校验：收起后，思考块标题行仍然位于该屏幕行，且位于底部时视口偏移准确归零
					const collapsedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetCollapsed = collapsedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetCollapsed?.row).toBe(initThinkingRow);
					expect(host.getScrollOffset()).toBe(0);

					// 3. 模拟快捷键 Ctrl+O 展开思考内容
					dispatchUIHostInput(host, "\x0f"); // Ctrl+O
					(host as any).renderCurrentFrame();

					// 校验：Ctrl+O 展开后，思考块标题行依然锁定在原屏幕行（绝不产生向上飞出屏幕顶部的跳跃）
					const ctrlOExpandedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetCtrlO = ctrlOExpandedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetCtrlO?.row).toBe(initThinkingRow);

					// 4. 模拟快捷键 Ctrl+O 收起思考内容
					dispatchUIHostInput(host, "\x0f"); // Ctrl+O
					(host as any).renderCurrentFrame();

					// 校验：Ctrl+O 收起后，依然留在原屏幕行，视口偏移归零（绝不跳跃回顶部 Banner）
					const ctrlOCollapsedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetCtrlOCol = ctrlOCollapsedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetCtrlOCol?.row).toBe(initThinkingRow);
					expect(host.getScrollOffset()).toBe(0);
				} finally {
					host.stop();
				}
			});
		});

		describe("Interrupt (打断) 交互规范与行为对齐 (dsh-TUI Parity)", () => {
			it("matchesKey: 正确识别 Ctrl+Enter 的各类终端序列，且不与普通回车混淆", () => {
				expect(matchesKey("\x1b[13;5u", Key.ctrlEnter)).toBe(true);
				expect(matchesKey("\x1b[13;1;5u", Key.ctrlEnter)).toBe(true);
				expect(matchesKey("\x1b[27;5;13~", Key.ctrlEnter)).toBe(true);

				// 普通回车不能被误判为 Ctrl+Enter
				expect(matchesKey("\r", Key.ctrlEnter)).toBe(false);
				expect(matchesKey("\n", Key.ctrlEnter)).toBe(false);
				expect(matchesKey("\x1b[13u", Key.ctrlEnter)).toBe(false);

				// Ctrl+Enter 序列不能被误判为普通 Enter
				expect(matchesKey("\x1b[13;5u", Key.enter)).toBe(false);
				expect(matchesKey("\x1b[27;5;13~", Key.enter)).toBe(false);
			});

			it("InputLine: 空闲态与工作态下的三种投递模式 (direct, steer, followUp, interrupt)", () => {
				const input = new InputLine();
				let submittedText = "";
				let submittedMode = "";
				input.onSubmitMode = (text, mode) => {
					submittedText = text;
					submittedMode = mode;
				};

				// 1. 空闲态下普通 Enter -> direct
				input.handleInput("Hello");
				input.handleInput("\r");
				expect(submittedText).toBe("Hello");
				expect(submittedMode).toBe("direct");
				expect(input.getText()).toBe("");

				// 2. 空闲态下 Ctrl+Enter -> interrupt
				input.handleInput("Immediate");
				input.handleInput("\x1b[13;5u");
				expect(submittedText).toBe("Immediate");
				expect(submittedMode).toBe("interrupt");
				expect(input.getText()).toBe("");

				// 3. 工作态下普通 Enter -> steer (引导当前运行轮次)
				input.setBusy(true);
				input.handleInput("Guide");
				input.handleInput("\r");
				expect(submittedText).toBe("Guide");
				expect(submittedMode).toBe("steer");
				expect(input.getText()).toBe("");

				// 4. 工作态下 Tab 键 -> followUp (排队等当前轮结束)
				input.handleInput("Later");
				input.handleInput("\t");
				expect(submittedText).toBe("Later");
				expect(submittedMode).toBe("followUp");
				expect(input.getText()).toBe("");

				// 5. 工作态下 Ctrl+Enter -> interrupt (立即打断并投递)
				input.handleInput("Stop and Do This");
				input.handleInput("\x1b[13;5u");
				expect(submittedText).toBe("Stop and Do This");
				expect(submittedMode).toBe("interrupt");
				expect(input.getText()).toBe("");

				// 6. 空输入下 Ctrl+Enter 也发出 interrupt 语义（投递持有队列，兑现"插队"提示）
				input.handleInput("\x1b[13;5u");
				expect(submittedText).toBe("");
				expect(submittedMode).toBe("interrupt");
			});

			it("turn_aborted：投影把在途工具结算为 cancelled，容器不再自造 unknown 状态", () => {
				const tui = createInteractiveUI({ modelName: "DeepSeek" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "用户任务" }));
				tui.consume(record({ type: "tool_call", toolName: "bash", args: { command: "sleep 10" }, callId: "call-1" }));
				tui.consume(record({ type: "turn_aborted", turnNumber: 1 }));

				const transcript = getTestUIHost(tui).transcript;
				// 封顶：当前轮已提交
				expect(transcript.getCurrentTurn()).toBeNull();
				const history = transcript.getHistory();
				expect(history.length).toBe(1);
				const turn = history[0]!;

				// 工具端态只由投影给出（用户主动取消 = cancelled），不再写 "结果未知" 文案
				const toolItem = turn.items.find((it) => it.kind === "tool") as any;
				expect(toolItem.status).toBe("cancelled");
				expect(toolItem.result).toBe("");

				const interruptItem = turn.items.find((it) => it.kind === "interrupt") as any;
				expect(interruptItem.text).toBe("已打断 · 接下来想做什么？");

				const joined = transcript.render(80).join("\n");
				expect(joined).toContain("已打断 · 接下来想做什么？");
				expect(joined).toContain("\x1b[2m");

				// 幂等：重复的 turn_aborted 不产生重复打断行
				tui.consume(record({ type: "turn_aborted", turnNumber: 1 }));
				expect(turn.items.filter((it) => it.kind === "interrupt").length).toBe(1);
			});

			it("UIHost: Esc 阶梯与 Ctrl+C 二次强制退出机制", () => {
				const cancelSources: Array<string | undefined> = [];
				let deliveredText = "";

				const host = new UIHost({
					modelName: "Uina",
					terminal: {
						columns: 80,
						rows: 24,
						start: () => {},
						stop: () => {},
						write: () => {},
						onResize: () => {},
					} as any,
				});

				host.onCancel = (source) => {
					cancelSources.push(source);
				};
				host.onInterruptAndDeliver = (text) => {
					deliveredText = text;
				};

				// 1. 工作态下按 Esc -> 只发送取消意图；实际 Subject/Host 信号由组合根接管
				host.setBusy(true);
				dispatchUIHostInput(host, "\x1b"); // Esc
				expect(cancelSources).toEqual(["escape"]);
				expect(host.isBusy()).toBe(true);
				host.setBusy(false);
				expect(host.isBusy()).toBe(false);

				// 2. 空闲态下单按 Esc -> 清空输入框内容
				dispatchUIHostInput(host, "some draft text");
				expect((host as any).inputLine.getText()).toBe("some draft text");
				dispatchUIHostInput(host, "\x1b"); // Esc
				expect((host as any).inputLine.getText()).toBe("");

				// 3. 工作态下 Ctrl+C -> UI 只发送取消意图，组合根查询 Host 权威忙闲
				host.setBusy(true);
				dispatchUIHostInput(host, "\x03"); // Ctrl+C
				expect(cancelSources).toEqual(["escape", "ctrl+c"]);
				expect(host.isBusy()).toBe(true);
				host.setBusy(false);

				// 5. 工作态下按 Ctrl+Enter -> 触发 cancelTurn 且调用 onInterruptAndDeliver
				host.setBusy(true);
				dispatchUIHostInput(host, "New Priority Task");
				dispatchUIHostInput(host, "\x1b[13;5u"); // Ctrl+Enter
				expect(deliveredText).toBe("New Priority Task");
				host.setBusy(false);
			});

			it("UIHost: 工作态下按 Esc 时优先打断当前轮次，输入框未发送的草稿完好保留", () => {
				const host = new UIHost({
					modelName: "TestModel",
					terminal: {
						columns: 80,
						rows: 24,
						start: () => {},
						stop: () => {},
						write: () => {},
						onResize: () => {},
					} as any,
				});

				host.setBusy(true);
				dispatchUIHostInput(host, "我的临时未发送草稿");
				expect((host as any).inputLine.getText()).toBe("我的临时未发送草稿");

				// 触发 Esc
				dispatchUIHostInput(host, "\x1b");

				// UI 只发取消意图，草稿完好保留，绝不被清空
				expect(host.isBusy()).toBe(true);
				expect((host as any).inputLine.getText()).toBe("我的临时未发送草稿");
			});

			it("InteractiveTUI: 接收到 turn_aborted 事件时自动调用 interruptTurn 并重置状态", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "做某事" }));
				expect(getTestUIHost(tui).isBusy()).toBe(true);

				// 模拟收到内核发出的结构化 turn_aborted 事件
				tui.consume(record({ type: "turn_aborted", turnNumber: 1 }));

				// 此时 busy 状态自动解除，且 transcript 正确记录 interrupt 行
				expect(getTestUIHost(tui).isBusy()).toBe(false);
				const history = getTestUIHost(tui).transcript.getHistory();
				expect(history.length).toBe(1);
				expect(history[0]!.items.some((it) => it.kind === "interrupt")).toBe(true);
			});

			it("TranscriptContainer: 打断后迟到的工具结算绝不重复开辟新轮次或生成重复工具卡 (图一防御)", () => {
				const transcript = new TranscriptContainer();
				transcript.startTurn(1, "执行长任务");
				transcript.startTool(toolStartNode("bash", { command: "sleep 10" }, "call-123"));

				// 用户按 Esc 打断
				transcript.interruptTurn("TestModel");

				// 校验当前轮已被封顶提交，工具状态为 unknown
				expect(transcript.getCurrentTurn()).toBeNull();
				const history = transcript.getHistory();
				expect(history.length).toBe(1);
				expect(history[0]!.items.filter((it) => it.kind === "tool").length).toBe(1);

				// 此时底层子进程退出，迟到收到 addToolDone
				transcript.addToolDone(
					toolDoneNode("bash", '{"error":"工具已返回，但取消时无法确认副作用状态"}', 200, "unknown", "call-123"),
				);

				// 必须严密保持为 1 轮，且绝不产生重复卡片
				expect(transcript.getCurrentTurn()).toBeNull();
				expect(transcript.getHistory().length).toBe(1);
				expect(history[0]!.items.filter((it) => it.kind === "tool").length).toBe(1);
				const tool = history[0]!.items.find((it) => it.kind === "tool") as any;
				expect(tool.status).toBe("unknown");
				expect(tool.result).toContain("工具已返回，但取消时无法确认副作用状态");
			});

			it("InteractiveTUI: 打断的轮次在结算时 activityLine 展示 '已打断当前轮次' 而非 '本轮已完成'", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "做任务" }));
				getTestUIHost(tui).cancelTurn("escape");

				// 收到 Host 的取消事实，而不是把取消意图伪装成正常完成。
				tui.consume(record({ type: "turn_aborted", turnNumber: 1 }));

				// 校验 activityLine 总结状态为“已打断当前轮次”
				const rendered = getTestUIHost(tui).activityLine.render(80).join("\n");
				expect(rendered).toContain("已打断当前轮次");
				expect(rendered).not.toContain("本轮已完成");
			});

			it("InteractiveTUI: 排队消息回填与草稿按时间顺序拼接，并置光标于末尾 (对齐 Pi restoreQueuedMessagesToEditor)", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "运行长任务" }));

				// 用户输入半截未发送的临时草稿
				dispatchUIHostInput(getTestUIHost(tui), "未发送的临时草稿");
				expect(getTestUIHost(tui).inputLine.getText()).toBe("未发送的临时草稿");

				// 模拟队列中有 2 条排队消息
				const queuedItems = [
					{ id: "q1", text: "排队任务一" },
					{ id: "q2", text: "排队任务二" },
				];

				// 使用生产代码的拼接规则，而不是在测试里复制一份
				const combined = combineQueuedDraft(queuedItems, getTestUIHost(tui).inputLine.getText());
				tui.setDraft(combined);

				// 校验回填文本与时间顺序
				const expected = "排队任务一\n\n排队任务二\n\n未发送的临时草稿";
				expect(getTestUIHost(tui).inputLine.getText()).toBe(expected);
				// 校验光标置于最后
				expect(getTestUIHost(tui).inputLine.getCursorIndex()).toBe(expected.length);
			});

			it("InteractiveTUI: 每次空白态 Ctrl+C 只向组合根发送取消意图", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "长耗时操作" }));

				const cancelSources: Array<string | undefined> = [];
				tui.onIntent((intent) => {
					if (intent.type === "turn.cancel") cancelSources.push(intent.source);
				});

				// UI 每次只报告输入意图，是否升级退出由组合根根据 Host 状态决定。
				dispatchUIHostInput(getTestUIHost(tui), "\x03");
				dispatchUIHostInput(getTestUIHost(tui), "\x03");
				expect(cancelSources).toEqual(["ctrl+c", "ctrl+c"]);
			});

			it("InteractiveTUI: 空闲态下 Ctrl+C 优先清空输入栏草稿，草稿为空时两连击退出", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				let cancelCount = 0;
				tui.onIntent((intent) => {
					if (intent.type === "turn.cancel") cancelCount++;
				});

				// 输入草稿
				dispatchUIHostInput(getTestUIHost(tui), "草稿文本");
				expect(getTestUIHost(tui).inputLine.getText()).toBe("草稿文本");

				// 第 1 次 Ctrl+C：清空草稿
				dispatchUIHostInput(getTestUIHost(tui), "\x03");
				expect(getTestUIHost(tui).inputLine.getText()).toBe("");
				expect(cancelCount).toBe(0);

				// 草稿为空时 Ctrl+C 也只发送取消意图；退出由组合根查询 Host idle 后决定。
				dispatchUIHostInput(getTestUIHost(tui), "\x03");
				expect(cancelCount).toBe(1);
			});

			it("InteractiveTUI: 工作态下按 Esc 触发 onCancel('escape') 并保留输入栏未发送草稿", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "正在执行任务" }));

				let cancelSource: string | undefined;
				tui.onIntent((intent) => {
					if (intent.type === "turn.cancel") cancelSource = intent.source;
				});

				dispatchUIHostInput(getTestUIHost(tui), "临时未发送的输入");
				expect(getTestUIHost(tui).inputLine.getText()).toBe("临时未发送的输入");

				// 按 Esc 打断
				dispatchUIHostInput(getTestUIHost(tui), "\x1b");
				expect(cancelSource).toBe("escape");
				// 草稿保留
				expect(getTestUIHost(tui).inputLine.getText()).toBe("临时未发送的输入");
			});

			it("InteractiveTUI: 工作态下 Ctrl+Enter 触发 onInterruptAndDeliver 且不触发 onCancel", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "执行中" }));

				let deliveredText: string | undefined;
				let cancelCalled = false;
				tui.onIntent((intent) => {
					if (intent.type === "turn.cancel") cancelCalled = true;
					if (intent.type === "turn.interruptAndDeliver") deliveredText = intent.text;
				});

				dispatchUIHostInput(getTestUIHost(tui), "紧急插队任务");
				// 按 Ctrl+Enter (CSI 格式 \x1b[13;5u)
				dispatchUIHostInput(getTestUIHost(tui), "\x1b[13;5u");

				expect(deliveredText).toBe("紧急插队任务");
				expect(cancelCalled).toBe(false);
			});

			it("Key Parsing: 准确区分 Alt+Up (\\x1b[1;3A) 与 Alt+A (\\x1ba)，杜绝键位串扰", () => {
				// \x1b[1;3A 是标准终端的 Alt+Up
				expect(matchesKey("\x1b[1;3A", Key.altUp)).toBe(true);
				expect(matchesKey("\x1b[1;3A", Key.alt("up"))).toBe(true);
				expect(matchesKey("\x1b[1;3A", Key.alt("a"))).toBe(false); // 关键修复校验：绝不能误判为 Alt+A

				// \x1ba 是 Alt+A
				expect(matchesKey("\x1ba", Key.alt("a"))).toBe(true);
				expect(matchesKey("\x1ba", Key.altUp)).toBe(false);

				// Alt+Down 与 Alt+Q 识别
				expect(matchesKey("\x1b[1;3B", Key.altDown)).toBe(true);
				expect(matchesKey("\x1bq", Key.alt("q"))).toBe(true);
			});

			it("InteractiveTUI: 按 Alt+Up 触发 onPullBackQueue 且不误触 Alt+A 绑定命令", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				let pullBackTriggered = false;
				tui.onIntent((intent) => {
					if (intent.type === "queue.pullBack") pullBackTriggered = true;
				});
				const openFeatureSpy = vi.spyOn(getTestUIHost(tui), "openFeature");
				getTestUIHost(tui).registry.registerCommand({
					name: "board",
					description: "Board",
					keybinding: "alt+a",
					handler: () => {
						getTestUIHost(tui).openFeature({ name: "help" });
					},
				});

				// 按 Alt+Up (\x1b[1;3A)
				dispatchUIHostInput(getTestUIHost(tui), "\x1b[1;3A");
				expect(pullBackTriggered).toBe(true);
				expect(openFeatureSpy).not.toHaveBeenCalled();

				// 按 Alt+A (\x1ba)：正常触发绑定命令
				dispatchUIHostInput(getTestUIHost(tui), "\x1ba");
				expect(openFeatureSpy).toHaveBeenCalledTimes(1);
			});

			describe("PendingQueueComponent & Queue UX", () => {
				it("队列为空时 render 返回空数组（0 行，杜绝空白占用与抖动）", () => {
					const queueComp = new PendingQueueComponent();
					expect(queueComp.render(80)).toEqual([]);
					expect(queueComp.getItems()).toEqual([]);
				});

				it("单条 Steer 消息渲染：包含 ◆ （Steer） 标题、文本内容与底部操作 Affordance", () => {
					const queueComp = new PendingQueueComponent();
					queueComp.setItems([
						{
							text: "查看 package.json 中的 vitest 配置",
							mode: "steer",
						},
					]);

					const lines = queueComp.render(80);
					expect(lines.length).toBe(3); // 标题 + 1 条待办 + 底部操作提示
					const raw = lines.map((l) => stripAnsi(l));
					expect(raw[0]).toContain("◆ (Steer) · 下一步送达");
					expect(raw[1]).toContain("↳ 查看 package.json 中的 vitest 配置");
					expect(raw[2]).toContain("↳ Alt+↑ 撤回 · Esc 打断并发送 · Ctrl+Enter 插队");
				});

				it("多条 Follow-up 消息渲染：包含 ◇ (Follow-up) 标题及数量标记", () => {
					const queueComp = new PendingQueueComponent();
					queueComp.setItems([
						{
							text: "运行 npm run test:coverage",
							mode: "followUp",
						},
						{
							text: "编译并检查 dist 输出产物",
							mode: "followUp",
						},
					]);

					const lines = queueComp.render(80);
					expect(lines.length).toBe(4); // 标题 + 2 条待办 + 底部提示
					const raw = lines.map((l) => stripAnsi(l));
					expect(raw[0]).toContain("◇ (Follow-up) · 本轮结束后送达 (2 条待办)");
					expect(raw[1]).toContain("↳ 运行 npm run test:coverage");
					expect(raw[2]).toContain("↳ 编译并检查 dist 输出产物");
					expect(raw[3]).toContain("↳ Alt+↑ 撤回 · Esc 打断并发送 · Ctrl+Enter 插队");
				});

				it("Steer + Follow-up 组合渲染，且多余条目折叠（Budget Clamping 机制）", () => {
					const queueComp = new PendingQueueComponent();
					queueComp.setItems([
						{ text: "紧急插队检查", mode: "steer" },
						{ text: "待办 1", mode: "followUp" },
						{ text: "待办 2", mode: "followUp" },
						{ text: "待办 3", mode: "followUp" },
						{ text: "待办 4", mode: "followUp" },
					]);

					const lines = queueComp.render(80);
					const raw = lines.map((l) => stripAnsi(l));
					expect(raw.some((l) => l.includes("◆ (Steer) · 下一步送达"))).toBe(true);
					expect(raw.some((l) => l.includes("◇ (Follow-up) · 本轮结束后送达 (4 条待办)"))).toBe(true);
					expect(raw.some((l) => l.includes("↳ 紧急插队检查"))).toBe(true);
					expect(raw.some((l) => l.includes("↳ 待办 1"))).toBe(true);
					expect(raw.some((l) => l.includes("↳ 待办 2"))).toBe(true);
					expect(raw.some((l) => l.includes("↳ ...另有 2 条待办已排队"))).toBe(true);
					expect(raw[raw.length - 1]).toContain("↳ Alt+↑ 撤回 · Esc 打断并发送 · Ctrl+Enter 插队");
				});

				it("多行换行被压平为单行，超长文本安全截断", () => {
					const queueComp = new PendingQueueComponent();
					queueComp.setItems([
						{
							text: "第一行内容\n第二行内容\r\n第三行内容" + "很长的文字".repeat(20),
							mode: "steer",
						},
					]);

					const lines = queueComp.render(50);
					const raw = lines.map((l) => stripAnsi(l));
					expect(raw[1]).not.toContain("\n");
					expect(raw[1]).toContain("第一行内容 第二行内容 第三行内容");
					// 每一行渲染宽度绝不超过 50
					for (const line of lines) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(50);
					}
				});

				it("InteractiveTUI: 接收 queue 消息时不污染 transcript 历史，而是挂载到 UIHost 悬浮区", () => {
					const tui = createInteractiveUI({ modelName: "TestModel", terminal: createSilentTerminal(80, 24).terminal });
					tui.start();
					const historyBefore = getTestUIHost(tui).transcript.getHistory().length;

					tui.consume(
						record({
							type: "queue",
							items: [{ id: "q-1", text: "排队消息1", mode: "steer", order: 1 }],
						}),
					);

					// transcript 历史中绝对不新增 notice，杜绝历史日志被反复刷屏污染
					expect(getTestUIHost(tui).transcript.getHistory().length).toBe(historyBefore);

					// UIHost 的 pendingQueue 组件状态已更新
					(getTestUIHost(tui) as any).renderCurrentFrame();
					const screenLines: string[] = (getTestUIHost(tui) as any).lastRenderedRows;
					const frameText = screenLines.map((l: string) => stripAnsi(l)).join("\n");
					expect(frameText).toContain("◆ (Steer) · 下一步送达");
					expect(frameText).toContain("↳ 排队消息1");

					// 队列清空时，悬浮区清空，不留残影
					tui.consume(record({ type: "queue", items: [] }));
					(getTestUIHost(tui) as any).renderCurrentFrame();
					const clearedLines: string[] = (getTestUIHost(tui) as any).lastRenderedRows;
					const clearedFrameText = clearedLines.map((l: string) => stripAnsi(l)).join("\n");
					expect(clearedFrameText).not.toContain("◆ (Steer)");
					expect(clearedFrameText).not.toContain("↳ 排队消息1");
					tui.close();
				});

				it("超窄终端（例如 width=35）：所有行绝对不超过 width 且不发生折行溢出", () => {
					const queueComp = new PendingQueueComponent();
					queueComp.setItems([
						{ text: "这是一条在极窄终端下排队的较长消息", mode: "steer" },
						{ text: "第二条跟进任务需要保证严格适配", mode: "followUp" },
					]);

					const lines = queueComp.render(35);
					expect(lines.length).toBeGreaterThan(0);
					for (const line of lines) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(35);
					}
				});
			});
		});
	});
	it("InteractiveTUI: reload notice 走 notify toast 而非 transcript", () => {
		const tui = new InteractiveTUI();
		const host = getTestUIHost(tui);
		const initialTranscriptLen = host.transcript.render(80).length;

		// 宿主事件流派发 notice（reloadExtensions 的产物）——经 tui.render 分发
		tui.consume(record({ type: "notice", text: "项目扩展已重新加载：1 个扩展激活。" }));

		// 不污染 transcript，出现在 toast 里
		expect(host.transcript.render(80).length).toBe(initialTranscriptLen);
		expect(host.getNotificationToast()).toEqual({ message: "项目扩展已重新加载：1 个扩展激活。", type: "info" });
		tui.close();
	});
});

describe("Transcript: 帧内单一行模型（getFrameModel）", () => {
	it("getFrameModel 与 render 输出恒等，且各索引 lineIndex 落在正确行", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "第一轮：请介绍你自己");
		transcript.appendToken(
			"我是助手。\n\n第二段内容，包含一些较长的文本用于产生折行，确保行索引计算覆盖多行段落场景。",
		);
		transcript.appendThinking("这是一段思考内容");
		transcript.appendToken("\n\n思考后的回答正文。");
		transcript.startTool(toolStartNode("bash", { command: "echo hi" }, "call-1"));
		transcript.addToolDone(toolDoneNode("bash", "hi", 5, "succeeded", "call-1", { command: "echo hi" }));
		transcript.appendToken("\n\n工具之后的收尾。");
		transcript.finishTurn();

		const W = 80;
		const model = transcript.getFrameModel(W);
		// 1. 行序列与 render 恒等
		expect(model.lines).toEqual(transcript.render(W));

		// 2. turnStartByUid：每个轮次起始行就是该轮的首行（用户行或空行）
		for (const [, start] of model.turnStartByUid) {
			expect(start).toBeGreaterThanOrEqual(0);
			expect(start).toBeLessThan(model.lines.length);
		}

		// 3. thinking 索引：指向的行确实是思考块（含 ✦ 图标与「思考」标题）
		expect(model.thinkingLocations.length).toBe(1);
		for (const loc of model.thinkingLocations) {
			const seg = model.lines.slice(loc.lineIndex, loc.lineIndex + Math.max(1, loc.lineCount ?? 1));
			expect(seg.join("\n")).toContain("思考");
		}

		// 4. tool 索引：指向的行确实是工具卡片（含工具名）
		expect(model.toolLocations.length).toBe(1);
		for (const loc of model.toolLocations) {
			const seg = model.lines.slice(loc.lineIndex, loc.lineIndex + Math.max(1, loc.lineCount));
			expect(seg.join("\n").toLowerCase()).toContain(loc.name.toLowerCase());
		}

		// 5. 帧内单源由调用方保证（FrameLayout.frameModel 贯通），这里验证重复取用内容不漂移
		expect(transcript.getFrameModel(W).lines).toEqual(model.lines);
	});

	it("流式进行中（currentTurn 存在）同样保持 model/render 恒等", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "流式问题");
		transcript.appendToken("流式进行中的部分回答。");
		transcript.appendThinking("思考中");
		const W = 60;
		const model = transcript.getFrameModel(W);
		expect(model.lines).toEqual(transcript.render(W));
		// 当前回合也登记进 turnStartByUid（一行一条，起始行落在行序列内）
		expect(model.turnStartByUid.size).toBe(1);
		for (const start of model.turnStartByUid.values()) {
			expect(start).toBeGreaterThanOrEqual(0);
			expect(start).toBeLessThan(model.lines.length);
		}
	});
});

describe("Transcript: 助手文本分段渲染与全文一次成型逐行等价", () => {
	// 参考实现：与分段缓存改造前的 formatAssistantMarkdown 算法逐行一致，
	// 作为「分段路径 ≡ 全文路径」的对拍基准。
	function referenceFormatFull(markdown: string, width: number, isFirstParagraph: boolean): string[] {
		const contentBudget = Math.max(20, width - 2);
		const rawLines = formatFullMarkdown(markdown, contentBudget);
		const formatted: string[] = [];
		let isFirst = isFirstParagraph;
		for (const rawLine of rawLines) {
			if (!rawLine.trim()) {
				formatted.push("");
				continue;
			}
			const clean = stripAnsi(rawLine).trimStart();
			if (["┌", "│", "└", "├", "┼", "┴", "┬"].some((ch) => clean.startsWith(ch))) {
				formatted.push(rawLine.trimStart());
				continue;
			}
			const wrapped = wrapLine(rawLine.trim(), contentBudget);
			for (let i = 0; i < wrapped.length; i++) {
				const piece = wrapped[i]!;
				if (isFirst && i === 0) {
					formatted.push(`${C.bold}${C.text}● ${C.reset}${piece}`);
					isFirst = false;
				} else {
					formatted.push(piece);
				}
			}
		}
		formatted.push("");
		return formatted;
	}

	const GNARLY_MD = [
		"# 主标题",
		"",
		"这是开头段落，包含**加粗**、`行内代码`与[链接](https://example.com)的中文文本，足够长以便在窄宽度下发生自动折行测试。".repeat(
			2,
		),
		"",
		"- 列表项一",
		"- 列表项二：带有 `code` 与**强调**",
		"",
		"> 引用块内容",
		"",
		"```typescript",
		"const a = 1;",
		"",
		"const b = 2; // 代码块内含空行，分段不得切断围栏",
		"```",
		"",
		"| 列一 | 列二 |",
		"| --- | --- |",
		"| 甲 | 乙 |",
		"| 丙 | 丁 |",
		"",
		"## 二级标题",
		"",
		"结尾段落。`尾段` 会随流式增长，必须每帧重排。",
	].join("\n");

	it("settled 渲染（走分段路径）与改造前全文算法逐行恒等", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "复杂 markdown");
		transcript.appendToken(GNARLY_MD);
		transcript.finishTurn();
		const rendered = transcript.render(80);
		// 转录区 turn 外壳 = 用户行 + 空行 + 正文 + 空行；正文部分对拍参考算法
		const body = rendered.slice(3);
		const expected = referenceFormatFull(GNARLY_MD, 80, true);
		expect(body).toEqual(expected);
	});

	it("流式进行中（currentTurn，含前缀段落）与 settled 渲染恒等", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "流式等价");
		transcript.appendToken(GNARLY_MD);
		const streamingRender = transcript.render(80);
		transcript.finishTurn();
		const settledRender = transcript.render(80);
		expect(streamingRender).toEqual(settledRender);
	});

	it("分段后前缀定位：每个文本 item 的首段带 ●（现状口径：item 粒度）", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "q");
		transcript.appendToken("第一段。");
		transcript.appendThinking("思考");
		transcript.appendToken("第二段才带前缀。");
		transcript.finishTurn();
		const rendered = transcript.render(80);
		// ● 前缀是轮次粒度：仅本轮首个文本 item 的首行；后续 item 不再带
		expect(rendered.find((l) => l.includes("第一段"))).toContain("●");
		expect(rendered.find((l) => l.includes("第二段才带前缀"))).not.toContain("●");
	});

	it("多个回合各自首段都带 ● 前缀（缓存不跨回合污染前缀状态）", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "第一问");
		transcript.appendToken("回合一的回答。");
		transcript.finishTurn();
		transcript.startTurn(2, "第二问");
		transcript.appendToken("回合二的回答。");
		transcript.finishTurn();
		const rendered = transcript.render(80);
		expect(rendered.filter((l) => l.includes("●") && l.includes("回答")).length).toBe(2);
	});

	it("InputLine: 词级移动 (Ctrl/Alt+Left/Right) 与词级删除 (Ctrl+W)", async () => {
		const { InputLine } = await import("../src/ui/components/editor/input-line.js");
		const input = new InputLine();
		input.setText("hello world foo_bar");
		expect(input.getCursorIndex()).toBe(19);

		// Ctrl+Left (向左跳过 foo_bar)
		input.handleInput("\x1b[1;5D");
		expect(input.getCursorIndex()).toBe(12);

		// Ctrl+Left (向左跳过 world)
		input.handleInput("\x1b[1;5D");
		expect(input.getCursorIndex()).toBe(6);

		// Ctrl+Right (向右跳到 world 末尾)
		input.handleInput("\x1b[1;5C");
		expect(input.getCursorIndex()).toBe(11);

		// 光标移到最后，测试 Ctrl+W 词级删除
		input.setText("git commit -m");
		input.handleInput("\x17"); // Ctrl+W 删除 -m
		expect(input.getText()).toBe("git commit ");

		input.handleInput("\x17"); // Ctrl+W 删除 commit
		expect(input.getText()).toBe("git ");
	});

	it("InputLine: 全选状态下按 Left/Right 正确解脱全选并归位首尾", async () => {
		const { InputLine } = await import("../src/ui/components/editor/input-line.js");
		const input = new InputLine();
		input.setText("hello world");
		input.handleInput("\x01"); // Ctrl+A
		expect(input.hasSelection()).toBe(true);

		input.handleInput("\x1b[D"); // Left
		expect(input.hasSelection()).toBe(false);
		expect(input.getCursorIndex()).toBe(0);

		input.handleInput("\x01"); // Ctrl+A
		input.handleInput("\x1b[C"); // Right
		expect(input.hasSelection()).toBe(false);
		expect(input.getCursorIndex()).toBe(11);
	});

	it("UIHost: 模态面板支持通过自身绑定的快捷键 Toggle 关闭，同时不破坏浮层对其他按键的捕获契约", () => {
		const registry = new ExtensionRegistry();
		let commandCalls = 0;
		registry.registerCommand({
			name: "tasks-test",
			description: "test tasks panel",
			keybinding: "alt+j",
			handler: () => {
				commandCalls++;
				harness.host.showPanel("tasks-test", (close) => ({
					render: () => ["tasks content"],
					handleInput: () => {},
					onClose: close,
				}));
			},
		} as any);

		const harness = createTestTUI({ registry });
		try {
			// 1. 初次按 Alt+J：打开面板
			dispatchUIHostInput(harness.host, "\x1bj");
			expect(commandCalls).toBe(1);
			expect(harness.host.overlayStack.hasVisible).toBe(true);

			// 2. 再次按 Alt+J：同键 Toggle 关闭面板
			dispatchUIHostInput(harness.host, "\x1bj");
			expect(harness.host.overlayStack.hasVisible).toBe(false);

			// 3. 输入框有草稿时，打开面板后按 Ctrl+C：关闭面板，且不误删输入框草稿
			harness.host.inputLine.setText("保留这段重要草稿");
			dispatchUIHostInput(harness.host, "\x1bj");
			expect(harness.host.overlayStack.hasVisible).toBe(true);

			dispatchUIHostInput(harness.host, "\x03");
			expect(harness.host.overlayStack.hasVisible).toBe(false);
			expect(harness.host.inputLine.getText()).toBe("保留这段重要草稿");

			// 4. 面板已关闭状态下，再次在输入框按 Ctrl+C：清空草稿
			dispatchUIHostInput(harness.host, "\x03");
			expect(harness.host.inputLine.getText()).toBe("");
		} finally {
			harness.dispose();
		}
	});
	it("formatErrorCardLines: 模型目录刷新告警卡片格式化（去重叠前缀、提炼徽标、友好注解、安全折行）", () => {
		const raw = "[模型目录刷新] 模型目录刷新: 5/6 家已更新; 未更新 vanyo-gpt: 模型目录请求失败 HTTP 403";
		const lines = formatErrorCardLines(raw, 80);
		expect(lines.length).toBeGreaterThan(0);
		const fullText = lines.join("\n");
		// 1. 去除套娃前缀，仅保留提炼后的模块徽标 [模型目录]
		expect(fullText).toContain("[模型目录]");
		expect(fullText).not.toContain("[模型目录刷新] 模型目录刷新");
		// 2. 摘要与明细分层
		expect(fullText).toContain("5/6 家已更新");
		expect(fullText).toContain("vanyo-gpt: 模型目录请求失败 HTTP 403");
		// 3. 增强友好注解
		expect(fullText).toContain("访问受限");
		// G9：文本启发式降级已删——“5/6 家已更新”不再凭文本猜成警告；
		// 显式 severity 应由事件源声明，文本一律按 error 呈现。
		expect(lines[0]).toContain("✗");
		// 5. 末行留白
		expect(lines[lines.length - 1]).toBe("");
	});

	it("formatErrorCardLines: 致命错误粉红标示与超窄宽度安全折行", () => {
		const raw = "[命令错误] 未知参数: --experimental-flag-with-a-very-long-argument-string-exceeding-normal-width";
		const lines = formatErrorCardLines(raw, 40);
		expect(lines.length).toBeGreaterThan(1);
		// 1. 致命错误标示为 ✗
		expect(lines[0]).toContain("✗");
		expect(lines[0]).toContain("[命令]");
		// 2. 宽度严格自适应，没有单行超过 40 列
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("formatErrorCardLines: 全盘失败 0/N 诚实标示为 error 而非降级 warning", () => {
		const raw = "[模型目录] 0/6 家已更新；未更新: 全部 Provider 均不可达";
		const lines = formatErrorCardLines(raw, 80);
		expect(lines[0]).toContain("✗");
		expect(lines[0]).not.toContain("⚠");
		expect(lines.join("\n")).toContain("0/6 家已更新");
	});

	it("formatErrorCardLines: 极端超窄终端（25 列）绝对不超宽与自动换行防护", () => {
		const raw = "[非常长的插件模块名称] 启动严重失败: 初始化依赖组件失败并在超长参数下尝试恢复";
		const lines = formatErrorCardLines(raw, 25);
		expect(lines.length).toBeGreaterThan(2);
		// 每一行必须严格 <= 25 列（绝对杜绝 pending-wrap 与帧破坏）
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(25);
		}
	});

	it("formatErrorCardLines: 堆栈调用行平滑缩进排版（无圆点 bullet 噪点）", () => {
		const raw = "[系统异常] 发生未捕获异常\n  at Object.run (file.ts:1:2)\n  at process.tick (core.ts:3:4)";
		const lines = formatErrorCardLines(raw, 80);
		const full = lines.join("\n");
		expect(full).toContain("at Object.run");
		expect(full).toContain("at process.tick");
		// 堆栈行前缀不应出现 bullet 圆点
		const stackLines = lines.filter((l) => l.includes("at Object.run") || l.includes("at process.tick"));
		for (const sl of stackLines) {
			expect(sl).not.toContain("•");
		}
	});

	it("TranscriptContainer: addError 接入结构化卡片渲染并在转录区展示", () => {
		const transcript = new TranscriptContainer();
		transcript.addError("[扩展系统] 插件加载失败: 缺少依赖模块 lodash");
		const blocks = transcript.render(80);
		const rendered = blocks.join("\n");
		expect(rendered).toContain("[扩展系统]");
		expect(rendered).toContain("插件加载失败: 缺少依赖模块 lodash");
		expect(rendered).toContain("✗");
	});
});
