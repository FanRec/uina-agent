/**
 * UIHost 控制台宿主。
 * 组装根容器树 (Root Container)、焦点系统、覆盖层栈、小部件槽位、转录区与输入区，
 * 调度原子全帧差量渲染与键盘输入分发。
 */

import type { ContextSnapshot, RequestUsage, ThinkingLevel, ToolResultStatus } from "../core/types.js";
import { ExtensionRegistry } from "../extensions/renderer-registry.js";
import type {
	BuiltinUIActionRequest,
	BuiltinUIActions,
	ExtensionUIContext,
	TerminalUIContext,
} from "../extensions/ui-contract.js";
import type { PromptSnapshotRecord } from "../session/prompt-snapshots.js";
import type { SessionEntry } from "../session/types.js";
import { type FileItem, searchFileCandidates } from "./components/editor/file-candidates.js";
import { type CommandItem, formatSuggestionCardLines, InputLine } from "./components/editor/index.js";
import { BannerComponent } from "./components/primitives/banner.js";
import {
	type CompactionCardData,
	type CompactionReplayDecoration,
	type ExternalContextCardData,
	type LineModel,
	type PromptContextCardData,
	TranscriptContainer,
} from "./components/transcript/index.js";
import {
	ActivityLineComponent,
	ContextBarComponent,
	type ContextSegments,
	formatCacheHitRate,
	formatWorkingHeader,
	PendingQueueComponent,
	type PendingQueueItem,
	ScrollbarGutterComponent,
	TimelineRailComponent,
} from "./components/widgets/index.js";
import { ComponentBoundary } from "./core/component-boundary.js";
import { FocusManager } from "./core/focus.js";
import { resolveGutterAction } from "./core/gutter.js";
import { decodeHoverTarget, encodeHoverTarget } from "./core/hover-target.js";
import { Key, matchesKey } from "./core/keys.js";
import { type InteractiveTarget, MouseSelectionTracker, type SelectableRegion } from "./core/mouse-selection.js";
import { OverlayStack } from "./core/overlay.js";
import { MainScreenRenderer } from "./core/renderer.js";
import { ScrollController } from "./core/scroll-controller.js";
import { WidgetSlots } from "./core/slots.js";
import { ProcessTerminal } from "./core/terminal.js";
import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "./core/types.js";
import {
	C,
	copyToClipboardUnified,
	normalizeFrameLine,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
} from "./core/utils.js";
import { createExtensionUIContext, type UIHostContextPort } from "./extension-ui-context.js";

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
}

/** Immutable frame geometry shared by rendering, scrolling and hit zones. */
interface FrameLayout {
	width: number;
	height: number;
	hasGutter: boolean;
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
export interface PanelComponent extends Component {
	onClose?: () => void;
	onRequestRender?: () => void;
	onDispose?: () => void;
}

export class UIHost implements UIHostContextPort {
	readonly terminal: ProcessTerminal;
	readonly renderer: MainScreenRenderer;
	readonly focusManager: FocusManager;
	readonly overlayStack: OverlayStack;
	readonly widgetSlots: WidgetSlots;
	private readonly componentBoundary: ComponentBoundary;
	readonly registry: ExtensionRegistry;
	readonly ctxUI: ExtensionUIContext;

	readonly transcript: TranscriptContainer;
	private headerComponent?: Component;
	private footerComponent?: Component;

	readonly banner: BannerComponent;
	readonly inputLine: InputLine;
	readonly activityLine: ActivityLineComponent;
	readonly contextBar: ContextBarComponent;
	readonly timelineRail: TimelineRailComponent;
	readonly scrollbarGutter: ScrollbarGutterComponent;
	private gutterMode: "timeline" | "scrollbar" = "timeline";

	// 业务参数
	modelName?: string;
	private usedTokens?: number;
	private contextWindow?: number;
	private usageActual = false;
	private reasoningEffort?: ThinkingLevel;
	private thinkingLevels: readonly ThinkingLevel[] = ["off"];
	private cwd: string;
	private lastUsage?: RequestUsage;
	private contextSegments?: ContextSegments;
	/** 最近一次有效提示词快照，供对话流与 /prompt 查询共用。 */
	private promptSnapshot?: PromptContextCardData;

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
	private readonly workingContributions = new Map<string, { message: string; startedAt: number; sequence: number }>();
	private contributionSequence = 0;
	private providerRetryMessage?: string;

	private activeSuggestions: {
		type: "command" | "file";
		query: string;
		start: number;
		end: number;
		items: (CommandItem | FileItem)[];
		selectedIndex: number;
		loading: boolean;
	} | null = null;
	private suggestionGeneration = 0;

	private readonly statuses = new Map<string, { text: string; sequence: number }>();

	private activeModalId: string | null = null;
	private activeModalHandle: OverlayHandle | null = null;

	private mouseTracker = new MouseSelectionTracker();
	private lastRenderedRows: string[] = [];
	private lastPermanentLines: string[] = [];
	/** 视口滚动状态与策略（offset/maxScroll/轮次邻居/自动滚屏）唯一属主。 */
	readonly scroll = new ScrollController();
	/** 视口离底指示器是否被 hover（驱动加粗高亮） */
	private viewportStatusHovered = false;
	/** 视口离底指示器纯文本（syncInputMetrics 单点计算，热区注册复用，防两处口径漂移）。 */
	private viewportStatusText = "";
	/** Geometry of the most recently rendered frame; reused by scroll/anchor paths. */
	private lastLayout: FrameLayout | null = null;
	private copyToastText = "";
	private copyToastTimer: NodeJS.Timeout | null = null;
	private notificationToast: {
		message: string;
		type: "info" | "warning" | "error";
		timer?: NodeJS.Timeout;
	} | null = null;

	startAutoScroll(direction: "up" | "down"): void {
		this.scroll.startAutoScroll(direction, () => {
			const layout = this.layoutFrame();
			this.lastLayout = layout;
			this.scroll.syncFromLayout(layout.effScroll, layout.maxScroll);
			this.mouseTracker.setScrollContext(layout.scrollStart);
			this.mouseTracker.updateFocusForScroll(layout.scrollStart);
			this.requestRender();
		});
	}

	stopAutoScroll(): void {
		this.scroll.stopAutoScroll();
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
	onInteraction?: () => void;
	onCancel?: (source?: "escape" | "ctrl+c") => void;
	onInterruptAndDeliver?: (text: string) => void;
	onPullBackQueue?: () => void;
	onThinkingLevelCycle?: () => void;

	private readonly features = new Map<keyof BuiltinUIActions, (action: BuiltinUIActionRequest) => void>();

	registerFeature<Name extends keyof BuiltinUIActions>(
		name: Name,
		handler: (action: Extract<BuiltinUIActionRequest, { name: Name }>) => void,
	): () => void {
		const wrapped = handler as (action: BuiltinUIActionRequest) => void;
		this.features.set(name, wrapped);
		return () => {
			if (this.features.get(name) === wrapped) this.features.delete(name);
		};
	}

	openFeature(action: BuiltinUIActionRequest): boolean {
		const handler = this.features.get(action.name);
		if (!handler) return false;
		if (!action.signal?.aborted) handler(action);
		return true;
	}

	openGutter(argument?: string): boolean {
		const action = resolveGutterAction(argument, this.gutterMode);
		this.setGutterMode(action.mode);
		if (action.style) this.setScrollbarThumbStyle(action.style);
		this.notify(action.message);
		return true;
	}

	registerMessageRenderer: TerminalUIContext["registerMessageRenderer"] = (type, renderer, options) =>
		this.registry.registerMessageRenderer(type, renderer, options);

	registerToolRenderer: TerminalUIContext["registerToolRenderer"] = (name, renderer, options) =>
		this.registry.registerToolRenderer(name, renderer, options);

	registerMarkdownTransformer: TerminalUIContext["registerMarkdownTransformer"] = (name, transformer, options) =>
		this.registry.registerMarkdownTransformer(name, transformer, options);

	private pendingQueue = new PendingQueueComponent();

	private dispatchRegisteredKeybinding(data: string): boolean {
		const command = this.registry
			.listCommands()
			.find((item) => item.keybinding && item.handler && matchesKey(data, item.keybinding));
		if (!command?.handler) return false;
		void Promise.resolve(command.handler("")).catch((error: unknown) => {
			this.notify(`命令错误: ${String(error)}`, "error");
		});
		return true;
	}

	private isMatchingModalKeybinding(modalId: string, data: string): boolean {
		const command = this.registry.getCommand(modalId);
		return Boolean(command?.keybinding && matchesKey(data, command.keybinding));
	}

	setPendingQueue(items: readonly PendingQueueItem[]): void {
		this.pendingQueue.setItems(items);
		this.requestRender();
	}

	cancelTurn(source: "escape" | "ctrl+c" = "escape"): void {
		// UI 只发送取消意图；Subject/Host 才是活动事实所有者。压缩 runActivity
		// 期间 UI busy 可能仍为 false，不能在这里用本地状态短路。
		try {
			this.onCancel?.(source);
		} catch {
			// ignore
		}
		this.requestRender();
	}

	/**
	 * Escape 语义单点（自外向内逐层退出）：非捕获浮层 > 联想卡片 > 工作态取消回合
	 * （草稿保留，tests/ui.test.ts 钉住的契约）> 选区 > 草稿 > 空闲取消。
	 * 捕获浮层在输入分发更早处按模态契约自有关闭，不进入本决策。
	 * 旧实现存在两套互相漂移的阶梯（handleTerminalInput 的 3.6 与 inputLine.onEscape），
	 * 本方法按各自已钉住的行为收敛，恒消费事件。
	 */
	private handleEscapeKey(): void {
		if (this.overlayStack.hasVisible) {
			this.overlayStack.hideTopOverlay();
		} else if (this.activeSuggestions) {
			this.clearSuggestions();
		} else if (this.busy) {
			this.cancelTurn("escape");
		} else if (this.inputLine.hasSelection()) {
			this.inputLine.clearSelection();
		} else if (this.inputLine.hasText()) {
			// 空闲态：有草稿先清草稿，而不是发送取消意图
			this.inputLine.clear();
		} else {
			this.cancelTurn("escape");
		}
		this.requestRender();
	}

	constructor(options: UIHostOptions = {}) {
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
		this.componentBoundary = new ComponentBoundary((component, operation, error) => {
			const name = component.constructor?.name || "TUI 组件";
			this.notify(`${name} ${operation === "render" ? "渲染" : "输入处理"}失败: ${String(error)}`, "error");
		});

		this.overlayStack = new OverlayStack(this.focusManager, () => this.requestRender(), this.componentBoundary);
		this.widgetSlots = new WidgetSlots(() => this.requestRender(), this.componentBoundary);
		this.registry = options.registry ?? new ExtensionRegistry();
		this.ctxUI = createExtensionUIContext(this);

		this.transcript = new TranscriptContainer();
		this.transcript.smoothReveal.setOnTick(() => this.updateHeartbeat());
		this.transcript.setRendererResolver({
			message: (type) => this.registry.getMessageRenderer(type),
			tool: (name) => this.registry.getToolRenderer(name),
			markdown: (text, context) => this.registry.transformMarkdown(text, context),
			componentRenderer: (component, width, height) => this.componentBoundary.render(component, width, height),
		});
		this.connectRegistry();

		this.banner = new BannerComponent({ cwd: this.cwd });

		this.inputLine = new InputLine();
		this.inputLine.onSubmitMode = (text, mode) => this.handleUserSubmitMode(text, mode);
		// Escape 不走 InputLine 回调：语义单点在 UIHost.handleEscapeKey，
		// handleTerminalInput 在焦点分发之前消费所有 Esc。
		this.inputLine.setCwd(this.cwd);
		this.inputLine.setReasoningEffort(this.reasoningEffort);

		this.activityLine = new ActivityLineComponent();
		this.contextBar = new ContextBarComponent();
		this.timelineRail = new TimelineRailComponent();
		this.scrollbarGutter = new ScrollbarGutterComponent();

		this.focusManager.setFocus(this.inputLine);
		this.syncContextComponents();
	}

	private connectRegistry(): void {
		this.stopRegistryUpdates ??= this.registry.onChange(() => {
			this.transcript.invalidate();
			this.requestRender();
		});
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
		this.workingContributions.clear();
		this.providerRetryMessage = undefined;
		this.stopAnimation();
		this.stopHeartbeat();
		if (this.notificationToast?.timer) {
			clearTimeout(this.notificationToast.timer);
			this.notificationToast = null;
		}
		if (this.copyToastTimer) {
			clearTimeout(this.copyToastTimer);
			this.copyToastTimer = null;
		}
		this.copyToastText = "";
		this.mouseTracker.clear();
		this.overlayStack.clear();
		this.clearSuggestions();
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
	setModel(model: string): void {
		this.modelName = model;
		this.syncContextComponents();
		this.requestRender();
	}

	setThinkingLevels(levels?: readonly ThinkingLevel[]): void {
		this.thinkingLevels = levels ? [...levels] : [];
		if (this.reasoningEffort && !this.thinkingLevels.includes(this.reasoningEffort)) this.setReasoningEffort(undefined);
	}

	setReasoningEffort(effort?: ThinkingLevel | string): void {
		if (!effort) {
			this.reasoningEffort = undefined;
			this.inputLine.setReasoningEffort(undefined);
			this.requestRender();
			return;
		}
		const lower = effort.toLowerCase().trim() as ThinkingLevel;
		if (!this.thinkingLevels.includes(lower)) throw new Error(`当前 Provider 不支持思考等级: ${effort}`);
		this.reasoningEffort = lower;
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.requestRender();
	}

	addCompaction(record: CompactionCardData): void {
		this.transcript.addCompaction(record);
		this.requestRender();
	}

	getReasoningEffort(): ThinkingLevel | undefined {
		return this.reasoningEffort;
	}

	getThinkingLevels(): readonly ThinkingLevel[] {
		return this.thinkingLevels;
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

	private syncContextComponents(): void {
		this.inputLine.setContextStats(
			this.modelName,
			this.usedTokens,
			this.contextWindow,
			this.usageActual,
			this.contextSegments,
		);
		this.inputLine.setCacheRate(
			formatCacheHitRate(this.lastUsage?.cacheRead, this.lastUsage?.promptTokens, this.lastUsage?.cacheWrite),
		);
		this.contextBar.update({
			usedTokens: this.usedTokens,
			contextWindow: this.contextWindow,
			cwd: this.cwd,
			cacheRead: this.lastUsage?.cacheRead,
			inputTokens: this.lastUsage?.promptTokens,
			cacheWrite: this.lastUsage?.cacheWrite,
			segments: this.contextSegments,
		});
	}

	setContext(snapshot: ContextSnapshot): void {
		this.usedTokens = snapshot.inputTokens;
		this.contextWindow = snapshot.contextWindow && snapshot.contextWindow > 0 ? snapshot.contextWindow : undefined;
		this.usageActual = snapshot.measurementKind === "exact";
		this.contextSegments = snapshot.segments;
		this.syncContextComponents();
		this.requestRender();
	}

	setRequestUsage(usage: RequestUsage): void {
		this.lastUsage = usage;
		this.syncContextComponents();
		this.requestRender();
	}

	markUsageEstimated(): void {
		this.usageActual = false;
		this.lastUsage = undefined;
		this.syncContextComponents();
		this.requestRender();
	}

	/** @param turnUid 轮次身份（来自 getTimelineTurns / 热区 id），不是显示用的 n。 */
	scrollToTurn(turnUid: number): void {
		// Uses the geometry the user actually clicked on (last frame), falling
		// back to a fresh layout when nothing has been rendered yet.
		const layout = this.lastLayout ?? this.layoutFrame();
		const lineOffset = this.transcript.getTurnStartLinesByUid(layout.transcriptContentW).get(turnUid);
		if (lineOffset === undefined) return;
		const targetScroll = layout.totalPerm - (layout.bannerCount + lineOffset) - layout.transcriptH;
		this.scroll.setOffset(Math.max(0, Math.min(layout.maxScroll, targetScroll)));
		this.requestRender();
	}

	scrollTurnUp(): void {
		const above = this.scroll.getTurnAbove();
		if (above !== null) {
			this.scrollToTurn(above);
		} else {
			this.scrollUp(5);
		}
	}

	scrollTurnDown(): void {
		const below = this.scroll.getTurnBelow();
		if (below !== null) {
			this.scrollToTurn(below);
		} else {
			this.scrollDown(5);
		}
	}

	replaceInput(text: string): void {
		this.clearSuggestions();
		this.inputLine.setText(text);
		this.requestRender();
	}

	loadHistory(messages: readonly import("../core/types.js").ChatMsg[]): void {
		this.transcript.loadHistory(messages);
		this.scroll.resetTail();
		this.requestRender();
	}

	loadSession(
		entries: readonly SessionEntry[],
		decorations: readonly CompactionReplayDecoration[] = [],
		promptSnapshots: readonly PromptSnapshotRecord[] = [],
	): void {
		const latest = promptSnapshots.at(-1);
		this.promptSnapshot = latest
			? {
					kind: "prompt",
					id: latest.id,
					turnNumber: latest.turnNumber,
					systemPrompt: latest.systemPrompt,
					injections: latest.injections,
				}
			: undefined;
		this.transcript.loadSession(entries, decorations, promptSnapshots);
		this.scroll.resetTail();
		this.requestRender();
	}

	/**
	 * 会话回溯重放：清空转录区、按 decorations 重建历史，并在引擎给出回溯轮号时
	 * 重开当前轮。此前这段序列由 InteractiveTUI 直接摸 transcript 内部手搓（且 clear
	 * 与 loadSession 内部清空重复），现收口为宿主公开入口。
	 */
	replayRewind(
		entries: readonly SessionEntry[],
		decorations: readonly CompactionReplayDecoration[] = [],
		turnNumber?: number,
		promptSnapshots: readonly PromptSnapshotRecord[] = [],
	): void {
		this.loadSession(entries, decorations, promptSnapshots);
		if (turnNumber !== undefined) {
			this.transcript.startTurn(turnNumber, "");
			this.activityLine.start("thinking", "正在思考与生成回复...");
		} else {
			this.activityLine.reset();
		}
		this.markUsageEstimated();
		this.requestRender();
	}

	// ── 回合生命周期门面 ──
	// InteractiveTUI 经这组粗粒度方法驱动转录区与活动行，不再直摸
	// transcript/activityLine 内部；每帧的状态变更与重绘请求在同一入口收口。

	/** turn_start：开新轮，活动行进入 thinking。 */
	startTurnCard(
		turnNumber: number,
		userText: string,
		images?: readonly import("../core/content.js").ImageContent[],
	): void {
		this.transcript.startTurn(turnNumber, userText, images);
		this.activityLine.start("thinking", "正在思考与生成回复...");
		this.requestRender();
	}

	/** thinking 增量：思考 token 也是生成，必须进活动行解码区间。 */
	appendThinkingStream(text: string): void {
		this.transcript.appendThinking(text);
		this.activityLine.addStreamText(text);
		this.activityLine.update("thinking", "正在深度推理 (Thinking)...");
		this.requestRender();
	}

	addPromptSnapshot(snapshot: PromptContextCardData): void {
		this.promptSnapshot = snapshot;
		this.transcript.addPromptSnapshot(snapshot);
		this.requestRender();
	}

	getPromptSnapshot(): PromptContextCardData | undefined {
		return this.promptSnapshot;
	}

	addExternalInput(input: ExternalContextCardData): void {
		this.transcript.addExternalInput(input);
		this.requestRender();
	}

	toggleContextCard(id?: string): boolean {
		const changed = this.transcript.toggleContextCard(id);
		if (changed) this.requestRender();
		return changed;
	}

	/** 扩展自定义消息（custom_message 事件）：display:false 由转录区守卫拦截。 */
	addCustomMessage(message: import("../extensions/ui-contract.js").CustomMessage): void {
		this.transcript.addCustomMessage(message);
		this.requestRender();
	}

	/** 正文增量。 */
	appendAssistantStream(text: string): void {
		this.transcript.appendToken(text);
		this.activityLine.addStreamText(text);
		this.activityLine.update("streaming", "正在输出回复...");
		this.requestRender();
	}

	/** usage_update 的服务端 output：活动行按 step 结算。 */
	addStreamedOutputTokens(tokens: number): void {
		this.activityLine.addRealOutputTokens(tokens);
	}

	/** tool_call：结算上一步解码区间，snap 后开运行中工具卡。 */
	beginToolCard(toolName: string, args?: unknown, callId?: string): void {
		this.activityLine.endStep();
		this.transcript.smoothReveal.snapToLatest();
		this.transcript.startTool(toolName, args, callId);
		this.activityLine.update("tool", `正在执行工具: ${toolName}`);
		this.requestRender();
	}

	/** tool_result：结算工具卡并提示继续生成。 */
	settleToolCard(
		toolName: string,
		result: string,
		elapsedMs: number,
		status: ToolResultStatus,
		callId?: string,
		args?: unknown,
		attachments?: { images?: import("../core/content.js").ImageContent[]; details?: unknown },
	): void {
		this.transcript.addToolDone(toolName, result, elapsedMs, status, callId, args, attachments);
		this.activityLine.update("streaming", `工具 ${toolName} 执行完毕，继续生成...`);
		this.requestRender();
	}

	/** turn_end：结算转录轮，活动行按"是否被打断"给收尾文案。 */
	finishTurnCard(): void {
		this.transcript.finishTurn();
		const history = this.transcript.getHistory();
		const lastTurn = history[history.length - 1];
		const isInterrupted = lastTurn?.items.some((it) => it.kind === "interrupt");
		const elapsed = this.getLastElapsedMs();
		this.activityLine.finish(isInterrupted ? "已打断当前轮次" : "本轮已完成", elapsed > 0 ? elapsed : undefined);
		this.requestRender();
	}

	/** turn_aborted：打断态收尾。 */
	interruptTurnCard(): void {
		this.transcript.interruptTurn(this.modelName);
		this.activityLine.finish("已打断当前轮次");
		this.requestRender();
	}

	/** error：错误卡 + 活动行复位。 */
	addErrorCard(text: string): void {
		this.transcript.addError(text);
		this.activityLine.reset();
		this.requestRender();
	}

	scrollUp(lines = 3): void {
		this.scroll.scrollUp(lines);
		this.requestRender();
	}

	scrollDown(lines = 3): void {
		this.scroll.scrollDown(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.scroll.scrollToTop();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.scroll.resetTail();
		this.requestRender();
	}

	getScrollOffset(): number {
		return this.scroll.getOffset();
	}

	/**
	 * 在执行可能改变历史行数的操作（展开/收起思考、展开/收起工具卡片、全局折叠）时，
	 * 精确保持当前屏幕上正在查看的内容（或用户交互的目标锚点）在视口中的屏幕行位置绝对不变。
	 */
	preserveScrollAnchor(action: () => void, targetAbsLine?: number): void {
		// "before" comes from the last rendered frame, so expanding a card costs
		// one layout (the incremental one) instead of two full ones.
		const before = this.lastLayout ?? this.layoutFrame();
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

		const after = this.layoutFrame();
		if (after.totalPerm <= after.transcriptH) {
			this.scroll.setOffset(0);
			return;
		}

		// 保持锚点行留在原屏幕行偏移位置
		const targetScrollStart = Math.max(0, Math.min(after.maxScroll, anchorLine - screenOffset));
		this.scroll.setOffset(
			Math.max(0, Math.min(after.maxScroll, after.totalPerm - after.transcriptH - targetScrollStart)),
		);
	}

	executeCommand(name: string, args: string): void {
		this.onUserLine?.(`/${name}${args ? ` ${args}` : ""}`, this.busy ? "followUp" : "direct");
	}

	private updateSuggestions(): void {
		const detection = this.inputLine.detectSuggestionQuery();
		if (!detection) {
			this.clearSuggestions();
			return;
		}
		const previous = this.activeSuggestions;
		if (
			detection.type === "file" &&
			previous?.type === "file" &&
			previous.query === detection.query &&
			previous.start === detection.start &&
			previous.end === detection.end
		) {
			return;
		}
		const generation = ++this.suggestionGeneration;

		if (detection.type === "command") {
			const query = detection.query.toLowerCase();
			const commands = this.registry.listCommands();
			const filtered = commands.filter(
				(c) => c.name.toLowerCase().includes(query) || c.description.toLowerCase().includes(query),
			);
			if (filtered.length > 0) {
				const prevSelected =
					previous?.type === "command" ? (previous.items[previous.selectedIndex] as CommandItem)?.name : undefined;
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
					loading: false,
				};
			} else {
				this.activeSuggestions = null;
			}
		} else if (detection.type === "file") {
			this.activeSuggestions = {
				type: "file",
				query: detection.query,
				start: detection.start,
				end: detection.end,
				items: [],
				selectedIndex: 0,
				loading: true,
			};
			const isCurrentFileQuery = (): boolean => {
				const current = this.inputLine.detectSuggestionQuery();
				return (
					current?.type === "file" &&
					current.query === detection.query &&
					current.start === detection.start &&
					current.end === detection.end
				);
			};
			void searchFileCandidates(this.cwd, detection.query, 40).then(
				(candidates) => {
					if (generation !== this.suggestionGeneration) return;
					if (!isCurrentFileQuery()) {
						this.clearSuggestions();
						this.requestRender();
						return;
					}
					this.activeSuggestions =
						candidates.length > 0
							? {
									type: "file",
									query: detection.query,
									start: detection.start,
									end: detection.end,
									items: candidates,
									selectedIndex: 0,
									loading: false,
								}
							: null;
					this.requestRender();
				},
				(error: unknown) => {
					if (generation !== this.suggestionGeneration) return;
					if (!isCurrentFileQuery()) {
						this.clearSuggestions();
						this.requestRender();
						return;
					}
					this.activeSuggestions = null;
					this.requestRender();
					this.notify(`文件候选查询失败：${String(error)}`, "warning", 2500);
				},
			);
		}
	}

	private clearSuggestions(): void {
		this.suggestionGeneration++;
		this.activeSuggestions = null;
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
		if (text) this.statuses.set(key, { text, sequence: ++this.contributionSequence });
		else this.statuses.delete(key);
		this.requestRender();
	}

	setWorking(key: string, message: string | undefined): void {
		if (message === undefined) this.workingContributions.delete(key);
		else {
			const previous = this.workingContributions.get(key);
			this.workingContributions.set(key, {
				message,
				startedAt: previous?.startedAt ?? Date.now(),
				sequence: ++this.contributionSequence,
			});
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
		this.headerComponent = component;
		this.requestRender();
	}

	setFooter(component: Component | undefined): void {
		this.footerComponent = component;
		this.requestRender();
	}

	showOverlay(component: Component, options?: OverlayOptions, dispose?: () => void): OverlayHandle {
		return this.overlayStack.showOverlay(component, options, dispose);
	}

	pasteToEditor(text: string): void {
		this.clearSuggestions();
		this.inputLine.insertText(text);
		this.requestRender();
	}

	setEditorText(text: string): void {
		this.clearSuggestions();
		this.inputLine.setText(text);
		this.requestRender();
	}

	getEditorText(): string {
		return this.inputLine.getText();
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
	showPanel(
		id: string,
		build: (close: () => void, api: { hide: () => void }) => PanelComponent,
		signal?: AbortSignal,
	): void {
		if (signal?.aborted) return;
		this.toggleModal(id, (closeModalState) => {
			let handle: OverlayHandle | null = null;
			const onAbort = () => doClose();
			const doClose = () => {
				closeModalState();
				handle?.hide();
			};
			const panel = build(doClose, { hide: () => handle?.hide() });
			panel.onRequestRender = () => this.requestRender();
			const dispose = panel.onDispose;
			let disposed = false;
			const disposeOnce = () => {
				if (disposed) return;
				disposed = true;
				signal?.removeEventListener("abort", onAbort);
				dispose?.();
			};
			const userOnClose = panel.onClose;
			panel.onClose = () => {
				userOnClose?.();
				doClose();
			};
			handle = this.overlayStack.showOverlay(panel, { anchor: "center" }, () => {
				disposeOnce();
				closeModalState();
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			return handle;
		});
	}

	// =========================================================================
	// 渲染管道与帧合成（Bottom-Pinned Frame Engine）
	// =========================================================================

	/** Sync the input line's transient metrics before it is rendered. */
	private syncInputMetrics(): void {
		const innerW = this.terminal.columns;
		const scrolled = this.scroll.getMaxScroll() > 0 && this.scroll.getOffset() > 0;
		const reservedRight = scrolled ? 36 : 10;
		const statusWidth = Math.max(24, innerW - reservedRight);
		const statusHeader = this.providerRetryMessage
			? formatWorkingHeader(
					this.providerRetryMessage,
					this.busy ? Math.max(0, Date.now() - this.turnStartTime) : 0,
					statusWidth,
				)
			: this.workingContributions.size === 0
				? this.activityLine.getHeaderString(statusWidth)
				: (() => {
						const working = [...this.workingContributions.values()].sort((a, b) => b.sequence - a.sequence)[0]!;
						return formatWorkingHeader(working.message, Date.now() - working.startedAt, statusWidth);
					})();
		// Show the viewport percentage using the previous frame's geometry; the
		// current frame's input height is required to compute it, so a one-frame
		// lag is unavoidable (and previously the header never rendered at all).
		const percent = scrolled
			? Math.round(
					((this.scroll.getMaxScroll() - Math.min(this.scroll.getOffset(), this.scroll.getMaxScroll())) /
						this.scroll.getMaxScroll()) *
						100,
				)
			: 100;
		// 视口离底指示器：品牌雾蓝（非告警语义），文案告知点击出口；hover 高亮由 viewport-status 热区分派
		const viewportStatusText = scrolled ? `[视口 ${percent}% · 点击回到最新]` : "";
		this.viewportStatusText = viewportStatusText;
		const viewportLabel = scrolled
			? `${this.viewportStatusHovered ? C.bold : ""}${C.claude}${viewportStatusText}${C.reset}`
			: "";
		this.inputLine.setStatusHeader(viewportLabel ? `${viewportLabel} ${statusHeader}` : statusHeader);
	}

	/**
	 * Single source of truth for frame geometry. Pure with respect to
	 * `scrollOffset`: it reports the clamped value instead of writing it, so
	 * rendering, scrollToTurn, preserveScrollAnchor and hit zones cannot drift.
	 */
	private computeLayout(reserveGutter: boolean): FrameLayout {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const innerW = width;

		// The input line keeps one safety column so the terminal never wraps it.
		const inputWidth = Math.max(2, innerW - 1);
		const inputLines = this.inputLine.render(innerW);
		const inputH = inputLines.length;

		const contextBarLines = this.contextBar.render(inputWidth);
		// The footer slot is a real frame region: extensions that call setFooter()
		// must see it, otherwise the API silently does nothing.
		const footerLines = this.footerComponent ? this.componentBoundary.render(this.footerComponent, inputWidth) : [];
		const belowLines = [...contextBarLines, ...this.widgetSlots.render("belowEditor", innerW), ...footerLines];
		const belowH = belowLines.length;

		const aboveEditorWidgets = this.widgetSlots.render("aboveEditor", innerW);
		const maxAboveH = Math.max(0, height - inputH - belowH - 1);
		const overlayLines = this.overlayStack.renderAbove(innerW, maxAboveH);

		let suggestionLines: string[] = [];
		if (
			this.activeSuggestions &&
			(this.activeSuggestions.items.length > 0 || this.activeSuggestions.loading) &&
			!this.overlayStack.hasVisible
		) {
			suggestionLines = formatSuggestionCardLines({
				type: this.activeSuggestions.type,
				title: this.activeSuggestions.type === "command" ? "命令" : "文件",
				query: this.activeSuggestions.query,
				columns: inputWidth,
				selectedIndex: this.activeSuggestions.selectedIndex,
				items: this.activeSuggestions.items,
				loading: this.activeSuggestions.loading,
				maxVisible: 5,
			});
		}

		const pendingLines =
			(!this.activeSuggestions || (this.activeSuggestions.items.length === 0 && !this.activeSuggestions.loading)) &&
			!this.overlayStack.hasVisible
				? this.pendingQueue.render(innerW)
				: [];

		// The stack is ordered top → editor-adjacent; when the budget is exceeded
		// keep the lines closest to the input box instead of the far ones.
		const aboveRaw = [...aboveEditorWidgets, ...overlayLines, ...suggestionLines, ...pendingLines];
		const aboveLines = aboveRaw.length > maxAboveH ? aboveRaw.slice(aboveRaw.length - maxAboveH) : aboveRaw;
		const aboveH = aboveLines.length;

		const breathingGap = 1;
		const transcriptH = Math.max(0, height - inputH - belowH - aboveH - breathingGap);
		const safeW = reserveGutter ? Math.max(20, innerW - 1) : innerW;
		const transcriptContentW = Math.max(18, reserveGutter ? safeW - 2 : innerW - 1);
		const bannerLines = this.componentBoundary.render(this.headerComponent ?? this.banner, transcriptContentW);
		// 帧内单一行模型：一次 ensureModel，行序列与四个热区索引全部同源（旧写法各取各的，assemble 重复 5 次）
		const frameModel = this.transcript.getFrameModel(transcriptContentW);
		const transcriptLines = frameModel.lines;
		const permanentLines = [...bannerLines, ...transcriptLines];
		const totalPerm = permanentLines.length;
		const maxScroll = Math.max(0, totalPerm - transcriptH);

		const effScroll = totalPerm <= transcriptH ? 0 : Math.max(0, Math.min(this.scroll.getOffset(), maxScroll));
		const scrollStart = totalPerm <= transcriptH ? 0 : totalPerm - transcriptH - effScroll;
		const visibleTranscript =
			totalPerm <= transcriptH
				? [...permanentLines, ...new Array(transcriptH - totalPerm).fill("")]
				: permanentLines.slice(scrollStart, scrollStart + transcriptH);

		return {
			width,
			height,
			hasGutter: reserveGutter && maxScroll > 0,
			innerW,
			inputWidth,
			inputLines,
			inputH,
			belowLines,
			belowH,
			maxAboveH,
			overlayLines,
			suggestionLines,
			pendingLines,
			aboveLines,
			aboveH,
			bannerLines,
			bannerCount: bannerLines.length,
			transcriptLines,
			permanentLines,
			totalPerm,
			safeW,
			transcriptContentW,
			transcriptH,
			maxScroll,
			effScroll,
			scrollStart,
			visibleTranscript,
			frameModel,
		};
	}

	private layoutFrame(): FrameLayout {
		const canNavigateTurns = this.transcript.getTimelineTurns().length > 1;
		let reserveGutter = this.gutterMode === "scrollbar" || canNavigateTurns;
		let layout = this.computeLayout(reserveGutter);
		if (layout.maxScroll === 0) {
			reserveGutter = false;
			layout = this.computeLayout(false);
		}
		const previousOffset = this.scroll.getOffset();
		this.scroll.markContent(layout.totalPerm, layout.transcriptH);
		return this.scroll.getOffset() === previousOffset ? layout : this.computeLayout(reserveGutter);
	}

	private renderCurrentFrame(): void {
		if (!this.running) return;
		this.syncInputMetrics();
		const layout = this.layoutFrame();
		this.lastLayout = layout;
		this.scroll.syncFromLayout(layout.effScroll, layout.maxScroll);
		const {
			width,
			height,
			inputWidth,
			inputLines,
			inputH,
			belowLines,
			belowH,
			aboveLines,
			aboveH,
			bannerCount,
			transcriptContentW,
			safeW,
			permanentLines,
			totalPerm,
			maxScroll,
			scrollStart,
			visibleTranscript,
			frameModel,
			suggestionLines,
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

		// 轮次邻居按 uid 定位（n 会撞号），写入滚动控制器供 rail 与翻轮入口消费。
		this.scroll.setTurnNeighbors(upTurnUid, downTurnUid);

		// 8. 组装整屏行数组（转录区 + 填充空白 + 提示条）
		let toastStr = "";
		if (this.copyToastText) {
			toastStr = `${C.suggestion}${this.copyToastText}${C.reset}`;
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
				gapLines.push(`${" ".repeat(pad)}${toastStr}`);
			} else {
				gapLines.push("");
			}
		}

		// 整个对话区域高度（从屏幕顶部到输入框顶部的全部可用垂直空间）
		const chatAreaH = visibleTranscript.length + gapLines.length;
		const allChatRows = [...visibleTranscript, ...gapLines];
		const atBottom = this.scroll.atBottom();

		// 跨屏选区提取用的是"用户看到的那一份行"，所以在这里就与屏幕对齐（制表符已展开）。
		this.lastPermanentLines = permanentLines.map((row) => normalizeFrameLine(row));
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

		if (!layout.hasGutter) {
			railGlyphs = [];
		} else if (this.gutterMode === "scrollbar") {
			const scrollRes = this.scrollbarGutter.renderGutterRows(chatAreaH, totalPerm, scrollStart);
			railGlyphs = scrollRes.gutterGlyphs;
			previewCard = scrollRes.hoverChip;
		} else {
			this.timelineRail.updateTurns(timelineTurns, activeTurnUid);
			const tlRes = this.timelineRail.renderRailRows(
				chatAreaH,
				atBottom,
				upTurnUid !== null,
				downTurnUid !== null,
				transcriptContentW,
			);
			railGlyphs = tlRes.railGlyphs;
			previewCard = tlRes.previewCard;
		}

		for (let r = 0; r < chatAreaH; r++) {
			const rawLine = allChatRows[r] ?? "";
			const baseLine = truncateToWidth(rawLine, transcriptContentW, " ");
			const pad = Math.max(0, transcriptContentW - visibleWidth(baseLine));
			const rail = layout.hasGutter ? (railGlyphs[r] ?? "  ") : "";
			// hover 中的工具卡行：底色延伸覆盖 rail 交界 2 列，否则卡片底色到
			// transcriptContentW 截止，交界处漏出 2 列默认背景（高亮空缺）。
			// 闲置刻度轨自带 SGR（▔/─/空格），其 reset 后重新注入 bg 保持连续。
			if (hoveredToolRowSet.has(r)) {
				const patchedRail = rail
					.replace(/\x1b\[0?m/g, `\x1b[0m${C.toolCardBackground}`)
					.replace(/\x1b\[49m/g, C.toolCardBackground);
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

		const fullScreenRows: string[] = [...allChatRows, ...aboveLines, ...inputLines, ...belowLines];

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

		addBlockTargets(
			frameModel.thinkingLocations.map((loc) => ({
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
			})),
		);

		addBlockTargets(
			frameModel.toolLocations.map((loc) => ({
				lineIndex: loc.lineIndex,
				rowCount: loc.lineCount - 1, // 卡片末行是底边框，不参与点击
				id: encodeHoverTarget({ kind: "tool", callId: loc.callId, line: bannerCount + loc.lineIndex }),
				onClick: () => {
					this.preserveScrollAnchor(() => {
						this.transcript.toggleTool(loc.item, transcriptContentW);
					}, bannerCount + loc.lineIndex);
					this.requestRender();
				},
			})),
		);

		addBlockTargets(
			frameModel.compactionLocations.map((loc) => ({
				lineIndex: loc.lineIndex,
				rowCount: loc.lineCount,
				id: encodeHoverTarget({ kind: "compaction", index: loc.index, line: bannerCount + loc.lineIndex }),
				onClick: () => {
					this.preserveScrollAnchor(() => {
						this.transcript.toggleCompaction(loc.index);
					}, bannerCount + loc.lineIndex);
					this.requestRender();
				},
			})),
		);

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
		if (layout.hasGutter && this.gutterMode === "scrollbar") {
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
							this.scroll.setOffset(targetOffset);
							this.requestRender();
						}
					},
				});
			}
		} else if (layout.hasGutter) {
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

		// (3.2) 注册联想浮层鼠标点击项
		if (this.activeSuggestions?.items.length && suggestionLines.length > 0 && !this.overlayStack.hasVisible) {
			const maxVisible = 5;
			const clampedIndex = Math.max(
				0,
				Math.min(this.activeSuggestions.selectedIndex, this.activeSuggestions.items.length - 1),
			);
			const startIndex = Math.max(
				0,
				Math.min(clampedIndex - Math.floor(maxVisible / 2), this.activeSuggestions.items.length - maxVisible),
			);
			const visibleCount = Math.min(maxVisible, this.activeSuggestions.items.length - startIndex);
			const suggStartRow = inputStartRow - suggestionLines.length;

			for (let i = 0; i < visibleCount; i++) {
				const itemIdx = startIndex + i;
				interactiveTargets.push({
					id: `suggestion-item-${itemIdx}`,
					row: suggStartRow + 1 + i,
					colStart: 0,
					colEnd: inputWidth - 1,
					onClick: () => {
						if (this.activeSuggestions) {
							this.activeSuggestions.selectedIndex = itemIdx;
							this.applyActiveSuggestion(false);
						}
					},
				});
			}
		}

		// (3.5) 视口离底指示器热区：仅离底时存在（顶部边框行），点击回底，hover 高亮。
		// 标签文本由 syncInputMetrics 单点计算，这里只复用，不再重复推导百分比。
		if (this.viewportStatusText) {
			interactiveTargets.push({
				id: encodeHoverTarget({ kind: "viewport-status" }),
				row: inputStartRow,
				colStart: 0,
				colEnd: Math.max(0, visibleWidth(this.viewportStatusText) + 3),
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
							const textIndex = this.inputLine.hitTest(r - 1, Math.max(0, col - 2));
							if (textIndex !== undefined) this.inputLine.setCursorIndex(textIndex);
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
			this.workingContributions.size > 0 ||
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
					this.workingContributions.size === 0 &&
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
		// 1.5 鼠标 SGR 与 X10 协议拦截（滚轮视口滚动、划词选区与交互热区）：
		// 消费完返回 null，否则返回剥除鼠标序列后待继续分发的剩余字节。
		const rest = this.dispatchMouseInput(data);
		if (rest === null) return;
		data = rest;

		// 2. 捕获浮层持有应用输入（Ctrl+C 安全处理仍在其后可用）
		if (this.dispatchCapturingOverlay(data)) return;

		// 3. 全局快捷键（非鼠标交互先停自动滚屏）
		if (this.dispatchGlobalShortcut(data)) return;
		if (this.dispatchRevealKey(data)) return;
		if (this.dispatchSuggestionsNav(data)) return;

		// 3.6 Esc 阶梯：语义单点（浮层 > 联想 > 选区 > 草稿 > 取消回合），恒消费
		if (matchesKey(data, Key.escape)) {
			this.handleEscapeKey();
			return;
		}

		// 4. 输入框严格未输入任何字符时敲 '?' 唤起帮助；若前面有空格则作为普通字符输入
		if (data === "?" && this.inputLine.getText() === "" && !this.overlayStack.hasVisible) {
			if (!this.dispatchRegisteredKeybinding("?")) this.openFeature({ name: "help" });
			return;
		}

		// 4.1/4.2 滚轮与键盘视口滚动
		if (this.dispatchScrollKeys(data)) return;

		// 5. 焦点组件输入处理
		const focused = this.focusManager.getFocused();
		if (focused?.handleInput) {
			this.componentBoundary.handleInput(focused, data);
			this.updateSuggestions();
			this.requestRender();
		}
	}

	/** SGR/X10 鼠标事件：返回 null 表示输入已被完全消费，否则返回剥除鼠标序列后的剩余字节。 */
	private dispatchMouseInput(data: string): string | null {
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
					} else if (res.dragEdge === null && this.scroll.isAutoScrolling()) {
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
				return null;
			}
			return data;
		}
		return data;
	}

	/**
	 * 捕获浮层在全局快捷键之前持有应用输入；Ctrl+C/Ctrl+C 安全处理仍在其后可用，
	 * 功能快捷键绝不能绕过模态的捕获契约。返回 true 表示输入已被消费。
	 */
	private dispatchCapturingOverlay(data: string): boolean {
		if (!matchesKey(data, Key.ctrl("c"))) this.onInteraction?.();
		const capturingOverlay = this.overlayStack.topCapturing;
		if (capturingOverlay) {
			if (this.activeModalId && this.isMatchingModalKeybinding(this.activeModalId, data)) {
				this.closeModal();
				this.requestRender();
				return true;
			}
			if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
				if (this.activeModalHandle) {
					this.closeModal();
				} else {
					this.overlayStack.hideTopOverlay();
				}
				this.requestRender();
				return true;
			}
			if (capturingOverlay.component.handleInput) {
				this.componentBoundary.handleInput(capturingOverlay.component, data);
				return true;
			}
		}
		return false;
	}

	/** 全局快捷键：注册键位、思考档位、Ctrl+C 阶梯与队列拉回。返回 true 表示已消费。 */
	private dispatchGlobalShortcut(data: string): boolean {
		// 非鼠标交互立即停止自动滚屏
		this.stopAutoScroll();
		if (this.dispatchRegisteredKeybinding(data)) return true;
		if (matchesKey(data, Key.ctrl("l"))) {
			if (this.contextBar.toggleExpanded()) this.requestRender();
			return true;
		}
		if (data === "\x1b[Z" || matchesKey(data, Key.shiftTab)) {
			this.onThinkingLevelCycle?.();
			return true;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			// 输入框编辑语义优先；但取消/退出事实由组合根查询 Host，不能读 UI busy。
			if (this.inputLine.hasSelection()) {
				this.inputLine.copySelection();
				this.inputLine.clearSelection();
				this.notify("已复制输入框内容", "info", 1500);
				this.requestRender();
				return true;
			}
			if (this.inputLine.hasText()) {
				this.clearSuggestions();
				this.inputLine.clear();
				this.requestRender();
				return true;
			}
			this.cancelTurn("ctrl+c");
			return true;
		}

		if (
			matchesKey(data, Key.altUp) ||
			matchesKey(data, Key.alt("up")) ||
			matchesKey(data, Key.alt("q")) ||
			matchesKey(data, Key.alt("Q"))
		) {
			this.onPullBackQueue?.();
			return true;
		}
		return false;
	}

	/** ctrl+o / alt+o 展开键：粘贴芯片 > hover 工具卡 > hover 压缩卡 > 最近思考块，逐层回退。返回 true 表示已消费。 */
	private dispatchRevealKey(data: string): boolean {
		if (matchesKey(data, Key.ctrl("o")) || matchesKey(data, Key.ctrl("O"))) {
			// 优先展开光标处的粘贴标记
			if (this.inputLine.hasChipAtCursor()) {
				this.inputLine.handleInput(data);
				this.requestRender();
				return true;
			}
			const layout = this.lastLayout ?? this.layoutFrame();
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
				return true;
			}

			// 如果当前悬停在会话压缩卡片上，单卡展开优先
			const hoveredCompactionIndex = this.transcript.getHoveredCompaction();
			if (hoveredCompactionIndex !== null) {
				const compactionLoc = this.transcript
					.getCompactionLineIndices(transcriptContentW)
					.find((l) => l.index === hoveredCompactionIndex);
				const targetAbsLine = compactionLoc ? bannerCount + compactionLoc.lineIndex : undefined;
				this.preserveScrollAnchor(() => {
					this.transcript.toggleCompaction(hoveredCompactionIndex);
				}, targetAbsLine);
				this.requestRender();
				return true;
			}

			const thinkingLocs = this.transcript.getThinkingLineIndices(transcriptContentW);
			const targetThinkingLoc = thinkingLocs.length > 0 ? thinkingLocs[thinkingLocs.length - 1] : undefined;
			const targetAbsLine = targetThinkingLoc ? bannerCount + targetThinkingLoc.lineIndex : undefined;

			this.preserveScrollAnchor(() => {
				const result = this.transcript.toggleThinking(undefined, transcriptContentW);
				if (!result.toggled) {
					const toolRes = this.transcript.toggleTool(undefined, transcriptContentW);
					if (!toolRes.toggled && !this.transcript.toggleContextCard()) {
						this.transcript.toggleCompaction();
					}
				}
			}, targetAbsLine);
			this.requestRender();
			return true;
		}

		if (matchesKey(data, Key.alt("o")) || matchesKey(data, Key.alt("O"))) {
			this.preserveScrollAnchor(() => {
				this.transcript.toggleAllThinking();
				this.transcript.toggleAllTools();
			});
			this.requestRender();
			return true;
		}
		return false;
	}

	/** 联想卡片键鼠交互（/ 命令或 @ 文件导航与自动补全）。返回 true 表示已消费。 */
	private dispatchSuggestionsNav(data: string): boolean {
		if (this.activeSuggestions?.loading && !this.busy && matchesKey(data, Key.tab)) return true;
		if (this.activeSuggestions && this.activeSuggestions.items.length > 0) {
			if (matchesKey(data, Key.up)) {
				this.activeSuggestions.selectedIndex = Math.max(0, this.activeSuggestions.selectedIndex - 1);
				this.requestRender();
				return true;
			}
			if (matchesKey(data, Key.down)) {
				this.activeSuggestions.selectedIndex = Math.min(
					this.activeSuggestions.items.length - 1,
					this.activeSuggestions.selectedIndex + 1,
				);
				this.requestRender();
				return true;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
				const isTab = matchesKey(data, Key.tab);
				this.applyActiveSuggestion(isTab);
				return true;
			}
		}
		return false;
	}

	/** 滚轮（X10）与键盘视口滚动（PageUp/PageDown、修饰方向键、Home/End 变体）。返回 true 表示已消费。 */
	private dispatchScrollKeys(data: string): boolean {
		// X10 鼠标滚轮（SGR 协议已在 dispatchMouseInput 拦截处理，这里只剩 \x1b[M 编码）
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
				return true;
			} else if (delta < 0) {
				this.scrollDown(-delta);
				return true;
			}
		}
		if (matchesKey(data, Key.pageup) || data === "\x1b[5~") {
			this.scrollUp(Math.max(1, Math.floor(this.terminal.rows / 2)));
			return true;
		}
		if (matchesKey(data, Key.pagedown) || data === "\x1b[6~") {
			this.scrollDown(Math.max(1, Math.floor(this.terminal.rows / 2)));
			return true;
		}
		if (data === "\x1b[1;2A" || data === "\x1b[1;5A" || data === "\x1b[1;3A") {
			this.scrollUp(3);
			return true;
		}
		if (data === "\x1b[1;2B" || data === "\x1b[1;5B" || data === "\x1b[1;3B") {
			this.scrollDown(3);
			return true;
		}
		if (data === "\x1b[5;2~" || data === "\x1b[1;5H" || data === "\x1b[1;2H") {
			this.scrollToTop();
			return true;
		}
		if (data === "\x1b[6;2~" || data === "\x1b[1;5F" || data === "\x1b[1;2F") {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	private applyActiveSuggestion(isTab: boolean): void {
		if (!this.activeSuggestions) return;
		const selected = this.activeSuggestions.items[this.activeSuggestions.selectedIndex];
		if (!selected) return;

		if (this.activeSuggestions.type === "command") {
			const cmd = selected as CommandItem;
			if (isTab || cmd.hasArgs) {
				this.inputLine.setText(`/${cmd.name} `);
				this.clearSuggestions();
				this.requestRender();
			} else {
				this.inputLine.clear();
				this.clearSuggestions();
				this.executeCommand(cmd.name, "");
				this.requestRender();
			}
		} else {
			const file = selected as FileItem;
			const isDir = file.kind === "directory";
			const escapedPath = /\s/.test(file.path) ? `"${file.path}"` : file.path;
			const replacement = isDir ? `@${escapedPath}` : `@${escapedPath} `;

			this.inputLine.replaceRange(this.activeSuggestions.start, this.activeSuggestions.end, replacement);

			if (isDir) {
				this.updateSuggestions();
			} else {
				this.clearSuggestions();
			}
			this.requestRender();
		}
	}

	private handleUserSubmitMode(text: string, mode: "direct" | "steer" | "followUp" | "interrupt"): void {
		// 不强制回底：视口主权归用户。在底部时 bottom-pinned 引擎自动跟随新内容；
		// 在历史位置时 computeLayout 的锚定机制保持视口绝对行号不变。
		this.clearSuggestions();
		this.inputLine.clear();

		if (mode === "interrupt") {
			if (this.busy) {
				this.transcript.interruptTurn(this.modelName);
				this.activityLine.update("idle", "已打断当前轮次");
				this.requestRender();
				this.onInterruptAndDeliver?.(text);
			} else if (text.trim()) {
				this.onUserLine?.(text, "direct");
			} else {
				// 空输入的 Ctrl+Enter：投递持有队列（"插队"提示语义）；队列空时上层天然 no-op。
				this.onInterruptAndDeliver?.(text);
			}
			return;
		}

		this.onUserLine?.(text, mode);
	}
}
