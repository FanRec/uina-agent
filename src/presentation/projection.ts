/**
 * 展示投影层：Fact -> PresentationNode。
 *
 * 只做语义归并，不做布局。节点身份稳定且与展示面无关：
 *   - 回合：`turn:${n}`
 *   - 工具：`turn:${n}:tool:${callId}`
 *
 * 时间一律来自 Fact 的 `at`：两端都已知才产生 `durationMs`，
 * 缺任一端保持 undefined，绝不以当前时钟补齐。
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

export type PresentationNode = TurnNode | ToolNode;

/** 投影只消费载荷与时刻；序号与来源属于事实流，不参与归并。 */
export type ProjectionInput = FactPayload & { readonly at?: number };

export function turnNodeId(turn: number): string {
	return `turn:${turn}`;
}

export function toolNodeId(turn: number, callId: string): string {
	return `turn:${turn}:tool:${callId}`;
}

/** 增量投影器：按 Fact 顺序维护节点；不持有终端、宽度或时钟。 */
export class PresentationProjection {
	private readonly nodes: PresentationNode[] = [];
	private readonly turns = new Map<number, TurnNode>();
	private readonly tools = new Map<string, ToolNode>();
	private currentTurn = 0;

	reset(): void {
		this.nodes.length = 0;
		this.turns.clear();
		this.tools.clear();
		this.currentTurn = 0;
	}

	applyAll(facts: readonly ProjectionInput[]): void {
		for (const fact of facts) this.apply(fact);
	}

	/** 回溯后当前回合由引擎给出；只影响后续 Fact 的归属，不伪造回合事实。 */
	continueTurn(turn: number): void {
		this.currentTurn = turn;
	}

	apply(fact: ProjectionInput): PresentationNode | undefined {
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
				return node;
			}

			case "turn.ended":
			case "turn.aborted": {
				const node = this.turns.get(fact.turn);
				if (!node) return undefined;
				node.status = fact.kind === "turn.ended" ? "completed" : "aborted";
				node.endedAt = at;
				if (fact.kind === "turn.ended") node.usage = fact.usage;
				return node;
			}

			case "tool.started": {
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
				return node;
			}

			case "tool.finished": {
				const existing = this.tools.get(fact.callId);
				if (existing) {
					if (fact.name.length > 0) existing.name = fact.name;
					if (existing.args === undefined) existing.args = fact.args;
					existing.status = fact.status;
					existing.result = fact.result;
					existing.details = fact.details;
					existing.images = fact.images;
					existing.endedAt = at;
					existing.durationMs =
						existing.startedAt === undefined || existing.endedAt === undefined
							? undefined
							: Math.max(0, existing.endedAt - existing.startedAt);
					return existing;
				}
				// 恢复缺口：只有完成事实、没有开始事实。保持时间为未知，不补零。
				const node: ToolNode = {
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
				return node;
			}

			// ── 其余 Fact 在后续批次投影（W2b/W2c）；本批不产生节点。 ──
			case "thinking.delta":
			case "assistant.delta":
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
			case "error":
			case "rewind":
				return undefined;

			default: {
				const _exhaustive: never = fact;
				return _exhaustive;
			}
		}
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
