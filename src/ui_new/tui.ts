/**
 * UinaTUI 控制器门面（以 dsh-TUI 为视觉面子，以 pi-tui 为架构里子）。
 * 统一调度：差量渲染引擎、一体化圆角容器输入盒、细线工具卡片、流光状态行与流式 Markdown。
 * 核心机制：
 * 1. 结构化会话回放：内存记录历史 Turn，窗口尺寸缩放时全量以最新列宽自然回流（动态适配宽度，绝不再被锁死为两行）；
 * 2. 窗口 Resize 原子清屏重排：通过 fullRedraw 彻底消除 Windows Terminal 折行导致的边框断片与幽灵重影；
 * 3. 硬件光标锁死与物理 Shift+Enter 原生多行换行保护。
 */

import { ProcessTerminal } from "./core/terminal.js";
import { MainScreenRenderer } from "./core/renderer.js";
import { InputLine } from "./editor/input-line.js";
import { ActivityLineComponent } from "./components/activity-line.js";
import { ThinkingViewComponent, formatThinkingLines } from "./components/thinking-view.js";
import { ActiveToolComponent, formatToolCardLines } from "./components/tool-view.js";
import { StreamMarkdownFormatter, formatFullMarkdown } from "./components/stream-markdown.js";
import { formatUnifiedDiffCardLines } from "./components/diff-view.js";
import { formatCompactionCardLines, type CompactionRecord } from "./components/compact-view.js";
import {
	formatSuggestionCardLines,
	getFileCandidates,
	type CommandItem,
	type FileItem,
} from "./components/suggestions.js";
import { ModelPicker } from "./components/model-picker.js";
import { EffortSlider } from "./components/effort-slider.js";
import { HelpMenu } from "./components/help-menu.js";
import { SubagentActivityStore, SubagentDashboard, type SubagentState } from "./components/subagent-dashboard.js";
import { SubagentDetailScene } from "./components/subagent-detail-scene.js";
import { BackgroundTaskRegistry, TaskDashboard } from "./components/task-dashboard.js";
import { TrajectoryStore, TrajectoryScene } from "./components/trajectory-scene.js";
import { getStartupBanner } from "./components/banner.js";
import { C, wrapTextWithAnsi } from "./core/utils.js";
import { Key, matchesKey, parseMouseEvent } from "./core/keys.js";
import type { Component, UinaUIMsg } from "./core/types.js";

export interface UinaTUIOptions {
	modelName?: string;
	toolCount?: number;
	cwd?: string;
}

export interface LocalCommand {
	name: string;
	description: string;
	tag?: string;
	hasArgs?: boolean;
	handler?: (args: string) => void | Promise<void>;
}

export interface TurnRecord {
	n: number;
	userText: string;
	assistantMarkdown: string;
	thinkingText?: string;
	thinkingCollapsed?: boolean;
	tools: Array<{ name: string; result: string; elapsedMs: number }>;
	diffs?: Array<{ oldText: string; newText: string; filename: string; collapsed?: boolean }>;
}

export class UinaTUI {
	private readonly terminal: ProcessTerminal;
	private readonly renderer: MainScreenRenderer;
	private readonly inputLine: InputLine;

	// 核心视觉挂件
	private readonly activityLine: ActivityLineComponent;
	private readonly thinkingView: ThinkingViewComponent;
	private readonly activeTool: ActiveToolComponent;
	private readonly markdown: StreamMarkdownFormatter;

	// 模型、Token 与工作区状态
	private modelName = "deepseek-chat";
	private usedTokens = 0;
	private contextWindow = 65536;
	private cwd = process.cwd();

	// 历史会话记录（用于窗口 Resize 时以新列宽全量高质量回流）
	private historyTurns: TurnRecord[] = [];
	private currentTurn: TurnRecord | null = null;
	private thinkingCommitted = false;

	// 鼠标命中区域映射与视口行数记录
	private thinkingBlockRanges: Array<{ startLine: number; endLine: number; turn: TurnRecord }> = [];
	private lastPermanentLineCount = 0;
	private lastActiveLineCount = 0;

	// 动画定时器（60ms 周期，仅在活跃期开启动态流光扫光，空闲时自动停帧零 CPU）
	private animTimer: NodeJS.Timeout | null = null;
	private running = false;
	private busy = false;
	private isFirstResponseLine = true;

	// 实时生成速度与 TPS 统计
	private turnStartTime = 0;
	private streamTokenCount = 0;
	private lastTps = 0;
	private lastElapsedMs = 0;

	// 自定义小部件插槽 (aboveEditor)
	private customWidgets: Component[] = [];

	// 内置与外置注册斜杠命令
	private commands: LocalCommand[] = [
		{ name: "help", description: "查看所有可用命令与快捷键 (或空行敲 ?)", hasArgs: false },
		{ name: "model", description: "打开模型切换浮层 (或带参直接切换)", hasArgs: true },
		{ name: "effort", description: "调整模型思考强度 (Reasoning Effort)", hasArgs: true },
		{ name: "subagents", description: "多子智能体看板与详情审查 (或按 Alt+A)", hasArgs: false },
		{ name: "agents", description: "多子智能体看板与详情审查", hasArgs: false },
		{ name: "tasks", description: "后台作业与进程管理看板 (或按 Alt+J)", hasArgs: false },
		{ name: "jobs", description: "后台作业与进程管理看板", hasArgs: false },
		{ name: "trajectory", description: "全屏事件时序与性能热点剖析 (或按 Alt+T)", hasArgs: false },
		{ name: "traj", description: "全屏审计轨迹看板", hasArgs: false },
		{ name: "compact", description: "压缩当前会话历史并释放上下文 (∴)", hasArgs: true },
		{ name: "think", description: "展开或折叠指定轮次的深度思考", hasArgs: true },
		{ name: "diff", description: "展开或收起差异对比卡片", hasArgs: true },
		{ name: "clear", description: "清空当前会话屏幕与历史", hasArgs: false },
		{ name: "quit", description: "退出当前终端会话", hasArgs: false },
		{ name: "exit", description: "退出当前终端会话", hasArgs: false },
	];

	// 当前思考推理强度 (复刻 dsh-TUI 5 档位：off, low, medium, high, max)
	private reasoningEffort: "off" | "low" | "medium" | "high" | "max" = "medium";

	// 统一子智能体活动状态管理
	private subagentStore: SubagentActivityStore = new SubagentActivityStore();

	// 统一后台任务与长驻进程注册管理
	private taskRegistry: BackgroundTaskRegistry = new BackgroundTaskRegistry();

	// 全屏审计轨迹与性能时序状态管理
	private trajectoryStore: TrajectoryStore = new TrajectoryStore();

	// 激活的半模态浮层（/model 选模型、/effort 调思考、/subagents 看板、/tasks 任务看板、/trajectory 轨迹看板、? 帮助菜单）
	private activeModal:
		| { type: "modelPicker"; picker: ModelPicker }
		| { type: "effortSlider"; slider: EffortSlider }
		| { type: "helpMenu"; menu: HelpMenu }
		| { type: "subagentDashboard"; dashboard: SubagentDashboard }
		| { type: "subagentDetail"; detailScene: SubagentDetailScene }
		| { type: "taskDashboard"; dashboard: TaskDashboard }
		| { type: "trajectory"; scene: TrajectoryScene }
		| null = null;

	// 会话压缩检查点记录列表
	private compactions: CompactionRecord[] = [];
	private onCompactCallback?: (instruction?: string) => Promise<string | void> | string | void;

	// 当前激活的输入联想浮层（/ 命令或 @ 文件）
	private activeSuggestions: {
		type: "command" | "file";
		query: string;
		start: number;
		end: number;
		items: Array<CommandItem | FileItem>;
		selectedIndex: number;
	} | null = null;

	// 历史视口滚动与通知队列
	private scrollOffset = 0;
	private systemNotices: string[] = [];

	// 事件回调
	private userInputCallback?: (text: string) => void;
	private interruptCallback?: () => void;
	private resizeTimer: NodeJS.Timeout | null = null;

	constructor(private readonly options: UinaTUIOptions = {}) {
		if (options.modelName) this.modelName = options.modelName;
		if (options.cwd) this.cwd = options.cwd;

		this.terminal = new ProcessTerminal();
		this.renderer = new MainScreenRenderer(this.terminal);
		this.inputLine = new InputLine();
		this.inputLine.setCwd(this.cwd);

		this.activityLine = new ActivityLineComponent();
		this.thinkingView = new ThinkingViewComponent();
		this.activeTool = new ActiveToolComponent();
		this.markdown = new StreamMarkdownFormatter();

		this.setupInputHandling();
	}

	/** 注册自定义斜杠命令 */
	registerCommand(cmd: LocalCommand): void {
		const existing = this.commands.findIndex((c) => c.name === cmd.name);
		if (existing >= 0) {
			this.commands[existing] = cmd;
		} else {
			this.commands.push(cmd);
		}
	}

	/** 动态切换当前模型并同步刷新输入底栏 */
	setModel(model: string): void {
		this.modelName = model;
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.requestRender();
	}

	/** 设定模型思考推理强度 (复刻 dsh-TUI 规范：off | low | medium | high | max，兼容 none) */
	setReasoningEffort(effort: "off" | "low" | "medium" | "high" | "max" | "none" | string): void {
		const lower = effort.toLowerCase().trim();
		if (lower === "none" || lower === "off") this.reasoningEffort = "off";
		else if (lower === "low") this.reasoningEffort = "low";
		else if (lower === "medium") this.reasoningEffort = "medium";
		else if (lower === "high") this.reasoningEffort = "high";
		else if (lower === "max") this.reasoningEffort = "max";
		else this.reasoningEffort = "medium";

		this.inputLine.setReasoningEffort(this.reasoningEffort);
		this.requestRender();
	}

	getReasoningEffort(): "off" | "low" | "medium" | "high" | "max" {
		return this.reasoningEffort;
	}

	getReasoningEffortName(): string {
		const names: Record<string, string> = {
			off: "Off",
			low: "Low",
			medium: "Medium",
			high: "High",
			max: "Max",
		};
		return names[this.reasoningEffort] ?? "Medium";
	}

	/** 获取子智能体活动状态管理存储实例 */
	getSubagentStore(): SubagentActivityStore {
		return this.subagentStore;
	}

	/** 打开多子智能体一级总览看板 */
	openSubagents(): void {
		if (this.subagentStore.list().length === 0) {
			this.subagentStore.loadSampleData();
		}
		this.activeModal = {
			type: "subagentDashboard",
			dashboard: new SubagentDashboard(this.subagentStore),
		};
		this.requestRender();
	}

	/** 打开单个子智能体二级审查详情页 */
	openSubagentDetail(agent: SubagentState): void {
		this.activeModal = {
			type: "subagentDetail",
			detailScene: new SubagentDetailScene(agent, (id) => {
				this.subagentStore.interrupt(id);
				this.handleNotice(`已向子智能体 [${id}] 发送中断信号`);
				this.requestRender();
			}),
		};
		this.requestRender();
	}

	/** 获取后台任务与作业注册表实例 */
	getTaskRegistry(): BackgroundTaskRegistry {
		return this.taskRegistry;
	}

	/** 打开后台任务看板 (TaskDashboard) */
	openTasks(): void {
		if (this.taskRegistry.list().length === 0) {
			this.taskRegistry.loadSampleData();
		}
		this.activeModal = {
			type: "taskDashboard",
			dashboard: new TaskDashboard(this.taskRegistry),
		};
		this.requestRender();
	}

	/** 获取审计轨迹存储实例 */
	getTrajectoryStore(): TrajectoryStore {
		return this.trajectoryStore;
	}

	/** 打开全屏审计轨迹看板 (TrajectoryScene) */
	openTrajectory(): void {
		if (this.trajectoryStore.list().length === 0) {
			this.trajectoryStore.loadSampleData();
		}
		this.activeModal = {
			type: "trajectory",
			scene: new TrajectoryScene(this.trajectoryStore),
		};
		this.requestRender();
	}

	/** 注册外部会话压缩总结回调 */
	onCompact(fn: (instruction?: string) => Promise<string | void> | string | void): void {
		this.onCompactCallback = fn;
	}

	/**
	 * 执行会话压缩，将已完成的对话历史归档并生成紧凑摘要卡片 (∴)
	 */
	async compact(customSummary?: string, tokensSaved?: number): Promise<void> {
		// 若有正在进行中的活跃轮次（如 Agent 决定在当前轮次内压缩），先结算并沉淀当前轮次内容
		if (this.currentTurn) {
			const tailLines = this.markdown.flush();
			if (tailLines.length > 0) {
				const width = this.terminal.columns;
				const margin = this.getPageMargin(width);
				const formattedTail = tailLines.map((line) =>
					this.isFirstResponseLine ? `${margin}${C.green}${C.bold}● ${C.reset}${line}` : `${margin}  ${line}`,
				);
				this.isFirstResponseLine = false;
				this.renderer.appendPermanentLines(formattedTail);
			}
			this.historyTurns.push(this.currentTurn);
			this.currentTurn = null;
			this.busy = false;
		}

		if (this.historyTurns.length === 0) {
			this.handleNotice("当前没有可压缩的历史会话");
			return;
		}

		this.activityLine.update("compacting", "正在压缩会话历史...");
		this.requestRender();

		const turnCount = this.historyTurns.length;
		let summary = customSummary;

		if (!summary && this.onCompactCallback) {
			try {
				const res = await this.onCompactCallback();
				if (typeof res === "string" && res.trim()) {
					summary = res.trim();
				}
			} catch {
				// 降级使用内置生成逻辑
			}
		}

		if (!summary) {
			const bullets = this.historyTurns
				.map((t, idx) => {
					const u = t.userText.replace(/\s+/g, " ").trim();
					const snippet = u.length > 36 ? `${u.slice(0, 36)}…` : u;
					return `• 第 ${idx + 1} 轮: "${snippet}"`;
				})
				.join("\n");
			summary = `本次压缩归档了前 ${turnCount} 轮对话记录，释放了上下文配额：\n${bullets}`;
		}

		const saved = tokensSaved ?? Math.max(1200, Math.floor(this.usedTokens * 0.7));
		this.usedTokens = Math.max(800, this.usedTokens - saved);

		const record: CompactionRecord = {
			id: this.compactions.length + 1,
			summary,
			turnsCount: turnCount,
			tokensSaved: saved,
			collapsed: true,
			timestamp: Date.now(),
			afterTurnN: turnCount,
		};

		this.compactions.push(record);
		// 历史对话完整保留，由吸底全帧渲染器自动排入转录视口
		this.inputLine.setContextStats(this.modelName, this.usedTokens, this.contextWindow);
		this.activityLine.finish("会话压缩完成");
		this.requestRender();
	}

	/** 向对话历史流中追加一张 Unified Diff 差异对比卡片 */
	appendDiff(oldText: string, newText: string, filename: string): void {
		if (!this.currentTurn) {
			this.currentTurn = {
				n: this.historyTurns.length + 1,
				userText: "",
				assistantMarkdown: "",
				tools: [],
				diffs: [],
			};
		}
		if (!this.currentTurn.diffs) {
			this.currentTurn.diffs = [];
		}
		this.currentTurn.diffs.push({ oldText, newText, filename, collapsed: true });
		this.requestRender();
	}

	private setupInputHandling(): void {
		this.inputLine.onSubmit = (text) => {
			const trimmed = text.trim();
			if (trimmed.startsWith("/")) {
				const [cmdName, ...rest] = trimmed.slice(1).split(/\s+/);
				const args = rest.join(" ");
				this.executeCommand(cmdName || "", args);
				return;
			}
			this.userInputCallback?.(text);
		};

		this.inputLine.onInterrupt = () => {
			this.interruptCallback?.();
		};
	}

	/** 启动 TUI 界面 */
	start(): void {
		if (this.running) return;
		this.running = true;

		this.terminal.start((data) => {
			this.handleRawInput(data);
		}, () => {
			if (this.resizeTimer) clearTimeout(this.resizeTimer);
			this.resizeTimer = setTimeout(() => {
				this.handleResize();
			}, 30);
		});

		// 动态设置终端标签页/窗口标题（复刻现代 CLI 规范）
		try {
			process.stdout.write(`\x1b]0;Uina · ${this.cwd}\x07`);
		} catch {}

		// 触发首屏常驻吸底全帧渲染（包含 dsh 像素鲸鱼 Banner 与底部吸附输入框）
		this.renderCurrentFrame();
	}

	/** 停止 TUI 界面 */
	stop(): void {
		if (!this.running) return;
		this.stopAnimation();
		this.renderer.clearActiveArea();
		this.terminal.stop();
		this.running = false;
	}

	onUserInput(cb: (text: string) => void): void {
		this.userInputCallback = cb;
	}

	onInterrupt(cb: () => void): void {
		this.interruptCallback = cb;
	}

	registerWidget(widget: Component): void {
		this.customWidgets.push(widget);
		this.requestRender();
	}

	pauseInput(): void {
		this.renderer.clearActiveArea();
	}

	resumeInput(): void {
		this.requestRender();
	}

	private handleMouseClick(row: number, _col: number): boolean {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const margin = this.getPageMargin(width);
		const innerW = width - margin.length;
		const rawInput = this.inputLine.render(innerW);
		const inputH = rawInput.length;
		const rawAbove = this.getAboveEditorLines(innerW);
		const aboveH = rawAbove.length;
		const transcriptH = Math.max(1, height - inputH - aboveH);

		// 若点击发生在转录区内 (row 1 ~ transcriptH)
		if (row <= transcriptH) {
			const permanentLines = this.getAllPermanentLines(innerW);
			const totalPerm = permanentLines.length;
			const maxScroll = Math.max(0, totalPerm - transcriptH);
			const effScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			const startIndex = totalPerm <= transcriptH ? 0 : totalPerm - transcriptH - effScroll;
			const lineIndex = startIndex + (row - 1);

			if (lineIndex >= 0 && lineIndex < permanentLines.length) {
				for (const range of this.thinkingBlockRanges) {
					if (lineIndex >= range.startLine && lineIndex <= range.endLine) {
						range.turn.thinkingCollapsed = !(range.turn.thinkingCollapsed ?? true);
						this.requestRender();
						return true;
					}
				}
			}
		}

		// 若点击发生在浮层区 (例如 EffortSlider 滑条上：直接点选对应档位并实时生效)
		if (this.activeModal?.type === "effortSlider" && row > transcriptH && row <= transcriptH + aboveH) {
			const modalRow = row - (transcriptH + 1);
			if (modalRow === 2) {
				// 点击在拟态滑轨行：按 5 档等分列宽命中选档
				const clickCol = Math.max(0, _col - margin.length);
				const colPct = Math.min(0.99, Math.max(0, clickCol / innerW));
				const tierIndex = Math.min(4, Math.floor(colPct * 5));
				const tier = this.activeModal.slider.setFocusIndex(tierIndex);
				this.setReasoningEffort(tier.id);
				return true;
			}
		}

		// 若点击发生在子智能体看板、详情页、后台任务看板或全屏轨迹看板的顶边栏右侧区域 (✕)：关闭看板
		if (
			(this.activeModal?.type === "subagentDashboard" ||
				this.activeModal?.type === "subagentDetail" ||
				this.activeModal?.type === "taskDashboard" ||
				this.activeModal?.type === "trajectory") &&
			row > transcriptH &&
			row <= transcriptH + aboveH
		) {
			const modalRow = row - (transcriptH + 1);
			if (modalRow === 0) {
				if (this.activeModal.type === "subagentDetail") {
					// 详情页点 ✕ 返回一级看板
					this.activeModal = {
						type: "subagentDashboard",
						dashboard: new SubagentDashboard(this.subagentStore),
					};
				} else {
					this.activeModal = null;
				}
				this.requestRender();
				return true;
			}
		}

		return false;
	}

	private handleRawInput(data: string): void {
		// 0. 拦截 ANSI SGR 鼠标事件（\x1b[<...）
		if (data.startsWith("\x1b[<")) {
			const mouse = parseMouseEvent(data);
			if (mouse) {
				if (mouse.button === 64) {
					// 鼠标滚轮向上：向上翻看对话历史
					this.scrollOffset += 3;
					this.requestRender();
					return;
				}
				if (mouse.button === 65) {
					// 鼠标滚轮向下：向下查看最新对话
					this.scrollOffset = Math.max(0, this.scrollOffset - 3);
					this.requestRender();
					return;
				}
				if (mouse.isDown && mouse.button === 0) {
					if (this.handleMouseClick(mouse.row, mouse.col)) {
						return;
					}
				}
			}
			// 任何鼠标事件（释放、移动、其他键）严禁漏给 inputLine 造成误输入
			return;
		}

		// 0.05 键盘 PageUp / PageDown 翻看转录流
		if (matchesKey(data, Key.pageup)) {
			this.scrollOffset += 10;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pagedown)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
			this.requestRender();
			return;
		}

		// 0.1 Shift+Tab 快捷循环切换思考强度 (off -> low -> medium -> high -> max -> off)
		if (
			matchesKey(data, Key.shiftTab) ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "backtab")
		) {
			const cycle: Array<"off" | "low" | "medium" | "high" | "max"> = ["off", "low", "medium", "high", "max"];
			const curIdx = cycle.indexOf(this.reasoningEffort);
			const nextEffort = cycle[(curIdx + 1) % cycle.length]!;
			this.setReasoningEffort(nextEffort);
			if (nextEffort === "max") {
				this.handleNotice("推理强度 → Max ⚡ (已进入极限推演档)");
			}
			return;
		}

		// 0.2 如果处于半模态浮层（ModelPicker、EffortSlider、HelpMenu），独占键盘交互
		if (this.activeModal) {
			if (this.activeModal.type === "modelPicker") {
				const picker = this.activeModal.picker;
				if (matchesKey(data, Key.up)) {
					picker.navigateUp();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					picker.navigateDown();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const res = picker.confirm();
					if (res?.action === "picked") {
						this.setModel(res.modelId);
						this.systemNotices.push(`  ${C.green}✓ 模型已切换至: ${res.modelId}${C.reset}`);
						this.activeModal = null;
					}
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					const res = picker.back();
					if (res.action === "close") {
						this.activeModal = null;
					}
					this.requestRender();
					return;
				}
				return;
			}

			if (this.activeModal.type === "effortSlider") {
				const slider = this.activeModal.slider;
				if (matchesKey(data, Key.left)) {
					const tier = slider.navigateLeft();
					// Live-apply 即时生效哲学：滑移即控制
					this.setReasoningEffort(tier.id);
					return;
				}
				if (matchesKey(data, Key.right)) {
					const tier = slider.navigateRight();
					// Live-apply 即时生效哲学：滑移即控制
					this.setReasoningEffort(tier.id);
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
					const tier = slider.getCurrentTier();
					this.activeModal = null;
					this.handleNotice(`推理强度 → ${tier.name}`);
					this.requestRender();
					return;
				}
				return;
			}

			if (this.activeModal.type === "subagentDashboard") {
				const dashboard = this.activeModal.dashboard;
				if (matchesKey(data, Key.up)) {
					dashboard.navigateUp();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					dashboard.navigateDown();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const agent = dashboard.getFocusedAgent();
					if (agent) {
						this.openSubagentDetail(agent);
					}
					return;
				}
				if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
					this.activeModal = null;
					this.requestRender();
					return;
				}
				return;
			}

			if (this.activeModal.type === "subagentDetail") {
				const scene = this.activeModal.detailScene;
				if (matchesKey(data, Key.left)) {
					scene.turnPage(-1);
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.right)) {
					scene.turnPage(1);
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.up)) {
					scene.scrollUp();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					scene.scrollDown();
					this.requestRender();
					return;
				}
				if (data === "x" || data === "X") {
					scene.interrupt();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q" || data === "Q") {
					this.activeModal = {
						type: "subagentDashboard",
						dashboard: new SubagentDashboard(this.subagentStore),
					};
					this.requestRender();
					return;
				}
				return;
			}

			if (this.activeModal.type === "taskDashboard") {
				const dashboard = this.activeModal.dashboard;
				if (matchesKey(data, Key.tab)) {
					dashboard.togglePane();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					dashboard.toggleMaximize();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.up)) {
					dashboard.navigateUp();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					dashboard.navigateDown();
					this.requestRender();
					return;
				}
				if (data === "k" || data === "K") {
					void dashboard.killCurrent();
					this.requestRender();
					return;
				}
				if (data === "r" || data === "R") {
					void dashboard.restartCurrent();
					this.requestRender();
					return;
				}
				if (data === "c" || data === "C") {
					dashboard.clearSettled();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
					this.activeModal = null;
					this.requestRender();
					return;
				}
				return;
			}

			if (this.activeModal.type === "trajectory") {
				const scene = this.activeModal.scene;
				if (matchesKey(data, Key.up)) {
					scene.navigateUp();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					scene.navigateDown();
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.left)) {
					scene.turnView(-1);
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
					scene.turnView(1);
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					scene.toggleMaximize();
					this.requestRender();
					return;
				}
				if (data === "e") {
					const found = scene.seekError(true);
					if (!found) this.handleNotice("后续没有报错节点");
					this.requestRender();
					return;
				}
				if (data === "E") {
					const found = scene.seekError(false);
					if (!found) this.handleNotice("前文没有报错节点");
					this.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
					this.activeModal = null;
					this.requestRender();
					return;
				}
				return;
			}

			if (this.activeModal.type === "helpMenu") {
				this.activeModal = null;
				this.requestRender();
				if (!matchesKey(data, Key.escape) && !matchesKey(data, Key.enter) && data !== "?" && data !== "？") {
					this.inputLine.handleInput(data);
					this.updateSuggestions();
					this.requestRender();
				}
				return;
			}
		}

		// 0.25 Alt+A 快捷键：全局唤起或关闭多子智能体看板
		if (matchesKey(data, Key.alt("a"))) {
			if (this.activeModal?.type === "subagentDashboard" || this.activeModal?.type === "subagentDetail") {
				this.activeModal = null;
			} else {
				this.openSubagents();
			}
			this.requestRender();
			return;
		}

		// 0.26 Alt+J 快捷键：全局唤起或关闭后台任务看板 (TaskDashboard)
		if (matchesKey(data, Key.alt("j"))) {
			if (this.activeModal?.type === "taskDashboard") {
				this.activeModal = null;
			} else {
				this.openTasks();
			}
			this.requestRender();
			return;
		}

		// 0.27 Alt+T 快捷键：全局唤起或关闭全屏审计轨迹 (TrajectoryScene)
		if (matchesKey(data, Key.alt("t"))) {
			if (this.activeModal?.type === "trajectory") {
				this.activeModal = null;
			} else {
				this.openTrajectory();
			}
			this.requestRender();
			return;
		}

		// 0.3 空输入框敲 ? 立即弹出帮助抽屉
		if (this.inputLine.getRawText() === "" && (data === "?" || data === "？")) {
			this.activeModal = {
				type: "helpMenu",
				menu: new HelpMenu(this.commands),
			};
			this.activeSuggestions = null;
			this.requestRender();
			return;
		}

		// 0.5 如果处于联想激活态，优先响应联想浮层的光标移动与确认选择
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

		// 1. 全局快捷键：Ctrl+O。
		if (matchesKey(data, Key.ctrl("o"))) {
			// 优先展开粘贴芯片
			if (this.inputLine.hasChipAtCursor()) {
				this.inputLine.handleInput(data);
				this.requestRender();
				return;
			}

			// 场景 1：流式思考进行中，瞬时切换当前实时推理流的展开/收起
			if (this.busy && !this.thinkingCommitted && this.currentTurn?.thinkingText) {
				this.thinkingView.toggleCollapse();
				if (this.currentTurn) {
					this.currentTurn.thinkingCollapsed = this.thinkingView.isCollapsed();
				}
				this.requestRender();
				return;
			}

			// 场景 2：闲置对话历史中，展开/折叠最新那一轮的思考内容
			const latestTurn = (this.currentTurn && this.currentTurn.thinkingText)
				? this.currentTurn
				: [...this.historyTurns].reverse().find((t) => Boolean(t.thinkingText));
			if (latestTurn) {
				latestTurn.thinkingCollapsed = !(latestTurn.thinkingCollapsed ?? true);
				this.handleResize();
				return;
			}

			// 场景 3：若最新一轮包含 diff 差异卡片，展开/折叠 diff
			const latestDiffTurn = (this.currentTurn && this.currentTurn.diffs && this.currentTurn.diffs.length > 0)
				? this.currentTurn
				: [...this.historyTurns].reverse().find((t) => t.diffs && t.diffs.length > 0);
			if (latestDiffTurn?.diffs && latestDiffTurn.diffs.length > 0) {
				const allCollapsed = latestDiffTurn.diffs.every((d) => d.collapsed ?? true);
				for (const d of latestDiffTurn.diffs) {
					d.collapsed = !allCollapsed;
				}
				this.handleResize();
				return;
			}

			// 场景 4：若包含会话压缩卡片，展开/收起最新压缩卡片摘要
			if (this.compactions.length > 0) {
				const latest = this.compactions[this.compactions.length - 1]!;
				latest.collapsed = !latest.collapsed;
				this.handleResize();
				return;
			}
			return;
		}

		// 2. 全局快捷键：Alt+O。全展开 / 全折叠
		if (matchesKey(data, "alt+o") || matchesKey(data, Key.alt("o"))) {
			const turnsWithThinking = this.historyTurns.filter((t) => Boolean(t.thinkingText));
			if (turnsWithThinking.length > 0) {
				const allExpanded = turnsWithThinking.every((t) => !(t.thinkingCollapsed ?? true));
				for (const t of turnsWithThinking) {
					t.thinkingCollapsed = allExpanded;
				}
				this.handleResize();
				return;
			}
		}

		this.inputLine.handleInput(data);
		this.updateSuggestions();
		this.requestRender();
	}

	private updateSuggestions(): void {
		const detection = this.inputLine.detectSuggestionQuery();
		if (!detection) {
			this.activeSuggestions = null;
			return;
		}

		if (detection.type === "command") {
			const query = detection.query.toLowerCase();
			const filtered = this.commands.filter(
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
					items: filtered,
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

	private executeCommand(name: string, args: string): void {
		const width = this.terminal.columns;
		const margin = this.getPageMargin(width);
		const cmd = this.commands.find((c) => c.name === name);
		if (cmd?.handler) {
			void cmd.handler(args);
			return;
		}

		if (name === "clear") {
			this.historyTurns = [];
			this.currentTurn = null;
			this.handleResize();
			return;
		}
		if (name === "quit" || name === "exit") {
			this.stop();
			process.stdout.write("\n已退出会话。\n");
			process.exit(0);
		}
		if (name === "help") {
			this.activeModal = {
				type: "helpMenu",
				menu: new HelpMenu(this.commands),
			};
			this.requestRender();
			return;
		}
		if (name === "model") {
			if (args.trim()) {
				this.setModel(args.trim());
				this.renderer.appendPermanentLines([`${margin}${C.green}✓ 已切换模型至: ${this.modelName}${C.reset}`, ""]);
			} else {
				this.activeModal = {
					type: "modelPicker",
					picker: new ModelPicker(this.modelName),
				};
			}
			this.requestRender();
			return;
		}
		if (name === "effort") {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "status") {
				this.handleNotice(`当前推理强度 ${this.getReasoningEffortName()}`);
				this.handleNotice("用法：/effort（滑杆）| /effort <id> | /effort status");
				return;
			}
			if (parts.length > 0) {
				const validTiers = ["off", "none", "low", "medium", "high", "max"];
				const target = parts[0]!.toLowerCase();
				if (validTiers.includes(target)) {
					this.setReasoningEffort(target);
					this.handleNotice(`推理强度 → ${this.getReasoningEffortName()}`);
				} else {
					this.handleNotice(`未知推理等级 ${parts[0]}（当前模型可选：off, low, medium, high, max）`);
				}
				return;
			}
			// 空参数 /effort 打开拟态滑块浮层
			this.activeModal = {
				type: "effortSlider",
				slider: new EffortSlider(this.reasoningEffort),
			};
			this.requestRender();
			return;
		}
		if (name === "subagents" || name === "agents") {
			this.openSubagents();
			return;
		}
		if (name === "tasks" || name === "jobs") {
			this.openTasks();
			return;
		}
		if (name === "trajectory" || name === "traj") {
			this.openTrajectory();
			return;
		}
		if (name === "diff") {
			const lastTurnWithDiff = [...this.historyTurns, this.currentTurn]
				.filter(Boolean)
				.reverse()
				.find((t) => t?.diffs && t.diffs.length > 0);
			if (lastTurnWithDiff?.diffs) {
				for (const d of lastTurnWithDiff.diffs) {
					d.collapsed = !(d.collapsed ?? true);
				}
				this.handleResize();
			}
			return;
		}
		if (name === "compact") {
			if (this.busy) {
				this.handleNotice("回合运行中，无法压缩会话");
				return;
			}
			if (args === "toggle" || (this.compactions.length > 0 && this.historyTurns.length === 0 && !args)) {
				const latest = this.compactions[this.compactions.length - 1];
				if (latest) {
					latest.collapsed = !latest.collapsed;
					this.handleResize();
				}
				return;
			}
			void this.compact(args ? args.trim() : undefined);
			return;
		}
		if (name === "think") {
			const turnsWithThinking = this.historyTurns.filter((t) => Boolean(t.thinkingText));
			if (!args || args === "latest" || args === "toggle") {
				const latestTurn = (this.currentTurn && this.currentTurn.thinkingText)
					? this.currentTurn
					: [...this.historyTurns].reverse().find((t) => Boolean(t.thinkingText));
				if (latestTurn) {
					latestTurn.thinkingCollapsed = !(latestTurn.thinkingCollapsed ?? true);
					this.handleResize();
				}
			} else if (args === "all") {
				const allExpanded = turnsWithThinking.every((t) => !(t.thinkingCollapsed ?? true));
				for (const t of turnsWithThinking) {
					t.thinkingCollapsed = allExpanded;
				}
				this.handleResize();
			} else {
				const targetNum = parseInt(args, 10);
				const target = this.historyTurns.find((t) => t.n === targetNum);
				if (target && target.thinkingText) {
					target.thinkingCollapsed = !(target.thinkingCollapsed ?? true);
					this.handleResize();
				}
			}
			return;
		}

		this.userInputCallback?.(`/${name}${args ? ` ${args}` : ""}`);
	}

	// =========================================================================
	// 格式化辅助方法（支持基于给定列宽的动态回流折行与宽屏呼吸边距）
	// =========================================================================

	private getPageMargin(_width: number): string {
		return "";
	}

	private formatUserTurn(userText: string, width: number): string[] {
		const margin = this.getPageMargin(width);
		const innerW = width - margin.length;
		const userLines = userText.split(/\r\n|\r|\n/);
		const maxWrapW = Math.max(20, innerW - 6);
		const formattedUser: string[] = [""];

		let isFirst = true;
		for (const rawLine of userLines) {
			const wrapped = wrapTextWithAnsi(rawLine, maxWrapW);
			for (const sub of wrapped) {
				if (isFirst) {
					formattedUser.push(`${margin}${C.cyan}${C.bold}❯ ${sub}${C.reset}`);
					isFirst = false;
				} else {
					formattedUser.push(`${margin}  ${C.cyan}${sub}${C.reset}`);
				}
			}
		}
		formattedUser.push("");
		return formattedUser;
	}

	private formatAssistantTurn(mdText: string, width = 80): string[] {
		if (!mdText) return [];
		const margin = this.getPageMargin(width);
		const innerW = width - margin.length;
		const lines = formatFullMarkdown(mdText, innerW);
		const formatted: string[] = [];
		let isFirst = true;
		for (const line of lines) {
			if (isFirst) {
				formatted.push(`${margin}${C.green}${C.bold}● ${C.reset}${line}`);
				isFirst = false;
			} else {
				formatted.push(`${margin}  ${line}`);
			}
		}
		formatted.push("");
		return formatted;
	}

	// =========================================================================
	// 主体事件消费（全面复刻 dsh-TUI 视觉语言）
	// =========================================================================

	private commitThinking(): void {
		if (this.currentTurn?.thinkingText && !this.thinkingCommitted) {
			this.thinkingCommitted = true;
			this.thinkingView.finish();
			this.requestRender();
		}
	}

	handleTurnStart(n: number, userText: string): void {
		this.busy = true;
		this.isFirstResponseLine = true;
		this.turnStartTime = Date.now();
		this.streamTokenCount = 0;
		this.thinkingCommitted = false;
		this.scrollOffset = 0; // 重置滚动视口到底部

		// 记录当前 Turn
		this.currentTurn = {
			n,
			userText,
			assistantMarkdown: "",
			thinkingText: "",
			thinkingCollapsed: true,
			tools: [],
		};

		// 2. 状态进入 thinking 阶段
		this.activityLine.start("thinking", "正在深度思考与组织回复...");
		this.thinkingView.reset();
		this.markdown.reset();
		this.activeTool.clear();

		// 记录至轨迹存储
		this.trajectoryStore.record({
			turn: n,
			kind: "turn_start",
			label: userText.trim().slice(0, 60),
			startedAt: this.turnStartTime,
		});

		this.startAnimation();
		this.requestRender();
	}

	appendToken(token: string): void {
		if (!this.busy) return;
		if (!this.thinkingCommitted && this.currentTurn?.thinkingText) {
			this.commitThinking();
		}

		if (this.currentTurn) {
			this.currentTurn.assistantMarkdown += token;
		}

		// 估算 Token 数量：中文约 1.5 字符/token，英文约 3~4 字符/token
		const tokenDelta = Math.max(1, Math.round(token.length / 2.5));
		this.streamTokenCount += tokenDelta;
		this.activityLine.addTokens(tokenDelta);
		this.activityLine.update("streaming", "正在生成回复...");

		const width = this.terminal.columns;
		const margin = this.getPageMargin(width);
		this.markdown.setWidth(width - margin.length);

		this.markdown.feedToken(token);
		this.scrollOffset = 0;
		this.requestRender();
	}

	appendThinking(text: string): void {
		if (this.currentTurn) {
			this.currentTurn.thinkingText = (this.currentTurn.thinkingText ?? "") + text;
		}
		this.thinkingView.appendThinking(text);
		this.activityLine.update("thinking", "正在深度推理 (DeepSeek-R1)...");
		this.scrollOffset = 0;
		this.requestRender();
	}

	handleToolStart(name: string, args: unknown): void {
		if (!this.thinkingCommitted && this.currentTurn?.thinkingText) {
			this.commitThinking();
		}
		this.activeTool.start(name, args);
		this.activityLine.update("tool", `正在执行工具: ${name}`);

		// 记录工具执行节点
		this.trajectoryStore.record({
			id: `tool-${name}-${Date.now()}`,
			turn: this.currentTurn?.n,
			kind: "tool_call",
			label: name,
			status: "running",
			argsJson: typeof args === "string" ? args : JSON.stringify(args),
		});

		this.requestRender();
	}

	handleToolDone(name: string, result: string, elapsedMs = 0): void {
		this.activeTool.clear();
		if (this.currentTurn) {
			this.currentTurn.tools.push({ name, result, elapsedMs });
		}
		this.activityLine.update("streaming", "工具执行完毕，继续生成...");

		// 结束最近运行中的同名工具节点
		const runningNode = [...this.trajectoryStore.list()]
			.reverse()
			.find((node) => node.kind === "tool_call" && node.label === name && node.status === "running");
		if (runningNode) {
			this.trajectoryStore.completeNode(runningNode.id, {
				durationMs: elapsedMs,
				status: "completed",
				resultPreview: result.slice(0, 100),
			});
		}

		this.scrollOffset = 0;
		this.requestRender();
	}

	handleTurnEnd(n: number, usage?: { usedTokens: number; contextWindow: number }): void {
		this.busy = false;

		// 记录终态 TPS 与耗时
		const elapsed = Math.max(1, Date.now() - this.turnStartTime);
		this.lastElapsedMs = elapsed;
		if (this.streamTokenCount > 0) {
			this.lastTps = Math.round((this.streamTokenCount / (elapsed / 1000)) * 10) / 10;
		}

		// 若本轮仅有思考无正文文本，也必须将思考过程完整提交进对话流
		if (!this.thinkingCommitted && this.currentTurn?.thinkingText) {
			this.commitThinking();
		}

		// 记录回复流节点
		this.trajectoryStore.record({
			turn: n,
			kind: "model_stream",
			label: `回复生成 (Turn #${n})`,
			status: "completed",
			startedAt: this.turnStartTime,
			endedAt: Date.now(),
			durationMs: elapsed,
			tokens: usage ? { total: usage.usedTokens } : { total: this.streamTokenCount },
		});

		this.markdown.flush();

		// 归档当前已完成的 Turn 到历史列表供窗口 Resize 动态回流
		if (this.currentTurn) {
			this.historyTurns.push(this.currentTurn);
			this.currentTurn = null;
		}

		// 状态行转为明确的静态完成态
		this.activityLine.finish("本轮已完成");
		this.stopAnimation();

		// 更新 Token 用量
		if (usage && usage.usedTokens > 0) {
			this.usedTokens = usage.usedTokens;
			if (usage.contextWindow) this.contextWindow = usage.contextWindow;
		}

		this.scrollOffset = 0;
		this.requestRender();
	}

	handleError(msg: string): void {
		this.trajectoryStore.record({
			kind: "error",
			label: msg.slice(0, 60),
			status: "failed",
			error: msg,
		});
		this.systemNotices.push(`  ${C.red}✗ [错误] ${msg}${C.reset}`);
		this.activityLine.reset();
		this.busy = false;
		this.stopAnimation();
		this.requestRender();
	}

	handleNotice(msg: string): void {
		this.systemNotices.push(`  ${C.blue}ℹ ${msg}${C.reset}`);
		this.requestRender();
	}

	dispatch(msg: UinaUIMsg): void {
		switch (msg.type) {
			case "turn_start":
				this.handleTurnStart(msg.n, msg.text);
				break;
			case "text":
				this.appendToken(msg.text);
				break;
			case "thinking":
				this.appendThinking(msg.text);
				break;
			case "tool_start":
				this.handleToolStart(msg.name, msg.args);
				break;
			case "tool_done":
				this.handleToolDone(msg.name, msg.result, msg.elapsedMs ?? (msg.ts ? Date.now() - msg.ts : 0));
				break;
			case "turn_end":
				this.handleTurnEnd(msg.n, msg.usage);
				break;
			case "error":
				this.handleError(msg.text);
				break;
			case "notice":
				this.handleNotice(msg.text);
				break;
		}
	}

	// =========================================================================
	// 活跃区域帧合成与全量视口重排
	// =========================================================================

	private getAboveEditorLines(innerW: number): string[] {
		const aboveLines: string[] = [];

		// 1. 思考链当前流式预览（仅在思考中且尚未出正文前展示）
		if (!this.thinkingCommitted && this.currentTurn?.thinkingText) {
			aboveLines.push(...this.thinkingView.render(innerW));
		}

		// 2. 当前运行中的工具动态卡片（若有）
		aboveLines.push(...this.activeTool.render(innerW));

		// 3. 自定义小部件
		for (const widget of this.customWidgets) {
			aboveLines.push(...widget.render(innerW));
		}

		// 4. 弹出式半模态浮层（/model 选模型、/effort 调思考、? 帮助菜单）或联想卡片
		if (this.activeModal) {
			if (this.activeModal.type === "modelPicker") {
				aboveLines.push(...this.activeModal.picker.formatLines(innerW));
			} else if (this.activeModal.type === "effortSlider") {
				aboveLines.push(...this.activeModal.slider.formatLines(innerW));
			} else if (this.activeModal.type === "helpMenu") {
				aboveLines.push(...this.activeModal.menu.formatLines(innerW));
			} else if (this.activeModal.type === "subagentDashboard") {
				aboveLines.push(...this.activeModal.dashboard.formatLines(innerW));
			} else if (this.activeModal.type === "subagentDetail") {
				aboveLines.push(...this.activeModal.detailScene.formatLines(innerW, this.terminal.rows));
			} else if (this.activeModal.type === "taskDashboard") {
				aboveLines.push(...this.activeModal.dashboard.formatLines(innerW, this.terminal.rows));
			} else if (this.activeModal.type === "trajectory") {
				aboveLines.push(...this.activeModal.scene.formatLines(innerW, this.terminal.rows));
			}
		} else if (this.activeSuggestions && this.activeSuggestions.items.length > 0) {
			aboveLines.push(
				...formatSuggestionCardLines({
					type: this.activeSuggestions.type,
					title: this.activeSuggestions.type === "command" ? "命令" : "文件",
					query: this.activeSuggestions.query,
					columns: innerW,
					selectedIndex: this.activeSuggestions.selectedIndex,
					items: this.activeSuggestions.items,
					maxVisible: 5,
				}),
			);
		}

		return aboveLines;
	}

	private buildActiveLines(width: number): string[] {
		const margin = this.getPageMargin(width);
		const innerW = width - margin.length;
		const above = this.getAboveEditorLines(innerW);
		const input = this.inputLine.render(innerW);
		return [...above, ...input].map((l) => `${margin}${l}`);
	}

	private getAllPermanentLines(innerW: number): string[] {
		const width = this.terminal.columns;
		const margin = this.getPageMargin(width);
		this.thinkingBlockRanges = [];
		const permanentLines: string[] = [];
		permanentLines.push(
			...getStartupBanner({ ...this.options, cwd: this.cwd }, innerW).map((l) => (l ? `${margin}${l}` : "")),
		);

		// 系统公告与通知（例如模型/思考强度调整提示）
		for (const notice of this.systemNotices) {
			permanentLines.push(notice ? `${margin}${notice}` : "");
		}

		// 回放初始无前置轮次的压缩记录（若有）
		const compsBefore = this.compactions.filter((c) => !c.afterTurnN || c.afterTurnN === 0);
		for (const comp of compsBefore) {
			permanentLines.push(
				...formatCompactionCardLines(comp, innerW).map((l) => (l ? `${margin}${l}` : "")),
			);
		}

		for (const turn of this.historyTurns) {
			permanentLines.push(...this.formatUserTurn(turn.userText, width));
			if (turn.thinkingText) {
				const startLine = permanentLines.length;
				const formatted = formatThinkingLines(turn.thinkingText, turn.thinkingCollapsed ?? true, innerW).map((l) =>
					l ? `${margin}${l}` : "",
				);
				permanentLines.push(...formatted);
				const endLine = permanentLines.length - 1;
				this.thinkingBlockRanges.push({ startLine, endLine, turn });
			}
			if (turn.assistantMarkdown) {
				permanentLines.push(...this.formatAssistantTurn(turn.assistantMarkdown, width));
			}
			for (const tool of turn.tools) {
				permanentLines.push(
					...formatToolCardLines(tool.name, tool.result, tool.elapsedMs, innerW).map((l) => `${margin}${l}`),
				);
			}
			if (turn.diffs) {
				for (const d of turn.diffs) {
					permanentLines.push(
						...formatUnifiedDiffCardLines(d.oldText, d.newText, d.filename, d.collapsed ?? true, innerW).map(
							(l) => (l ? `${margin}${l}` : ""),
						),
					);
				}
			}

			// 回放跟随在本轮之后产生的会话压缩卡片（保证时间线上之前的对话全部完整可见）
			const compsAfter = this.compactions.filter((c) => c.afterTurnN === turn.n);
			for (const comp of compsAfter) {
				permanentLines.push(
					"",
					...formatCompactionCardLines(comp, innerW).map((l) => (l ? `${margin}${l}` : "")),
					"",
				);
			}
		}

		if (this.currentTurn) {
			permanentLines.push(...this.formatUserTurn(this.currentTurn.userText, width));
			if (this.currentTurn.thinkingText && this.thinkingCommitted) {
				const startLine = permanentLines.length;
				const formatted = formatThinkingLines(
					this.currentTurn.thinkingText,
					this.currentTurn.thinkingCollapsed ?? true,
					innerW,
				).map((l) => (l ? `${margin}${l}` : ""));
				permanentLines.push(...formatted);
				const endLine = permanentLines.length - 1;
				this.thinkingBlockRanges.push({ startLine, endLine, turn: this.currentTurn });
			}
			if (this.currentTurn.assistantMarkdown) {
				permanentLines.push(...this.formatAssistantTurn(this.currentTurn.assistantMarkdown, width));
			}
			for (const tool of this.currentTurn.tools) {
				permanentLines.push(
					...formatToolCardLines(tool.name, tool.result, tool.elapsedMs, innerW).map((l) => `${margin}${l}`),
				);
			}
			if (this.currentTurn.diffs) {
				for (const d of this.currentTurn.diffs) {
					permanentLines.push(
						...formatUnifiedDiffCardLines(d.oldText, d.newText, d.filename, d.collapsed ?? true, innerW).map(
							(l) => (l ? `${margin}${l}` : ""),
						),
					);
				}
			}
		}

		return permanentLines;
	}

	/**
	 * 底部常驻全帧渲染（Bottom-Pinned Frame Composition）
	 * 保证输入框永远吸底锁定在 [height - inputH, height - 1]，浮层在输入框正上方向上覆盖，杜绝任何纵向抖动与下方空白！
	 */
	private renderCurrentFrame(): void {
		if (!this.running) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const margin = this.getPageMargin(width);
		const innerW = width - margin.length;

		// 1. 同步输入行与状态行
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

		// 3. 渲染输入框正上方的浮层与动态瞬态卡片（OverlayAbove 哲学：不挤占输入框位置）
		const rawAbove = this.getAboveEditorLines(innerW);
		const maxAboveH = Math.max(0, height - inputH - 1);
		const cappedAbove = rawAbove.slice(0, maxAboveH);
		const aboveLines = cappedAbove.map((l) => `${margin}${l}`);
		const aboveH = aboveLines.length;

		// 4. 转录区可用高度 = 视口总高 - 输入框高 - 浮层高
		const transcriptH = Math.max(0, height - inputH - aboveH);

		// 5. 格式化所有永久历史行
		const permanentLines = this.getAllPermanentLines(innerW);
		const totalPerm = permanentLines.length;

		// 6. 滚动视口处理
		let visibleTranscript: string[] = [];
		if (totalPerm <= transcriptH) {
			// 内容未填满视口：历史置顶显示，输入框与浮层正上方为整齐留白
			const padCount = transcriptH - totalPerm;
			visibleTranscript = [...permanentLines, ...new Array(padCount).fill("")];
		} else {
			// 内容超出视口：默认吸底展示最新内容，支持 scrollOffset 翻看历史
			const maxScroll = totalPerm - transcriptH;
			const effScroll = Math.max(0, Math.min(this.scrollOffset, maxScroll));
			const start = totalPerm - transcriptH - effScroll;
			visibleTranscript = permanentLines.slice(start, start + transcriptH);
		}

		// 7. 组装整屏行（总高度恒等于 height，输入框恒定位于屏幕最底端 [height - inputH, height - 1]）
		const fullScreenRows: string[] = [
			...visibleTranscript,
			...aboveLines,
			...inputLines,
		];

		// 8. 提交原子全帧渲染
		this.renderer.renderFrame(fullScreenRows);
	}

	private renderScheduled = false;
	private requestRender(): void {
		if (!this.running) return;
		if (this.renderScheduled) return;
		this.renderScheduled = true;
		setImmediate(() => {
			this.renderScheduled = false;
			if (!this.running) return;
			this.renderCurrentFrame();
		});
	}

	/**
	 * 窗口缩放处理：执行全量视口重排，按最新列宽与行高彻底重排并消除残留
	 */
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
}
