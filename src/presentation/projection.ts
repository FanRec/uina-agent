/**
 * 展示投影层：Fact -> PresentationNode。
 *
 * 只做语义归并，不做布局。节点身份稳定且与展示面无关：
 *   - 回合：`turn:${n}`
 *   - 思考块：`turn:${n}:thinking:${i}`
 *   - 工具：`turn:${n}:tool:${callId}`
 *
 * 时间一律来自 Fact 的 `at`：两端都已知才产生 `durationMs`，
 * 缺任一端保持 undefined，绝不以当前时钟补齐。
 *
 * 一条事实可以同时结算多个节点（例如回合中止会结算该回合所有在途工具），
 * 因此 `apply` 返回本次变更的节点列表，顺序即展示顺序。
 */

import type { ImageContent } from "../core/content.js";
import type { RequestUsage, ToolResultStatus } from "../core/types.js";
import type { FactPayload } from "./facts.js";

export type TurnStatus = "running" | "completed" | "aborted";

export interface TurnNode {
	readonly kind: "turn";
	readonly id: string;
	readonly turn: number;
	readonly userText: string;
	readonly images?: readonly ImageContent[];
	status: TurnStatus;
	readonly startedAt?: number;
	endedAt?: number;
	usage?: RequestUsage;
}

export interface ThinkingNode {
	readonly kind: "thinking";
	readonly id: string;
	readonly turn: number;
	text: string;
	/** `running` 是进行态；关闭时只可能是 completed 或 cancelled。 */
	status: "running" | "completed" | "cancelled";
	readonly startedAt?: number;
	endedAt?: number;
	durationMs?: number;
}

export interface ToolNode {
	readonly kind: "tool";
	readonly id: string;
	readonly turn: number;
	readonly callId: string;
	name: string;
	args?: unknown;
	/** `running` 是进行态；其余五态直接使用 ToolResultStatus 词汇。 */
	status: "running" | ToolResultStatus;
	readonly startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	result?: string;
	details?: unknown;
	images?: readonly ImageContent[];
}

export type PresentationNode = TurnNode | ThinkingNode | ToolNode;

/** 投影只消费载荷与时刻；序号与来源属于事实流，不参与归并。 */
export type ProjectionInput = FactPayload & { readonly at?: number };

export function turnNodeId(turn: number): string {
	return `turn:${turn}`;
}

export function thinkingNodeId(turn: number, index: number): string {
	return `turn:${turn}:thinking:${index}`;
}

export function toolNodeId(turn: number, callId: string): string {
	return `turn:${turn}:tool:${callId}`;
}

export function durationBetween(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
	if (startedAt === undefined || endedAt === undefined) return undefined;
	return Math.max(0, endedAt - startedAt);
}

/** 增量投影器：按 Fact 顺序维护节点；不持有终端、宽度或时钟。 */
export class PresentationProjection {
	private readonly nodes: PresentationNode[] = [];
	private readonly turns = new Map<number, TurnNode>();
	private readonly tools = new Map<string, ToolNode>();
	private readonly thinkingCounters = new Map<number, number>();
	private openThinking?: ThinkingNode;
	private currentTurn = 0;

	reset(): void {
		this.nodes.length = 0;
		this.turns.clear();
		this.tools.clear();
		this.thinkingCounters.clear();
		this.openThinking = undefined;
		this.currentTurn = 0;
	}

	applyAll(facts: readonly ProjectionInput[]): void {
		for (const fact of facts) this.apply(fact);
	}

	/** 回溯后当前回合由引擎给出；只影响后续 Fact 的归属，不伪造回合事实。 */
	continueTurn(turn: number): void {
		this.currentTurn = turn;
	}

	apply(fact: ProjectionInput): readonly PresentationNode[] {
		const at = fact.at;
		switch (fact.kind) {
			case "turn.started": {
				const node: TurnNode = {
					kind: "turn",
					id: turnNodeId(fact.turn),
					turn: fact.turn,
					userText: fact.userText,
					images: fact.images,
					status: "running",
					startedAt: at,
				};
				this.currentTurn = fact.turn;
				this.turns.set(fact.turn, node);
				this.nodes.push(node);
				return [node];
			}

			case "turn.ended":
			case "turn.aborted": {
				const node = this.turns.get(fact.turn);
				if (!node) return [];
				const closing = fact.kind === "turn.ended" ? "completed" : "cancelled";
				const thinking = this.closeThinking(closing, at);
				const changed: PresentationNode[] = [];
				if (thinking) changed.push(thinking);
				node.status = fact.kind === "turn.ended" ? "completed" : "aborted";
				node.endedAt = at;
				if (fact.kind === "turn.ended") node.usage = fact.usage;
				// 回合终态仍未结算的工具：中止是用户主动取消；正常结束却仍在跑说明
				// 缺少完成事实（恢复缺口），只能如实标为结果未知。
				const settled = this.settleRunningTools(fact.turn, fact.kind === "turn.aborted" ? "cancelled" : "unknown", at);
				changed.push(...settled);
				changed.push(node);
				return changed;
			}

			case "thinking.delta": {
				const open = this.openThinking;
				if (open && open.turn === this.currentTurn) {
					open.text += fact.text;
					return [open];
				}
				const closed = this.closeThinking("cancelled", at);
				const index = (this.thinkingCounters.get(this.currentTurn) ?? 0) + 1;
				this.thinkingCounters.set(this.currentTurn, index);
				const node: ThinkingNode = {
					kind: "thinking",
					id: thinkingNodeId(this.currentTurn, index),
					turn: this.currentTurn,
					text: fact.text,
					status: "running",
					startedAt: at,
				};
				this.nodes.push(node);
				this.openThinking = node;
				return closed ? [closed, node] : [node];
			}

			case "assistant.delta": {
				const closed = this.closeThinking("completed", at);
				return closed ? [closed] : [];
			}

			case "tool.started": {
				const closed = this.closeThinking("completed", at);
				const node: ToolNode = {
					kind: "tool",
					id: toolNodeId(this.currentTurn, fact.callId),
					turn: this.currentTurn,
					callId: fact.callId,
					name: fact.name,
					args: fact.args,
					status: "running",
					startedAt: at,
				};
				this.tools.set(fact.callId, node);
				this.nodes.push(node);
				return closed ? [closed, node] : [node];
			}

			case "tool.finished": {
				const closed = this.closeThinking("completed", at);
				const existing = this.tools.get(fact.callId);
				let node: ToolNode;
				if (existing) {
					if (fact.name.length > 0) existing.name = fact.name;
					if (existing.args === undefined) existing.args = fact.args;
					existing.status = fact.status;
					existing.result = fact.result;
					existing.details = fact.details;
					existing.images = fact.images;
					existing.endedAt = at;
					existing.durationMs = durationBetween(existing.startedAt, at);
					node = existing;
				} else {
					// 恢复缺口：只有完成事实、没有开始事实。保持时间为未知，不补零。
					node = {
						kind: "tool",
						id: toolNodeId(this.currentTurn, fact.callId),
						turn: this.currentTurn,
						callId: fact.callId,
						name: fact.name,
						args: fact.args,
						status: fact.status,
						endedAt: at,
						result: fact.result,
						details: fact.details,
						images: fact.images,
					};
					this.tools.set(fact.callId, node);
					this.nodes.push(node);
				}
				return closed ? [closed, node] : [node];
			}

			case "error": {
				const closed = this.closeThinking("cancelled", at);
				return closed ? [closed] : [];
			}

			// ── 这些 Fact 不产生展示节点：由域专属表面（状态行、卡片、面板）表达。 ──
			case "usage.reported":
			case "context.updated":
			case "context.prepared":
			case "model.selected":
			case "thinking.selected":
			case "compaction.started":
			case "compaction.progress":
			case "compaction.ended":
			case "notice":
			case "retry":
			case "retry.recovered":
			case "queue":
			case "external":
			case "custom.message":
			case "rewind":
				return [];

			default: {
				const _exhaustive: never = fact;
				return _exhaustive;
			}
		}
	}

	private closeThinking(status: "completed" | "cancelled", at: number | undefined): ThinkingNode | undefined {
		const node = this.openThinking;
		if (!node) return undefined;
		this.openThinking = undefined;
		node.status = status;
		node.endedAt = at;
		node.durationMs = durationBetween(node.startedAt, at);
		return node;
	}

	private settleRunningTools(turn: number, status: "cancelled" | "unknown", at: number | undefined): ToolNode[] {
		const settled: ToolNode[] = [];
		for (const node of this.tools.values()) {
			if (node.turn !== turn || node.status !== "running") continue;
			node.status = status;
			node.endedAt = at;
			node.durationMs = durationBetween(node.startedAt, at);
			settled.push(node);
		}
		return settled;
	}

	list(): readonly PresentationNode[] {
		return this.nodes;
	}

	tool(callId: string): ToolNode | undefined {
		return this.tools.get(callId);
	}

	turn(turn: number): TurnNode | undefined {
		return this.turns.get(turn);
	}
}
