import { describe, it, expect, vi } from "vitest";
import {
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
import { StreamMarkdownFormatter } from "../src/ui/components/transcript/stream-markdown.js";
import { ContextBarComponent } from "../src/ui/components/widgets/context-bar.js";
import { ActivityLineComponent } from "../src/ui/components/widgets/activity-line.js";
import { InputLine } from "../src/ui/components/editor/input-line.js";
import { ExtensionRegistry } from "../src/ui/extensions/registry.js";
import { createExtensionUIContext } from "../src/ui/extensions/context.js";
import { CustomMessageComponent } from "../src/ui/components/transcript/custom-message.js";
import { CustomEntryComponent } from "../src/ui/components/transcript/custom-entry.js";
import { JobRegistry, type JobOutcome } from "../src/extensions/jobs/registry.js";
import { createJobAdapter } from "../src/ui/adapters/jobs.js";
import { TaskDashboard } from "../src/ui/components/overlays/task-dashboard.js";
import { createSubagentAdapter } from "../src/ui/adapters/subagents.js";
import { SubagentDashboard } from "../src/ui/components/overlays/subagent-dashboard.js";
import { TrajectoryProjection } from "../src/ui/adapters/agent-events.js";
import { TrajectoryScene } from "../src/ui/components/overlays/trajectory-scene.js";
import { createInteractiveUI } from "../src/ui/tui.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";

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
		expect(above).toEqual(["overlay-line-1", "overlay-line-2"]);

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
		const port = createJobAdapter(registry, "root");

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
		proj.onToolDone(toolId, "run_command", "exit code 0", 120, false);
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
		box.setContextStats("deepseek-chat", 14200, 65536);
		const lines = box.render(80);
		expect(lines.length).toBe(4);
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("思考中");
		expect(lines[1]).toContain("│");
		expect(lines[3]).toContain("╰");
		expect(lines[3]).toContain("deepseek-chat");
	});

	it("ActivityLine 流光动画与状态文本", () => {
		const act = new ActivityLineComponent();
		act.update("streaming", "流式生成中");
		const str = act.getHeaderString(60);
		expect(stripAnsi(str)).toContain("流式生成中");
	});

	it("ContextBar 上下文利用率柱状图", () => {
		const bar = new ContextBarComponent();
		bar.update(32000, 64000);
		const lines = bar.render(80);
		expect(lines[0]).toContain("ctx");
		expect(lines[0]).toContain("50.0%");
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
		const { formatCompactionCardLines } = await import("../src/ui/components/transcript/compact-view.js");

		const record = {
			id: 1,
			summary: "1. 讨论系统架构\n2. 落地输入联想与差异卡片\n3. 优化文件发现机制",
			turnsCount: 3,
			tokensSaved: 18500,
			collapsed: true,
			timestamp: Date.now(),
		};

		const collapsedLines = formatCompactionCardLines(record, 70);
		expect(collapsedLines.length).toBe(3);
		expect(collapsedLines[0]).toContain("∴ 会话已压缩 · 归档 3 轮对话");
		expect(stripAnsi(collapsedLines[2]!)).toContain("18.5k");
		const cWidths = collapsedLines.map((l) => visibleWidth(l));
		expect(cWidths.every((w) => w === cWidths[0])).toBe(true);

		record.collapsed = false;
		const expandedLines = formatCompactionCardLines(record, 70);
		expect(expandedLines.length).toBeGreaterThan(3);
		expect(expandedLines[0]).toContain("完整摘要");
		expect(expandedLines.join("\n")).toContain("讨论系统架构");
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
				toolCount: 8,
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
				toolCount: 2,
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
				toolCount: 2,
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
				toolCount: 2,
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
				toolCount: 2,
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

	it("用户输入展示为金色 ❯ 标记且助手段落折行采用 4 格悬挂缩进", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "你好世界");
		// 输入超过行宽的长文本测试自动折行
		transcript.appendToken("这是一段非常长的助手回答内容用于测试悬挂缩进功能确保换行后不会顶格到最左边而是严格保持四空格缩进对齐首行正文。");
		transcript.finishTurn();

		const rendered = transcript.render(40);
		// 校验用户前缀
		expect(rendered.some((l: string) => l.includes("❯") && l.includes("你好世界"))).toBe(true);

		// 校验助手首行带 ● 且后续折行行以 4 格空格对齐
		const assistantLines = rendered.filter((l: string) => l.includes("这是一段") || l.includes("悬挂缩进") || l.includes("四空格"));
		expect(assistantLines.length).toBeGreaterThan(1);
		expect(assistantLines[0]).toContain("●");
		expect(assistantLines[1]!.startsWith("    ")).toBe(true);
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
});
