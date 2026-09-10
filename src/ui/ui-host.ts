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
import { PendingQueueComponent } from "./components/widgets/pending-queue.js";
import type { QueuedMessage } from "../agent/queue.js";
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

/** Immutable frame geometry shared by rendering, scrolling and hit zones. */
interface FrameLayout {
	width: number;
	height: number;
	margin: string;
	innerW: number;
	inputWidth: number;
	inputLines: string[];
	inputH: number;
	belowLines: string[];
	belowH: number;
	maxAboveH: number;
	overlayLines: string[];
	suggestionLines: string[];
	pendingLines: string[];
	aboveLines: string[];
	aboveH: number;
	bannerLines: string[];
	bannerCount: number;
	transcriptLines: string[];
	permanentLines: string[];
	totalPerm: number;
	safeW: number;
	transcriptContentW: number;
	transcriptH: number;
	maxScroll: number;
	effScroll: number;
	scrollStart: number;
	visibleTranscript: string[];
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
	modelName?: string;
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
	/** Geometry of the most recently rendered frame; reused by scroll/anchor paths. */
	private lastLayout: FrameLayout | null = null;
	private exitPending = false;
	private exitTimer: NodeJS.Timeout | null = null;
	private copyToastText = "";
	private copyToastTimer: NodeJS.Timeout | null = null;
	private notificationToast: {
		message: string;
		type: "info" | "warning" | "error";
		timer?: NodeJS.Timeout;
	} | null = null;

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
	onInterrupt?: (force?: boolean) => void;
	onCancel?: (source?: "escape" | "ctrl+c") => void;
	onExit?: () => void;
	onInterruptAndDeliver?: (text: string) => void;
	onPullBackQueue?: () => void;
	onThinkingLevelCycle?: () => void;

	private cancelPending = false;
	private jobPort?: JobPort;
	private subagentPort?: SubagentPort;

	setJobPort(port: JobPort): void {
		this.jobPort = port;
	}

	setSubagentPort(port: SubagentPort): void {
		this.subagentPort = port;
	}

	private pendingQueue = new PendingQueueComponent();

	setPendingQueue(items: readonly QueuedMessage[]): void {
		this.pendingQueue.setItems(items);
		this.requestRender();
	}

	cancelTurn(source: "escape" | "ctrl+c" = "escape"): void {
		if (this.busy) {
			this.cancelPending = true;
			this.transcript.interruptTurn(this.modelName);
			this.activityLine.update("idle", "已打断当前轮次");
			try {
				this.onCancel?.(source);
			} catch {
				// ignore
			}
			try {
				this.onInterrupt?.(false);
			} catch {
				// ignore
			}
			this.requestRender();
		}
	}

	constructor(options: UIHostOptions = {}) {
		this.jobPort = options.jobPort;
		this.subagentPort = options.subagentPort;
		this.cwd = options.cwd ?? process.cwd();
		this.modelName = options.modelName;
		this.thinkingLevels = options.thinkingLevels ? [...options.thinkingLevels] : [];
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
		this.inputLine.onSubmitMode = (text, mode) => this.handleUserSubmitMode(text, mode);
		this.inputLine.onInterrupt = () => {
			if (this.busy) {
				this.cancelTurn("ctrl+c");
			} else {
				try {
					this.onExit?.();
				} catch {
					// ignore
				}
				try {
					this.onInterrupt?.(true);
				} catch {
					// ignore
				}
			}
		};
		this.inputLine.onEscape = () => {
			if (this.overlayStack.hasVisible) {
				this.overlayStack.hideTopOverlay();
			} else if (this.activeSuggestions) {
				this.activeSuggestions = null;
			} else if (this.busy) {
				this.cancelTurn();
			} else if (this.inputLine.hasSelection()) {
				this.inputLine.clearSelection();
			} else if (this.inputLine.hasText()) {
				this.inputLine.clear();
			}
			this.requestRender();
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
		if (this.notificationToast?.timer) {
			clearTimeout(this.notificationToast.timer);
			this.notificationToast = null;
		}
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
		this.thinkingLevels = levels ? [...levels] : [];
		if (this.reasoningEffort && !this.thinkingLevels.includes(this.reasoningEffort)) this.setReasoningEffort(undefined);
	}

	setReasoningEffort(effort?: ThinkingLevel | string): void {
		if (!effort) { this.reasoningEffort = undefined; this.inputLine.setReasoningEffort(undefined); this.requestRender(); return; }
		const lower = effort.toLowerCase().trim() as ThinkingLevel;
		if (!this.thinkingLevels.includes(lower)) throw new Error(`当前 Provider 不支持思考等级: ${effort}`);
		this.reasoningEffort = lower;
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.requestRender();
	}

	addCompaction(record: import("./components/transcript/compact-view.js").CompactionRecord): void {
		this.transcript.addCompaction(record);
		this.trajectoryProjection.onCompaction(record.summary, record.tokensSaved);
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
		this.inputLine.setBusy(busy);
		if (busy) {
			this.turnStartTime = Date.now();
			this.streamTokenCount = 0;
			this.startAnimation();
		} else {
			this.cancelPending = false;
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
		// Uses the geometry the user actually clicked on (last frame), falling
		// back to a fresh layout when nothing has been rendered yet.
		const layout = this.lastLayout ?? this.computeLayout();
		const lineOffset = this.transcript.getTurnStartLines(layout.transcriptContentW).get(turnN);
		if (lineOffset === undefined) return;
		const targetScroll = layout.totalPerm - (layout.bannerCount + lineOffset) - layout.transcriptH;
		this.scrollOffset = Math.max(0, Math.min(layout.maxScroll, targetScroll));
		this.requestRender();
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

	/**
	 * 在执行可能改变历史行数的操作（展开/收起思考、展开/收起工具卡片、全局折叠）时，
	 * 精确保持当前屏幕上正在查看的内容（或用户交互的目标锚点）在视口中的屏幕行位置绝对不变。
	 */
	preserveScrollAnchor(action: () => void, targetAbsLine?: number): void {
		// "before" comes from the last rendered frame, so expanding a card costs
		// one layout (the incremental one) instead of two full ones.
		const before = this.lastLayout ?? this.computeLayout();
		const oldScrollStart = before.scrollStart;

		// 确定锚点行在原全量内容中的绝对行索引及在视口中的屏幕行偏移
		const anchorLine =
			typeof targetAbsLine === "number" &&
			targetAbsLine >= oldScrollStart &&
			targetAbsLine < oldScrollStart + before.transcriptH
				? targetAbsLine
				: oldScrollStart;
		const screenOffset = anchorLine - oldScrollStart;

		action();

		const after = this.computeLayout();
		if (after.totalPerm <= after.transcriptH) {
			this.scrollOffset = 0;
			return;
		}

		// 保持锚点行留在原屏幕行偏移位置
		const targetScrollStart = Math.max(0, Math.min(after.maxScroll, anchorLine - screenOffset));
		this.scrollOffset = Math.max(0, Math.min(after.maxScroll, after.totalPerm - after.transcriptH - targetScrollStart));
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

	notify(message: string, type: "info" | "warning" | "error" = "info", timeoutMs = 3000): void {
		if (this.notificationToast?.timer) {
			clearTimeout(this.notificationToast.timer);
		}
		let timer: NodeJS.Timeout | undefined;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				this.clearNotification();
			}, timeoutMs);
			timer.unref?.();
		}
		this.notificationToast = { message, type, timer };
		this.requestRender();
	}

	clearNotification(): void {
		if (this.notificationToast) {
			if (this.notificationToast.timer) {
				clearTimeout(this.notificationToast.timer);
			}
			this.notificationToast = null;
			this.requestRender();
		}
	}

	getNotificationToast(): { message: string; type: "info" | "warning" | "error" } | null {
		if (!this.notificationToast) return null;
		return { message: this.notificationToast.message, type: this.notificationToast.type };
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
			menu.onConvertToInput = (text) => {
				close();
				handle?.hide();
				this.inputLine.setText(text);
				this.requestRender();
			};
			handle = this.overlayStack.showOverlay(menu, { anchor: "center" }, () => close());
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
			handle = this.overlayStack.showOverlay(picker, { anchor: "center" }, () => close());
			return handle;
		});
	}

	openEffortSlider(
		currentLevel?: ThinkingLevel,
		tiers?: readonly (EffortTier | ThinkingLevel)[],
		onChange?: (level: ThinkingLevel) => void,
	): void {
		if (!this.thinkingLevels.length) { this.notify("当前模型未声明思考档位", "info"); return; }
		this.toggleModal("effort", (close) => {
			const declaredTiers = (tiers && tiers.length > 0)
				? tiers.filter(t => this.thinkingLevels.includes(typeof t === "string" ? t : t.id))
				: DEFAULT_EFFORT_TIERS.filter((t) => this.thinkingLevels.includes(t.id));
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
			handle = this.overlayStack.showOverlay(slider, { anchor: "center" }, () => close());
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
			handle = this.overlayStack.showOverlay(view, { anchor: "center" }, () => close());
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
				detailHandle = this.overlayStack.showOverlay(detail, { anchor: "center" }, () => close());
				detail.onClose = () => {
					detailHandle?.hide();
					detailHandle = null;
					close();
				};
				detail.onRequestRender = () => this.requestRender();
			};
			view.onRequestRender = () => this.requestRender();

			handle = this.overlayStack.showOverlay(view, { anchor: "center" }, () => {
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
			handle = this.overlayStack.showOverlay(scene, { anchor: "center" }, () => close());
			return handle;
		});
	}


	// =========================================================================
	// 渲染管道与帧合成（Bottom-Pinned Frame Engine）
	// =========================================================================

	/** Sync the input line's transient metrics before it is rendered. */
	private syncInputMetrics(): void {
		const innerW = this.terminal.columns;
		const statusHeader = this.activityLine.getHeaderString(Math.min(60, innerW - 20));
		// Show the viewport percentage using the previous frame's geometry; the
		// current frame's input height is required to compute it, so a one-frame
		// lag is unavoidable (and previously the header never rendered at all).
		const scrolled = this.lastMaxScroll > 0 && this.scrollOffset > 0;
		const percent = scrolled ? Math.round(((this.lastMaxScroll - Math.min(this.scrollOffset, this.lastMaxScroll)) / this.lastMaxScroll) * 100) : 100;
		this.inputLine.setStatusHeader(scrolled ? `${C.yellow}[📜 视口 ${percent}% (PageDn到底)]${C.reset} ${statusHeader}` : statusHeader);
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, this.usageActual, this.contextSegments);
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.inputLine.setCacheRate(formatCacheHitRate(this.cacheReadTokens, this.inputTokensCount, this.cacheWriteTokens));
		const now = Date.now();
		const elapsed = this.busy ? Math.max(1, now - this.turnStartTime) : this.lastElapsedMs;
		const currentTps = this.busy
			? (this.streamTokenCount > 0 && elapsed > 100
				? Math.round((this.streamTokenCount / (elapsed / 1000)) * 10) / 10
				: 0)
			: this.lastTps;
		this.inputLine.setSpeedStats(currentTps, elapsed, this.busy);
	}

	/**
	 * Single source of truth for frame geometry. Pure with respect to
	 * `scrollOffset`: it reports the clamped value instead of writing it, so
	 * rendering, scrollToTurn, preserveScrollAnchor and hit zones cannot drift.
	 */
	private computeLayout(): FrameLayout {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const margin = this.getPageMargin(width);
		const innerW = width;

		// The input line keeps one safety column so the terminal never wraps it.
		const inputWidth = Math.max(2, innerW - 1);
		const inputLines = this.inputLine.render(innerW).map((l) => `${margin}${l}`);
		const inputH = inputLines.length;

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
		// The footer slot is a real frame region: extensions that call setFooter()
		// must see it, otherwise the API silently does nothing.
		const footerLines = this.footerContainer.render(inputWidth).map((l) => `${margin}${l}`);
		const belowLines = [
			...contextBarLines,
			...this.widgetSlots.render("belowEditor", innerW).map((l) => `${margin}${l}`),
			...footerLines,
		];
		const belowH = belowLines.length;

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

		const pendingLines =
			(!this.activeSuggestions || this.activeSuggestions.items.length === 0) && !this.overlayStack.hasVisible
				? this.pendingQueue.render(innerW)
				: [];

		// The stack is ordered top → editor-adjacent; when the budget is exceeded
		// keep the lines closest to the input box instead of the far ones.
		const aboveRaw = [...aboveEditorWidgets, ...overlayLines, ...suggestionLines, ...pendingLines];
		const aboveLines = (aboveRaw.length > maxAboveH ? aboveRaw.slice(aboveRaw.length - maxAboveH) : aboveRaw).map((l) => `${margin}${l}`);
		const aboveH = aboveLines.length;

		const breathingGap = 1;
		const transcriptH = Math.max(0, height - inputH - belowH - aboveH - breathingGap);
		const safeW = Math.max(20, innerW - 1);
		const transcriptContentW = Math.max(18, safeW - 2);
		const bannerLines = this.headerContainer.render(transcriptContentW).map((l) => (l ? `${margin}${l}` : ""));
		const transcriptLines = this.transcript.render(transcriptContentW).map((l) => (l ? `${margin}${l}` : ""));
		const permanentLines = [...bannerLines, ...transcriptLines];
		const totalPerm = permanentLines.length;
		const maxScroll = Math.max(0, totalPerm - transcriptH);
		const effScroll = totalPerm <= transcriptH ? 0 : Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const scrollStart = totalPerm <= transcriptH ? 0 : totalPerm - transcriptH - effScroll;
		const visibleTranscript = totalPerm <= transcriptH
			? [...permanentLines, ...new Array(transcriptH - totalPerm).fill("")]
			: permanentLines.slice(scrollStart, scrollStart + transcriptH);

		return {
			width, height, margin, innerW, inputWidth, inputLines, inputH,
			belowLines, belowH, maxAboveH, overlayLines, suggestionLines, pendingLines,
			aboveLines, aboveH, bannerLines, bannerCount: bannerLines.length,
			transcriptLines, permanentLines, totalPerm, safeW, transcriptContentW,
			transcriptH, maxScroll, effScroll, scrollStart, visibleTranscript,
		};
	}

	private renderCurrentFrame(): void {
		if (!this.running) return;
		this.syncInputMetrics();
		const layout = this.computeLayout();
		this.lastLayout = layout;
		this.scrollOffset = layout.effScroll;
		const {
			width, height, margin, inputWidth, inputLines, inputH,
			belowLines, belowH, aboveLines, aboveH, bannerCount, transcriptContentW,
			safeW, permanentLines, totalPerm, maxScroll, scrollStart, visibleTranscript,
		} = layout;

		// 7.5. 右侧时间线导航轨（TimelineRail，对标图一）合成
		const timelineTurns = this.transcript.getTimelineTurns();
		const turnStartMap = this.transcript.getTurnStartLines(transcriptContentW);

		// Navigation semantics: ▲ targets the nearest turn above the viewport,
		// ▼ the nearest turn below it. Comparing an absolute line against the
		// scroll *distance* (the old code) pointed at rows already on screen.
		const viewportTop = scrollStart;
		const viewportBottom = scrollStart + visibleTranscript.length;
		let activeTurnN: number | null = null;
		let upTurnN: number | null = null;
		let downTurnN: number | null = null;

		for (const [turnN, lineOffset] of turnStartMap.entries()) {
			const absLine = bannerCount + lineOffset;
			if (absLine <= viewportTop) {
				activeTurnN = turnN;
			}
			if (absLine < viewportTop) {
				upTurnN = turnN;
			}
			if (absLine >= viewportBottom && downTurnN === null) {
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
		} else if (this.notificationToast) {
			const col =
				this.notificationToast.type === "error"
					? C.error
					: this.notificationToast.type === "warning"
						? C.warning
						: C.inactive;
			toastStr = `${col}${this.notificationToast.message}${C.reset}`;
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
			const tlRes = this.timelineRail.renderRailRows(chatAreaH, atBottom, upTurnN !== null, downTurnN !== null, transcriptContentW);
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

		// (1) 注册思考折叠行交互（按思考块全域行注册）
		const thinkingLocs = this.transcript.getThinkingLineIndices(transcriptContentW);
		for (const loc of thinkingLocs) {
			const thinkingRows = Math.max(1, loc.lineCount ?? 1);
			for (let r = 0; r < thinkingRows; r++) {
				const absLine = bannerCount + loc.lineIndex + r;
				if (absLine >= scrollStart && absLine < scrollStart + visibleTranscript.length) {
					const screenRow = absLine - scrollStart;
					interactiveTargets.push({
						id: `thinking:${loc.turnN}:${absLine}`,
						row: screenRow,
						colStart: 0,
						colEnd: Math.max(0, transcriptContentW - 1),
						onClick: () => {
							this.preserveScrollAnchor(() => {
								this.transcript.toggleThinking(loc.turn, transcriptContentW);
							}, bannerCount + loc.lineIndex);
							this.requestRender();
						},
					});
				}
			}
		}

		// (1.5) 注册工具卡片折叠交互（Tool Cards：按整张卡片块全域注册）
		const toolLocs = this.transcript.getToolLineIndices(transcriptContentW);
		for (const loc of toolLocs) {
			const cardContentRows = Math.max(1, loc.lineCount - 1);
			for (let r = 0; r < cardContentRows; r++) {
				const absLine = bannerCount + loc.lineIndex + r;
				if (absLine >= scrollStart && absLine < scrollStart + visibleTranscript.length) {
					const screenRow = absLine - scrollStart;
					interactiveTargets.push({
						id: `tool:${loc.callId}:${absLine}`,
						row: screenRow,
						colStart: 0,
						colEnd: Math.max(0, transcriptContentW - 1),
						onClick: () => {
							this.preserveScrollAnchor(() => {
								this.transcript.toggleTool(loc.item, transcriptContentW);
							}, bannerCount + loc.lineIndex);
							this.requestRender();
						},
					});
				}
			}
		}

		// (1.8) 注册会话压缩卡片折叠交互（Compaction Cards：整张卡片全域点击展开/收起）
		const compactionLocs = this.transcript.getCompactionLineIndices(transcriptContentW);
		for (const loc of compactionLocs) {
			const compactionRows = Math.max(1, loc.lineCount);
			for (let r = 0; r < compactionRows; r++) {
				const absLine = bannerCount + loc.lineIndex + r;
				if (absLine >= scrollStart && absLine < scrollStart + visibleTranscript.length) {
					const screenRow = absLine - scrollStart;
					interactiveTargets.push({
						id: `compaction:${loc.index}:${absLine}`,
						row: screenRow,
						colStart: 0,
						colEnd: Math.max(0, transcriptContentW - 1),
						onClick: () => {
							this.preserveScrollAnchor(() => {
								this.transcript.toggleCompaction(loc.index);
							}, bannerCount + loc.lineIndex);
							this.requestRender();
						},
					});
				}
			}
		}

		// (1.9) 注册帮助浮层全域点击收起交互
		if (this.activeModalId === "help" && aboveH > 0) {
			const aboveStartRow = allChatRows.length;
			for (let r = 0; r < aboveH; r++) {
				interactiveTargets.push({
					id: `help-overlay-row-${r}`,
					row: aboveStartRow + r,
					colStart: 0,
					colEnd: Math.max(0, width - 1),
					onClick: () => {
						this.closeModal();
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
					const hoveredThinkingTurn = res.hoverTargetId?.startsWith("thinking:")
						? parseInt(res.hoverTargetId.split(":")[1] ?? "", 10)
						: res.hoverTargetId?.startsWith("thinking-")
							? parseInt(res.hoverTargetId.replace("thinking-", ""), 10)
							: null;
					if (this.transcript.setHoveredThinkingTurn(hoveredThinkingTurn)) {
						this.requestRender();
					}

					let hoveredToolId: string | null = null;
					if (res.hoverTargetId?.startsWith("tool:")) {
						const parts = res.hoverTargetId.split(":");
						hoveredToolId = parts[1] ?? null;
					} else if (res.hoverTargetId?.startsWith("tool-")) {
						const parts = res.hoverTargetId.split("-");
						hoveredToolId = parts.slice(1, -1).join("-");
					}
					if (this.transcript.setHoveredToolId(hoveredToolId)) {
						this.requestRender();
					}

					let hoveredCompactionIndex: number | null = null;
					if (res.hoverTargetId?.startsWith("compaction:")) {
						const parts = res.hoverTargetId.split(":");
						const idx = parseInt(parts[1] ?? "", 10);
						if (!Number.isNaN(idx)) hoveredCompactionIndex = idx;
					}
					if (this.transcript.setHoveredCompaction(hoveredCompactionIndex)) {
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
			// 1. 如果处于工作态（模型生成、工具执行中）
			if (this.busy) {
				if (this.cancelPending) {
					// 正在中断收敛中或底层卡死，用户再次按下 Ctrl+C 意图强制退出应用（对齐 dsh-TUI Chat.tsx onExit()）
					this.cancelPending = false;
					try {
						this.onExit?.();
					} catch {
						// ignore
					}
					try {
						this.onInterrupt?.(true);
					} catch {
						// ignore
					}
					return;
				}
				this.cancelPending = true;
				this.exitPending = false;
				if (this.exitTimer) {
					clearTimeout(this.exitTimer);
					this.exitTimer = null;
				}
				this.cancelTurn("ctrl+c");
				return;
			}

			// 2. 空闲态下，第 1 次按 Ctrl+C：若输入框有选区先清选区；若有草稿先清草稿；都为空则提示“再次按 Ctrl+C 退出”
			if (this.inputLine.hasSelection()) {
				this.inputLine.clearSelection();
				this.requestRender();
				return;
			}
			if (this.inputLine.hasText()) {
				this.inputLine.clear();
				this.requestRender();
				return;
			}

			// 3. 空闲态且输入框为空：第 1 次提示，第 2 次在 2 秒内按下才真正触发退出
			if (this.exitPending) {
				if (this.exitTimer) {
					clearTimeout(this.exitTimer);
					this.exitTimer = null;
				}
				try {
					this.onExit?.();
				} catch {
					// ignore
				}
				try {
					this.onInterrupt?.(true); // 真正关闭退出
				} catch {
					// ignore
				}
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

		if (matchesKey(data, Key.altUp) || matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("q")) || matchesKey(data, Key.alt("Q"))) {
			this.onPullBackQueue?.();
			return;
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
			const layout = this.lastLayout ?? this.computeLayout();
			const { transcriptContentW, bannerCount } = layout;

			// 如果当前焦点或悬停在工具卡片上，单卡展开优先
			const hoveredToolId = this.transcript.getHoveredToolId();
			if (hoveredToolId) {
				const toolLoc = this.transcript.getToolLineIndices(transcriptContentW).find((l) => l.callId === hoveredToolId);
				const targetAbsLine = toolLoc ? bannerCount + toolLoc.lineIndex : undefined;
				this.preserveScrollAnchor(() => {
					this.transcript.toggleTool(hoveredToolId, transcriptContentW);
				}, targetAbsLine);
				this.requestRender();
				return;
			}

			// 如果当前悬停在会话压缩卡片上，单卡展开优先
			const hoveredCompactionIndex = this.transcript.getHoveredCompaction();
			if (hoveredCompactionIndex !== null) {
				const compactionLoc = this.transcript.getCompactionLineIndices(transcriptContentW).find((l) => l.index === hoveredCompactionIndex);
				const targetAbsLine = compactionLoc ? bannerCount + compactionLoc.lineIndex : undefined;
				this.preserveScrollAnchor(() => {
					this.transcript.toggleCompaction(hoveredCompactionIndex);
				}, targetAbsLine);
				this.requestRender();
				return;
			}

			const thinkingLocs = this.transcript.getThinkingLineIndices(transcriptContentW);
			const targetThinkingLoc = thinkingLocs.length > 0 ? thinkingLocs[thinkingLocs.length - 1] : undefined;
			const targetAbsLine = targetThinkingLoc ? bannerCount + targetThinkingLoc.lineIndex : undefined;

			this.preserveScrollAnchor(() => {
				const result = this.transcript.toggleThinking(undefined, transcriptContentW);
				if (!result.toggled) {
					const toolRes = this.transcript.toggleTool(undefined, transcriptContentW);
					if (!toolRes.toggled) {
						this.transcript.toggleCompaction();
					}
				}
			}, targetAbsLine);
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.alt("o")) || matchesKey(data, Key.alt("O"))) {
			this.preserveScrollAnchor(() => {
				this.transcript.toggleAllThinking();
				this.transcript.toggleAllTools();
			});
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

		// 3.6 Esc 阶梯处理（无浮层/菜单时）：工作态打断当前轮；空闲态取消选区或清空草稿（对齐 dsh-TUI）
		if (matchesKey(data, Key.escape)) {
			if (this.busy) {
				this.cancelTurn("escape");
				return;
			}
			if (this.inputLine.hasSelection()) {
				this.inputLine.clearSelection();
				this.requestRender();
				return;
			}
			if (this.inputLine.hasText()) {
				this.inputLine.clear();
				this.requestRender();
				return;
			}
		}

		// 4. 输入框严格未输入任何字符时敲 '?' 唤起帮助；若前面有空格则作为普通字符输入
		if (data === "?" && this.inputLine.getText() === "" && !this.overlayStack.hasVisible) {
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
		const mode = this.busy ? "steer" : "direct";
		this.handleUserSubmitMode(text, mode);
	}

	private handleUserSubmitMode(text: string, mode: "direct" | "steer" | "followUp" | "interrupt"): void {
		this.scrollOffset = 0;
		this.activeSuggestions = null;
		this.inputLine.clear();

		if (mode === "interrupt") {
			if (this.busy) {
				this.cancelPending = true;
				this.transcript.interruptTurn(this.modelName);
				this.activityLine.update("idle", "已打断当前轮次");
				this.requestRender();
				this.onInterruptAndDeliver?.(text);
			} else {
				this.onUserLine?.(text, "direct");
			}
			return;
		}

		this.onUserLine?.(text, mode);
	}
}
