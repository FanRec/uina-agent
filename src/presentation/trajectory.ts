/**
 * 轨迹只读投影（TrajectoryProjection）。
 *
 * 只消费 PresentationNode，不再自持状态机：节点身份、时间与终态全部来自
 * Presentation Core。这里只做轨迹域翻译（节点种类、稳定聚合名、5000 上限）。
 *
 * 时间缺失保持 undefined，看板显示"时间未知"，绝不以当前时钟补齐。
 */

import {
	durationBetween,
	type PresentationNode,
	type ThinkingNode,
	type ToolNode,
	type TurnNode,
} from "./projection.js";

export type TrajectoryNodeKind = "turn_start" | "thinking" | "tool_call" | "model_stream" | "compaction" | "error";

export type TrajectoryNodeStatus = "running" | "completed" | "failed" | "cancelled" | "unknown" | "not_started";

export interface TrajectoryNode {
	id: string;
	turn?: number;
	kind: TrajectoryNodeKind;
	/** 稳定聚合名（不含回合号）；热点表以 `${kind}:${name}` 归并。 */
	name: string;
	label: string;
	status: TrajectoryNodeStatus;
	/** 未知时保持 undefined；看板显示“时间未知”，不以时钟补齐。 */
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	tokens?: {
		input?: number;
		output?: number;
		total?: number;
	};
	argsJson?: string;
	resultPreview?: string;
	error?: string;
}

export interface HotspotRow {
	kind: TrajectoryNodeKind;
	name: string;
	count: number;
	totalDurationMs: number;
	avgDurationMs: number;
	totalTokens: number;
	errors: number;
}

/** 看板数据源（只读）：任何拥有节点序列的消费者都可以喂给视图。 */
export interface TrajectoryEventSource {
	list(): readonly TrajectoryNode[];
	aggregate(sortBy?: "duration" | "tokens" | "errors"): HotspotRow[];
}

/** 明细节点上限；更早的节点折叠为聚合总量，防止长会话内存增长。 */
const NODE_LIMIT = 5000;

interface HotspotTotals {
	readonly kind: TrajectoryNodeKind;
	readonly name: string;
	count: number;
	totalDurationMs: number;
	totalTokens: number;
	errors: number;
}

const TOOL_STATUS: Record<ToolNode["status"], TrajectoryNodeStatus> = {
	running: "running",
	succeeded: "completed",
	failed: "failed",
	cancelled: "cancelled",
	unknown: "unknown",
	not_started: "not_started",
};

const THINKING_STATUS: Record<ThinkingNode["status"], TrajectoryNodeStatus> = {
	running: "running",
	completed: "completed",
	cancelled: "cancelled",
};

function argsJson(args: unknown): string | undefined {
	if (args === undefined) return undefined;
	return typeof args === "string" ? args : JSON.stringify(args);
}

function turnEntry(node: TurnNode): TrajectoryNode {
	return {
		id: node.id,
		turn: node.turn,
		kind: "turn_start",
		name: "用户提问",
		label: `用户提问: ${node.userText.slice(0, 40)}`,
		status: node.status === "running" ? "running" : node.status === "aborted" ? "cancelled" : "completed",
		startedAt: node.startedAt,
		endedAt: node.endedAt,
		durationMs: durationBetween(node.startedAt, node.endedAt),
	};
}

function streamEntry(node: TurnNode): TrajectoryNode {
	return {
		id: `${node.id}:stream`,
		turn: node.turn,
		kind: "model_stream",
		name: "回复生成",
		label: `回复生成 (Turn #${node.turn})`,
		status: node.status === "aborted" ? "cancelled" : "completed",
		startedAt: node.startedAt,
		endedAt: node.endedAt,
		durationMs: durationBetween(node.startedAt, node.endedAt),
		...(node.usage?.totalTokens === undefined ? {} : { tokens: { total: node.usage.totalTokens } }),
	};
}

function thinkingEntry(node: ThinkingNode): TrajectoryNode {
	return {
		id: node.id,
		turn: node.turn,
		kind: "thinking",
		name: "深度推理",
		label: "深度推理",
		status: THINKING_STATUS[node.status],
		startedAt: node.startedAt,
		endedAt: node.endedAt,
		durationMs: node.durationMs,
		...(node.text.length === 0 ? {} : { resultPreview: node.text.slice(0, 100) }),
	};
}

function toolEntry(node: ToolNode): TrajectoryNode {
	const args = argsJson(node.args);
	return {
		id: node.id,
		turn: node.turn,
		kind: "tool_call",
		name: node.name,
		label: node.name,
		status: TOOL_STATUS[node.status],
		startedAt: node.startedAt,
		endedAt: node.endedAt,
		durationMs: node.durationMs,
		...(args === undefined ? {} : { argsJson: args }),
		...(node.result === undefined || node.result.length === 0 ? {} : { resultPreview: node.result.slice(0, 100) }),
		...(node.status === "failed" ? { error: node.result ?? "执行失败" } : {}),
	};
}

export class TrajectoryProjection implements TrajectoryEventSource {
	private nodes: TrajectoryNode[] = [];
	private readonly byId = new Map<string, TrajectoryNode>();
	/** 被上限淘汰的节点按聚合键折叠，热点表仍保留历史总量。 */
	private readonly folded = new Map<string, HotspotTotals>();
	private errorSeq = 0;
	private compactionSeq = 0;

	list(): readonly TrajectoryNode[] {
		return this.nodes;
	}

	/** 单节点 upsert：同一稳定 ID 只更新，不重复追加。 */
	apply(node: PresentationNode): void {
		switch (node.kind) {
			case "turn":
				this.upsert(turnEntry(node));
				if (node.status !== "running") this.upsert(streamEntry(node));
				return;
			case "thinking":
				this.upsert(thinkingEntry(node));
				return;
			case "assistant":
				// 正文段属于转录内容，不是活动事实：轨迹只记回合/思考/工具/模型流。
				return;
			case "tool":
				this.upsert(toolEntry(node));
				return;
			default: {
				const _exhaustive: never = node;
				return _exhaustive;
			}
		}
	}

	/**
	 * 恢复/回溯：用投影的完整节点序列重建，不保留旧轨迹。
	 * `model_stream` 在所属回合的尾部补出，保持与实时路径相同的时序。
	 */
	replaceAll(nodes: readonly PresentationNode[]): void {
		this.nodes = [];
		this.byId.clear();
		this.folded.clear();
		let pendingTurn: TurnNode | undefined;
		const flushStream = (): void => {
			if (pendingTurn && pendingTurn.status !== "running") this.upsert(streamEntry(pendingTurn));
			pendingTurn = undefined;
		};
		for (const node of nodes) {
			if (node.kind === "turn") {
				flushStream();
				this.upsert(turnEntry(node));
				pendingTurn = node;
				continue;
			}
			this.apply(node);
		}
		flushStream();
	}

	/** 运行错误不是 PresentationNode；时间仍由调用方传入事实时刻。 */
	onError(text: string, at?: number): void {
		this.upsert({
			id: `error:${++this.errorSeq}`,
			kind: "error",
			name: "运行错误",
			label: text.slice(0, 50),
			status: "failed",
			startedAt: at,
			endedAt: at,
			durationMs: at === undefined ? undefined : 0,
			error: text,
		});
	}

	/** 压缩 token 只用于本节点展示，不进入热点 token 合计。 */
	onCompaction(summary: string, tokensBefore: number | undefined, at?: number): void {
		this.upsert({
			id: `compaction:${++this.compactionSeq}`,
			kind: "compaction",
			name: "会话历史压缩",
			label: "会话历史压缩",
			status: "completed",
			startedAt: at,
			endedAt: at,
			durationMs: at === undefined ? undefined : 0,
			resultPreview: summary.slice(0, 80),
			...(tokensBefore === undefined ? {} : { tokens: { total: tokensBefore } }),
		});
	}

	aggregate(sortBy: "duration" | "tokens" | "errors" = "duration"): HotspotRow[] {
		const rows = new Map<string, HotspotRow>();
		const accumulate = (node: TrajectoryNode): void => {
			const key = `${node.kind}:${node.name}`;
			const row = rows.get(key) ?? {
				kind: node.kind,
				name: node.name,
				count: 0,
				totalDurationMs: 0,
				avgDurationMs: 0,
				totalTokens: 0,
				errors: 0,
			};
			row.count += 1;
			row.totalDurationMs += node.durationMs ?? 0;
			// 压缩 token 是上下文规模，不是生成量，不混入热点合计。
			if (node.kind !== "compaction") row.totalTokens += node.tokens?.total ?? 0;
			row.errors += node.status === "failed" ? 1 : 0;
			rows.set(key, row);
		};
		for (const totals of this.folded.values()) {
			const key = `${totals.kind}:${totals.name}`;
			const row = rows.get(key) ?? {
				kind: totals.kind,
				name: totals.name,
				count: 0,
				totalDurationMs: 0,
				avgDurationMs: 0,
				totalTokens: 0,
				errors: 0,
			};
			row.count += totals.count;
			row.totalDurationMs += totals.totalDurationMs;
			row.totalTokens += totals.totalTokens;
			row.errors += totals.errors;
			rows.set(key, row);
		}
		for (const node of this.nodes) accumulate(node);
		const result = [...rows.values()];
		for (const row of result) row.avgDurationMs = Math.round(row.totalDurationMs / row.count);
		if (sortBy === "duration") result.sort((a, b) => b.totalDurationMs - a.totalDurationMs);
		else if (sortBy === "tokens") result.sort((a, b) => b.totalTokens - a.totalTokens);
		else result.sort((a, b) => b.errors - a.errors);
		return result;
	}

	private upsert(next: TrajectoryNode): void {
		const existing = this.byId.get(next.id);
		if (existing) {
			Object.assign(existing, next);
			return;
		}
		this.nodes.push(next);
		this.byId.set(next.id, next);
		while (this.nodes.length > NODE_LIMIT) {
			const evicted = this.nodes.shift()!;
			this.byId.delete(evicted.id);
			this.fold(evicted);
		}
	}

	private fold(node: TrajectoryNode): void {
		const key = `${node.kind}:${node.name}`;
		const totals = this.folded.get(key) ?? {
			kind: node.kind,
			name: node.name,
			count: 0,
			totalDurationMs: 0,
			totalTokens: 0,
			errors: 0,
		};
		totals.count += 1;
		totals.totalDurationMs += node.durationMs ?? 0;
		if (node.kind !== "compaction") totals.totalTokens += node.tokens?.total ?? 0;
		totals.errors += node.status === "failed" ? 1 : 0;
		this.folded.set(key, totals);
	}
}
