/**
 * UIHost 控制台宿主。
 * 组装根容器树 (Root Container)、焦点系统、覆盖层栈、小部件槽位、转录区与输入区，
 * 调度原子全帧差量渲染与键盘输入分发。
 */

import { spawn } from "node:child_process";
import { Container } from "./core/container.js";
import { FocusManager } from "./core/focus.js";
import { OverlayStack } from "./core/overlay.js";
import { WidgetSlots } from "./core/slots.js";
import { ProcessTerminal } from "./core/terminal.js";
import { MainScreenRenderer } from "./core/renderer.js";
import { Key, matchesKey } from "./core/keys.js";
import { MouseSelectionTracker, type InteractiveTarget, type SelectableRegion } from "./core/mouse-selection.js";
import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "./core/types.js";
import type { ThinkingLevel } from "../core/types.js";
import type { SessionEntry } from "../session/types.js";
import { C, visibleWidth, truncateToWidth } from "./core/utils.js";
import { InputLine } from "./components/editor/input-line.js";
import { BannerComponent } from "./components/primitives/banner.js";
import { TranscriptContainer } from "./components/transcript/transcript.js";
import { ActivityLineComponent } from "./components/widgets/activity-line.js";
import { ContextBarComponent, formatCacheHitRate, type ContextSegments } from "./components/widgets/context-bar.js";
import { TimelineRailComponent } from "./components/widgets/timeline-rail.js";
import { ScrollbarGutterComponent } from "./components/widgets/scrollbar-gutter.js";
import { HelpMenu } from "./components/overlays/help-menu.js";
import { ModelPicker, type ModelGroup } from "./components/overlays/model-picker.js";
import { EffortSlider, DEFAULT_EFFORT_TIERS, type EffortTier } from "./components/overlays/effort-slider.js";
import { TaskDashboard, type JobPort } from "./components/overlays/task-dashboard.js";
import { SubagentDashboard } from "./components/overlays/subagent-dashboard.js";
import { SubagentDetailScene } from "./components/overlays/subagent-detail-scene.js";
import { TrajectoryScene } from "./components/overlays/trajectory-scene.js";
import type { SubagentPort } from "./adapters/subagents.js";
import {
	formatSuggestionCardLines,
	getFileCandidates,
	type CommandItem,
	type FileItem,
} from "./components/editor/suggestions.js";
import { ExtensionRegistry } from "./extensions/registry.js";
import { createExtensionUIContext, type UIHostContextPort } from "./extensions/context.js";
import type { ExtensionUIContext } from "./extensions/types.js";
import { TrajectoryProjection } from "./adapters/agent-events.js";

function overlayCard(baseLine: string, cardLine: string, startCol: number, width: number): string {
	const leftPart = truncateToWidth(baseLine, startCol, " ");
	const leftW = visibleWidth(leftPart);
	const padL = Math.max(0, startCol - leftW);
	const rightPart = `${leftPart}${" ".repeat(padL)}${cardLine}`;
	const curW = visibleWidth(rightPart);
	const padR = Math.max(0, width - curW);
	return `${rightPart}${" ".repeat(padR)}`;
}

export interface UIHostOptions {
	terminal?: ProcessTerminal;
	cwd?: string;
	modelName?: string;
	thinkingLevels?: readonly ThinkingLevel[];
	thinkingLevel?: ThinkingLevel;
	registry?: ExtensionRegistry;
	jobPort?: JobPort;
	subagentPort?: SubagentPort;
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
	readonly contextBar: ContextBarComponent;
	readonly timelineRail: TimelineRailComponent;
	readonly scrollbarGutter: ScrollbarGutterComponent;
	private gutterMode: "timeline" | "scrollbar" = "timeline";
	private upTurnN: number | null = null;
	private downTurnN: number | null = null;

	// 状态投影
	readonly trajectoryProjection: TrajectoryProjection;

	// 业务参数
	private modelName?: string;
	private usedTokens = 0;
	private contextWindow?: number;
	private usageActual = false;
	private reasoningEffort?: ThinkingLevel;
	private thinkingLevels: readonly ThinkingLevel[] = ["off"];
	private cwd: string;
	private cacheReadTokens?: number;
	private inputTokensCount?: number;
	private cacheWriteTokens?: number;
	private contextSegments?: ContextSegments;

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

	private activeSuggestions: {
		type: "command" | "file";
		query: string;
		start: number;
		end: number;
		items: (CommandItem | FileItem)[];
		selectedIndex: number;
	} | null = null;

	private rawInputListeners = new Set<(data: string) => void>();
	private readonly statuses = new Map<string, string>();


	private activeModalId: string | null = null;
	private activeModalHandle: OverlayHandle | null = null;

	private mouseTracker = new MouseSelectionTracker();
	private lastRenderedRows: string[] = [];
	private lastPermanentLines: string[] = [];
	private lastScrollStart = 0;
	private lastChatAreaH = 0;
	private lastMaxScroll = 0;
	private autoScrollTimer: NodeJS.Timeout | null = null;
	private autoScrollDirection: "up" | "down" | null = null;
	private exitPending = false;
	private exitTimer: NodeJS.Timeout | null = null;
	private copyToastText = "";
	private copyToastTimer: NodeJS.Timeout | null = null;

	startAutoScroll(direction: "up" | "down"): void {
		if (this.autoScrollTimer && this.autoScrollDirection === direction) {
			return;
		}
		this.stopAutoScroll();
		if (direction === "up" && this.scrollOffset >= this.lastMaxScroll) {
			return;
		}
		if (direction === "down" && this.scrollOffset <= 0) {
			return;
		}
		this.autoScrollDirection = direction;
		this.autoScrollTimer = setInterval(() => {
			if (direction === "up") {
				if (this.scrollOffset >= this.lastMaxScroll) {
					this.stopAutoScroll();
					return;
				}
				this.scrollOffset = Math.min(this.lastMaxScroll, this.scrollOffset + 1);
				const newScrollStart = Math.max(0, this.lastScrollStart - 1);
				this.mouseTracker.updateFocusContent(newScrollStart, 0);
				this.renderCurrentFrame();
			} else {
				if (this.scrollOffset <= 0) {
					this.stopAutoScroll();
					return;
				}
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				const bottomRow = Math.max(0, this.lastChatAreaH - 1);
				const newScrollStart = Math.min(this.lastMaxScroll, this.lastScrollStart + 1);
				this.mouseTracker.updateFocusContent(newScrollStart + bottomRow, bottomRow);
				this.renderCurrentFrame();
			}
		}, 60);
	}

	stopAutoScroll(): void {
		if (this.autoScrollTimer) {
			clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = null;
		}
		this.autoScrollDirection = null;
	}

	showCopyToast(text: string): void {
		this.copyToastText = text;
		this.requestRender();
		if (this.copyToastTimer) clearTimeout(this.copyToastTimer);
		this.copyToastTimer = setTimeout(() => {
			this.copyToastText = "";
			this.requestRender();
		}, 2000);
	}

	private onCopyOnSelect = (text: string): void => {
		// 1. OSC 52 终端原生协议（对齐 dsh-TUI: setClipboard(text) 首选通道）
		// 终端模拟器（Windows Terminal、iTerm2 等）直接在前端写入宿主剪贴板，0 子进程消耗
		const b64 = Buffer.from(text, "utf-8").toString("base64");
		process.stdout.write(`\x1b]52;c;${b64}\x07`);

		// 2. 本地 Native 兜底（对标 dsh-TUI copyNative: 非 SSH 环境下的轻量安全兜底）
		if (process.platform === "win32" && !process.env["SSH_CONNECTION"]) {
			try {
				// 使用 Windows 原生 clip.exe，前置切换 chcp 65001 保证 UTF-8 中文不乱码
				// 启动耗时不到 5ms，比启动整个 powershell.exe 轻量十倍以上
				const child = spawn("cmd.exe", ["/c", "chcp 65001 >nul && clip"], {
					stdio: ["pipe", "ignore", "ignore"],
					windowsHide: true,
				});
				child.on("error", () => {});
				child.stdin.end(Buffer.from(text, "utf-8"));
				child.unref();
			} catch {
				// 静默失败，已有 OSC 52 保证
			}
		} else if (process.platform === "darwin" && !process.env["SSH_CONNECTION"]) {
			try {
				const child = spawn("pbcopy", [], {
					stdio: ["pipe", "ignore", "ignore"],
				});
				child.on("error", () => {});
				child.stdin.end(Buffer.from(text, "utf-8"));
				child.unref();
			} catch {}
		}

		const lineCount = text.split("\n").length;
		const toast = lineCount > 1 ? `已复制 ${lineCount} 行 (${text.length} 字符)` : `已复制 ${text.length} 字符`;
		this.showCopyToast(toast);
	};

	// 事件回调
	onUserLine?: (text: string, mode: "steer" | "followUp" | "direct") => void;
	onInterrupt?: () => void;
	onThinkingLevelCycle?: () => void;

	private jobPort?: JobPort;
	private subagentPort?: SubagentPort;

	setJobPort(port: JobPort): void {
		this.jobPort = port;
	}

	setSubagentPort(port: SubagentPort): void {
		this.subagentPort = port;
	}

	constructor(options: UIHostOptions = {}) {
		this.jobPort = options.jobPort;
		this.subagentPort = options.subagentPort;
		this.cwd = options.cwd ?? process.cwd();
		this.modelName = options.modelName;
		this.thinkingLevels = options.thinkingLevels?.length ? [...options.thinkingLevels] : ["off"];
		this.reasoningEffort = options.thinkingLevel;
		if (this.reasoningEffort && !this.thinkingLevels.includes(this.reasoningEffort)) {
			throw new Error(`当前 Provider 不支持思考等级: ${this.reasoningEffort}`);
		}

		this.terminal = options.terminal ?? new ProcessTerminal();
		this.renderer = new MainScreenRenderer(this.terminal);
		this.focusManager = new FocusManager();

		this.overlayStack = new OverlayStack(this.focusManager, () => this.requestRender());
		this.widgetSlots = new WidgetSlots(() => this.requestRender());
		this.registry = options.registry ?? new ExtensionRegistry();
		this.ctxUI = createExtensionUIContext(this);

		this.trajectoryProjection = new TrajectoryProjection();

		// 组装根容器树
		this.rootContainer = new Container();
		this.headerContainer = new Container();
		this.transcript = new TranscriptContainer();
		this.transcript.smoothReveal.setOnTick(() => this.requestRender());
		this.transcript.setRendererResolver({
			message: (type) => this.registry.getMessageRenderer(type),
			entry: (type) => this.registry.getEntryRenderer(type),
		});
		this.editorContainer = new Container();
		this.footerContainer = new Container();

		this.banner = new BannerComponent({
			modelName: this.modelName,
			cwd: this.cwd,
		});
		this.headerContainer.addChild(this.banner);

		this.inputLine = new InputLine();
		this.inputLine.onSubmit = (text) => this.handleUserSubmit(text);
		this.inputLine.onInterrupt = () => this.onInterrupt?.();
		this.inputLine.onEscape = () => {
			if (this.overlayStack.hasVisible) this.overlayStack.hideTopOverlay();
		};
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, this.usageActual);
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.editorContainer.addChild(this.inputLine);

		this.activityLine = new ActivityLineComponent();
		this.contextBar = new ContextBarComponent();
		this.timelineRail = new TimelineRailComponent();
		this.scrollbarGutter = new ScrollbarGutterComponent();

		this.rootContainer.addChild(this.headerContainer);
		this.rootContainer.addChild(this.transcript);
		this.rootContainer.addChild(this.editorContainer);
		this.rootContainer.addChild(this.footerContainer);

		this.focusManager.setFocus(this.inputLine);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.transcript.smoothReveal.setEnabled(true);

		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.handleResize(),
		);

		this.requestRender();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.transcript.smoothReveal.setEnabled(false);
		this.stopAutoScroll();
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

	/**
	 * Public input bridge for embedders and tests. Interactive terminals enter
	 * through ProcessTerminal, while headless callers can feed the same raw
	 * key protocol without reaching into the private dispatcher.
	 */
	handleInput(data: string): void {
		this.handleTerminalInput(data);
	}

	setModel(model: string): void {
		this.modelName = model;
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, this.usageActual, this.contextSegments);
		this.banner.setOptions({ modelName: this.modelName, cwd: this.cwd });
		this.requestRender();
	}

	setThinkingLevels(levels?: readonly ThinkingLevel[]): void {
		this.thinkingLevels = levels?.length ? [...levels] : ["off"];
	}

	setReasoningEffort(effort: ThinkingLevel | string): void {
		const lower = effort.toLowerCase().trim() as ThinkingLevel;
		if (!this.thinkingLevels.includes(lower)) throw new Error(`当前 Provider 不支持思考等级: ${effort}`);
		this.reasoningEffort = lower;
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.requestRender();
	}

	addCompaction(record: import("./components/transcript/compact-view.js").CompactionRecord): void {
		this.transcript.addCompaction(record);
		this.requestRender();
	}

	getReasoningEffort(): ThinkingLevel | undefined {
		return this.reasoningEffort;
	}

	getStreamTokenCount(): number {
		return this.streamTokenCount;
	}

	setGutterMode(mode: "timeline" | "scrollbar"): void {
		this.gutterMode = mode;
		this.requestRender();
	}

	getGutterMode(): "timeline" | "scrollbar" {
		return this.gutterMode;
	}

	toggleGutterMode(): void {
		this.setGutterMode(this.gutterMode === "timeline" ? "scrollbar" : "timeline");
	}

	getScrollbarThumbStyle(): import("./components/widgets/scrollbar-gutter.js").ScrollbarThumbStyle {
		return this.scrollbarGutter.getThumbStyle();
	}

	setScrollbarThumbStyle(style: import("./components/widgets/scrollbar-gutter.js").ScrollbarThumbStyle): void {
		this.scrollbarGutter.setThumbStyle(style);
		this.requestRender();
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		if (busy) {
			this.turnStartTime = Date.now();
			this.streamTokenCount = 0;
			this.startAnimation();
		} else {
			if (this.turnStartTime > 0) {
				this.lastElapsedMs = Math.max(1, Date.now() - this.turnStartTime);
			}
			this.stopAnimation();
		}
		this.requestRender();
	}

	getLastElapsedMs(): number {
		return this.lastElapsedMs;
	}

	isBusy(): boolean {
		return this.busy;
	}

	incrementTokens(count = 1): void {
		this.streamTokenCount += count;
	}

	setUsage(
		used: number,
		contextWindow?: number,
		actual = false,
		details?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; segments?: ContextSegments },
	): void {
		this.usedTokens = used;
		this.contextWindow = contextWindow && contextWindow > 0 ? contextWindow : undefined;
		this.usageActual = actual;
		this.cacheReadTokens = details?.cacheRead;
		this.inputTokensCount = details?.input;
		this.cacheWriteTokens = details?.cacheWrite;
		if (details?.segments) {
			this.contextSegments = details.segments;
		}
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, actual, this.contextSegments);
		this.contextBar.update({
			usedTokens: this.usedTokens,
			contextWindow: this.contextWindow,
			cwd: this.cwd,
			cacheRead: this.cacheReadTokens,
			inputTokens: this.inputTokensCount,
			cacheWrite: this.cacheWriteTokens,
			segments: this.contextSegments,
		});
		this.requestRender();
	}

	markUsageEstimated(): void {
		this.usageActual = false;
		this.cacheReadTokens = undefined;
		this.inputTokensCount = undefined;
		this.cacheWriteTokens = undefined;
		this.requestRender();
	}

	scrollToTurn(turnN: number): void {
		const transcriptContentW = Math.max(20, this.terminal.columns - 2);
		const turnStartMap = this.transcript.getTurnStartLines(transcriptContentW);
		const lineOffset = turnStartMap.get(turnN);
		if (lineOffset !== undefined) {
			const bannerLines = this.headerContainer.render(transcriptContentW);
			const totalPerm = bannerLines.length + this.transcript.render(transcriptContentW).length;
			const transcriptH = Math.max(1, this.terminal.rows - 8);
			const maxScroll = Math.max(0, totalPerm - transcriptH);
			const targetScroll = totalPerm - (bannerLines.length + lineOffset) - transcriptH;
			this.scrollOffset = Math.max(0, Math.min(maxScroll, targetScroll));
			this.requestRender();
		}
	}

	scrollTurnUp(): void {
		if (this.upTurnN !== null) {
			this.scrollToTurn(this.upTurnN);
		} else {
			this.scrollUp(5);
		}
	}

	scrollTurnDown(): void {
		if (this.downTurnN !== null) {
			this.scrollToTurn(this.downTurnN);
		} else {
			this.scrollDown(5);
		}
	}

	replaceInput(text: string): void {
		this.inputLine.setText(text);
		this.requestRender();
	}

	loadHistory(messages: readonly import("../core/types.js").ChatMsg[]): void {
		this.transcript.loadHistory(messages);
		this.requestRender();
	}

	loadSession(entries: readonly SessionEntry[]): void {
		this.transcript.loadSession(entries);
		this.requestRender();
	}

	scrollUp(lines = 3): void {
		this.scrollOffset += lines;
		this.requestRender();
	}

	scrollDown(lines = 3): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.scrollOffset = 999999;
		this.requestRender();
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
		this.requestRender();
	}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	executeCommand(name: string, args: string): void {
		this.onUserLine?.(`/${name}${args ? ` ${args}` : ""}`, this.busy ? "followUp" : "direct");
	}

	private updateSuggestions(): void {
		const detection = this.inputLine.detectSuggestionQuery();
		if (!detection) {
			this.activeSuggestions = null;
			return;
		}

		if (detection.type === "command") {
			const query = detection.query.toLowerCase();
			const commands = this.registry.listCommands();
			const filtered = commands.filter(
				(c) => c.name.toLowerCase().includes(query) || c.description.toLowerCase().includes(query),
			);
			if (filtered.length > 0) {
				const prevSelected =
					this.activeSuggestions?.type === "command"
						? (this.activeSuggestions.items[this.activeSuggestions.selectedIndex] as CommandItem)?.name
						: undefined;
				let newIndex = 0;
				if (prevSelected) {
					const found = filtered.findIndex((c) => c.name === prevSelected);
					if (found >= 0) newIndex = found;
				}
				this.activeSuggestions = {
					type: "command",
					query: detection.query,
					start: detection.start,
					end: detection.end,
					items: filtered.map((c) => ({
						name: c.name,
						description: c.description,
						hasArgs: Boolean(c.hasArgs),
					})),
					selectedIndex: newIndex,
				};
			} else {
				this.activeSuggestions = null;
			}
		} else if (detection.type === "file") {
			const candidates = getFileCandidates(this.cwd, detection.query, 40);
			if (candidates.length > 0) {
				this.activeSuggestions = {
					type: "file",
					query: detection.query,
					start: detection.start,
					end: detection.end,
					items: candidates,
					selectedIndex: 0,
				};
			} else {
				this.activeSuggestions = null;
			}
		}
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
		if (text) this.statuses.set(key, text);
		else this.statuses.delete(key);
		const visible = [...this.statuses.values()].at(-1);
		if (visible) this.activityLine.update("streaming", visible);
		else this.activityLine.reset();
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

	toggleModal(id: string, opener: (close: () => void) => OverlayHandle): void {
		if (this.activeModalId === id) {
			this.closeModal();
			return;
		}
		this.closeModal();
		this.activeModalId = id;
		const handle = opener(() => {
			if (this.activeModalId === id) {
				this.activeModalId = null;
				this.activeModalHandle = null;
			}
		});
		this.activeModalHandle = handle;
	}

	closeModal(): void {
		if (this.activeModalHandle) {
			const h = this.activeModalHandle;
			this.activeModalId = null;
			this.activeModalHandle = null;
			h.hide();
		}
	}

	openHelpMenu(): void {
		this.toggleModal("help", (close) => {
			const menu = new HelpMenu(this.registry.listCommands());
			let handle: OverlayHandle | null = null;
			menu.onClose = () => {
				close();
				handle?.hide();
			};
			handle = this.overlayStack.showOverlay(menu, undefined, () => close());
			return handle;
		});
	}

	openModelPicker(currentModel?: string, groups: ModelGroup[] = [], onPick?: (name: string) => Promise<void> | void): void {
		this.toggleModal("model", (close) => {
			const picker = new ModelPicker(currentModel ?? this.modelName, groups);
			let handle: OverlayHandle | null = null;
			picker.onPick = (name) => {
				if (onPick) void onPick(name);
				close();
				handle?.hide();
			};
			picker.onClose = () => {
				close();
				handle?.hide();
			};
			picker.onRequestRender = () => this.requestRender();
			handle = this.overlayStack.showOverlay(picker, undefined, () => close());
			return handle;
		});
	}

	openEffortSlider(
		currentLevel?: ThinkingLevel,
		tiers?: EffortTier[],
		onChange?: (level: ThinkingLevel) => void,
	): void {
		this.toggleModal("effort", (close) => {
			const declaredTiers = tiers ?? DEFAULT_EFFORT_TIERS.filter((t) => this.thinkingLevels.includes(t.id));
			const slider = new EffortSlider(currentLevel ?? this.reasoningEffort ?? "off", declaredTiers);
			let handle: OverlayHandle | null = null;
			slider.onChange = (level) => {
				this.setReasoningEffort(level);
				onChange?.(level);
			};
			slider.onClose = () => {
				close();
				handle?.hide();
			};
			slider.onRequestRender = () => this.requestRender();
			handle = this.overlayStack.showOverlay(slider, undefined, () => close());
			return handle;
		});
	}

	openTasks(): void {
		if (!this.jobPort) return;
		this.toggleModal("tasks", (close) => {
			const view = new TaskDashboard(this.jobPort!);
			let handle: OverlayHandle | null = null;
			view.onClose = () => {
				close();
				handle?.hide();
			};
			view.onRequestRender = () => this.requestRender();
			handle = this.overlayStack.showOverlay(view, undefined, () => close());
			return handle;
		});
	}

	openSubagents(): void {
		if (!this.subagentPort) return;
		this.toggleModal("subagents", (close) => {
			const view = new SubagentDashboard(this.subagentPort!);
			let handle: OverlayHandle | null = null;
			let detailHandle: OverlayHandle | null = null;

			view.onClose = () => {
				close();
				handle?.hide();
			};
			view.onDrilldown = (agent) => {
				handle?.hide();
				const detail = new SubagentDetailScene(agent, this.subagentPort!);
				detailHandle = this.overlayStack.showOverlay(detail, undefined, () => close());
				detail.onClose = () => {
					detailHandle?.hide();
					detailHandle = null;
					close();
				};
				detail.onRequestRender = () => this.requestRender();
			};
			view.onRequestRender = () => this.requestRender();

			handle = this.overlayStack.showOverlay(view, undefined, () => {
				if (!detailHandle) close();
			});
			return handle;
		});
	}

	openTrajectory(): void {
		this.toggleModal("trajectory", (close) => {
			const scene = new TrajectoryScene(this.trajectoryProjection);
			let handle: OverlayHandle | null = null;
			scene.onClose = () => {
				close();
				handle?.hide();
			};
			scene.onRequestRender = () => this.requestRender();
			handle = this.overlayStack.showOverlay(scene, undefined, () => close());
			return handle;
		});
	}


	// =========================================================================
	// 渲染管道与帧合成（Bottom-Pinned Frame Engine）
	// =========================================================================

	private renderCurrentFrame(): void {
		if (!this.running) return;

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const margin = this.getPageMargin(width);
		const innerW = width;

		// 1. 同步状态行与输入框指标
		const statusHeader = this.activityLine.getHeaderString(Math.min(60, innerW - 20));
		const cacheRate = formatCacheHitRate(this.cacheReadTokens, this.inputTokensCount, this.cacheWriteTokens);
		this.inputLine.setStatusHeader(statusHeader);
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, this.usageActual, this.contextSegments);
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.inputLine.setCacheRate(cacheRate);

		const now = Date.now();
		const elapsed = this.busy ? Math.max(1, now - this.turnStartTime) : this.lastElapsedMs;
		const currentTps = this.busy
			? (this.streamTokenCount > 0 && elapsed > 100
				? Math.round((this.streamTokenCount / (elapsed / 1000)) * 10) / 10
				: 0)
			: this.lastTps;
		this.inputLine.setSpeedStats(currentTps, elapsed, this.busy);

		// 2. 渲染底部输入框。给最右侧保留一列安全空间，避免终端在
		// 最后一列自动换行时吞掉 dsh-tui 风格的 `╮`/`╯` 闭合角。
		const inputWidth = Math.max(2, innerW - 1);
		const rawInput = this.inputLine.render(innerW);
		const inputLines = rawInput.map((l) => `${margin}${l}`);
		const inputH = inputLines.length;

		// 3. 渲染 ContextBar 与 belowEditor 小部件（对标图二单行与 hover 展开）
		this.contextBar.update({
			usedTokens: this.usedTokens,
			contextWindow: this.contextWindow,
			cwd: this.cwd,
			cacheRead: this.cacheReadTokens,
			inputTokens: this.inputTokensCount,
			cacheWrite: this.cacheWriteTokens,
			segments: this.contextSegments,
		});
		const contextBarLines = this.contextBar.render(inputWidth).map((l) => `${margin}${l}`);
		const belowLines = [
			...contextBarLines,
			...this.widgetSlots.render("belowEditor", innerW).map((l) => `${margin}${l}`),
		];
		const belowH = belowLines.length;

		// 4. 渲染 OverlayAbove 浮层与 SuggestionCard
		const aboveEditorWidgets = this.widgetSlots.render("aboveEditor", innerW);
		const maxAboveH = Math.max(0, height - inputH - belowH - 1);
		const overlayLines = this.overlayStack.renderAbove(innerW, maxAboveH);

		let suggestionLines: string[] = [];
		if (this.activeSuggestions && this.activeSuggestions.items.length > 0 && !this.overlayStack.hasVisible) {
			suggestionLines = formatSuggestionCardLines({
				type: this.activeSuggestions.type,
				title: this.activeSuggestions.type === "command" ? "命令" : "文件",
				query: this.activeSuggestions.query,
				columns: innerW,
				selectedIndex: this.activeSuggestions.selectedIndex,
				items: this.activeSuggestions.items,
				maxVisible: 5,
			});
		}

		const aboveLines = [...aboveEditorWidgets, ...overlayLines, ...suggestionLines].slice(0, maxAboveH).map((l) => `${margin}${l}`);
		const aboveH = aboveLines.length;

		// 5. 计算转录区可用高度与固定 1 行呼吸空间
		const breathingGap = 1;
		const transcriptH = Math.max(0, height - inputH - belowH - aboveH - breathingGap);

		// 6. 渲染永久历史行（对齐输入框宽度，为右侧 2 列导航轨留出空间并规避终端边界裁剪）
		const safeW = Math.max(20, innerW - 1);
		const transcriptContentW = Math.max(18, safeW - 2);
		const bannerLines = this.headerContainer.render(transcriptContentW).map((l) => (l ? `${margin}${l}` : ""));
		const transcriptLines = this.transcript.render(transcriptContentW).map((l) => (l ? `${margin}${l}` : ""));
		const permanentLines = [...bannerLines, ...transcriptLines];
		const totalPerm = permanentLines.length;

		// 7. 滚动视口处理
		const maxScroll = Math.max(0, totalPerm - transcriptH);
		let visibleTranscript: string[] = [];
		let scrollStart = 0;
		if (totalPerm <= transcriptH) {
			const padCount = transcriptH - totalPerm;
			visibleTranscript = [...permanentLines, ...new Array(padCount).fill("")];
			this.scrollOffset = 0;
			scrollStart = 0;
		} else {
			const effScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			this.scrollOffset = effScroll;
			scrollStart = totalPerm - transcriptH - effScroll;
			visibleTranscript = permanentLines.slice(scrollStart, scrollStart + transcriptH);

			if (effScroll > 0) {
				const percent = maxScroll > 0 ? Math.round(((maxScroll - effScroll) / maxScroll) * 100) : 100;
				this.inputLine.setStatusHeader(`${C.yellow}[📜 视口 ${percent}% (PageDn到底)]${C.reset} ${statusHeader}`);
			}
		}

		// 7.5. 右侧时间线导航轨（TimelineRail，对标图一）合成
		const timelineTurns = this.transcript.getTimelineTurns();
		const turnStartMap = this.transcript.getTurnStartLines(transcriptContentW);
		const bannerCount = bannerLines.length;

		let activeTurnN: number | null = null;
		let upTurnN: number | null = null;
		let downTurnN: number | null = null;

		for (const [turnN, lineOffset] of turnStartMap.entries()) {
			const absLine = bannerCount + lineOffset;
			if (absLine <= scrollStart) {
				activeTurnN = turnN;
			}
			if (absLine < scrollStart) {
				upTurnN = turnN;
			}
			if (absLine > scrollStart && absLine <= maxScroll && downTurnN === null) {
				downTurnN = turnN;
			}
		}

		if (activeTurnN === null && timelineTurns.length > 0) {
			activeTurnN = timelineTurns[0]!.n;
		}

		this.upTurnN = upTurnN;
		this.downTurnN = downTurnN;

		// 8. 组装整屏行数组（转录区 + 填充空白 + 提示条）
		let toastStr = "";
		if (this.exitPending) {
			toastStr = `${C.gray}再次按 Ctrl+C 退出${C.reset}`;
		} else if (this.copyToastText) {
			toastStr = `${C.iceBlue}${this.copyToastText}${C.reset}`;
		}

		const gapCount = Math.max(0, height - visibleTranscript.length - aboveH - inputH - belowH);
		const gapLines: string[] = [];
		for (let g = 0; g < gapCount; g++) {
			if (g === gapCount - 1 && toastStr) {
				const toastW = visibleWidth(toastStr);
				const pad = Math.max(0, transcriptContentW - toastW - 1);
				gapLines.push(`${margin}${" ".repeat(pad)}${toastStr}`);
			} else {
				gapLines.push("");
			}
		}

		// 整个对话区域高度（从屏幕顶部到输入框顶部的全部可用垂直空间）
		const chatAreaH = visibleTranscript.length + gapLines.length;
		const allChatRows = [...visibleTranscript, ...gapLines];
		const atBottom = this.scrollOffset === 0;

		this.lastPermanentLines = permanentLines;
		this.lastScrollStart = scrollStart;
		this.lastChatAreaH = chatAreaH;
		this.lastMaxScroll = maxScroll;
		this.mouseTracker.setScrollContext(scrollStart, chatAreaH);

		let railGlyphs: string[] = [];
		let previewCard: { topRow: number; lines: string[] } | undefined;

		if (this.gutterMode === "scrollbar") {
			const scrollRes = this.scrollbarGutter.renderGutterRows(chatAreaH, totalPerm, scrollStart);
			railGlyphs = scrollRes.gutterGlyphs;
			previewCard = scrollRes.hoverChip;
		} else {
			this.timelineRail.updateTurns(timelineTurns, activeTurnN);
			const tlRes = this.timelineRail.renderRailRows(chatAreaH, atBottom, upTurnN !== null, downTurnN !== null);
			railGlyphs = tlRes.railGlyphs;
			previewCard = tlRes.previewCard;
		}

		for (let r = 0; r < chatAreaH; r++) {
			const rawLine = allChatRows[r] ?? "";
			const baseLine = truncateToWidth(rawLine, transcriptContentW, " ");
			const pad = Math.max(0, transcriptContentW - visibleWidth(baseLine));
			allChatRows[r] = `${baseLine}${" ".repeat(pad)}${railGlyphs[r] ?? "  "}`;
		}

		if (previewCard) {
			for (let i = 0; i < previewCard.lines.length; i++) {
				const targetRow = previewCard.topRow + i;
				if (targetRow < chatAreaH) {
					const cardLine = previewCard.lines[i]!;
					const cardW = visibleWidth(cardLine);
					const cardStartCol = Math.max(0, transcriptContentW - cardW - 1);
					const baseLine = allChatRows[targetRow]!;
					const contentWithoutRail = truncateToWidth(baseLine, transcriptContentW, " ");
					const overlaid = overlayCard(contentWithoutRail, cardLine, cardStartCol, transcriptContentW);
					allChatRows[targetRow] = `${overlaid}${railGlyphs[targetRow] ?? "  "}`;
				}
			}
		}

		const fullScreenRows: string[] = [
			...allChatRows,
			...aboveLines,
			...inputLines,
			...belowLines,
		];

		// 8.5. 注册全屏鼠标交互热区（Click Targets 与 Hover 探测）
		const interactiveTargets: InteractiveTarget[] = [];

		// (1) 注册思考折叠行交互
		const thinkingLocs = this.transcript.getThinkingLineIndices(transcriptContentW);
		for (const loc of thinkingLocs) {
			const absLine = bannerCount + loc.lineIndex;
			if (absLine >= scrollStart && absLine < scrollStart + visibleTranscript.length) {
				const screenRow = absLine - scrollStart;
				interactiveTargets.push({
					// absLine 让同编号的历史轮次与当前轮次也拥有不同目标。
					id: `thinking-${loc.turnN}-${absLine}`,
					row: screenRow,
					colStart: 0,
					// 思考标题可能很长；整行都应可点击，但把右侧
					// TimelineRail 的两列留给导航轨，避免热区重叠。
					colEnd: Math.max(0, transcriptContentW - 1),
					onClick: () => {
						const res = this.transcript.toggleThinking(loc.turn, transcriptContentW);
						if (res.toggled) {
							this.scrollOffset = Math.max(0, this.scrollOffset + res.lineDelta);
						}
						this.requestRender();
					},
				});
			}
		}

		// (2) 注册右侧 Gutter 交互（ScrollbarGutter 或 TimelineRail）
		if (this.gutterMode === "scrollbar") {
			for (let r = 0; r < chatAreaH; r++) {
				interactiveTargets.push({
					id: `scrollbar-row-${r}`,
					row: r,
					colStart: safeW - 2,
					colEnd: safeW,
					onClick: () => {
						const currentGeo = this.scrollbarGutter.computeGeometry(chatAreaH, totalPerm, scrollStart);
						if (currentGeo) {
							const targetContentTop = this.scrollbarGutter.mapRowToScrollTop(r, currentGeo);
							const targetOffset = Math.max(0, maxScroll - targetContentTop);
							this.scrollOffset = targetOffset;
							this.requestRender();
						}
					},
				});
			}
		} else {
			const railGeo = this.timelineRail.getGeometry(chatAreaH, atBottom);
			if (railGeo && timelineTurns.length > 0) {
				interactiveTargets.push({
					id: "rail-up",
					row: railGeo.upRow,
					colStart: safeW - 2,
					colEnd: safeW,
					onClick: () => this.scrollTurnUp(),
				});
				interactiveTargets.push({
					id: "rail-down",
					row: railGeo.downRow,
					colStart: safeW - 2,
					colEnd: safeW,
					onClick: () => this.scrollTurnDown(),
				});
				for (let k = 0; k < railGeo.shown; k++) {
					const screenRow = railGeo.tickTop + k;
					const turn = timelineTurns[railGeo.windowStart + k];
					if (turn) {
						interactiveTargets.push({
							id: `rail-tick-${turn.n}`,
							row: screenRow,
							colStart: safeW - 2,
							colEnd: safeW,
							onClick: () => this.scrollToTurn(turn.n),
						});
					}
				}
			}
		}

		const inputStartRow = allChatRows.length + aboveH;

		// (3) 注册输入框底边框上下文进度区域 Hover 展开交互（图一 + 需求3）
		const inputBottomBorderRow = inputStartRow + inputH - 1;
		const progressHotspotW = Math.max(1, this.inputLine.getProgressHotspotWidth?.() ?? 35);
		interactiveTargets.push({
			id: "context-progress",
			row: inputBottomBorderRow,
			colStart: 0,
			colEnd: Math.max(0, Math.min(inputWidth - 1, progressHotspotW - 1)),
		});

		// (4) 注册输入框点击交互，点击聚焦或定位光标
		if (inputH >= 3) {
			for (let r = 1; r < inputH - 1; r++) {
				interactiveTargets.push({
					id: `input-content-row-${r}`,
					row: inputStartRow + r,
					colStart: 0,
					colEnd: inputWidth - 1,
					onClick: (col?: number) => {
						this.focusManager.setFocus(this.inputLine);
						if (typeof col === "number" && typeof (this.inputLine as any).setCursorByClick === "function") {
							// 减去 dsh-tui 风格的 `› ` 提示符（共 2 列）
							(this.inputLine as any).setCursorByClick(Math.max(0, col - 2));
						}
						this.requestRender();
					},
				});
			}
		}

		this.mouseTracker.setTargets(interactiveTargets);

		// 8.6. 注册独立划选区域（转录历史区与输入框内容行相互隔离，禁止越界污染）
		const selectableRegions: SelectableRegion[] = [
			{
				id: "transcript",
				startRow: 0,
				endRow: Math.max(0, visibleTranscript.length - 1),
				colStart: 0,
				colEnd: Math.max(0, safeW - 2),
			},
		];

		if (inputH >= 3) {
			selectableRegions.push({
				id: "input",
				startRow: inputStartRow + 1,
				endRow: inputStartRow + inputH - 2,
				colStart: 2, // 排除 `› ` 提示符
				colEnd: Math.max(2, inputWidth - 1),
			});
		}

		this.mouseTracker.setSelectableRegions(selectableRegions);

		// 9. 保存当前完整帧供鼠标选区提取，注入划词反色高亮并提交渲染
		this.lastRenderedRows = fullScreenRows;
		const finalRows = this.mouseTracker.applyHighlight(fullScreenRows, scrollStart);
		this.renderer.renderFrame(finalRows);
	}

	private getPageMargin(_width: number): string {
		return "";
	}

	private handleResize(): void {
		this.stopAutoScroll();
		this.requestRender();
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
			} catch (error) { this.notify(`终端输入监听器失败: ${String(error)}`, "error"); }
		}

		// 1.5 鼠标 SGR 协议拦截（滚轮视口滚动、划词选区与交互热区）
		if (data.startsWith("\x1b[<")) {
			const isRelease = data.endsWith("m");
			const res = this.mouseTracker.handleInput(
				data,
				this.lastRenderedRows,
				this.onCopyOnSelect,
				this.lastPermanentLines,
			);
			if (isRelease) {
				this.stopAutoScroll();
			}
			if (res.handled) {
				if (res.dragEdge === "top") {
					this.startAutoScroll("up");
				} else if (res.dragEdge === "bottom") {
					this.startAutoScroll("down");
				} else if (res.dragEdge === null && this.autoScrollTimer) {
					this.stopAutoScroll();
				}

				if (res.hoverTargetId !== undefined) {
					const hoveredThinkingTurn = res.hoverTargetId?.startsWith("thinking-")
						? parseInt(res.hoverTargetId.replace("thinking-", ""), 10)
						: null;
					if (this.transcript.setHoveredThinkingTurn(hoveredThinkingTurn)) {
						this.requestRender();
					}

					const isCtxProgressHovered = res.hoverTargetId === "context-progress";
					if (this.contextBar.setHovered(isCtxProgressHovered)) {
						this.requestRender();
					}

					if (res.hoverTargetId?.startsWith("rail-tick-")) {
						const turnN = parseInt(res.hoverTargetId.replace("rail-tick-", ""), 10);
						this.timelineRail.setHoverTurnN(turnN);
						const target = this.mouseTracker.getTarget(res.hoverTargetId);
						if (target) {
							this.timelineRail.setHover(target.row);
						}
						this.requestRender();
					} else if (res.hoverTargetId === "rail-up" || res.hoverTargetId === "rail-down") {
						const target = this.mouseTracker.getTarget(res.hoverTargetId);
						if (target) {
							this.timelineRail.setHover(target.row);
						}
						this.requestRender();
					} else if (res.hoverTargetId?.startsWith("scrollbar-row-")) {
						const row = parseInt(res.hoverTargetId.replace("scrollbar-row-", ""), 10);
						if (this.scrollbarGutter.setHover(row)) {
							this.requestRender();
						}
					} else {
						let needReq = false;
						if (this.timelineRail.getHoverRow() !== null || this.timelineRail.getHoverTurnN() !== null) {
							this.timelineRail.setHoverTurnN(null);
							this.timelineRail.setHover(null);
							needReq = true;
						}
						if (this.scrollbarGutter.getHoverRow() !== null) {
							this.scrollbarGutter.clearHover();
							needReq = true;
						}
						if (needReq) {
							this.requestRender();
						}
					}
				}
				if (res.wheelDelta !== undefined) {
					if (res.wheelDelta < 0) {
						this.scrollUp(Math.abs(res.wheelDelta));
					} else {
						this.scrollDown(res.wheelDelta);
					}
				}
				if (res.needRender) {
					this.renderCurrentFrame();
				}
				return;
			}
		}

		// 2. 全局快捷键拦截（非鼠标交互立即停止自动滚屏）
		this.stopAutoScroll();
		if (data === "\x1b[Z" || matchesKey(data, Key.shiftTab)) {
			this.onThinkingLevelCycle?.();
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			// 1. 如果处于工作态（模型生成、工具执行中），直接触发平滑打断，绝不触发退出
			if (this.busy) {
				this.exitPending = false;
				if (this.exitTimer) {
					clearTimeout(this.exitTimer);
					this.exitTimer = null;
				}
				this.onInterrupt?.();
				return;
			}

			// 2. 如果输入框内部处于 Ctrl+A 选区态，优先复制
			if (this.inputLine.hasSelection()) {
				this.inputLine.copySelection();
				this.showCopyToast("已复制到剪贴板");
				return;
			}

			// 3. 如果聊天输入框中有内容，按 Ctrl+C 直接清空内容（完全对齐 dsh-TUI 规范），本次不计入退出意图
			if (this.inputLine.hasText()) {
				this.inputLine.clear();
				this.activeSuggestions = null;
				this.exitPending = false;
				if (this.exitTimer) {
					clearTimeout(this.exitTimer);
					this.exitTimer = null;
				}
				this.requestRender();
				return;
			}

			// 4. 输入框为空且空闲态下的双击退出机制（对齐 dsh-TUI）
			if (this.exitPending) {
				this.exitPending = false;
				if (this.exitTimer) {
					clearTimeout(this.exitTimer);
					this.exitTimer = null;
				}
				this.onInterrupt?.(); // 真正关闭退出
				return;
			}

			this.exitPending = true;
			this.requestRender();
			if (this.exitTimer) clearTimeout(this.exitTimer);
			this.exitTimer = setTimeout(() => {
				this.exitPending = false;
				this.requestRender();
			}, 3000);
			return;
		}

		// 用户按了除 Ctrl+C 外的其他键，取消退出待确认态
		if (this.exitPending && !data.startsWith("\x1b[<")) {
			this.exitPending = false;
			if (this.exitTimer) {
				clearTimeout(this.exitTimer);
				this.exitTimer = null;
			}
			this.requestRender();
		}

		if (matchesKey(data, Key.alt("a")) || matchesKey(data, Key.alt("A"))) {
			this.openSubagents();
			return;
		}

		if (matchesKey(data, Key.alt("j")) || matchesKey(data, Key.alt("J"))) {
			this.openTasks();
			return;
		}

		if (matchesKey(data, Key.alt("t")) || matchesKey(data, Key.alt("T"))) {
			this.openTrajectory();
			return;
		}

		if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.ctrl("O"))) {
			// 优先展开光标处的粘贴标记
			if (this.inputLine.hasChipAtCursor()) {
				this.inputLine.handleInput(data);
				this.requestRender();
				return;
			}
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
				this.closeModal();
				this.overlayStack.hideTopOverlay();
				return;
			}
		}

		// 3.5 联想卡片键鼠交互（/ 命令或 @ 文件导航与自动补全）
		if (this.activeSuggestions && this.activeSuggestions.items.length > 0) {
			if (matchesKey(data, Key.up)) {
				this.activeSuggestions.selectedIndex = Math.max(0, this.activeSuggestions.selectedIndex - 1);
				this.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.activeSuggestions.selectedIndex = Math.min(
					this.activeSuggestions.items.length - 1,
					this.activeSuggestions.selectedIndex + 1,
				);
				this.requestRender();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.activeSuggestions = null;
				this.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
				const selected = this.activeSuggestions.items[this.activeSuggestions.selectedIndex];
				if (selected) {
					if (this.activeSuggestions.type === "command") {
						const cmd = selected as CommandItem;
						if (cmd.hasArgs) {
							this.inputLine.setText(`/${cmd.name} `);
							this.activeSuggestions = null;
							this.requestRender();
							return;
						} else {
							this.inputLine.clear();
							this.activeSuggestions = null;
							this.executeCommand(cmd.name, "");
							this.requestRender();
							return;
						}
					} else {
						const file = selected as FileItem;
						const isDir = file.kind === "directory";
						const escapedPath = /\s/.test(file.path) ? `"${file.path}"` : file.path;
						const replacement = isDir ? `@${escapedPath}` : `@${escapedPath} `;

						this.inputLine.replaceRange(
							this.activeSuggestions.start,
							this.activeSuggestions.end,
							replacement,
						);

						if (isDir) {
							// 选中目录时无缝深入下级目录，保持浮层并立即重新索引
							this.updateSuggestions();
						} else {
							this.activeSuggestions = null;
						}
						this.requestRender();
						return;
					}
				}
			}
		}

		// 4. 输入框未输入时敲 '?' 直接唤起帮助
		if (data === "?" && !this.inputLine.getText().trim() && !this.overlayStack.hasVisible) {
			this.openHelpMenu();
			return;
		}

		// 4.1 终端鼠标滚轮支持（SGR \x1b[< 与 X10 模式）
		if (data.includes("\x1b[<")) {
			const sgrMatches = [...data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)[Mm]/g)];
			if (sgrMatches.length > 0) {
				let delta = 0;
				for (const m of sgrMatches) {
					const code = parseInt(m[1]!, 10);
					if ((code & 64) === 64) {
						if ((code & 1) === 0) delta += 3;
						else delta -= 3;
					}
				}
				if (delta > 0) {
					this.scrollUp(delta);
					return;
				} else if (delta < 0) {
					this.scrollDown(-delta);
					return;
				}
			}
		}
		if (data.startsWith("\x1b[M") && data.length >= 6) {
			let offset = 0;
			let delta = 0;
			while (offset + 6 <= data.length && data.slice(offset, offset + 3) === "\x1b[M") {
				const btn = data.charCodeAt(offset + 3) - 32;
				if (btn === 64) delta += 3;
				else if (btn === 65) delta -= 3;
				offset += 6;
			}
			if (delta > 0) {
				this.scrollUp(delta);
				return;
			} else if (delta < 0) {
				this.scrollDown(-delta);
				return;
			}
		}

		// 4.2 键盘视口滚动支持（PageUp / PageDown / Shift+Up/Down / Ctrl+Up/Down / Alt+Up/Down / Home / End）
		if (matchesKey(data, Key.pageup) || data === "\x1b[5~") {
			this.scrollUp(Math.max(1, Math.floor(this.terminal.rows / 2)));
			return;
		}
		if (matchesKey(data, Key.pagedown) || data === "\x1b[6~") {
			this.scrollDown(Math.max(1, Math.floor(this.terminal.rows / 2)));
			return;
		}
		if (data === "\x1b[1;2A" || data === "\x1b[1;5A" || data === "\x1b[1;3A") {
			this.scrollUp(3);
			return;
		}
		if (data === "\x1b[1;2B" || data === "\x1b[1;5B" || data === "\x1b[1;3B") {
			this.scrollDown(3);
			return;
		}
		if (data === "\x1b[5;2~" || data === "\x1b[1;5H" || data === "\x1b[1;2H") {
			this.scrollToTop();
			return;
		}
		if (data === "\x1b[6;2~" || data === "\x1b[1;5F" || data === "\x1b[1;2F") {
			this.scrollToBottom();
			return;
		}

		// 5. 焦点组件输入处理
		const focused = this.focusManager.getFocused();
		if (focused && focused.handleInput) {
			focused.handleInput(data);
			this.updateSuggestions();
			this.requestRender();
		}
	}

	private handleUserSubmit(text: string): void {
		this.scrollOffset = 0;
		this.activeSuggestions = null;
		this.inputLine.clear();

		const mode = this.busy ? "followUp" : "direct";
		this.onUserLine?.(text, mode);
	}
}
