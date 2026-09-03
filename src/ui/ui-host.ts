/**
 * UIHost 控制台宿主。
 * 组装根容器树 (Root Container)、焦点系统、覆盖层栈、小部件槽位、转录区与输入区，
 * 调度原子全帧差量渲染与键盘输入分发。
 */

import { Container } from "./core/container.js";
import { FocusManager } from "./core/focus.js";
import { OverlayStack } from "./core/overlay.js";
import { WidgetSlots } from "./core/slots.js";
import { ProcessTerminal } from "./core/terminal.js";
import { MainScreenRenderer } from "./core/renderer.js";
import { Key, matchesKey } from "./core/keys.js";
import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "./core/types.js";
import { InputLine } from "./components/editor/input-line.js";
import { BannerComponent } from "./components/primitives/banner.js";
import { TranscriptContainer } from "./components/transcript/transcript.js";
import { ActivityLineComponent } from "./components/widgets/activity-line.js";
import { ModelPicker } from "./components/overlays/model-picker.js";
import { EffortSlider } from "./components/overlays/effort-slider.js";
import { HelpMenu } from "./components/overlays/help-menu.js";
import { TaskDashboard } from "./components/overlays/task-dashboard.js";
import { SubagentDashboard } from "./components/overlays/subagent-dashboard.js";
import { SubagentDetailScene } from "./components/overlays/subagent-detail-scene.js";
import { TrajectoryScene } from "./components/overlays/trajectory-scene.js";
import { ExtensionRegistry } from "./extensions/registry.js";
import { createExtensionUIContext, type UIHostContextPort } from "./extensions/context.js";
import type { ExtensionUIContext } from "./extensions/types.js";
import { createJobAdapter } from "./adapters/jobs.js";
import { createSubagentAdapter } from "./adapters/subagents.js";
import { TrajectoryProjection } from "./adapters/agent-events.js";
import type { JobRegistry } from "../extensions/jobs/registry.js";
import type { SubagentRegistry } from "../extensions/subagents/registry.js";

export interface UIHostOptions {
	terminal?: ProcessTerminal;
	cwd?: string;
	modelName?: string;
	toolCount?: number;
	jobs?: JobRegistry;
	subagents?: SubagentRegistry;
	onModelChange?: (model: string) => void | Promise<void>;
	onEffortChange?: (effort: "off" | "low" | "medium" | "high" | "max") => void;
	onCompactRequest?: (instruction?: string) => void | Promise<void>;
}

export class UIHost implements UIHostContextPort {
	readonly terminal: ProcessTerminal;
	readonly renderer: MainScreenRenderer;
	readonly focusManager: FocusManager;
	readonly overlayStack: OverlayStack;
	readonly widgetSlots: WidgetSlots;
	readonly registry: ExtensionRegistry;
	readonly ctxUI: ExtensionUIContext;

	// 核心容器结构
	readonly rootContainer: Container;
	readonly headerContainer: Container;
	readonly transcript: TranscriptContainer;
	readonly editorContainer: Container;
	readonly footerContainer: Container;

	readonly banner: BannerComponent;
	readonly inputLine: InputLine;
	readonly activityLine: ActivityLineComponent;

	// 状态投影
	readonly trajectoryProjection: TrajectoryProjection;

	// 业务参数
	private modelName = "deepseek-chat";
	private usedTokens = 0;
	private contextWindow = 65536;
	private reasoningEffort: "off" | "low" | "medium" | "high" | "max" = "medium";
	private cwd: string;

	// 运行与动画状态
	private running = false;
	private busy = false;
	private turnStartTime = 0;
	private streamTokenCount = 0;
	private lastTps = 0;
	private lastElapsedMs = 0;
	private renderScheduled = false;
	private animTimer: NodeJS.Timeout | null = null;
	private scrollOffset = 0;

	private rawInputListeners = new Set<(data: string) => void>();
	private jobsRegistry?: JobRegistry;
	private subagentsRegistry?: SubagentRegistry;

	private readonly options: UIHostOptions;

	// 事件回调
	onUserLine?: (text: string, mode: "steer" | "followUp" | "direct") => void;
	onInterrupt?: () => void;
	onDirectCommand?: (command: string) => void | Promise<void>;
	onCompactRequest?: (instruction?: string) => void | Promise<void>;

	constructor(options: UIHostOptions = {}) {
		this.options = options;
		this.onCompactRequest = options.onCompactRequest;
		this.cwd = options.cwd ?? process.cwd();
		if (options.modelName) this.modelName = options.modelName;
		this.jobsRegistry = options.jobs;
		this.subagentsRegistry = options.subagents;

		this.terminal = options.terminal ?? new ProcessTerminal();
		this.renderer = new MainScreenRenderer(this.terminal);
		this.focusManager = new FocusManager();

		this.overlayStack = new OverlayStack(this.focusManager, () => this.requestRender());
		this.widgetSlots = new WidgetSlots(() => this.requestRender());
		this.registry = new ExtensionRegistry();
		this.ctxUI = createExtensionUIContext(this);

		this.trajectoryProjection = new TrajectoryProjection();

		// 组装根容器树
		this.rootContainer = new Container();
		this.headerContainer = new Container();
		this.transcript = new TranscriptContainer();
		this.editorContainer = new Container();
		this.footerContainer = new Container();

		this.banner = new BannerComponent({
			modelName: this.modelName,
			toolCount: options.toolCount ?? 6,
			cwd: this.cwd,
		});
		this.headerContainer.addChild(this.banner);

		this.inputLine = new InputLine();
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.editorContainer.addChild(this.inputLine);

		this.activityLine = new ActivityLineComponent();

		this.rootContainer.addChild(this.headerContainer);
		this.rootContainer.addChild(this.transcript);
		this.rootContainer.addChild(this.editorContainer);
		this.rootContainer.addChild(this.footerContainer);

		this.focusManager.setFocus(this.inputLine);
		this.registerDefaultCommands();
	}

	start(): void {
		if (this.running) return;
		this.running = true;

		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.handleResize(),
		);

		this.requestRender();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.stopAnimation();
		this.overlayStack.clear();
		this.terminal.stop();
	}

	requestRender(): void {
		if (!this.running || this.renderScheduled) return;
		this.renderScheduled = true;
		setImmediate(() => {
			this.renderScheduled = false;
			if (!this.running) return;
			this.renderCurrentFrame();
		});
	}

	setModel(model: string): void {
		this.modelName = model;
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.banner.setOptions({ modelName: this.modelName, cwd: this.cwd });
		this.requestRender();
		void this.options.onModelChange?.(model);
	}

	setReasoningEffort(effort: "off" | "low" | "medium" | "high" | "max" | string): void {
		const lower = effort.toLowerCase().trim();
		if (lower === "off" || lower === "low" || lower === "medium" || lower === "high" || lower === "max") {
			this.reasoningEffort = lower;
		} else {
			this.reasoningEffort = "medium";
		}
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.requestRender();
		this.options.onEffortChange?.(this.reasoningEffort);
	}

	addCompaction(record: import("./components/transcript/compact-view.js").CompactionRecord): void {
		this.transcript.addCompaction(record);
		this.requestRender();
	}

	getReasoningEffort(): "off" | "low" | "medium" | "high" | "max" {
		return this.reasoningEffort;
	}

	cycleReasoningEffort(): void {
		const tiers: ("off" | "low" | "medium" | "high" | "max")[] = ["off", "low", "medium", "high", "max"];
		const idx = tiers.indexOf(this.reasoningEffort);
		const next = tiers[(idx + 1) % tiers.length]!;
		this.setReasoningEffort(next);
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		if (busy) {
			this.turnStartTime = Date.now();
			this.streamTokenCount = 0;
			this.startAnimation();
		} else {
			this.stopAnimation();
		}
		this.requestRender();
	}

	isBusy(): boolean {
		return this.busy;
	}

	incrementTokens(count = 1): void {
		this.streamTokenCount += count;
	}

	setUsage(used: number, contextWindow?: number): void {
		this.usedTokens = used;
		if (contextWindow) this.contextWindow = contextWindow;
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.requestRender();
	}

	replaceInput(text: string): void {
		this.inputLine.setText(text);
		this.requestRender();
	}

	// =========================================================================
	// UIHostContextPort 实现
	// =========================================================================

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (type === "error") {
			this.transcript.addError(message);
		} else {
			this.transcript.addNotice(message);
		}
		this.requestRender();
	}

	setStatus(key: string, text: string | undefined): void {
		if (text) {
			this.activityLine.update(key as any, text);
		} else {
			this.activityLine.reset();
		}
		this.requestRender();
	}

	setWorkingMessage(message?: string): void {
		if (message) {
			this.activityLine.update("streaming", message);
		} else {
			this.activityLine.reset();
		}
		this.requestRender();
	}

	setWorkingVisible(visible: boolean): void {
		if (visible) this.startAnimation();
		else this.stopAnimation();
		this.requestRender();
	}

	setWidget(key: string, component: Component | undefined, placement?: WidgetPlacement, priority?: number): void {
		this.widgetSlots.setWidget(key, component, placement, priority);
	}

	setHeader(component: Component | undefined): void {
		this.headerContainer.clear();
		if (component) {
			this.headerContainer.addChild(component);
		} else {
			this.headerContainer.addChild(this.banner);
		}
		this.requestRender();
	}

	setFooter(component: Component | undefined): void {
		this.footerContainer.clear();
		if (component) {
			this.footerContainer.addChild(component);
		}
		this.requestRender();
	}

	showOverlay(component: Component, options?: OverlayOptions, dispose?: () => void): OverlayHandle {
		return this.overlayStack.showOverlay(component, options, dispose);
	}

	pasteToEditor(text: string): void {
		this.inputLine.insertText(text);
		this.requestRender();
	}

	setEditorText(text: string): void {
		this.inputLine.setText(text);
		this.requestRender();
	}

	getEditorText(): string {
		return this.inputLine.getText();
	}

	onTerminalInput(handler: (data: string) => void): () => void {
		this.rawInputListeners.add(handler);
		return () => this.rawInputListeners.delete(handler);
	}

	// =========================================================================
	// 覆盖层快捷弹出
	// =========================================================================

	openModelPicker(): void {
		const picker = new ModelPicker(this.modelName);
		let handle: OverlayHandle | null = null;
		picker.onPick = (modelId) => {
			this.setModel(modelId);
			handle?.hide();
		};
		picker.onClose = () => {
			handle?.hide();
		};
		picker.onRequestRender = () => this.requestRender();
		handle = this.overlayStack.showOverlay(picker);
	}

	openEffortSlider(): void {
		const slider = new EffortSlider(this.reasoningEffort);
		let handle: OverlayHandle | null = null;
		slider.onChange = (tierId) => {
			this.setReasoningEffort(tierId);
		};
		slider.onClose = () => {
			handle?.hide();
		};
		slider.onRequestRender = () => this.requestRender();
		handle = this.overlayStack.showOverlay(slider);
	}

	openHelpMenu(): void {
		const menu = new HelpMenu(this.registry.listCommands());
		let handle: OverlayHandle | null = null;
		menu.onClose = () => {
			handle?.hide();
		};
		handle = this.overlayStack.showOverlay(menu);
	}

	openTaskDashboard(): void {
		if (!this.jobsRegistry) {
			this.notify("后台作业服务尚未就绪", "warning");
			return;
		}
		const port = createJobAdapter(this.jobsRegistry);
		const dashboard = new TaskDashboard(port);
		let handle: OverlayHandle | null = null;
		dashboard.onClose = () => {
			handle?.hide();
		};
		dashboard.onRequestRender = () => this.requestRender();
		handle = this.overlayStack.showOverlay(dashboard);
	}

	openSubagentDashboard(): void {
		if (!this.subagentsRegistry) {
			this.notify("子代理服务尚未就绪", "warning");
			return;
		}
		const port = createSubagentAdapter(this.subagentsRegistry);
		const dashboard = new SubagentDashboard(port);
		let handle: OverlayHandle | null = null;
		dashboard.onClose = () => {
			handle?.hide();
		};
		dashboard.onDrilldown = (subagent) => {
			handle?.hide();
			this.openSubagentDetail(subagent);
		};
		dashboard.onRequestRender = () => this.requestRender();
		handle = this.overlayStack.showOverlay(dashboard);
	}

	openSubagentDetail(subagent: Parameters<SubagentDetailScene["setSubagent"]>[0]): void {
		if (!this.subagentsRegistry) return;
		const port = createSubagentAdapter(this.subagentsRegistry);
		const detail = new SubagentDetailScene(subagent, port);
		let handle: OverlayHandle | null = null;
		detail.onClose = () => {
			handle?.hide();
			this.openSubagentDashboard();
		};
		detail.onRequestRender = () => this.requestRender();
		handle = this.overlayStack.showOverlay(detail);
	}

	openTrajectoryScene(): void {
		const scene = new TrajectoryScene(this.trajectoryProjection);
		let handle: OverlayHandle | null = null;
		scene.onClose = () => {
			handle?.hide();
		};
		scene.onRequestRender = () => this.requestRender();
		handle = this.overlayStack.showOverlay(scene);
	}

	// =========================================================================
	// 渲染管道与帧合成（Bottom-Pinned Frame Engine）
	// =========================================================================

	private renderCurrentFrame(): void {
		if (!this.running) return;

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const margin = this.getPageMargin(width);
		const innerW = width - margin.length;

		// 1. 同步状态行与输入框指标
		const statusHeader = this.activityLine.getHeaderString(Math.min(60, innerW - 20));
		this.inputLine.setStatusHeader(statusHeader);
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.inputLine.setReasoningEffort(this.reasoningEffort);

		const now = Date.now();
		const elapsed = this.busy ? Math.max(1, now - this.turnStartTime) : this.lastElapsedMs;
		const currentTps = this.busy
			? (this.streamTokenCount > 0 && elapsed > 100
				? Math.round((this.streamTokenCount / (elapsed / 1000)) * 10) / 10
				: 0)
			: this.lastTps;
		this.inputLine.setSpeedStats(currentTps, elapsed, this.busy);

		// 2. 渲染底部输入框
		const rawInput = this.inputLine.render(innerW);
		const inputLines = rawInput.map((l) => `${margin}${l}`);
		const inputH = inputLines.length;

		// 3. 渲染 belowEditor 小部件
		const belowLines = this.widgetSlots.render("belowEditor", innerW).map((l) => `${margin}${l}`);
		const belowH = belowLines.length;

		// 4. 渲染 OverlayAbove 浮层（叠加于输入框正上方）
		const aboveEditorWidgets = this.widgetSlots.render("aboveEditor", innerW);
		const maxAboveH = Math.max(0, height - inputH - belowH - 1);
		const overlayLines = this.overlayStack.renderAbove(innerW, maxAboveH);
		const aboveLines = [...aboveEditorWidgets, ...overlayLines].slice(0, maxAboveH).map((l) => `${margin}${l}`);
		const aboveH = aboveLines.length;

		// 5. 计算转录区可用高度
		const transcriptH = Math.max(0, height - inputH - belowH - aboveH);

		// 6. 渲染永久历史行
		const bannerLines = this.headerContainer.render(innerW).map((l) => (l ? `${margin}${l}` : ""));
		const transcriptLines = this.transcript.render(innerW).map((l) => (l ? `${margin}${l}` : ""));
		const permanentLines = [...bannerLines, ...transcriptLines];
		const totalPerm = permanentLines.length;

		// 7. 滚动视口处理
		let visibleTranscript: string[] = [];
		if (totalPerm <= transcriptH) {
			const padCount = transcriptH - totalPerm;
			visibleTranscript = [...permanentLines, ...new Array(padCount).fill("")];
		} else {
			const maxScroll = totalPerm - transcriptH;
			const effScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			const start = totalPerm - transcriptH - effScroll;
			visibleTranscript = permanentLines.slice(start, start + transcriptH);
		}

		// 8. 组装整屏行数组（严格锁定撑满 height 行，输入框吸底）
		const fullScreenRows: string[] = [
			...visibleTranscript,
			...aboveLines,
			...inputLines,
			...belowLines,
		];

		// 9. 提交差量渲染
		this.renderer.renderFrame(fullScreenRows);
	}

	private getPageMargin(width: number): string {
		if (width >= 120) return "  ";
		if (width >= 80) return " ";
		return "";
	}

	private handleResize(): void {
		if (!this.running) return;
		this.scrollOffset = 0;
		this.renderCurrentFrame();
	}

	private startAnimation(): void {
		if (this.animTimer) return;
		this.animTimer = setInterval(() => {
			this.requestRender();
		}, 60);
	}

	private stopAnimation(): void {
		if (this.animTimer) {
			clearInterval(this.animTimer);
			this.animTimer = null;
		}
	}

	// =========================================================================
	// 键盘与终端输入分发
	// =========================================================================

	private handleTerminalInput(data: string): void {
		// 1. 原生监听器优先
		for (const listener of this.rawInputListeners) {
			try {
				listener(data);
			} catch {}
		}

		// 2. 全局快捷键拦截
		if (data === "\x1b[Z") {
			// Shift+Tab：循环切换思考强度
			this.cycleReasoningEffort();
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			this.onInterrupt?.();
			return;
		}

		if (matchesKey(data, Key.alt("a")) || matchesKey(data, Key.alt("A"))) {
			this.openSubagentDashboard();
			return;
		}

		if (matchesKey(data, Key.alt("j")) || matchesKey(data, Key.alt("J"))) {
			this.openTaskDashboard();
			return;
		}

		if (matchesKey(data, Key.alt("t")) || matchesKey(data, Key.alt("T"))) {
			this.openTrajectoryScene();
			return;
		}

		if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.ctrl("O"))) {
			this.transcript.toggleThinking();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.alt("o")) || matchesKey(data, Key.alt("O"))) {
			this.transcript.toggleAllThinking();
			this.requestRender();
			return;
		}

		// 3. 顶层捕获浮层处理
		const topOverlay = this.overlayStack.topCapturing;
		if (topOverlay) {
			if (topOverlay.component.handleInput) {
				topOverlay.component.handleInput(data);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.overlayStack.hideTopOverlay();
				return;
			}
		}

		// 4. 输入框未输入时敲 '?' 直接唤起帮助
		if (data === "?" && !this.inputLine.getText().trim() && !this.overlayStack.hasVisible) {
			this.openHelpMenu();
			return;
		}

		// 5. 焦点组件输入处理
		const focused = this.focusManager.getFocused();
		if (focused && focused.handleInput) {
			focused.handleInput(data);

			// 输入提交事件判定（由 InputLine 触发）
			if ((focused as unknown) === this.inputLine && matchesKey(data, Key.enter)) {
				const text = this.inputLine.getExpandedText().trim();
				if (text) {
					this.handleUserSubmit(text);
				}
			}
			this.requestRender();
		}
	}

	private handleUserSubmit(text: string): void {
		this.inputLine.clear();

		// 斜杠命令分发
		if (text.startsWith("/")) {
			const parts = text.slice(1).trim().split(/\s+/);
			const cmdName = parts[0]!.toLowerCase();
			const args = parts.slice(1).join(" ");

			const cmd = this.registry.getCommand(cmdName);
			if (cmd?.handler) {
				void cmd.handler(args);
				return;
			}
		}

		// !cmd 直通执行分发
		if (text.startsWith("!")) {
			const cmdText = text.slice(1).trim();
			if (cmdText) {
				void this.onDirectCommand?.(cmdText);
				return;
			}
		}

		// 普通对话提交
		const mode = this.busy ? "followUp" : "direct";
		this.onUserLine?.(text, mode);
	}

	private registerDefaultCommands(): void {
		const reg = (name: string, description: string, handler: (args: string) => void) => {
			this.registry.registerCommand({ name, description, handler });
		};

		reg("help", "查看所有可用命令与快捷键", () => this.openHelpMenu());
		reg("model", "打开模型切换浮层 (或带参直接切换)", (args) => {
			if (args) this.setModel(args.trim());
			else this.openModelPicker();
		});
		reg("effort", "调整模型思考强度 (Reasoning Effort)", (args) => {
			if (args) this.setReasoningEffort(args.trim());
			else this.openEffortSlider();
		});
		reg("subagents", "多子智能体看板与详情审查", () => this.openSubagentDashboard());
		reg("agents", "多子智能体看板与详情审查", () => this.openSubagentDashboard());
		reg("tasks", "后台作业与进程管理看板", () => this.openTaskDashboard());
		reg("jobs", "后台作业与进程管理看板", () => this.openTaskDashboard());
		reg("trajectory", "全屏事件时序与性能热点剖析", () => this.openTrajectoryScene());
		reg("traj", "全屏审计轨迹看板", () => this.openTrajectoryScene());
		reg("compact", "压缩当前会话历史并释放上下文 (∴)", (args) => {
			void this.onCompactRequest?.(args);
		});
		reg("think", "展开或折叠深度思考过程", () => {
			this.transcript.toggleThinking();
			this.requestRender();
		});
		reg("clear", "清空当前会话屏幕与历史", () => {
			this.transcript.clear();
			this.requestRender();
		});
	}
}
