/**
 * 多子智能体看板组件（完整复刻 dsh-TUI SubagentDashboard & SubagentCard 视觉规范）。
 *
 * 特性：
 * 1. 统一子智能体领域模型：状态（running/completed/failed/cancelled）、时间线、Token、工具链、输出流；
 * 2. 顶栏全局状态指示器：运行中 🟡、已完成 🟢、报错/中断 🔴；
 * 3. 任务卡片排版：状态小圆点、任务描述、模型/路由、运行耗时、Token 吞吐、工具调用次数；
 * 4. 实时动态末行（liveLine）：当智能体处于运行中时，卡片下方自动展示最新一行思考/回复输出；
 * 5. 键盘与鼠标双模控制：↑/↓ 上下导航聚焦，Enter 下钻进入二级审查页，Esc 退出。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../core/utils.js";

export type SubagentStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export type SubagentOutputKind = "text" | "thinking" | "tool" | "error" | "system";

export interface SubagentOutputLine {
	kind: SubagentOutputKind;
	text: string;
	at: number;
	settled?: boolean;
}

export interface SubagentToolCall {
	id?: string;
	name: string;
	status: "running" | "completed" | "failed";
	startedAt: number;
	endedAt?: number;
	argsPreview?: string;
	resultPreview?: string;
	error?: string;
}

export interface SubagentTokenUsage {
	input?: number;
	output?: number;
	total?: number;
	context?: number;
}

export interface SubagentState {
	agentId: string;
	runId?: string;
	description: string;
	provider?: string;
	model?: string;
	effort?: string;
	status: SubagentStatus;
	startedAt: number;
	completedAt?: number;
	error?: string;
	output: string[];
	outputEvents: SubagentOutputLine[];
	toolCalls: SubagentToolCall[];
	tokens?: SubagentTokenUsage;
	summary?: string;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSec = seconds % 60;
	return `${minutes}m${remSec}s`;
}

/**
 * 统一子智能体活动状态管理存储库
 */
export class SubagentActivityStore {
	private states = new Map<string, SubagentState>();
	private listeners = new Set<() => void>();

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {
				// ignore listener errors
			}
		}
	}

	list(): SubagentState[] {
		return Array.from(this.states.values());
	}

	get(agentId: string): SubagentState | undefined {
		return this.states.get(agentId);
	}

	onSpawned(agentId: string, description: string, model = "deepseek-chat", info: Partial<SubagentState> = {}): SubagentState {
		const existing = this.states.get(agentId);
		const state: SubagentState = existing ?? {
			agentId,
			runId: info.runId ?? agentId,
			description,
			provider: info.provider ?? "deepseek",
			model,
			effort: info.effort ?? "medium",
			status: "running",
			startedAt: info.startedAt ?? Date.now(),
			output: [],
			outputEvents: [],
			toolCalls: [],
		};
		if (existing) {
			Object.assign(existing, info, { description, model, status: existing.status === "completed" ? existing.status : "running" });
		} else {
			this.states.set(agentId, state);
		}
		this.notify();
		return state;
	}

	pushOutput(agentId: string, kind: SubagentOutputKind, text: string, settled = true): void {
		const state = this.states.get(agentId);
		if (!state) return;
		state.outputEvents.push({ kind, text, at: Date.now(), settled });
		if (state.outputEvents.length > 150) state.outputEvents.splice(0, state.outputEvents.length - 150);
		state.output.push(text);
		if (state.output.length > 150) state.output.splice(0, state.output.length - 150);
		this.notify();
	}

	startToolCall(agentId: string, tool: { id?: string; name: string; argsPreview?: string }): void {
		const state = this.states.get(agentId);
		if (!state) return;
		state.toolCalls.push({
			id: tool.id ?? `tool-${Date.now()}`,
			name: tool.name,
			status: "running",
			startedAt: Date.now(),
			argsPreview: tool.argsPreview,
		});
		this.notify();
	}

	endToolCall(agentId: string, toolId: string, status: "completed" | "failed", resultPreview?: string, error?: string): void {
		const state = this.states.get(agentId);
		if (!state) return;
		const call = state.toolCalls.find((t) => t.id === toolId) ?? state.toolCalls[state.toolCalls.length - 1];
		if (call) {
			call.status = status;
			call.endedAt = Date.now();
			if (resultPreview) call.resultPreview = resultPreview;
			if (error) call.error = error;
		}
		this.notify();
	}

	complete(agentId: string, summary?: string, tokens?: SubagentTokenUsage): void {
		const state = this.states.get(agentId);
		if (!state) return;
		state.status = "completed";
		state.completedAt = Date.now();
		if (summary) state.summary = summary;
		if (tokens) state.tokens = tokens;
		this.notify();
	}

	fail(agentId: string, error: string): void {
		const state = this.states.get(agentId);
		if (!state) return;
		state.status = "failed";
		state.completedAt = Date.now();
		state.error = error;
		this.notify();
	}

	interrupt(agentId: string): void {
		const state = this.states.get(agentId);
		if (!state || state.status === "completed" || state.status === "failed") return;
		state.status = "cancelled";
		state.completedAt = Date.now();
		state.error = "任务已被用户手动中断 (Interrupt by user)";
		this.notify();
	}

	/** 创建内置演示用的多状态并发智能体样例 */
	loadSampleData(): void {
		this.states.clear();

		// 1. 运行中 Agent (带实时流式打字)
		this.onSpawned("subagent-01", "数据库死锁与事务锁等待推演", "deepseek-reasoner", { effort: "high" });
		this.pushOutput("subagent-01", "thinking", "正在拉取订单事务与库存行锁时序图...");
		this.pushOutput("subagent-01", "thinking", "发现 orders 与 inventory 存在交叉加锁隐患");
		this.pushOutput("subagent-01", "text", "正在推演隔离级别调整与锁排序规避方案...", false);
		this.startToolCall("subagent-01", { id: "t1", name: "grep_search", argsPreview: `{"Query":"FOR UPDATE","SearchPath":"src/dao"}` });
		this.endToolCall("subagent-01", "t1", "completed", "匹配到 8 处并发悲观锁持有语句");
		this.startToolCall("subagent-01", { id: "t2", name: "view_file", argsPreview: `{"Path":"src/dao/order.ts","Line":42}` });

		// 2. 已完成 Agent
		this.onSpawned("subagent-02", "前端代码语法高亮与 Markdown 表格基准审查", "deepseek-chat");
		this.pushOutput("subagent-02", "text", "已完成 SyntaxText 与自适应细线网格测试。");
		this.startToolCall("subagent-02", { id: "t3", name: "run_command", argsPreview: `{"CommandLine":"pnpm vitest run"}` });
		this.endToolCall("subagent-02", "t3", "completed", "56/56 tests passed (0 errors)");
		this.complete("subagent-02", "经全面基准审计，表格细线对齐与高亮着色 100% 达标，无任何行溢出或破坏性折行。", {
			input: 1450,
			output: 2890,
			total: 4340,
		});

		// 3. 失败/报警 Agent
		this.onSpawned("subagent-03", "跨模块循环依赖死锁排查", "deepseek-chat");
		this.pushOutput("subagent-03", "error", "Fatal Error: Circular dependency detected in cycle: A -> B -> C -> A");
		this.fail("subagent-03", "检测到未解的循环引用拓扑环，无法完成拓扑排序构建。");
	}
}

/**
 * 单个子智能体卡片行渲染
 */
export function formatSubagentCard(subagent: SubagentState, innerWidth: number, isFocused: boolean): string[] {
	const isRunning = subagent.status === "running" || subagent.status === "starting";
	const elapsed = subagent.completedAt ? subagent.completedAt - subagent.startedAt : Date.now() - subagent.startedAt;
	const totalTokens = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0);

	// 状态图标与颜色
	let glyph = "🟢";
	if (isRunning) {
		glyph = "🟡";
	} else if (subagent.status === "failed" || subagent.status === "cancelled") {
		glyph = "🔴";
	}

	// 标题行组成: glyph + 描述 + 模型 + 耗时 + tokens + 工具数
	const focusPrefix = isFocused ? `${C.bold}${C.glowWhite}❯ ` : "  ";
	const descStyled = isFocused
		? `${C.bold}${C.cyan}${subagent.description}${C.reset}`
		: `${C.bold}${subagent.description}${C.reset}`;

	const metaStyled = `${C.gray}·${C.reset} ${C.dim}${subagent.model ?? "default"}${C.reset} ${C.gray}·${C.reset} ${C.dim}${formatDuration(elapsed)}${C.reset} ${C.gray}·${C.reset} ${C.dim}${totalTokens || "—"} tok${C.reset} ${C.gray}·${C.reset} ${C.dim}${subagent.toolCalls.length} tools${C.reset}`;

	const rawHeader = `${focusPrefix}${glyph} ${descStyled} ${metaStyled}`;
	const headerLine = truncateToWidth(rawHeader, innerWidth, "…");

	const lines = [headerLine];

	// 如果处于运行中，展示最新的流式输出预览行 (liveLine)
	if (isRunning && subagent.output.length > 0) {
		const lastLine = subagent.output[subagent.output.length - 1]!;
		const liveText = `     ${C.gray}│${C.reset} ${C.dim}${lastLine}${C.reset}`;
		lines.push(truncateToWidth(liveText, innerWidth, "…"));
	}

	return lines;
}

/**
 * 一级总览看板 (SubagentDashboard)
 */
export class SubagentDashboard {
	private store: SubagentActivityStore;
	private focusIndex = 0;

	constructor(store: SubagentActivityStore) {
		this.store = store;
	}

	getSubagents(): SubagentState[] {
		return this.store.list();
	}

	getFocusedAgent(): SubagentState | undefined {
		const list = this.getSubagents();
		return list[this.focusIndex];
	}

	navigateUp(): void {
		const total = this.getSubagents().length;
		if (total === 0) return;
		this.focusIndex = (this.focusIndex - 1 + total) % total;
	}

	navigateDown(): void {
		const total = this.getSubagents().length;
		if (total === 0) return;
		this.focusIndex = (this.focusIndex + 1) % total;
	}

	setFocusIndex(index: number): void {
		const total = this.getSubagents().length;
		if (index >= 0 && index < total) {
			this.focusIndex = index;
		}
	}

	formatLines(terminalWidth = 80): string[] {
		const boxWidth = getContentBoxWidth(terminalWidth - 4);
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const subagents = this.getSubagents();

		// 1. 顶边框与退出按钮 ✕
		const titleTag = `─ 子智能体看板 (Subagents) `;
		const exitTag = ` ✕ ─`;
		const fillCount = Math.max(1, boxWidth - 2 - visibleWidth(titleTag) - visibleWidth(exitTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(fillCount)}${exitTag}╮${C.reset}`;

		// 2. 状态统计聚合行 (Running / Completed / Failed)
		const runningCount = subagents.filter((s) => s.status === "running" || s.status === "starting").length;
		const completedCount = subagents.filter((s) => s.status === "completed").length;
		const failedCount = subagents.filter((s) => s.status === "failed" || s.status === "cancelled").length;

		const metricsBar = `  ${C.yellow}🟡 ${runningCount} 运行中${C.reset}    ${C.green}🟢 ${completedCount} 已完成${C.reset}    ${failedCount > 0 ? `${C.red}🔴 ${failedCount} 失败/中断${C.reset}` : `${C.dim}🔴 0 失败${C.reset}`}`;
		const metricsPad = Math.max(0, innerW - visibleWidth(metricsBar));
		const metricsLine = `  ${borderCol}│${C.reset} ${metricsBar}${" ".repeat(metricsPad)} ${borderCol}│${C.reset}`;

		const dividerLine = `  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`;

		// 3. 卡片列表渲染
		const contentLines: string[] = [];
		if (subagents.length === 0) {
			const emptyMsg = `${C.dim}暂无正在运行或已完结的子智能体任务${C.reset}`;
			const pad = Math.max(0, innerW - visibleWidth(emptyMsg));
			contentLines.push(`  ${borderCol}│${C.reset} ${emptyMsg}${" ".repeat(pad)} ${borderCol}│${C.reset}`);
		} else {
			for (let i = 0; i < subagents.length; i++) {
				const agent = subagents[i]!;
				const isFocused = i === this.focusIndex;
				const cardLines = formatSubagentCard(agent, innerW, isFocused);

				for (const cl of cardLines) {
					const pad = Math.max(0, innerW - visibleWidth(cl));
					contentLines.push(`  ${borderCol}│${C.reset} ${cl}${" ".repeat(pad)} ${borderCol}│${C.reset}`);
				}

				// 卡片间轻量分割线
				if (i < subagents.length - 1) {
					contentLines.push(`  ${borderCol}│${C.reset}   ${C.gray}${"─".repeat(Math.max(10, innerW - 6))}${C.reset}   ${borderCol}│${C.reset}`);
				}
			}
		}

		// 4. 底部快捷键提示行
		const hintText = `${C.dim}↑/↓ 浏览 · ${C.bold}Enter${C.reset}${C.dim} 查看详情 · ${C.bold}Esc${C.reset}${C.dim} 退出${C.reset}`;
		const hintPad = Math.max(0, innerW - visibleWidth(hintText));
		const hintLine = `  ${borderCol}│${C.reset} ${hintText}${" ".repeat(hintPad)} ${borderCol}│${C.reset}`;

		// 5. 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;

		return [
			topLine,
			`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
			metricsLine,
			dividerLine,
			...contentLines,
			dividerLine,
			hintLine,
			botLine,
		];
	}
}
