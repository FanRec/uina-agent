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
import { MouseSelectionTracker, type InteractiveTarget, type SelectableRegion } from "./core/mouse-selection.js";
import { decodeHoverTarget, encodeHoverTarget } from "./core/hover-target.js";
import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "./core/types.js";
import type { ThinkingLevel } from "../core/types.js";
import type { SessionAccess, SessionEntry } from "../session/types.js";
import type { ContextSnapshot } from "../core/types.js";
import { C, copyToClipboardUnified, visibleWidth, truncateToWidth, stripAnsi, normalizeFrameLine } from "./core/utils.js";
import {
	InputLine,
	formatSuggestionCardLines,
	getFileCandidates,
	type CommandItem,
	type FileItem,
} from "./components/editor/index.js";
import { BannerComponent } from "./components/primitives/banner.js";
import {
		TranscriptContainer,
	type CompactionCardData,
	type CompactionReplayDecoration,
	type LineModel,
} from "./components/transcript/index.js";
import {
	ActivityLineComponent,
	formatWorkingHeader,
	PendingQueueComponent,
	ContextBarComponent,
	formatCacheHitRate,
	type ContextSegments,
	TimelineRailComponent,
	ScrollbarGutterComponent,
} from "./components/widgets/index.js";
import {
	HelpMenu,
	ModelPicker,
	type ModelGroup,
	EffortSlider,
	DEFAULT_EFFORT_TIERS,
	type EffortTier,
	TaskDashboard,
	type JobPort,
	SubagentDashboard,
	SubagentDetailScene,
	TrajectoryScene,
	BranchInspectorOverlay,
} from "./components/overlays/index.js";
import type { QueuedMessage } from "../agent/queue.js";
import type { SubagentPort } from "./adapters/subagents.js";
import { ExtensionRegistry } from "../extensions/renderer-registry.js";
import { createExtensionUIContext, type UIHostContextPort } from "./extension-ui-context.js";
import type { ExtensionUIContext } from "../extensions/ui-contract.js";
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
	sessionPort?: SessionAccess;
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
	/** 帧内单一行模型（转录区原始引用，仅当帧有效）。 */
	frameModel: LineModel;
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

/** 可挂进 overlayStack 的居中面板组件契约：可选的关闭回调与重绘请求。 */
interface PanelComponent extends Component {
	onClose?: () => void;
	onRequestRender?: () => void;
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
	/** 视口上方/下方最近的轮次，按 uid 定位（n 会撞号）。 */
	private upTurnUid: number | null = null;
	private downTurnUid: number | null = null;

	// 状态投影
	readonly trajectoryProjection: TrajectoryProjection;

	// 业务参数
	modelName?: string;
	private usedTokens?: number;
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
 private stopRegistryUpdates?: () => void;
	private busy = false;
	private turnStartTime = 0;

	private lastElapsedMs = 0;
	private renderScheduled = false;
	/**
	 * 统一帧时钟：唯一的动画重绘定时器（50ms）。
	 *
	 * busy 动画、扩展工作、smoothReveal 揭示、工具运行共用。
	 * 旧实现是三个独立 setInterval（60/50/300ms），相位漂移导致帧率抖动，
	 * 且各自持句柄、各自启停。现在状态源只置标志，updateHeartbeat() 收敛启停。
	 */
	private heartbeatTimer: NodeJS.Timeout | null = null;
	/** busy 动画需要重绘（转圈 spinner、耗时计时器）。仅作心跳状态源标志。 */
	private busyAnimation = false;
	private workingMessage?: string;
	private workingStartedAt?: number;
	private providerRetryMessage?: string;
	private scrollOffset = 0;
	private lastTotalPerm = 0;

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
	private lastMaxScroll = 0;
	private autoScrollTimer: NodeJS.Timeout | null = null;
	private autoScrollDirection: "up" | "down" | null = null;
	/** 视口离底指示器是否被 hover（驱动加粗高亮） */
	private viewportStatusHovered = false;
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
				this.requestRender();
			} else {
				if (this.scrollOffset <= 0) {
					this.stopAutoScroll();
					return;
				}
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.requestRender();
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
		text = this.cleanCodeBlockSelection(text);
		copyToClipboardUnified(text);

		const lineCount = text.split("\n").length;
		const toast = lineCount > 1 ? `已复制 ${lineCount} 行 (${text.length} 字符)` : `已复制 ${text.length} 字符`;
		this.showCopyToast(toast);
	};

	private cleanCodeBlockSelection(text: string): string {
		const lines = text.split("\n");
		const hasCodeFrame = lines.some((line) => {
			const clean = stripAnsi(line);
			return /^\s*[┌└]─/.test(clean) || /^\s*│/.test(clean) || /│\s*$/.test(clean);
		});
		if (!hasCodeFrame) return text;
		return lines
			.filter((line) => !/^\s*[┌└]─+[─┐┘\s]*$/.test(stripAnsi(line)))
			.map((line) => {
				const clean = stripAnsi(line);
				const match = clean.match(/^\s*│\s?(.*?)\s?│\s*$/);
				if (match && !match[1].includes("│")) return match[1];
				return line;
			})
			.join("\n");
	}


	// 事件回调
	onUserLine?: (text: string, mode: "steer" | "followUp" | "direct") => void;
	onInterrupt?: (force?: boolean) => void;
	onCancel?: (source?: "escape" | "ctrl+c") => void;
	onExit?: () => void;
	onInterruptAndDeliver?: (text: string) => void;
	onPullBackQueue?: () => void;
	onThinkingLevelCycle?: () => void;

	/** Ctrl+C 二次按键升级为强制退出；不是主体 busy/活动事实。 */
	private cancelPending = false;
	private jobPort?: JobPort;
	private subagentPort?: SubagentPort;
	private sessionPort?: SessionAccess;

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
		// UI 只发送取消意图；Subject/Host 才是活动事实所有者。压缩 runActivity
		// 期间 UI busy 可能仍为 false，不能在这里用本地状态短路。
		if (this.busy) {
			this.cancelPending = source === "ctrl+c";
			this.transcript.interruptTurn(this.modelName);
			this.activityLine.update("idle", "正在取消当前活动");
		}
		try {
			this.onCancel?.(source);
		} catch {
			// ignore
		}
		this.requestRender();
	}

	constructor(options: UIHostOptions = {}) {
		this.jobPort = options.jobPort;
		this.subagentPort = options.subagentPort;
		this.sessionPort = options.sessionPort;
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
		this.transcript.smoothReveal.setOnTick(() => this.updateHeartbeat());
		this.transcript.setRendererResolver({
			message: (type) => this.registry.getMessageRenderer(type),
   tool: (name) => this.registry.getToolRenderer(name),
   markdown: (text, context) => this.registry.transformMarkdown(text, context),
		});
		this.connectRegistry();
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
		this.inputLine.onEscape = () => {
			if (this.overlayStack.hasVisible) {
				this.overlayStack.hideTopOverlay();
			} else if (this.activeSuggestions) {
				this.activeSuggestions = null;
			} else if (this.inputLine.hasSelection()) {
				this.inputLine.clearSelection();
			} else if (this.inputLine.hasText()) {
				// 体验优先级：输入框里有内容时 Escape 先清草稿，而不是打断工作中的回合
				this.inputLine.clear();
			} else {
				this.cancelTurn();
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

 private connectRegistry(): void {
  this.stopRegistryUpdates ??= this.registry.onChange(() => { this.transcript.invalidate(); this.requestRender(); });
  this.transcript.invalidate();
 }

	start(): void {
  this.connectRegistry();
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
  this.stopRegistryUpdates?.();
  this.stopRegistryUpdates = undefined;
		if (!this.running) return;
		this.running = false;
		this.transcript.smoothReveal.setEnabled(false);
		this.stopAutoScroll();
		this.workingMessage = undefined;
		this.workingStartedAt = undefined;
		this.providerRetryMessage = undefined;
		this.stopAnimation();
		this.stopHeartbeat();
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

	addCompaction(record: CompactionCardData): void {
		this.transcript.addCompaction(record);
		if (!record.status || record.status === "completed") this.trajectoryProjection.onCompaction(record.summary, record.tokensBefore);
		this.requestRender();
	}

	getReasoningEffort(): ThinkingLevel | undefined {
		return this.reasoningEffort;
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

	/** 展开/折叠深度思考过程（官方 /think 命令经 pi.ui 调用）。 */
	toggleThinking(): void {
		this.transcript.toggleThinking();
		this.requestRender();
	}

	/** 清空当前屏幕转录流（官方 /clear 命令经 pi.ui 调用）。 */
	clearTranscript(): void {
		this.transcript.clear();
		this.requestRender();
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

	setContext(snapshot: ContextSnapshot): void {
		this.usedTokens = snapshot.inputTokens;
		this.contextWindow = snapshot.contextWindow && snapshot.contextWindow > 0 ? snapshot.contextWindow : undefined;
		this.usageActual = snapshot.measurementKind === "exact";
		this.contextSegments = snapshot.segments;
		this.cacheReadTokens = undefined;
		this.inputTokensCount = undefined;
		this.cacheWriteTokens = undefined;
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, this.usageActual, this.contextSegments);
		this.contextBar.update({ usedTokens: this.usedTokens, contextWindow: this.contextWindow, cwd: this.cwd, segments: this.contextSegments });
		this.requestRender();
	}
	markUsageEstimated(): void {
		this.usageActual = false;
		this.cacheReadTokens = undefined;
		this.inputTokensCount = undefined;
		this.cacheWriteTokens = undefined;
		this.requestRender();
	}

	/** @param turnUid 轮次身份（来自 getTimelineTurns / 热区 id），不是显示用的 n。 */
	scrollToTurn(turnUid: number): void {
		// Uses the geometry the user actually clicked on (last frame), falling
		// back to a fresh layout when nothing has been rendered yet.
		const layout = this.lastLayout ?? this.computeLayout();
		const lineOffset = this.transcript.getTurnStartLinesByUid(layout.transcriptContentW).get(turnUid);
		if (lineOffset === undefined) return;
		const targetScroll = layout.totalPerm - (layout.bannerCount + lineOffset) - layout.transcriptH;
		this.scrollOffset = Math.max(0, Math.min(layout.maxScroll, targetScroll));
		this.requestRender();
	}

	scrollTurnUp(): void {
		if (this.upTurnUid !== null) {
			this.scrollToTurn(this.upTurnUid);
		} else {
			this.scrollUp(5);
		}
	}

	scrollTurnDown(): void {
		if (this.downTurnUid !== null) {
			this.scrollToTurn(this.downTurnUid);
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
		this.scrollOffset = 0;
		this.lastTotalPerm = 0;
		this.requestRender();
	}

	loadSession(entries: readonly SessionEntry[], decorations: readonly CompactionReplayDecoration[] = []): void {
		this.transcript.loadSession(entries, decorations);
		this.scrollOffset = 0;
		this.lastTotalPerm = 0;
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
		this.lastTotalPerm = 0;
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
		this.workingMessage = message;
		this.requestRender();
	}

	setWorkingVisible(visible: boolean): void {
		if (visible) this.workingStartedAt ??= Date.now();
		else {
			this.workingStartedAt = undefined;
			this.workingMessage = undefined;
		}
		this.updateHeartbeat();
		this.requestRender();
	}

	/** 当前 Provider 重试状态。独立于回合 ActivityLine，直到恢复或回合结束才清除。 */
	setProviderRetryMessage(message?: string): void {
		this.providerRetryMessage = message;
		this.updateHeartbeat();
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

	// =========================================================================
	// 模态面板装配（所有居中面板共用同一套 onClose/onRequestRender/hide 接线）
	// =========================================================================

	/**
	 * toggleModal + showOverlay 的唯一接线点：close()/hide()/onClose 三者互相唤醒的
	 * 顺序在这里只写一次，7 个面板不可能再各自漂移出不同的关闭语义。
	 */
	private openPanel(id: string, build: (close: () => void, api: { hide: () => void }) => PanelComponent): void {
		this.toggleModal(id, (closeModalState) => {
			let handle: OverlayHandle | null = null;
			const doClose = () => {
				closeModalState();
				handle?.hide();
			};
			const panel = build(doClose, { hide: () => handle?.hide() });
			panel.onRequestRender = () => this.requestRender();
			const userOnClose = panel.onClose;
			panel.onClose = () => {
				userOnClose?.();
				doClose();
			};
			handle = this.overlayStack.showOverlay(panel, { anchor: "center" }, () => closeModalState());
			return handle;
		});
	}

	openHelpMenu(): void {
		this.openPanel("help", (close, { hide }) => {
			const menu = new HelpMenu(this.registry.listCommands());
			menu.onClose = () => close();
			menu.onConvertToInput = (text) => {
				close();
				// close() 只清模态状态；overlay 必须显式 hide 移出栈，否则会继续捕获输入。
				hide();
				this.inputLine.setText(text);
				this.requestRender();
			};
			return menu;
		});
	}

	openModelPicker(currentModel?: string, groups: ModelGroup[] = [], onPick?: (name: string) => Promise<void> | void): void {
		this.openPanel("model", (close) => {
			const picker = new ModelPicker(currentModel ?? this.modelName, groups);
			picker.onPick = (name) => {
				if (onPick) void onPick(name);
				close();
			};
			picker.onClose = () => close();
			return picker;
		});
	}

	openEffortSlider(
		currentLevel?: ThinkingLevel,
		tiers?: readonly (EffortTier | ThinkingLevel)[],
		onChange?: (level: ThinkingLevel) => void,
	): void {
		if (!this.thinkingLevels.length) { this.notify("当前模型未声明思考档位", "info"); return; }
		this.openPanel("effort", (close) => {
			const declaredTiers = (tiers && tiers.length > 0)
				? tiers.filter(t => this.thinkingLevels.includes(typeof t === "string" ? t : t.id))
				: DEFAULT_EFFORT_TIERS.filter((t) => this.thinkingLevels.includes(t.id));
			const slider = new EffortSlider(currentLevel ?? this.reasoningEffort ?? "off", declaredTiers);
			slider.onChange = (level) => {
				this.setReasoningEffort(level);
				onChange?.(level);
			};
			slider.onClose = () => close();
			return slider;
		});
	}

	openTasks(): void {
		if (!this.jobPort) return;
		this.openPanel("tasks", (close) => {
			const view = new TaskDashboard(this.jobPort!);
			view.onClose = () => close();
			return view;
		});
	}

	openSubagents(): void {
		if (!this.subagentPort) return;
		this.openPanel("subagents", (close, { hide }) => {
			const view = new SubagentDashboard(this.subagentPort!);
			view.onClose = () => close();
			view.onDrilldown = (agent) => {
				// 详情页是叠在列表之上的第二层 overlay：自己持 handle、自己 hide，
				// 关闭语义（hide 详情 → close 整个模态）与列表层相互独立。
				hide();
				const detail = new SubagentDetailScene(agent, this.subagentPort!);
				let detailHandle: OverlayHandle | null = null;
				detail.onClose = () => {
					detailHandle?.hide();
					detailHandle = null;
					close();
				};
				detail.onRequestRender = () => this.requestRender();
				detailHandle = this.overlayStack.showOverlay(detail, { anchor: "center" }, () => close());
			};
			return view;
		});
	}

	openTrajectory(): void {
		this.openPanel("trajectory", (close) => {
			const scene = new TrajectoryScene(this.trajectoryProjection);
			scene.onClose = () => close();
			return scene;
		});
	}

	openHistory(): void {
		const sessionPort = this.sessionPort;
		if (!sessionPort) return;
		this.openPanel("history", (close) => {
			const view = new BranchInspectorOverlay(sessionPort);
			view.onClose = () => close();
			return view;
		});
	}


	// =========================================================================
	// 渲染管道与帧合成（Bottom-Pinned Frame Engine）
	// =========================================================================

	/** Sync the input line's transient metrics before it is rendered. */
	private syncInputMetrics(): void {
		const innerW = this.terminal.columns;
		const statusWidth = Math.min(60, innerW - 20);
		const statusHeader = this.providerRetryMessage
			? formatWorkingHeader(this.providerRetryMessage, this.busy ? Math.max(0, Date.now() - this.turnStartTime) : 0, statusWidth)
			: this.workingStartedAt === undefined
				? this.activityLine.getHeaderString(statusWidth)
				: formatWorkingHeader(this.workingMessage || "正在处理...", Date.now() - this.workingStartedAt, statusWidth);
		// Show the viewport percentage using the previous frame's geometry; the
		// current frame's input height is required to compute it, so a one-frame
		// lag is unavoidable (and previously the header never rendered at all).
		const scrolled = this.lastMaxScroll > 0 && this.scrollOffset > 0;
		const percent = scrolled ? Math.round(((this.lastMaxScroll - Math.min(this.scrollOffset, this.lastMaxScroll)) / this.lastMaxScroll) * 100) : 100;
		// 视口离底指示器：品牌雾蓝（非告警语义），文案告知点击出口；hover 高亮由 viewport-status 热区分派
		const viewportLabel = scrolled
			? `${this.viewportStatusHovered ? C.bold : ""}${C.claude}[视口 ${percent}% · 点击回到最新]${C.reset}`
			: "";
		this.inputLine.setStatusHeader(viewportLabel ? `${viewportLabel} ${statusHeader}` : statusHeader);
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow, this.usageActual, this.contextSegments);
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.inputLine.setCacheRate(formatCacheHitRate(this.cacheReadTokens, this.inputTokensCount, this.cacheWriteTokens));
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
		// 帧内单一行模型：一次 ensureModel，行序列与四个热区索引全部同源（旧写法各取各的，assemble 重复 5 次）
		const frameModel = this.transcript.getFrameModel(transcriptContentW);
		const transcriptLines = frameModel.lines.map((l) => (l ? `${margin}${l}` : ""));
		const permanentLines = [...bannerLines, ...transcriptLines];
		const totalPerm = permanentLines.length;
		const maxScroll = Math.max(0, totalPerm - transcriptH);

		// 如果用户离开了底部（正在查看历史），底层追加了新内容（totalPerm 增大）时，
		// 自动增加 scrollOffset 保持视口顶部的绝对行号绝对不变，防止新 token 将用户正在查看的内容顶跑。
		if (this.scrollOffset > 0 && this.lastTotalPerm > 0 && totalPerm > this.lastTotalPerm) {
			const delta = totalPerm - this.lastTotalPerm;
			this.scrollOffset += delta;
		}
		this.lastTotalPerm = totalPerm;

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
			transcriptH, maxScroll, effScroll, scrollStart, visibleTranscript, frameModel,
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
			safeW, permanentLines, totalPerm, maxScroll, scrollStart, visibleTranscript, frameModel,
		} = layout;

		// 7.5. 右侧时间线导航轨（TimelineRail，对标图一）合成
		const timelineTurns = this.transcript.getTimelineTurns();
		const turnStartByUid = frameModel.turnStartByUid;

		// Navigation semantics: ▲ targets the nearest turn above the viewport,
		// ▼ the nearest turn below it. Comparing an absolute line against the
		// scroll *distance* (the old code) pointed at rows already on screen.
		const viewportTop = scrollStart;
		const viewportBottom = scrollStart + visibleTranscript.length;
		let activeTurnUid: number | null = null;
		let upTurnUid: number | null = null;
		let downTurnUid: number | null = null;

		for (const [turnUid, lineOffset] of turnStartByUid.entries()) {
			const absLine = bannerCount + lineOffset;
			if (absLine <= viewportTop) {
				activeTurnUid = turnUid;
			}
			if (absLine < viewportTop) {
				upTurnUid = turnUid;
			}
			if (absLine >= viewportBottom && downTurnUid === null) {
				downTurnUid = turnUid;
			}
		}

		if (activeTurnUid === null && timelineTurns.length > 0) {
			activeTurnUid = timelineTurns[0]!.uid;
		}

		this.upTurnUid = upTurnUid;
		this.downTurnUid = downTurnUid;

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

		// 跨屏选区提取用的是"用户看到的那一份行"，所以在这里就与屏幕对齐（制表符已展开）。
		this.lastPermanentLines = permanentLines.map((row) => normalizeFrameLine(row));
		this.lastMaxScroll = maxScroll;
		this.mouseTracker.setScrollContext(scrollStart, chatAreaH);

		let railGlyphs: string[] = [];
		// hover 中工具卡占用的屏幕行集合（含卡片末尾空行），供 rail 交界底色延伸判断
		const hoveredToolRowSet = new Set<number>();
		const hoveredToolIdNow = this.transcript.getHoveredToolId();
		if (hoveredToolIdNow !== null) {
			for (const loc of frameModel.toolLocations) {
				if (loc.callId !== hoveredToolIdNow) continue;
				for (let r = 0; r < loc.lineCount; r++) {
					const absLine = bannerCount + loc.lineIndex + r;
					if (absLine >= scrollStart && absLine < scrollStart + visibleTranscript.length) {
						hoveredToolRowSet.add(absLine - scrollStart);
					}
				}
			}
		}
		let previewCard: { topRow: number; lines: string[] } | undefined;

		if (this.gutterMode === "scrollbar") {
			const scrollRes = this.scrollbarGutter.renderGutterRows(chatAreaH, totalPerm, scrollStart);
			railGlyphs = scrollRes.gutterGlyphs;
			previewCard = scrollRes.hoverChip;
		} else {
			this.timelineRail.updateTurns(timelineTurns, activeTurnUid);
			const tlRes = this.timelineRail.renderRailRows(chatAreaH, atBottom, upTurnUid !== null, downTurnUid !== null, transcriptContentW);
			railGlyphs = tlRes.railGlyphs;
			previewCard = tlRes.previewCard;
		}

		for (let r = 0; r < chatAreaH; r++) {
			const rawLine = allChatRows[r] ?? "";
			const baseLine = truncateToWidth(rawLine, transcriptContentW, " ");
			const pad = Math.max(0, transcriptContentW - visibleWidth(baseLine));
			const rail = railGlyphs[r] ?? "  ";
			// hover 中的工具卡行：底色延伸覆盖 rail 交界 2 列，否则卡片底色到
			// transcriptContentW 截止，交界处漏出 2 列默认背景（高亮空缺）。
			// 闲置刻度轨自带 SGR（▔/─/空格），其 reset 后重新注入 bg 保持连续。
			if (hoveredToolRowSet.has(r)) {
				const patchedRail = rail.replace(/\x1b\[0?m/g, `\x1b[0m${C.toolCardBackground}`).replace(/\x1b\[49m/g, C.toolCardBackground);
				allChatRows[r] = `${baseLine}${" ".repeat(pad)}${C.toolCardBackground}${patchedRail}${C.reset}`;
			} else {
				allChatRows[r] = `${baseLine}${" ".repeat(pad)}${rail}`;
			}
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
		// (1.5) 注册工具卡片折叠交互（Tool Cards：按整张卡片块全域注册）
		// (1.8) 注册会话压缩卡片折叠交互（Compaction Cards：整张卡片全域点击展开/收起）
		// 三类块共用同一几何规则：块内每一行共享一个 id，注册为视口内可见行的点击热区。
		const blockGeo = { bannerCount, scrollStart, visibleH: visibleTranscript.length, contentW: transcriptContentW };
		const addBlockTargets = (
			blocks: readonly { lineIndex: number; rowCount: number; id: string; onClick: (absLine: number) => void }[],
		): void => {
			for (const block of blocks) {
				for (let r = 0; r < Math.max(1, block.rowCount); r++) {
					const absLine = blockGeo.bannerCount + block.lineIndex + r;
					if (absLine < blockGeo.scrollStart || absLine >= blockGeo.scrollStart + blockGeo.visibleH) continue;
					interactiveTargets.push({
						id: block.id,
						row: absLine - blockGeo.scrollStart,
						colStart: 0,
						colEnd: Math.max(0, blockGeo.contentW - 1),
						onClick: () => block.onClick(absLine),
					});
				}
			}
		};

		addBlockTargets(frameModel.thinkingLocations.map((loc) => ({
			lineIndex: loc.lineIndex,
			// 块级 id：一个思考块一个 id（块内所有行共享）。逐行不同 id 会被
			// 当成"目标变了"而触发全量重绘。
			rowCount: loc.lineCount ?? 1,
			id: encodeHoverTarget({ kind: "thinking", uid: loc.item.uid }),
			onClick: () => {
				this.preserveScrollAnchor(() => {
					this.transcript.toggleThinking(loc.item, transcriptContentW);
				}, bannerCount + loc.lineIndex);
				this.requestRender();
			},
		})));

		addBlockTargets(frameModel.toolLocations.map((loc) => ({
			lineIndex: loc.lineIndex,
			rowCount: loc.lineCount - 1, // 卡片末行是底边框，不参与点击
			id: encodeHoverTarget({ kind: "tool", callId: loc.callId, line: bannerCount + loc.lineIndex }),
			onClick: () => {
				this.preserveScrollAnchor(() => {
					this.transcript.toggleTool(loc.item, transcriptContentW);
				}, bannerCount + loc.lineIndex);
				this.requestRender();
			},
		})));

		addBlockTargets(frameModel.compactionLocations.map((loc) => ({
			lineIndex: loc.lineIndex,
			rowCount: loc.lineCount,
			id: encodeHoverTarget({ kind: "compaction", index: loc.index, line: bannerCount + loc.lineIndex }),
			onClick: () => {
				this.preserveScrollAnchor(() => {
					this.transcript.toggleCompaction(loc.index);
				}, bannerCount + loc.lineIndex);
				this.requestRender();
			},
		})));

		// (1.9) 注册帮助浮层全域点击收起交互
		if (this.activeModalId === "help" && aboveH > 0) {
			const aboveStartRow = allChatRows.length;
			for (let r = 0; r < aboveH; r++) {
				interactiveTargets.push({
					id: encodeHoverTarget({ kind: "help-overlay-row", row: r }),
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
					id: encodeHoverTarget({ kind: "scrollbar-row", row: r }),
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
					id: encodeHoverTarget({ kind: "rail-up" }),
					row: railGeo.upRow,
					colStart: safeW - 2,
					colEnd: safeW,
					onClick: () => this.scrollTurnUp(),
				});
				interactiveTargets.push({
					id: encodeHoverTarget({ kind: "rail-down" }),
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
							id: encodeHoverTarget({ kind: "rail-tick", turnUid: turn.uid }),
							row: screenRow,
							colStart: safeW - 2,
							colEnd: safeW,
							onClick: () => this.scrollToTurn(turn.uid),
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
			id: encodeHoverTarget({ kind: "context-progress" }),
			row: inputBottomBorderRow,
			colStart: 0,
			colEnd: Math.max(0, Math.min(inputWidth - 1, progressHotspotW - 1)),
		});

		// (3.5) 视口离底指示器热区：仅离底时存在（顶部边框行），点击回底，hover 高亮
		if (this.lastMaxScroll > 0 && this.scrollOffset > 0) {
			const labelLen = visibleWidth(`[视口 ${Math.round(((this.lastMaxScroll - Math.min(this.scrollOffset, this.lastMaxScroll)) / this.lastMaxScroll) * 100)}% · 点击回到最新]`);
			interactiveTargets.push({
				id: encodeHoverTarget({ kind: "viewport-status" }),
				row: inputStartRow,
				colStart: 0,
				colEnd: Math.max(0, labelLen),
				onClick: () => {
					this.scrollToBottom();
				},
			});
		}

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
						if (typeof col === "number") {
							// 减去 dsh-tui 风格的 `› ` 提示符（共 2 列）
							this.inputLine.setCursorByClick(Math.max(0, col - 2));
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
		// 屏幕逐格显示的就是这份行：渲染器与鼠标/选区共用它，列模型才不会与屏幕分叉。
		const displayRows = fullScreenRows.map((row) => normalizeFrameLine(row));
		this.lastRenderedRows = displayRows;
		const finalRows = this.mouseTracker.applyHighlight(displayRows, scrollStart);
		this.renderer.renderFrame(finalRows);
	}

	private getPageMargin(_width: number): string {
		return "";
	}

	private handleResize(): void {
		this.stopAutoScroll();
		this.requestRender();
	}

	/**
	 * 心跳状态源聚合与启停收敛。任何「状态在变」标志为真即开，全假即关。
	 */
	private updateHeartbeat(): void {
		const needed =
			this.busyAnimation ||
			this.providerRetryMessage !== undefined ||
			this.workingStartedAt !== undefined ||
			this.transcript.smoothReveal.isAnimating() ||
			this.transcript.hasRunningTools();
		if (needed && this.heartbeatTimer === null) {
			this.heartbeatTimer = setInterval(() => {
				// 推进揭示游标后统一重绘；所有状态源归零时自停
				if (this.transcript.smoothReveal.isAnimating()) this.transcript.smoothReveal.advance();
				this.requestRender();
				if (
					!this.busyAnimation &&
					this.providerRetryMessage === undefined &&
					this.workingStartedAt === undefined &&
					!this.transcript.smoothReveal.isAnimating() &&
					!this.transcript.hasRunningTools()
				) {
					this.stopHeartbeat();
				}
			}, 50);
		} else if (!needed && this.heartbeatTimer !== null) {
			this.stopHeartbeat();
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	getHeartbeatActiveForTest(): boolean {
		return this.heartbeatTimer !== null;
	}

	/** 工具状态变化（开始/结束）时由 tui 门面调用：重新评估心跳需求。 */
	notifyToolActivity(): void {
		this.updateHeartbeat();
	}

	private startAnimation(): void {
		if (this.busyAnimation) return;
		this.busyAnimation = true;
		this.updateHeartbeat();
	}

	private stopAnimation(): void {
		if (!this.busyAnimation) return;
		this.busyAnimation = false;
		this.updateHeartbeat();
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

		// 1.5 鼠标 SGR 与 X10 协议拦截（滚轮视口滚动、划词选区与交互热区）
		const sgrPattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
		const sgrMatches = [...data.matchAll(sgrPattern)];
		if (sgrMatches.length > 0 || data.includes("\x1b[<") || /^\[<\d+;\d+;\d+[Mm]/.test(data)) {
			let anyNeedRender = false;
			for (const match of sgrMatches) {
				const eventStr = match[0];
				const isRelease = match[4] === "m";
				const res = this.mouseTracker.handleInput(
					eventStr,
					this.lastRenderedRows,
					this.onCopyOnSelect,
					this.lastPermanentLines,
					// 输入框区域的芯片是视图压缩，复制时还原为逻辑内容；转录区原样透传
					(regionId, text) => (regionId === "input" ? this.inputLine.expandForCopy(text) : text),
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
						// 注意 null 与 undefined 之别：null = 鼠标已离开所有热区（必须走分派清除旧 hover）；
						// undefined = 本事件不携带 hover 信息。用 != null 会让移出事件被挡在门外，hover 永不熄灭。
						const target = decodeHoverTarget(res.hoverTargetId ?? "");

						const hoveredThinkingUid = target?.kind === "thinking" ? target.uid : null;
						if (this.transcript.setHoveredThinkingUid(hoveredThinkingUid)) {
							anyNeedRender = true;
						}

						const hoveredToolId = target?.kind === "tool" ? target.callId : null;
						if (this.transcript.setHoveredToolId(hoveredToolId)) {
							anyNeedRender = true;
						}

						const hoveredCompactionIndex = target?.kind === "compaction" ? target.index : null;
						if (this.transcript.setHoveredCompaction(hoveredCompactionIndex)) {
							anyNeedRender = true;
						}

						if (this.contextBar.setHovered(target?.kind === "context-progress")) {
							anyNeedRender = true;
						}

						if (target?.kind === "viewport-status") {
							if (!this.viewportStatusHovered) {
								this.viewportStatusHovered = true;
								anyNeedRender = true;
							}
						} else if (this.viewportStatusHovered) {
							this.viewportStatusHovered = false;
							anyNeedRender = true;
						}

						if (target?.kind === "rail-tick") {
							this.timelineRail.setHoverTurnUid(target.turnUid);
							const hit = this.mouseTracker.getTarget(res.hoverTargetId ?? "");
							if (hit) this.timelineRail.setHover(hit.row);
							anyNeedRender = true;
						} else if (target?.kind === "rail-up" || target?.kind === "rail-down") {
							const hit = this.mouseTracker.getTarget(res.hoverTargetId ?? "");
							if (hit) this.timelineRail.setHover(hit.row);
							anyNeedRender = true;
						} else if (target?.kind === "scrollbar-row") {
							if (this.scrollbarGutter.setHover(target.row)) {
								anyNeedRender = true;
							}
						} else {
							let needReq = false;
							if (this.timelineRail.getHoverRow() !== null || this.timelineRail.getHoverTurnUid() !== null) {
								this.timelineRail.setHoverTurnUid(null);
								this.timelineRail.setHover(null);
								needReq = true;
							}
							if (this.scrollbarGutter.getHoverRow() !== null) {
								this.scrollbarGutter.clearHover();
								needReq = true;
							}
							if (needReq) {
								anyNeedRender = true;
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
						anyNeedRender = true;
					}
				}
			}
			if (anyNeedRender) {
				this.requestRender();
			}

			// 从输入流中彻底剥除所有 SGR 鼠标序列及其残缺碎片，防止透传到输入框
			data = data.replace(sgrPattern, "").replace(/\[<\d+;\d+;\d+[Mm]/g, "");
			if (!data || data.trim() === "" || data.includes("\x1b[<")) {
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
			// 输入框编辑语义优先；但取消/退出事实由组合根查询 Host，不能读 UI busy。
			if (this.inputLine.hasSelection()) {
				this.inputLine.copySelection();
				return;
			}
			if (this.inputLine.hasText()) {
				this.inputLine.clear();
				this.requestRender();
				return;
			}
			if (this.cancelPending) {
				this.cancelPending = false;
				this.onExit?.();
				this.onInterrupt?.(true);
				return;
			}
			this.cancelTurn("ctrl+c");
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

		if (matchesKey(data, Key.alt("h")) || matchesKey(data, Key.alt("H"))) {
			this.openHistory();
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

		// 4.1 X10 鼠标滚轮（SGR 协议已在 1.5 拦截处理，这里只剩 \x1b[M 编码）
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
		// 不强制回底：视口主权归用户。在底部时 bottom-pinned 引擎自动跟随新内容；
		// 在历史位置时 computeLayout 的锚定机制保持视口绝对行号不变。
		this.activeSuggestions = null;
		this.inputLine.clear();

		if (mode === "interrupt") {
			if (this.busy) {
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
