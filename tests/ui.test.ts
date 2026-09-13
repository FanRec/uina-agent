import { describe, it, expect, vi } from "vitest";
import {
	C,
	visibleWidth,
	truncateToWidth,
	wrapTextWithAnsi,
	stripAnsi,
} from "../src/ui/core/utils.js";
import { Container } from "../src/ui/core/container.js";
import { FocusManager } from "../src/ui/core/focus.js";
import { OverlayStack } from "../src/ui/core/overlay.js";
import { WidgetSlots } from "../src/ui/core/slots.js";
import { CURSOR_MARKER } from "../src/ui/core/types.js";
import { Key, matchesKey } from "../src/ui/core/keys.js";
import { StreamMarkdownFormatter } from "../src/ui/components/transcript/stream-markdown.js";
import { ContextBarComponent, allocateBarColumns, renderSegmentedBar } from "../src/ui/components/widgets/context-bar.js";
import { ScrollbarGutterComponent } from "../src/ui/components/widgets/scrollbar-gutter.js";
import { TimelineRailComponent } from "../src/ui/components/widgets/timeline-rail.js";
import { SmoothRevealController, revealStep, safeSliceEnd } from "../src/ui/components/transcript/smooth-reveal.js";
import {
	computeWordDiff,
	alignSplitDiff,
	formatSplitDiffCardLines,
	formatDiffCardLines,
	formatToolCardLines,
	getToolCategory,
	getToolCategoryColor,
	displayName,
	foldTerminalCommand,
	formatDuration,
	applyCardBackground,
	extractSummaryArgs,
	BLACK_CIRCLE,
	BULLET,
	MULTIPLICATION_X,
	GUTTER_FIRST,
	GUTTER_REST,
	CustomMessageComponent,
	CustomEntryComponent,
	TranscriptContainer,
} from "../src/ui/components/transcript/index.js";
import {
	ActivityLineComponent,
	PendingQueueComponent,
	formatTpsGauge,
	formatTpsSparkline,
} from "../src/ui/components/widgets/index.js";
import {
	InputLine,
	segmentWithMarkers,
	snapCursorToMarkerBoundary,
} from "../src/ui/components/editor/index.js";
import {
	TaskDashboard,
	type JobPort,
	SubagentDashboard,
	TrajectoryScene,
	ModelPicker,
	EffortSlider,
	HelpMenu,
} from "../src/ui/components/overlays/index.js";
import { getStartupBanner } from "../src/ui/components/primitives/banner.js";
import { calculateContextSegments } from "../src/agent/context.js";
import { combineQueuedDraft } from "../src/cli/draft.js";
import { ExtensionRegistry } from "../src/extensions/renderer-registry.js";
import { createExtensionUIContext } from "../src/ui/extension-ui-context.js";
import { JobRegistry, type JobOutcome, type JobSnapshot } from "../src/extensions/jobs/registry.js";
import { createJobAdapter } from "../src/ui/adapters/jobs.js";
import { createSubagentAdapter } from "../src/ui/adapters/subagents.js";
import { TrajectoryProjection } from "../src/ui/adapters/agent-events.js";
import { createInteractiveUI, InteractiveTUI } from "../src/ui/tui.js";
import { UIHost } from "../src/ui/ui-host.js";

describe("UI Core: Utils", () => {
	it("正确计算包含中文与 ANSI 样式的可见字符宽度", () => {
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("你好世界")).toBe(8);
		expect(visibleWidth("\x1b[31m你好\x1b[0m world")).toBe(10);
	});

	it("ANSI 安全截断：不截断转义码且正确补齐闭合", () => {
		const text = "\x1b[36m这是一个很长的句子需要截断\x1b[0m";
		const truncated = truncateToWidth(text, 10);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(10);
		expect(truncated).toContain("\x1b[0m");
	});

	it("带 ANSI 样式的文本折行", () => {
		const text = "第一行测试很长需要折行的一句话\n第二行短";
		const lines = wrapTextWithAnsi(text, 12);
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

	it("FocusManager 焦点转移与 CURSOR_MARKER 提取", () => {
		const focusManager = new FocusManager();
		const comp1 = { focused: false, render: () => [] };
		const comp2 = { focused: false, render: () => [] };

		focusManager.setFocus(comp1);
		expect(comp1.focused).toBe(true);

		focusManager.setFocus(comp2);
		expect(comp1.focused).toBe(false);
		expect(comp2.focused).toBe(true);

		const rawLines = [
			"Top line text",
			`Prompt > input text${CURSOR_MARKER}`,
			"Bottom line text",
		];
		const { cleanLines, cursor } = focusManager.extractCursor(rawLines);
		expect(cursor).toEqual({ row: 1, col: visibleWidth("Prompt > input text") + 1 });
		expect(cleanLines[1]).toBe("Prompt > input text");
		expect(cleanLines[1]).not.toContain(CURSOR_MARKER);
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

	it("WidgetSlots 小部件插槽：placement 分离与优先级排序", () => {
		const renderSpy = vi.fn();
		const slots = new WidgetSlots(renderSpy);

		slots.setWidget("w1", { render: () => ["above-1"] }, "aboveEditor", 10);
		slots.setWidget("w2", { render: () => ["above-0"] }, "aboveEditor", 0);
		slots.setWidget("w3", { render: () => ["below-1"] }, "belowEditor", 10);

		const above = slots.render("aboveEditor", 80);
		expect(above).toEqual(["above-0", "above-1"]);

		const below = slots.render("belowEditor", 80);
		expect(below).toEqual(["below-1"]);

		slots.removeWidget("w1");
		expect(slots.render("aboveEditor", 80)).toEqual(["above-0"]);
	});
});

describe("UI Extensions: ExtensionRegistry & ExtensionUIContext", () => {
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

	it("CustomEntryComponent 支持动态注册的 EntryRenderer 与默认兜底", () => {
		const registry = new ExtensionRegistry();

		const compDefault = new CustomEntryComponent({
			customType: "meta:run",
			data: { runId: 123 },
		});
		const renderedDefault = compDefault.render(80);
		expect(renderedDefault.join("\n")).toContain("[条目: meta:run]");
		expect(renderedDefault.join("\n")).toContain('"runId":123');

		registry.registerEntryRenderer("meta:run", (entry) => ({
			render: () => [`Custom Entry: ${JSON.stringify(entry.data)}`],
		}));

		const compCustom = new CustomEntryComponent(
			{ customType: "meta:run", data: { runId: 123 } },
			registry.getEntryRenderer("meta:run"),
		);
		expect(compCustom.render(80)).toEqual(['Custom Entry: {"runId":123}']);
	});

	it("从单一 session entry 流按原顺序恢复消息、扩展内容和压缩记录", () => {
		const transcript = new TranscriptContainer();
		transcript.loadSession([
			{ kind: "message", message: { role: "user", content: "ORDER_A" } },
			{ kind: "custom_message", customType: "probe", content: "ORDER_C" },
			{ kind: "message", message: { role: "assistant", content: "ORDER_B" } },
			{ kind: "custom_message", customType: "hidden", content: "MUST_NOT_RENDER", display: false },
			{ kind: "custom_entry", customType: "probe-entry", data: { text: "ORDER_D" } },
			{ kind: "compaction", summary: "ORDER_SUMMARY", retainedTail: [], tokensBefore: 42 },
		]);

		const rendered = stripAnsi(transcript.render(80).join("\n"));
		const positions = ["ORDER_A", "ORDER_C", "ORDER_B", "ORDER_D", "ORDER_SUMMARY"].map((text) => rendered.indexOf(text));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(rendered).not.toContain("MUST_NOT_RENDER");
	});

	it("createExtensionUIContext 调度宿主接口", () => {
		const hostPort = {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
			setWorkingVisible: vi.fn(),
			setWidget: vi.fn(),
			setHeader: vi.fn(),
			setFooter: vi.fn(),
			showOverlay: vi.fn(),
			pasteToEditor: vi.fn(),
			setEditorText: vi.fn(),
			getEditorText: vi.fn(() => "current-text"),
			onTerminalInput: vi.fn(() => () => {}),
			requestRender: vi.fn(),
		};

		const ctx = createExtensionUIContext(hostPort);

		ctx.notify("test message", "warning");
		expect(hostPort.notify).toHaveBeenCalledWith("test message", "warning");

		ctx.setStatus("model", "gpt-4o");
		expect(hostPort.setStatus).toHaveBeenCalledWith("model", "gpt-4o");

		ctx.setWorkingMessage("searching...");
		expect(hostPort.setWorkingMessage).toHaveBeenCalledWith("searching...");

		expect(ctx.getEditorText()).toBe("current-text");
	});
});

describe("UI Adapters: Jobs & Subagents & Trajectory", () => {
	it("createJobAdapter 无状态直连 JobRegistry，取消任务同步生效", async () => {
		const registry = new JobRegistry();
		const port = createJobAdapter(registry);

		// 初始列表为空
		expect(port.list()).toEqual([]);

		// 启动一个真实后台作业
		const spec = {
			label: "test-build",
			ownerId: "root",
			source: { extension: "build-tool" },
			start: (ctx: any) => {
				ctx.observe({ text: "Compiling typescript...\n" });
				let cancelled = false;
				return {
					cancel: () => {
						cancelled = true;
					},
					done: new Promise<JobOutcome>((resolve) => {
						setTimeout(() => resolve({ status: cancelled ? "killed" : "completed" }), 200);
					}),
				};
			},
		};

		const jobId = await registry.start(spec);
		const snapshot = registry.get(jobId, "root");
		expect(snapshot.label).toBe("test-build");

		// UI Port 直接拉取到该任务
		const tasks = port.list();
		expect(tasks.length).toBe(1);
		expect(tasks[0]!.label).toBe("test-build");

		// 读取日志
		const readRes = port.read(snapshot.id, 0);
		expect(readRes.text).toContain("Compiling typescript...");

		// 通过 UI Port 发送取消指令
		const cancelRes = port.cancel(snapshot.id, "用户终止");
		expect(cancelRes).toBe(true);

		// Dashboard 无状态渲染
		const dashboard = new TaskDashboard(port);
		const lines = dashboard.formatLines(80);
		expect(lines.join("\n")).toContain("后台任务与进程看板");
		expect(lines.join("\n")).toContain("test-build");

		await registry.close();
	});

	it("createSubagentAdapter 无状态直连 SubagentRegistry", async () => {
		const mockRegistry = {
			list: vi.fn(() => [
				{
					id: "sub-1",
					ownerId: "root",
					label: "代码审计子智能体",
					status: "running" as const,
					createdAt: Date.now() - 5000,
					outputCursor: 1,
					busy: true,
				},
			]),
			read: vi.fn(() => ({
				cursor: 1,
				output: [{ cursor: 0, kind: "text" as const, text: "正在分析 AST 节点..." }],
				outputLost: false,
				subagent: {} as any,
			})),
			transcript: vi.fn(() => ({
				subagent: {} as any,
				messages: [],
			})),
			send: vi.fn(async () => {}),
			interrupt: vi.fn(async () => "interruption-requested" as const),
		};

		const port = createSubagentAdapter(mockRegistry as any);
		const agents = port.list("root");
		expect(agents.length).toBe(1);
		expect(agents[0]!.label).toBe("代码审计子智能体");

		const dashboard = new SubagentDashboard(port, "root");
		const lines = dashboard.formatLines(80);
		expect(lines.join("\n")).toContain("多子智能体看板");
		expect(lines.join("\n")).toContain("代码审计子智能体");
		expect(lines.join("\n")).toContain("正在分析 AST 节点...");
	});

	it("TrajectoryProjection 严格从真实运行时事件构建时序与性能热点，杜绝假数据", () => {
		const proj = new TrajectoryProjection();
		expect(proj.list()).toEqual([]);

		// 1. 用户轮次开始
		proj.onTurnStart(1, "请排查死锁");
		expect(proj.list().length).toBe(1);
		expect(proj.list()[0]!.kind).toBe("turn_start");

		// 2. 深度思考
		const thinkId = proj.onThinkingStart("思考链推演");
		proj.onThinkingDone(thinkId, "推演完成：锁顺序颠倒");
		expect(proj.list().length).toBe(2);

		// 3. 工具执行
		const toolId = proj.onToolStart("run_command", { CommandLine: "pnpm test" });
		proj.onToolDone(toolId, "run_command", "exit code 0", 120, "succeeded");
		expect(proj.list().length).toBe(3);

		// 4. 热点聚合
		const hotspots = proj.aggregate("duration");
		expect(hotspots.length).toBeGreaterThan(0);
		expect(hotspots.some((h) => h.name === "run_command")).toBe(true);

		// 5. 轨迹看板渲染无假数据 (Tab 切换到热点视图可审查聚合的工具指标)
		const scene = new TrajectoryScene(proj);
		scene.handleInput("\t");
		const lines = scene.formatLines(80);
		expect(lines.join("\n")).toContain("全屏事件时序与审计轨迹");
		expect(lines.join("\n")).toContain("run_command");
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

	it("当前流式思考立即可见，并注册鼠标展开目标", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "正在处理的问题");
		transcript.appendThinking("这是尚未进入工具阶段的实时思考内容");

		expect(transcript.render(60).join("\n")).toContain("实时思考内容");
		expect(transcript.getThinkingLineIndices(60).map(({ turnN, lineIndex }) => ({ turnN, lineIndex })))
			.toEqual([{ turnN: 1, lineIndex: 3 }]);
	});

	it("鼠标折叠当前 thinking 时按块对象定位，不会误切同编号的历史轮次", () => {
		const transcript = new TranscriptContainer();
		transcript.loadHistory([
			{ role: "user", content: "旧问题" },
			{ role: "assistant", content: "", thinking: "旧思考" },
		]);
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
		// 未 hover 时渲染 1 行空白占位行（防抖）
		expect(normalLines.length).toBe(1);
		expect(normalLines[0]).toBe("");

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
		expect(banner).toContain("模型未知");
		expect(banner).not.toContain("Latency <");
		expect(banner).not.toContain("tools ready");
	});

	it("模型选择器两级展示：第一级为服务商，Enter展开第二级模型列表，Enter选择，Esc返回", () => {
		const groups = [
			{
				id: "deepseek",
				name: "deepseek",
				description: "https://api.deepseek.com",
				models: [
					{
						id: "deepseek-v4-flash",
						name: "deepseek-v4-flash",
						description: "默认配置模型",
						provider: "deepseek",
					},
				],
			},
			{
				id: "anthropic",
				name: "anthropic",
				description: "api.anthropic.com",
				models: [
					{
						id: "claude-3-7-sonnet",
						name: "claude-3-7-sonnet",
						description: "主力模型",
						provider: "anthropic",
					},
					{
						id: "claude-3-5-haiku",
						name: "claude-3-5-haiku",
						description: "轻量模型",
						provider: "anthropic",
					},
				],
			},
		];

		const picker = new ModelPicker("deepseek-v4-flash", groups);
		let pickedModel = "";
		let closed = false;
		picker.onPick = (id) => { pickedModel = id; };
		picker.onClose = () => { closed = true; };

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
		picker2.onClose = () => { closed = true; };
		picker2.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	it("Shift+Tab 只请求 runtime 切换 thinking，不直接改写 UI 权威状态", () => {
		const host = new UIHost({ modelName: "model", thinkingLevels: ["off", "high"], thinkingLevel: "off" });
		const requested = vi.fn();
		host.onThinkingLevelCycle = requested;
		host.handleInput("\x1b[Z");
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

	it("CompactionRecord 格式化渲染与折叠双态像素对齐", async () => {
		const { formatCompactionCardLines } = await import("../src/ui/components/transcript/cards.js");

		const record = {
			summary: "1. 讨论系统架构\n2. 落地输入联想与差异卡片\n3. 优化文件发现机制",
			turnsCount: 3,
			tokensSaved: 18500,
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

	it("SyntaxText: 语言名称规范化与轻量语法高亮及降级", async () => {
		const { normalizeLanguage, highlightCode, highlightLines } = await import("../src/ui/components/primitives/syntax-text.js");

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
		const mockStdout = {
			columns: 80,
			rows: 24,
			isTTY: true,
			write: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: vi.fn(),
			resume: vi.fn(),
			pause: vi.fn(),
			setEncoding: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "deepseek-chat",
				cwd: "e:/Uina/test",
			});
			tui.host.registry.registerCommand({ name: "model", description: "切换模型", hasArgs: true });

			expect(tui.host.isBusy()).toBe(false);

			tui.render({ type: "turn_start", n: 1, text: "测试提问" });
			expect(tui.host.isBusy()).toBe(true);

			tui.render({ type: "text", text: "模型正在分析..." });
			tui.render({ type: "tool_start", name: "list_dir", args: {} });
			tui.render({ type: "tool_done", name: "list_dir", result: "dir output", elapsedMs: 50 });

			tui.render({ type: "turn_end", n: 1, usage: { usedTokens: 2048, contextWindow: 65536, actual: false } });
			expect(tui.host.isBusy()).toBe(false);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("正确捕获终端输入并在按下 Enter 时提交用户行", () => {
		let stdinCallback: ((data: string) => void) | undefined;
		const mockStdout = {
			columns: 80,
			rows: 24,
			isTTY: true,
			write: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: vi.fn(),
			resume: vi.fn(),
			pause: vi.fn(),
			setEncoding: vi.fn(),
			on: vi.fn((event: string, cb: (data: string) => void) => {
				if (event === "data") stdinCallback = cb;
			}),
			removeListener: vi.fn(),
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "test-model",
			});

			const submittedLines: string[] = [];
			tui.onLine((line) => {
				submittedLines.push(line);
			});

			// 1. 模拟输入 "2222" 并按回车 (\r)
			expect(stdinCallback).toBeDefined();
			stdinCallback!("2");
			stdinCallback!("2");
			stdinCallback!("2");
			stdinCallback!("2");
			stdinCallback!("\r");

			expect(submittedLines).toEqual(["2222"]);

			// 2. 模拟输入 "3333" 并按回车 (\n)
			stdinCallback!("3");
			stdinCallback!("3");
			stdinCallback!("3");
			stdinCallback!("3");
			stdinCallback!("\n");

			expect(submittedLines).toEqual(["2222", "3333"]);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("启动时正确恢复历史会话消息 (loadHistory) 到转录流中", () => {
		const mockStdout = {
			columns: 80,
			rows: 24,
			isTTY: true,
			write: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: vi.fn(),
			resume: vi.fn(),
			pause: vi.fn(),
			setEncoding: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "test-model",
			});

			tui.loadHistory([
				{ role: "user", content: "之前问的问题" },
				{ role: "assistant", content: "之前回答的答案", thinking: "思考过程" },
			]);

			const history = tui.host.transcript.getHistory();
			expect(history.length).toBe(1);
			expect(history[0]?.userText).toBe("之前问的问题");
			expect(history[0]?.assistantMarkdown).toBe("之前回答的答案");
			expect(history[0]?.thinkingText).toBe("思考过程");

			const rendered = tui.host.transcript.render(80);
			expect(rendered.some((l) => l.includes("之前问的问题"))).toBe(true);
			expect(rendered.some((l) => l.includes("之前回答的答案"))).toBe(true);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("支持鼠标滚轮与键盘 (PageUp/PageDown) 视口滚动", () => {
		let stdinCallback: ((data: string) => void) | undefined;
		const mockStdout = {
			columns: 80,
			rows: 24,
			isTTY: true,
			write: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: vi.fn(),
			resume: vi.fn(),
			pause: vi.fn(),
			setEncoding: vi.fn(),
			on: vi.fn((event: string, cb: (data: string) => void) => {
				if (event === "data") stdinCallback = cb;
			}),
			removeListener: vi.fn(),
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "test-model",
			});

			expect(tui.host.getScrollOffset()).toBe(0);

			// 1. 模拟按下 PageUp (\x1b[5~)
			stdinCallback!("\x1b[5~");
			expect(tui.host.getScrollOffset()).toBeGreaterThan(0);

			// 2. 模拟按下 PageDown (\x1b[6~)
			stdinCallback!("\x1b[6~");
			expect(tui.host.getScrollOffset()).toBe(0);

			// 3. 模拟 SGR 鼠标滚轮向上滚动 (\x1b[<64;20;10M)
			stdinCallback!("\x1b[<64;20;10M");
			expect(tui.host.getScrollOffset()).toBe(3);

			// 4. 模拟 SGR 鼠标滚轮向下滚动 (\x1b[<65;20;10M)
			stdinCallback!("\x1b[<65;20;10M");
			expect(tui.host.getScrollOffset()).toBe(0);

			// 5. 模拟滚上去后发送新消息，视口自动归位
			stdinCallback!("\x1b[<64;20;10M");
			expect(tui.host.getScrollOffset()).toBe(3);
			stdinCallback!("h");
			stdinCallback!("i");
			stdinCallback!("\r");
			expect(tui.host.getScrollOffset()).toBe(0);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("高频与粘包 SGR 鼠标事件被彻底拦截隔离，绝不泄漏至 InputLine 产生伪造粘贴标记", () => {
		let stdinCallback: ((data: string) => void) | undefined;
		const mockStdout = {
			columns: 80,
			rows: 24,
			isTTY: true,
			write: () => true,
			on: () => {},
			removeListener: () => {},
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: () => true,
			resume: () => {},
			pause: () => {},
			setEncoding: () => {},
			on: (_evt: string, cb: (data: string) => void) => {
				stdinCallback = cb;
			},
			removeListener: () => {},
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "test-model",
			});

			// 模拟高频移动产生的大量粘包 SGR 鼠标事件 (35 号 hover/move 事件连发)
			const packetChunk = "\x1b[<35;54;39M\x1b[<35;53;39M\x1b[<35;52;39M\x1b[<35;51;39M\x1b[<35;50;40M".repeat(5);
			stdinCallback!(packetChunk);

			// 模拟拆包时遗失了开头的 ESC 导致的残片
			stdinCallback!("[<35;54;39M[<35;53;39M");

			// 验证输入框中绝对没有任何内容，更无 [已粘贴] 胶囊
			const text = tui.host.getEditorText();
			expect(text).toBe("");
			expect(text.includes("已粘贴")).toBe(false);
			expect(text.includes("[<35;")).toBe(false);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("Agent 流式输出追加内容时，离开底部的视口保持绝对行号锚定，绝不被新内容顶跑", () => {
		let stdinCallback: ((data: string) => void) | undefined;
		const mockStdout = {
			columns: 80,
			rows: 20,
			isTTY: true,
			write: () => true,
			on: () => {},
			removeListener: () => {},
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: () => true,
			resume: () => {},
			pause: () => {},
			setEncoding: () => {},
			on: (_evt: string, cb: (data: string) => void) => {
				stdinCallback = cb;
			},
			removeListener: () => {},
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "test-model",
			});

			// 初始化 50 行历史，形成可滚动视口
			tui.host.transcript.startTurn(1, "初次提问");
			for (let i = 0; i < 50; i++) {
				tui.host.transcript.appendToken(`历史数据行 ${i}\n`);
			}
			tui.host.transcript.commitThinking();

			// 触发一次初始全帧渲染
			(tui.host as any).renderCurrentFrame();
			const initialLayout = (tui.host as any).computeLayout();
			const initialScrollStart = initialLayout.scrollStart;

			// 用户向上滚动查看历史
			stdinCallback!("\x1b[<64;20;10M"); // 滚轮向上滚 3 行
			stdinCallback!("\x1b[<64;20;10M"); // 滚轮向上滚 3 行
			(tui.host as any).renderCurrentFrame();

			const userScrolledLayout = (tui.host as any).computeLayout();
			const anchoredScrollStart = userScrolledLayout.scrollStart;
			expect(anchoredScrollStart).toBeLessThan(initialScrollStart);

			// 模拟 Agent 正在工作流式吐字，连续追加 30 行新内容
			for (let i = 0; i < 30; i++) {
				tui.host.transcript.appendToken(`流式新增行 ${i}\n`);
			}

			// 再次渲染，验证用户的视口顶部绝对行号纹丝不动，绝对没有被新行顶跑
			(tui.host as any).renderCurrentFrame();
			const streamedLayout = (tui.host as any).computeLayout();
			expect(streamedLayout.scrollStart).toBe(anchoredScrollStart);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("支持 / 命令与 @ 文件输入联想浮层与 Tab 补全", () => {
		let stdinCallback: ((data: string) => void) | undefined;
		const mockStdout = {
			columns: 80,
			rows: 24,
			isTTY: true,
			write: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const mockStdin = {
			isTTY: true,
			setRawMode: vi.fn(),
			resume: vi.fn(),
			pause: vi.fn(),
			setEncoding: vi.fn(),
			on: vi.fn((event: string, cb: (data: string) => void) => {
				if (event === "data") stdinCallback = cb;
			}),
			removeListener: vi.fn(),
		};

		const origStdout = process.stdout;
		const origStdin = process.stdin;
		Object.defineProperty(process, "stdout", { value: mockStdout, configurable: true });
		Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

		try {
			const tui = createInteractiveUI({
				modelName: "test-model",
				cwd: process.cwd(),
			});
			tui.host.registry.registerCommand({ name: "model", description: "切换模型", hasArgs: true });

			// 1. 输入 / 触发斜杠命令联想
			stdinCallback!("/");
			stdinCallback!("m");
			stdinCallback!("o");
			stdinCallback!("d");

			// 验证输入框文本为 /mod
			expect(tui.host.inputLine.getText()).toBe("/mod");

			// 按 Tab 自动补全为 /model
			stdinCallback!("\t");
			expect(tui.host.inputLine.getText()).toBe("/model ");

			// 清空输入框
			tui.host.inputLine.clear();

			// 2. 输入 @ 触发文件路径联想
			stdinCallback!("@");
			stdinCallback!("p");
			stdinCallback!("a");
			stdinCallback!("c");
			stdinCallback!("k");

			expect(tui.host.inputLine.getText()).toBe("@pack");

			// 按 Tab 自动补全
			stdinCallback!("\t");
			expect(tui.host.inputLine.getText()).toContain("@package.json");

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	it("助手回复展示带有实心绿点 ● 前缀与优化的视觉呼吸层次", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "1+1等于几？");
		transcript.appendToken("等于 2。");
		transcript.finishTurn();

		const rendered = transcript.render(80);
		expect(rendered.some((l: string) => l.includes("●") && l.includes("等于 2。"))).toBe(true);
	});

	it("用户输入展示为金色 ❯ 标记且助手段落折行采用零边距左对齐（无多余前导空格）", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "你好世界");
		// 输入超过行宽的长文本测试自动折行
		transcript.appendToken("这是一段非常长的助手回答内容用于测试换行功能确保换行后严格左对齐杜绝多余空格污染复制。");
		transcript.finishTurn();

		const rendered = transcript.render(30);
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

		const screenRows = [
			"Hello World Beautiful Day",
			"Second Line Text",
		];

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

	it("MouseSelectionTracker noSelect 保护：智能剥离 ● 符号与输入框外框 │", async () => {
		const { MouseSelectionTracker } = await import("../src/ui/core/mouse-selection.js");
		const tracker = new MouseSelectionTracker();

		const screenRows = [
			"● 这是回答内容",
			"│› 输入框文字      │",
		];

		// 1. 划选包含 ● 的行，提取时剥离 ●
		let copied1 = "";
		tracker.handleInput("\x1b[<0;1;1M", screenRows, (t) => { copied1 = t; });
		tracker.handleInput("\x1b[<32;14;1M", screenRows);
		tracker.handleInput("\x1b[<0;14;1m", screenRows, (t) => { copied1 = t; });
		expect(copied1).toBe("这是回答内容");

		// 2. 划选输入框，提取时隔离外框 │
		let copied2 = "";
		tracker.handleInput("\x1b[<0;1;2M", screenRows, (t) => { copied2 = t; });
		tracker.handleInput("\x1b[<32;20;2M", screenRows);
		tracker.handleInput("\x1b[<0;20;2m", screenRows, (t) => { copied2 = t; });
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
		tracker.handleInput("\x1b[<0;3;3M", screenRows, (t) => { copiedText = t; });
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
		tracker.handleInput("\x1b[<0;11;3m", screenRows, (t) => { copiedText = t; });
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
		const releaseRes = tracker.handleInput("\x1b[<0;1;1m", currentScreenRows, (t) => { copiedText = t; }, permanentLines);
		expect(releaseRes.handled).toBe(true);
		expect(copiedText).toContain("这是第 0 行长长长长长的转录历史正文内容");
		// 起始点击在 col 5，向上选中到第 0 行时，终点行第 15 行精准截断至 anchor col
		expect(copiedText).toContain("这是第");
		const copiedLineCount = copiedText.split("\n").length;
		expect(copiedLineCount).toBe(16);
	});

	it("TimelineRail 导航轨刻度与 Hover 气泡卡片生成", async () => {
		const { TimelineRailComponent } = await import("../src/ui/components/widgets/timeline-rail.js");
		const rail = new TimelineRailComponent();
		rail.updateTurns([
			{ uid: 1, n: 1, userText: "第一轮用户问题" },
			{ uid: 2, n: 2, userText: "第二轮长问题" },
		], 1);

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

		expect(formatCacheHitRate(0, 1000, 0)).toBeUndefined();
	});

	it("Ctrl+C 在输入框有内容时清空内容而不触发退出流程", async () => {
		const origStdout = process.stdout;
		const origStdin = process.stdin;
		try {
			const fakeStdout = {
				columns: 100,
				rows: 30,
				write: () => true,
				on: () => fakeStdout,
				removeListener: () => fakeStdout,
			} as unknown as NodeJS.WriteStream;

			const fakeStdin = {
				isTTY: true,
				setRawMode: () => fakeStdin,
				resume: () => fakeStdin,
				pause: () => fakeStdin,
				on: () => fakeStdin,
				removeListener: () => fakeStdin,
			} as unknown as NodeJS.ReadStream;

			Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

			const tui = createInteractiveUI({
				modelName: "deepseek-chat",
				cwd: "e:/Uina/test",
			});

			let interruptCalled = false;
			tui.host.onInterrupt = () => {
				interruptCalled = true;
			};

			// 输入文字
			tui.host.handleInput("hello world");
			expect(tui.host.inputLine.getText()).toBe("hello world");

			// 按 Ctrl+C：应清空输入框内容，不应退出也不应触发退出确认
			tui.host.handleInput("\x03"); // Ctrl+C
			expect(tui.host.inputLine.getText()).toBe("");
			expect(interruptCalled).toBe(false);
			expect((tui.host as any).exitPending).toBe(false);

			// 输入框已清空后，再次按 Ctrl+C：应触发退出确认 (exitPending = true)
			tui.host.handleInput("\x03");
			expect((tui.host as any).exitPending).toBe(true);

			// 3秒内再次按 Ctrl+C：真正退出
			tui.host.handleInput("\x03");
			expect(interruptCalled).toBe(true);

			tui.close();
		} finally {
			Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
			Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
		}
	});

	describe("UI Architecture & Component Integrity Fixes", () => {
		it("truncateToWidth 当 maxWidth 小于省略号长度时安全降级不超宽", () => {
			expect(visibleWidth(truncateToWidth("hello", 1, "..."))).toBeLessThanOrEqual(1);
			expect(visibleWidth(truncateToWidth("hello", 0, "..."))).toBe(0);
			expect(visibleWidth(truncateToWidth("hello", 2, "..."))).toBeLessThanOrEqual(2);
		});

		it("EffortSlider 在只有少量或单个档位时安全初始化不发生越界崩溃", () => {
			const slider1 = new EffortSlider("high", [{ id: "high", name: "High", description: "Deep" }]);
			expect(slider1.getCurrentTier().id).toBe("high");
			expect(slider1.navigateRight().id).toBe("high");
			expect(slider1.navigateLeft().id).toBe("high");

			const slider2 = new EffortSlider("unknown", [{ id: "low", name: "Low", description: "Fast" }]);
			expect(slider2.getCurrentTier().id).toBe("low");
		});

		it("EffortSlider 支持传入 ThinkingLevel[] 纯字符串数组并安全切换与触发 onChange", () => {
			const changedLevels: string[] = [];
			const slider = new EffortSlider("off", ["off", "high", "max"]);
			slider.onChange = (level) => changedLevels.push(level);

			expect(slider.getCurrentTier().id).toBe("off");
			expect(slider.getCurrentTier().name).toBe("Off");

			slider.handleInput("\x1b[C"); // Key.right
			expect(slider.getCurrentTier().id).toBe("high");
			expect(slider.getCurrentTier().name).toBe("High");
			expect(changedLevels).toEqual(["high"]);

			slider.handleInput("\x1b[C"); // Key.right
			expect(slider.getCurrentTier().id).toBe("max");
			expect(slider.getCurrentTier().name).toBe("Max");
			expect(changedLevels).toEqual(["high", "max"]);

			slider.handleInput("\x1b[D"); // Key.left
			expect(slider.getCurrentTier().id).toBe("high");
			expect(changedLevels).toEqual(["high", "max", "high"]);
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

			let changed: string = "";
			// 模拟 builtin.ts 中执行 /effort 打开滑块传入 declaredLevels 字符串数组
			host.openEffortSlider("off", ["off", "high", "max"] as any, (level) => {
				changed = level;
			});

			// 按右箭头切换档位，验证绝不抛出 TypeError: Cannot read properties of undefined (reading 'toLowerCase')
			expect(() => {
				host.handleInput("\x1b[C"); // Key.right
			}).not.toThrow();

			expect(changed).toBe("high");
			expect(host.getReasoningEffort()).toBe("high");

			// 验证 setReasoningEffort 传入 undefined/空值安全守卫
			expect(() => host.setReasoningEffort(undefined as any)).not.toThrow();
		});

		it("TranscriptContainer 严格保证思考、文本、运行中工具与完成工具的时间序节点流", () => {
			const transcript = new TranscriptContainer();
			transcript.startTurn(1, "用户输入");
			transcript.appendThinking("开始推理");
			transcript.appendToken("第一段文本回复");
			transcript.startTool("bash", { command: "ls" }, "call-1");

			let lines = transcript.render(80).join("\n");
			expect(lines).toContain("开始推理");
			expect(lines).toContain("第一段文本回复");
			expect(lines).toContain("Bash");
			expect(lines).toContain("Running…");

			transcript.addToolDone("bash", "file1.txt\nfile2.txt", 120, "succeeded", "call-1");
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

		it("TaskDashboard 当任务数量超过4个时使用滑动视口平滑滚动", () => {
			const mockJobs: JobSnapshot[] = [];
			for (let i = 0; i < 8; i++) {
				mockJobs.push({
					id: `job-${i}`,
					label: `Task ${i}`,
					status: "running" as const,
					ownerId: "root",
					source: { extension: "test" },
					startedAt: Date.now() - 1000,
				});
			}
			const port: JobPort = {
				list: () => mockJobs,
				read: () => ({
					output: [],
					text: "",
					cursor: 0,
					outputLost: false,
					finished: false,
					truncated: false,
					job: mockJobs[0]!,
				}),
				cancel: () => true,
			};
			const dash = new TaskDashboard(port);
			let rendered = dash.render(80).join("\n");
			expect(rendered).toContain("Task 0");
			expect(rendered).toContain("(1/8)");

			for (let i = 0; i < 6; i++) {
				dash.handleInput("\x1b[B");
			}
			rendered = dash.render(80).join("\n");
			expect(rendered).toContain("Task 6");
			expect(rendered).toContain("(7/8)");
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
			const banner = getStartupBanner({ modelName: "uina-model", cwd: process.cwd() }, 100);
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
			expect(fastGauge).toContain("32m"); // C.green (≥50)
			expect(fastGauge).toContain("▕");
			expect(fastGauge).toContain("▏");

			const medGauge = formatTpsGauge(35, 60, 8);
			expect(medGauge).toContain("33m"); // C.yellow (≥20)

			const slowGauge = formatTpsGauge(10, 60, 8);
			expect(slowGauge).toContain("31m"); // C.red (<20)
		});

		it("formatTpsSparkline 正确将多段采样归一化为火花线字符", () => {
			const samples = [10, 25, 40, 60, 80];
			const spark = formatTpsSparkline(samples);
			expect(spark.length).toBe(5);
			expect(spark[0]).toBe(" ");
			expect(spark[spark.length - 1]).toBe("█");
		});

		it("ActivityLineComponent 在完成时输出耗时、Token数与火花线趋势图", () => {
			const act = new ActivityLineComponent();
			act.start("streaming", "正在生成回复...");
			act.addTokens(50);
			act.finish("生成结束", 1000, 50);

			const header = act.getHeaderString(100);
			expect(header).toContain("生成结束");
			expect(header).toContain("耗时 1.0s");
			expect(header).toContain("50 tokens");
			expect(header).toContain("tps");
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
			// 默认 lastMaxScroll 为 0，此时 startAutoScroll 不会无故起动计时器
			host.startAutoScroll("up");
			// 手动设置最大可滚动范围
			(host as any).lastMaxScroll = 50;
			(host as any).lastChatAreaH = 20;
			(host as any).lastScrollStart = 30;

			host.startAutoScroll("up");
			expect((host as any).autoScrollTimer).not.toBeNull();
			expect((host as any).autoScrollDirection).toBe("up");

			// 停止自动滚屏
			host.stopAutoScroll();
			expect((host as any).autoScrollTimer).toBeNull();
			expect((host as any).autoScrollDirection).toBeNull();

			// 键盘输入应当立刻打断自动滚屏
			host.startAutoScroll("up");
			expect((host as any).autoScrollTimer).not.toBeNull();
			(host as any).handleTerminalInput("a");
			expect((host as any).autoScrollTimer).toBeNull();
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
			rail.updateTurns([
				{ uid: 1, n: 1, userText: "问题一" },
				{ uid: 2, n: 2, userText: "问题二" },
			], 2);
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
			rail.updateTurns([
				{ uid: 11, n: 1, userText: "第一轮" },
				{ uid: 12, n: 1, userText: "撞号的第七轮" },
			], 12);
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

			// 按 q 键关闭
			menu.handleInput("q");
			expect(closed).toBe(true);
		});

		it("HelpMenu 严防超长描述撑破边框，所有渲染行宽度严格一致且包含核心快捷键", () => {
			const longCommand = {
				name: "extremely_long_command_name_that_should_not_break_the_ui",
				description: "这是一个极其漫长并且没有任何换行的超长命令描述，用来测试排版引擎的截断与边界防护能力，绝对不能破坏右侧边框！".repeat(3),
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

		it("HelpMenu: 按 '?' 优先触发 onConvertToInput，未提供则回退至 onClose", () => {
			const menu = new HelpMenu();
			let convertedText = "";
			let closed = false;

			menu.onConvertToInput = (t) => { convertedText = t; };
			menu.onClose = () => { closed = true; };

			menu.handleInput("?");
			expect(convertedText).toBe("?");
			expect(closed).toBe(false);

			const menu2 = new HelpMenu();
			let closed2 = false;
			menu2.onClose = () => { closed2 = true; };
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

			// 1. 空行按 '?' -> 唤起 HelpMenu 浮层
			expect((host as any).inputLine.getText()).toBe("");
			host.handleInput("?");
			expect((host as any).activeModalId).toBe("help");

			// 2. 帮助浮层处于打开状态时，再次按 '?' -> 转换为普通输入，关闭浮层，输入框内容变为 '?'
			host.handleInput("?");
			expect((host as any).activeModalId).toBeNull();
			expect((host as any).inputLine.getText()).toBe("?");

			// 3. 清空输入框，输入前置空格再敲 '?' -> 不唤起帮助看板，作为普通字符追加
			(host as any).inputLine.clear();
			host.handleInput(" ");
			expect((host as any).inputLine.getText()).toBe(" ");
			host.handleInput("?");
			expect((host as any).activeModalId).toBeNull();
			expect((host as any).inputLine.getText()).toBe(" ?");

			// 4. 清空输入框，唤起帮助看板后按 Esc / q -> 正常收起看板，输入框仍为空
			(host as any).inputLine.clear();
			host.handleInput("?");
			expect((host as any).activeModalId).toBe("help");
			host.handleInput("\x1b"); // Esc
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
				turnsCount: 1,
				tokensSaved: 5000,
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
			tui.render({ type: "turn_start", n: 1, text: "你好" });
			tui.render({ type: "thinking", text: "正在思考哲学问题..." });
			tui.render({ type: "text", text: "这是一段长度为 30 个字符的回复文本用于测试" });
			tui.render({ type: "tool_start", name: "bash", args: { cmd: "ls" }, callId: "tool-1" });
			tui.render({ type: "tool_done", name: "bash", result: "file.txt", status: "succeeded", callId: "tool-1", elapsedMs: 120 });
			tui.render({
				type: "turn_end",
				n: 1,
				usage: { usedTokens: 500, contextWindow: 128000, actual: true },
			});

			const nodes = tui.host.trajectoryProjection.list();
			expect(nodes.some((n) => n.kind === "turn_start")).toBe(true);
			expect(nodes.some((n) => n.kind === "thinking" && n.status === "completed")).toBe(true);
			expect(nodes.some((n) => n.kind === "tool_call" && n.status === "completed")).toBe(true);
			expect(nodes.some((n) => n.kind === "model_stream" && n.status === "completed")).toBe(true);

			// 测试压缩时轨迹同步
			tui.host.addCompaction({
				summary: "历史压缩摘要",
				turnsCount: 1,
				tokensSaved: 3000,
				collapsed: true,
			});
			const compNode = tui.host.trajectoryProjection.list().find((n) => n.kind === "compaction");
			expect(compNode).toBeDefined();
			expect(compNode?.tokens?.total).toBe(3000);

			tui.close();
		});

		it("UIHost: notify() 零高度瞬态 Toast 呈现于呼吸空隙末行，不污染 transcript 历史", () => {
			const tui = new InteractiveTUI();
			const host = tui.host;
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
			const host = tui.host;
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
			const host = tui.host;

			host.addCompaction({
				summary: "第 1 轮到第 3 轮的压缩总结",
				turnsCount: 3,
				tokensSaved: 12000,
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
			const mockAddCompaction = vi.fn();
			const mockSetEffort = vi.fn();

			const handlers = new Map<string, Function>();
			const mockPi: any = {
				registerCommand: vi.fn(),
				on: vi.fn((event: string, handler: Function) => {
					handlers.set(event, handler);
					return () => handlers.delete(event);
				}),
				ui: {
					notify: mockNotify,
					clearNotification: mockClear,
				},
			};

			const mockServices: any = {
				subject: { compact: vi.fn(), getModel: () => ({ thinkingLevels: ["off", "high", "max"] }) },
				models: { choices: () => [] },
				jobs: {},
				subagents: {},
				ui: {
					addCompaction: mockAddCompaction,
					setReasoningEffort: mockSetEffort,
				},
				reload: vi.fn(),
				shutdown: vi.fn(),
			};

			const activate = activateBuiltinCommands(mockServices);
			activate(mockPi);

			// 1. 触发 session_before_compact
			const beforeHandler = handlers.get("session_before_compact");
			expect(beforeHandler).toBeDefined();
			beforeHandler!({ type: "session_before_compact", tokensBefore: 15000 });
			expect(mockNotify).toHaveBeenCalledWith("正在压缩会话…", "info", 0);

			// 2. 触发 session_compact
			const compactHandler = handlers.get("session_compact");
			expect(compactHandler).toBeDefined();
			compactHandler!({
				type: "session_compact",
				summary: "完成测试总结",
				tokensBefore: 15000,
				retainedTailCount: 2,
			});
			expect(mockNotify).toHaveBeenCalledWith("会话已压缩", "info", 2500);
			expect(mockAddCompaction).toHaveBeenCalledWith({
				summary: "完成测试总结",
				turnsCount: 2,
				tokensSaved: 15000,
				collapsed: true,
			});

			// 3. 触发 session_compact_failed
			const failedHandler = handlers.get("session_compact_failed");
			expect(failedHandler).toBeDefined();
			failedHandler!({ type: "session_compact_failed", error: "Token limit" });
			expect(mockNotify).toHaveBeenCalledWith("会话压缩失败", "warning", 3000);

			// 4. 触发 thinking_level_select 驱动 Toast 与底栏状态联动
			const thinkingHandler = handlers.get("thinking_level_select");
			expect(thinkingHandler).toBeDefined();
			thinkingHandler!({ type: "thinking_level_select", level: "high" });
			expect(mockSetEffort).toHaveBeenCalledWith("high");
			expect(mockNotify).toHaveBeenCalledWith("思考等级: high", "info", 2000);
		});

		it("ExtensionUIContext: select 支持滚动窗口限制与超长截断", async () => {
			let capturedComponent: any = null;
			const mockHost: any = {
				showOverlay: (comp: any) => {
					capturedComponent = comp;
					return { hide: () => {} };
				},
				requestRender: () => {},
			};
			const ctx = createExtensionUIContext(mockHost);

			// 生成 20 个选项
			const manyOptions = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
			const promise = ctx.select("测试长列表", manyOptions);

			expect(capturedComponent).toBeDefined();
			const rendered = capturedComponent.render(80).join("\n");
			// 最多显示 8 个选项，其余显示滚动提示
			expect(rendered).toContain("Option 1");
			expect(rendered).toContain("Option 8");
			expect(rendered).not.toContain("Option 9");
			expect(rendered).toContain("↓+12");

			capturedComponent.handleInput("\x1b[B"); // Down
			capturedComponent.handleInput("\r"); // Enter
			const result = await promise;
			expect(result).toBe("Option 2");
		});

		it("ExtensionUIContext: input 支持 CURSOR_MARKER 与字形簇光标移动", async () => {
			let capturedComponent: any = null;
			const mockHost: any = {
				showOverlay: (comp: any) => {
					capturedComponent = comp;
					return { hide: () => {} };
				},
				requestRender: () => {},
			};
			const ctx = createExtensionUIContext(mockHost);
			const promise = ctx.input("请输入内容", "占位符");

			expect(capturedComponent).toBeDefined();
			expect(capturedComponent.render(80).join("\n")).toContain(CURSOR_MARKER);

			capturedComponent.handleInput("Hello👋🏻");
			// 退格删除 emoji
			capturedComponent.handleInput("\x7f");
			// 提交
			capturedComponent.handleInput("\r");
			const result = await promise;
			expect(result).toBe("Hello");
		});

		describe("dsh-TUI Tool Use Parity & Lifecycle", () => {
			it("正确映射工具五维语义类别与主题色彩", () => {
				expect(getToolCategory("replace_file_content")).toBe("write");
				expect(getToolCategory("write_to_file")).toBe("write");
				expect(getToolCategory("run_command")).toBe("exec");
				expect(getToolCategory("bash")).toBe("exec");
				expect(getToolCategory("view_file")).toBe("read");
				expect(getToolCategory("grep_search")).toBe("read");
				expect(getToolCategory("search_web")).toBe("web");
				expect(getToolCategory("invoke_subagent")).toBe("task");
				expect(getToolCategory("unknown_tool")).toBe("default");

				expect(getToolCategoryColor("write")).toBeDefined();
				expect(getToolCategoryColor("exec")).toBeDefined();
				expect(getToolCategoryColor("read")).toBeDefined();
				expect(getToolCategoryColor("web")).toBeDefined();
				expect(getToolCategoryColor("task")).toBeDefined();
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
				// get_time、session_*、job_*、subagent_*）全部落到兜底分支：显示成
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
					["job_list", "JobList", "task"],
					["job_output", "JobOutput", "task"],
					["job_kill", "JobKill", "task"],
					["subagent_start", "SubagentStart", "task"],
					["subagent_list", "SubagentList", "task"],
					["subagent_status", "SubagentStatus", "task"],
					["subagent_output", "SubagentOutput", "task"],
					["subagent_messages", "SubagentMessages", "task"],
					["subagent_send", "SubagentSend", "task"],
					["subagent_interrupt", "SubagentInterrupt", "task"],
				];
				for (const [name, display, category] of expected) {
					expect({ name, display: displayName(name), category: getToolCategory(name) }).toEqual({ name, display, category });
				}
			});

			it("displayName 兜底把分隔符切成大驼峰（新工具不再显示成 Get_time）", () => {
				expect(displayName("brand_new_tool")).toBe("BrandNewTool");
				expect(displayName("kebab-tool")).toBe("KebabTool");
				expect(displayName("alreadyCamel")).toBe("AlreadyCamel");
			});

			it("结构化结果（数组 / 嵌套对象）不再渲染成 [object Object]", () => {
				// session_list / job_list / subagent_list 的结果是 JSON 数组
				const listText = stripAnsi(
					formatToolCardLines(
						"session_list",
						JSON.stringify([{ id: "a", source: "main" }, { id: "b", source: "main" }]),
						10,
						100,
						"succeeded",
					).join("\n"),
				);
				expect(listText).not.toContain("[object Object]");
				expect(listText).toContain(`"id":"a"`);
				expect(listText).toContain(`"id":"b"`);

				// job_kill 返回嵌套对象：job 字段本身是对象，旧代码会渲染成 [object Object]
				const nestedText = stripAnsi(
					formatToolCardLines(
						"job_kill",
						JSON.stringify({ outcome: "cancellation-requested", job: { id: "j1", status: "killed" } }),
						10,
						100,
						"succeeded",
					).join("\n"),
				);
				expect(nestedText).not.toContain("[object Object]");
				expect(nestedText).toContain("cancellation-requested");

				// 空数组有明确表示，不退化成「执行完成，无输出」
				const emptyText = stripAnsi(formatToolCardLines("job_list", JSON.stringify([]), 10, 100, "succeeded").join("\n"));
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
				// 卡片末尾空行作为边距留白，绝不带底色
				expect(lines[lines.length - 1]).toBe("");
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
				const linesEven = formatToolCardLines("bash", "", 0, 80, "running", { command: "ls" }, {
					startedAt: 1200,
					now: 2400, // runMs = 1200ms -> 1.2s
				});
				const renderedEven = linesEven.join("\n");
				expect(renderedEven).toContain(BLACK_CIRCLE);
				expect(stripAnsi(renderedEven)).toContain("Bash(ls)");
				expect(renderedEven).toContain("· 1.2s");
				expect(renderedEven).toContain("Running… (1.2s)");

				// now=1800 为奇数周期 (1800/600=3)，闪烁隐藏
				const linesOdd = formatToolCardLines("bash", "", 0, 80, "running", { command: "ls" }, {
					startedAt: 1000,
					now: 1800,
				});
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
				expect(rendered).toContain(BULLET);
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
				expect(rendered).toContain(MULTIPLICATION_X);
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
					JSON.stringify({ stdout: "a\nb\nc\nd" }),
					100,
					80,
					"succeeded",
				);
				expect(fourLines.join("\n")).toContain("d");
				expect(fourLines.join("\n")).not.toContain("lines (ctrl+o to expand)");

				// 5 行：折叠保留 3 行 + 折叠提示
				const fiveLines = formatToolCardLines(
					"run_command",
					JSON.stringify({ stdout: "a\nb\nc\nd\ne" }),
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
				// d 和 e 应该被折叠进 +2 lines
				expect(strippedLines.some((l) => l.endsWith("   d"))).toBe(false);
				expect(strippedLines.some((l) => l.endsWith("   e"))).toBe(false);
				expect(strippedLines.some((l) => l.includes("… +2 lines (ctrl+o to expand)"))).toBe(true);

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
				transcript.startTool("bash", { command: "test1" }, "call-1");
				transcript.addToolDone("bash", JSON.stringify({ stdout: "1\n2\n3\n4\n5" }), 100, "succeeded", "call-1");
				transcript.startTool("bash", { command: "test2" }, "call-2");
				transcript.addToolDone("bash", JSON.stringify({ stdout: "a\nb\nc\nd\ne" }), 100, "succeeded", "call-2");

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
				const origStdout = process.stdout;
				const origStdin = process.stdin;
				try {
					const fakeStdout = {
						columns: 100,
						rows: 30,
						write: () => true,
						on: () => fakeStdout,
						removeListener: () => fakeStdout,
					} as unknown as NodeJS.WriteStream;

					const fakeStdin = {
						isTTY: true,
						setRawMode: () => fakeStdin,
						resume: () => fakeStdin,
						pause: () => fakeStdin,
						on: () => fakeStdin,
						removeListener: () => fakeStdin,
					} as unknown as NodeJS.ReadStream;

					Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
					Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

					const host = new UIHost({
						modelName: "deepseek-chat",
						cwd: "e:/Uina/test",
					});
					host.start();

					// 开启一轮对话并添加一个多行输出的工具调用
					host.transcript.startTurn(1, "运行测试脚本");
					host.transcript.startTool("bash", { command: "npm test" }, "call-test-123");
					host.transcript.addToolDone(
						"bash",
						JSON.stringify({ stdout: "line 1\nline 2\nline 3\nline 4" }),
						150,
						"succeeded",
						"call-test-123",
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
					host.handleInput(hoverSeq);

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
					host.handleInput(clickDownSeq);
					host.handleInput(clickUpSeq);

					// 验证工具卡片被成功切换为展开状态（isExpanded = true）
					const locs = host.transcript.getToolLineIndices(100);
					expect(locs.find((l) => l.callId === "call-test-123")?.isExpanded).toBe(true);

					host.stop();
				} finally {
					Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
					Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
				}
			});

			it("展开与收起思考内容时保持画面原位置绝对稳定（锚点固定，鼠标点击与 Ctrl+O 均不跳屏）", () => {
				const origStdout = process.stdout;
				const origStdin = process.stdin;
				try {
					const fakeStdout = {
						columns: 80,
						rows: 24,
						write: () => true,
						on: () => fakeStdout,
						removeListener: () => fakeStdout,
					} as unknown as NodeJS.WriteStream;

					const fakeStdin = {
						isTTY: true,
						setRawMode: () => fakeStdin,
						resume: () => fakeStdin,
						pause: () => fakeStdin,
						on: () => fakeStdin,
						removeListener: () => fakeStdin,
					} as unknown as NodeJS.ReadStream;

					Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
					Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

					const host = new UIHost({
						modelName: "deepseek-chat",
						cwd: "e:/Uina/test",
					});
					host.start();

					// 填充若干轮次历史记录，使总行数超出视口高度
					for (let t = 1; t <= 5; t++) {
						host.transcript.startTurn(t, `这是历史提问 ${t}`);
						host.transcript.appendToken(`历史回复第 1 行\n历史回复第 2 行\n历史回复第 3 行`);
						host.transcript.finishTurn();
					}

					// 当前轮次：包含 40 行深度思考
					host.transcript.startTurn(6, "请详细分析");
					host.transcript.appendThinking("开始分析思考。\n" + Array.from({ length: 40 }, (_, i) => `思考推导步骤 ${i + 1}`).join("\n"));
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
					host.handleInput(clickDown);
					host.handleInput(clickUp);
					(host as any).renderCurrentFrame();

					// 校验：展开后，思考块标题行必须严格锁定在同一个屏幕行（画面绝对不跳动）
					const expandedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetExpanded = expandedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetExpanded?.row).toBe(initThinkingRow);

					// 2. 模拟鼠标点击收起思考内容
					host.handleInput(clickDown);
					host.handleInput(clickUp);
					(host as any).renderCurrentFrame();

					// 校验：收起后，思考块标题行仍然位于该屏幕行，且位于底部时视口偏移准确归零
					const collapsedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetCollapsed = collapsedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetCollapsed?.row).toBe(initThinkingRow);
					expect(host.getScrollOffset()).toBe(0);

					// 3. 模拟快捷键 Ctrl+O 展开思考内容
					host.handleInput("\x0f"); // Ctrl+O
					(host as any).renderCurrentFrame();

					// 校验：Ctrl+O 展开后，思考块标题行依然锁定在原屏幕行（绝不产生向上飞出屏幕顶部的跳跃）
					const ctrlOExpandedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetCtrlO = ctrlOExpandedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetCtrlO?.row).toBe(initThinkingRow);

					// 4. 模拟快捷键 Ctrl+O 收起思考内容
					host.handleInput("\x0f"); // Ctrl+O
					(host as any).renderCurrentFrame();

					// 校验：Ctrl+O 收起后，依然留在原屏幕行，视口偏移归零（绝不跳跃回顶部 Banner）
					const ctrlOCollapsedTargets: any[] = (host as any).mouseTracker.targets;
					const thinkingTargetCtrlOCol = ctrlOCollapsedTargets.find((t) => t.id.startsWith("thinking:"));
					expect(thinkingTargetCtrlOCol?.row).toBe(initThinkingRow);
					expect(host.getScrollOffset()).toBe(0);

					host.stop();
				} finally {
					Object.defineProperty(process, "stdout", { value: origStdout, configurable: true });
					Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
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
			});

			it("TranscriptContainer: interruptTurn 会封顶思考、把未确认的运行中工具标为 unknown，并插入暗调打断行", () => {
				const transcript = new TranscriptContainer();
				transcript.startTurn(1, "用户任务");
				transcript.appendThinking("正在推理中...");
				transcript.startTool("bash", { command: "sleep 10" }, "call-1");

				// 触发打断
				transcript.interruptTurn("DeepSeek");

				// 校验思考已封顶且当前轮已结束
				expect(transcript.getCurrentTurn()).toBeNull();
				const history = transcript.getHistory();
				expect(history.length).toBe(1);
				const turn = history[0]!;

				// 工具状态必须为 failed，且包含已由用户打断
				const toolItem = turn.items.find((it) => it.kind === "tool") as any;
				expect(toolItem).toBeDefined();
				expect(toolItem.status).toBe("unknown");
				expect(toolItem.result).toBe("已请求中断，工具结果尚未确认");

				// 存在 interrupt 行
				const interruptItem = turn.items.find((it) => it.kind === "interrupt") as any;
				expect(interruptItem).toBeDefined();
				expect(interruptItem.text).toBe("已打断 · 接下来想让 DeepSeek 做什么？");

				// 渲染测试：暗淡样式
				const lines = transcript.render(80);
				const joined = lines.join("\n");
				expect(joined).toContain("已打断 · 接下来想让 DeepSeek 做什么？");
				expect(joined).toContain("\x1b[2m");

				// 幂等性测试：重复调用不会产生重复的打断行
				transcript.interruptTurn("DeepSeek");
				expect(turn.items.filter((it) => it.kind === "interrupt").length).toBe(1);
			});

			it("UIHost: Esc 阶梯与 Ctrl+C 二次强制退出机制", () => {
				let interruptedCalls: boolean[] = [];
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

				host.onInterrupt = (force) => {
					interruptedCalls.push(force ?? false);
				};
				host.onInterruptAndDeliver = (text) => {
					deliveredText = text;
				};

				// 1. 工作态下按 Esc -> 触发 cancelTurn，调用 onInterrupt(false)，cancelPending = true，busy 保持直到事件下发
				host.setBusy(true);
				host.handleInput("\x1b"); // Esc
				expect(interruptedCalls).toEqual([false]);
				expect((host as any).cancelPending).toBe(true);
				expect(host.isBusy()).toBe(true);
				// 模拟收到终端终止事件，解除 busy 与 cancelPending
				host.setBusy(false);
				expect(host.isBusy()).toBe(false);
				expect((host as any).cancelPending).toBe(false);

				// 2. 空闲态下单按 Esc -> 清空输入框内容
				host.handleInput("some draft text");
				expect((host as any).inputLine.getText()).toBe("some draft text");
				host.handleInput("\x1b"); // Esc
				expect((host as any).inputLine.getText()).toBe("");

				// 3. 工作态下第 1 次按 Ctrl+C -> cancelTurn, cancelPending = true, busy 仍为 true
				interruptedCalls = [];
				host.setBusy(true);
				host.handleInput("\x03"); // Ctrl+C
				expect(interruptedCalls).toEqual([false]);
				expect(host.isBusy()).toBe(true);
				expect((host as any).cancelPending).toBe(true);

				// 4. 工作态且 cancelPending 时第 2 次按 Ctrl+C -> 触发强制退出 onInterrupt(true)
				host.handleInput("\x03"); // Ctrl+C
				expect(interruptedCalls).toEqual([false, true]);
				host.setBusy(false);

				// 5. 工作态下按 Ctrl+Enter -> 触发 cancelTurn 且调用 onInterruptAndDeliver
				host.setBusy(true);
				host.handleInput("New Priority Task");
				host.handleInput("\x1b[13;5u"); // Ctrl+Enter
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
				host.handleInput("我的临时未发送草稿");
				expect((host as any).inputLine.getText()).toBe("我的临时未发送草稿");

				// 触发 Esc
				host.handleInput("\x1b");

				// 当前轮次打断中，但草稿完好保留，绝不被清空
				expect(host.isBusy()).toBe(true);
				expect((host as any).cancelPending).toBe(true);
				expect((host as any).inputLine.getText()).toBe("我的临时未发送草稿");
			});

			it("InteractiveTUI: 接收到 turn_aborted 事件时自动调用 interruptTurn 并重置状态", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.render({ type: "turn_start", n: 1, text: "做某事" });
				expect(tui.host.isBusy()).toBe(true);

				// 模拟收到内核发出的结构化 turn_aborted 事件
				tui.render({ type: "turn_aborted", n: 1 });

				// 此时 busy 状态自动解除，且 transcript 正确记录 interrupt 行
				expect(tui.host.isBusy()).toBe(false);
				const history = tui.host.transcript.getHistory();
				expect(history.length).toBe(1);
				expect(history[0]!.items.some((it) => it.kind === "interrupt")).toBe(true);
			});

			it("TranscriptContainer: 打断后迟到的工具结算绝不重复开辟新轮次或生成重复工具卡 (图一防御)", () => {
				const transcript = new TranscriptContainer();
				transcript.startTurn(1, "执行长任务");
				transcript.startTool("bash", { command: "sleep 10" }, "call-123");

				// 用户按 Esc 打断
				transcript.interruptTurn("TestModel");

				// 校验当前轮已被封顶提交，工具状态为 unknown
				expect(transcript.getCurrentTurn()).toBeNull();
				const history = transcript.getHistory();
				expect(history.length).toBe(1);
				expect(history[0]!.items.filter((it) => it.kind === "tool").length).toBe(1);

				// 此时底层子进程退出，迟到收到 addToolDone
				transcript.addToolDone("bash", "{\"error\":\"工具已返回，但取消时无法确认副作用状态\"}", 200, "unknown", "call-123");

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
				tui.render({ type: "turn_start", n: 1, text: "做任务" });
				tui.host.cancelTurn("escape");

				// 收到后端的 turn_end
				tui.render({ type: "turn_end", n: 1 });

				// 校验 activityLine 总结状态为“已打断当前轮次”
				const rendered = tui.host.activityLine.render(80).join("\n");
				expect(rendered).toContain("已打断当前轮次");
				expect(rendered).not.toContain("本轮已完成");
			});

			it("InteractiveTUI: 排队消息回填与草稿按时间顺序拼接，并置光标于末尾 (对齐 Pi restoreQueuedMessagesToEditor)", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.render({ type: "turn_start", n: 1, text: "运行长任务" });

				// 用户输入半截未发送的临时草稿
				tui.host.handleInput("未发送的临时草稿");
				expect(tui.host.inputLine.getText()).toBe("未发送的临时草稿");

				// 模拟队列中有 2 条排队消息
				const queuedItems = [
					{ id: "q1", text: "排队任务一" },
					{ id: "q2", text: "排队任务二" },
				];

				// 使用生产代码的拼接规则，而不是在测试里复制一份
				const combined = combineQueuedDraft(queuedItems, tui.host.inputLine.getText());
				tui.replaceInput(combined);

				// 校验回填文本与时间顺序
				const expected = "排队任务一\n\n排队任务二\n\n未发送的临时草稿";
				expect(tui.host.inputLine.getText()).toBe(expected);
				// 校验光标置于最后
				expect(tui.host.inputLine.getCursorIndex()).toBe(expected.length);
			});

			it("InteractiveTUI: 工作态下第 1 次按 Ctrl+C 触发 onCancel('ctrl+c')，第 2 次触发 onForceExit (对齐 dsh-TUI 防卡死强制退出)", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.render({ type: "turn_start", n: 1, text: "长耗时操作" });

				let cancelSource: string | undefined;
				let forceExited = false;
				tui.onCancel((source) => {
					cancelSource = source;
				});
				tui.onForceExit(() => {
					forceExited = true;
				});

				// 第 1 次 Ctrl+C：打断当前轮次
				tui.host.handleInput("\x03");
				expect(cancelSource).toBe("ctrl+c");
				expect(forceExited).toBe(false);

				// 第 2 次 Ctrl+C（处于 cancelPending 阶段）：立即触发防卡死强制退出
				tui.host.handleInput("\x03");
				expect(forceExited).toBe(true);
			});

			it("InteractiveTUI: 空闲态下 Ctrl+C 优先清空输入栏草稿，草稿为空时两连击退出", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				let forceExited = false;
				tui.onForceExit(() => {
					forceExited = true;
				});

				// 输入草稿
				tui.host.handleInput("草稿文本");
				expect(tui.host.inputLine.getText()).toBe("草稿文本");

				// 第 1 次 Ctrl+C：清空草稿
				tui.host.handleInput("\x03");
				expect(tui.host.inputLine.getText()).toBe("");
				expect(forceExited).toBe(false);

				// 草稿为空时第 1 次 Ctrl+C：激活 exitPending
				tui.host.handleInput("\x03");
				expect(forceExited).toBe(false);

				// 2 秒内第 2 次 Ctrl+C：触发退出
				tui.host.handleInput("\x03");
				expect(forceExited).toBe(true);
			});

			it("InteractiveTUI: 工作态下按 Esc 触发 onCancel('escape') 并保留输入栏未发送草稿", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.render({ type: "turn_start", n: 1, text: "正在执行任务" });

				let cancelSource: string | undefined;
				tui.onCancel((source) => {
					cancelSource = source;
				});

				tui.host.handleInput("临时未发送的输入");
				expect(tui.host.inputLine.getText()).toBe("临时未发送的输入");

				// 按 Esc 打断
				tui.host.handleInput("\x1b");
				expect(cancelSource).toBe("escape");
				// 草稿保留
				expect(tui.host.inputLine.getText()).toBe("临时未发送的输入");
			});

			it("InteractiveTUI: 工作态下 Ctrl+Enter 触发 onInterruptAndDeliver 且不触发 onCancel", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				tui.render({ type: "turn_start", n: 1, text: "执行中" });

				let deliveredText: string | undefined;
				let cancelCalled = false;
				tui.onCancel(() => {
					cancelCalled = true;
				});
				tui.onInterruptAndDeliver((text) => {
					deliveredText = text;
				});

				tui.host.handleInput("紧急插队任务");
				// 按 Ctrl+Enter (CSI 格式 \x1b[13;5u)
				tui.host.handleInput("\x1b[13;5u");

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

			it("InteractiveTUI: 按 Alt+Up 触发 onPullBackQueue 且不误唤起多智能体看板", () => {
				const tui = createInteractiveUI({ modelName: "TestModel" });
				let pullBackTriggered = false;
				tui.onPullBackQueue(() => {
					pullBackTriggered = true;
				});
				const openSubagentsSpy = vi.spyOn(tui.host, "openSubagents");

				// 按 Alt+Up (\x1b[1;3A)
				tui.host.handleInput("\x1b[1;3A");
				expect(pullBackTriggered).toBe(true);
				expect(openSubagentsSpy).not.toHaveBeenCalled();

				// 按 Alt+A (\x1ba)：正常唤起多智能体看板
				tui.host.handleInput("\x1ba");
				expect(openSubagentsSpy).toHaveBeenCalledTimes(1);
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
							id: "steer-1",
							text: "查看 package.json 中的 vitest 配置",
							mode: "steer",
							order: 1,
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
							id: "f-1",
							text: "运行 npm run test:coverage",
							mode: "followUp",
							order: 1,
						},
						{
							id: "f-2",
							text: "编译并检查 dist 输出产物",
							mode: "followUp",
							order: 2,
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
						{ id: "s-1", text: "紧急插队检查", mode: "steer", order: 1 },
						{ id: "f-1", text: "待办 1", mode: "followUp", order: 2 },
						{ id: "f-2", text: "待办 2", mode: "followUp", order: 3 },
						{ id: "f-3", text: "待办 3", mode: "followUp", order: 4 },
						{ id: "f-4", text: "待办 4", mode: "followUp", order: 5 },
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
							id: "long-1",
							text: "第一行内容\n第二行内容\r\n第三行内容" + "很长的文字".repeat(20),
							mode: "steer",
							order: 1,
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
					const tui = createInteractiveUI({ modelName: "TestModel" });
					const historyBefore = tui.host.transcript.getHistory().length;

					tui.render({
						type: "queue",
						items: [
							{ id: "q-1", text: "排队消息1", mode: "steer", order: 1 },
						],
					});

					// transcript 历史中绝对不新增 notice，杜绝历史日志被反复刷屏污染
					expect(tui.host.transcript.getHistory().length).toBe(historyBefore);

					// UIHost 的 pendingQueue 组件状态已更新
					(tui.host as any).renderCurrentFrame();
					const screenLines: string[] = (tui.host as any).lastRenderedRows;
					const frameText = screenLines.map((l: string) => stripAnsi(l)).join("\n");
					expect(frameText).toContain("◆ (Steer) · 下一步送达");
					expect(frameText).toContain("↳ 排队消息1");

					// 队列清空时，悬浮区清空，不留残影
					tui.render({ type: "queue", items: [] });
					(tui.host as any).renderCurrentFrame();
					const clearedLines: string[] = (tui.host as any).lastRenderedRows;
					const clearedFrameText = clearedLines.map((l: string) => stripAnsi(l)).join("\n");
					expect(clearedFrameText).not.toContain("◆ (Steer)");
					expect(clearedFrameText).not.toContain("↳ 排队消息1");
				});

				it("超窄终端（例如 width=35）：所有行绝对不超过 width 且不发生折行溢出", () => {
					const queueComp = new PendingQueueComponent();
					queueComp.setItems([
						{ id: "s-1", text: "这是一条在极窄终端下排队的较长消息", mode: "steer", order: 1 },
						{ id: "f-1", text: "第二条跟进任务需要保证严格适配", mode: "followUp", order: 2 },
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
});

