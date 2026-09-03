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
import type { ThinkingLevel } from "../core/types.js";
import { C } from "./core/utils.js";
import { InputLine } from "./components/editor/input-line.js";
import { BannerComponent } from "./components/primitives/banner.js";
import { TranscriptContainer } from "./components/transcript/transcript.js";
import { ActivityLineComponent } from "./components/widgets/activity-line.js";
import { HelpMenu } from "./components/overlays/help-menu.js";
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

export interface UIHostOptions {
	terminal?: ProcessTerminal;
	cwd?: string;
	modelName?: string;
	thinkingLevels?: readonly ThinkingLevel[];
	toolCount?: number;
	registry?: ExtensionRegistry;
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
	private reasoningEffort: ThinkingLevel = "medium";
	private thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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


	// 事件回调
	onUserLine?: (text: string, mode: "steer" | "followUp" | "direct") => void;
	onInterrupt?: () => void;

	constructor(options: UIHostOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		if (options.modelName) this.modelName = options.modelName;
		if (options.thinkingLevels?.length) this.thinkingLevels = [...options.thinkingLevels];

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
		this.transcript.setRendererResolver({
			message: (type) => this.registry.getMessageRenderer(type),
			entry: (type) => this.registry.getEntryRenderer(type),
		});
		this.editorContainer = new Container();
		this.footerContainer = new Container();

		this.banner = new BannerComponent({
			modelName: this.modelName,
			toolCount: options.toolCount ?? 6,
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
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.editorContainer.addChild(this.inputLine);

		this.activityLine = new ActivityLineComponent();

		this.rootContainer.addChild(this.headerContainer);
		this.rootContainer.addChild(this.transcript);
		this.rootContainer.addChild(this.editorContainer);
		this.rootContainer.addChild(this.footerContainer);

		this.focusManager.setFocus(this.inputLine);
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
	}

	setThinkingLevels(levels: readonly ThinkingLevel[]): void {
		this.thinkingLevels = levels.length ? [...levels] : ["off"];
		if (!this.thinkingLevels.includes(this.reasoningEffort)) this.reasoningEffort = "off";
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

	getReasoningEffort(): ThinkingLevel {
		return this.reasoningEffort;
	}

	cycleReasoningEffort(): void {
		const tiers = this.thinkingLevels;
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

	loadHistory(messages: readonly import("../core/types.js").ChatMsg[]): void {
		this.transcript.loadHistory(messages);
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

	openHelpMenu(): void {
		const menu = new HelpMenu(this.registry.listCommands());
		let handle: OverlayHandle | null = null;
		menu.onClose = () => {
			handle?.hide();
		};
		handle = this.overlayStack.showOverlay(menu);
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

		// 4. 渲染 OverlayAbove 浮层（叠加于输入框正上方）与 SuggestionCard 联想卡片
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
			this.scrollOffset = 0;
		} else {
			const maxScroll = totalPerm - transcriptH;
			const effScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			this.scrollOffset = effScroll;
			const start = totalPerm - transcriptH - effScroll;
			visibleTranscript = permanentLines.slice(start, start + transcriptH);

			if (effScroll > 0) {
				const percent = maxScroll > 0 ? Math.round(((maxScroll - effScroll) / maxScroll) * 100) : 100;
				this.inputLine.setStatusHeader(`${C.yellow}[📜 视口 ${percent}% (PageDn到底)]${C.reset} ${statusHeader}`);
			}
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
			} catch (error) { this.notify(`终端输入监听器失败: ${String(error)}`, "error"); }
		}

		// 2. 全局快捷键拦截
		if (data === "\x1b[Z") {
			// Shift+Tab：循环切换思考强度
			this.executeCommand("effort", "");
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			this.onInterrupt?.();
			return;
		}

		if (matchesKey(data, Key.alt("a")) || matchesKey(data, Key.alt("A"))) {
			this.executeCommand("subagents", "");
			return;
		}

		if (matchesKey(data, Key.alt("j")) || matchesKey(data, Key.alt("J"))) {
			this.executeCommand("tasks", "");
			return;
		}

		if (matchesKey(data, Key.alt("t")) || matchesKey(data, Key.alt("T"))) {
			this.executeCommand("trajectory", "");
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
			this.executeCommand("help", "");
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
