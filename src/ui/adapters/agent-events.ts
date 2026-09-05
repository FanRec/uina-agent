import type { ToolResultStatus } from "../../core/types.js";
/**
 * Agent 运行时事件适配器与轨迹只读投影（TrajectoryProjection）。
 * 接收 Subject 生命周期 hooks，向 Transcript 分发内容并构建真实时间线时序节点，杜绝任何假数据。
 */

import type {
	HotspotRow,
	TrajectoryEventSource,
	TrajectoryNode,
} from "../components/overlays/trajectory-scene.js";

export class TrajectoryProjection implements TrajectoryEventSource {
	private readonly nodes: TrajectoryNode[] = [];
	private readonly listeners = new Set<() => void>();
	private currentTurnN = 0;
	private turnStartTime = 0;

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {}
		}
	}

	list(): readonly TrajectoryNode[] {
		return this.nodes;
	}

	onTurnStart(n: number, userText: string): void {
		this.currentTurnN = n;
		this.turnStartTime = Date.now();

		this.nodes.push({
			id: `turn-${n}-${Date.now()}`,
			turn: n,
			kind: "turn_start",
			label: `用户提问: ${userText.slice(0, 40)}`,
			status: "completed",
			startedAt: this.turnStartTime,
			endedAt: this.turnStartTime,
			durationMs: 0,
		});
		this.notify();
	}

	onThinkingStart(preview = "深度推理"): string {
		const id = `think-${Date.now()}`;
		this.nodes.push({
			id,
			turn: this.currentTurnN,
			kind: "thinking",
			label: preview,
			status: "running",
			startedAt: Date.now(),
		});
		this.notify();
		return id;
	}

	onThinkingDone(id: string, fullPreview?: string): void {
		const node = this.nodes.find((n) => n.id === id);
		if (node) {
			node.status = "completed";
			node.endedAt = Date.now();
			node.durationMs = Math.max(1, node.endedAt - node.startedAt);
			if (fullPreview) node.resultPreview = fullPreview.slice(0, 100);
			this.notify();
		}
	}

	onToolStart(name: string, args: unknown, callId?: string): string {
		const id = callId ?? `tool-${name}-${Date.now()}`;
		this.nodes.push({
			id,
			turn: this.currentTurnN,
			kind: "tool_call",
			label: name,
			status: "running",
			startedAt: Date.now(),
			argsJson: typeof args === "string" ? args : JSON.stringify(args),
		});
		this.notify();
		return id;
	}

	onToolDone(id: string, name: string, result: string, elapsedMs = 0, status: ToolResultStatus = "unknown"): void {
		const node = this.nodes.find((n) => n.id === id) ??
			[...this.nodes].reverse().find((n) => n.kind === "tool_call" && n.label === name && n.status === "running");

		if (node) {
			node.status = status === "succeeded" ? "completed" : status;
			node.endedAt = Date.now();
			node.durationMs = elapsedMs || Math.max(1, node.endedAt - node.startedAt);
			node.resultPreview = result.slice(0, 100);
			if (status === "failed") node.error = result;
			this.notify();
		}
	}

	onTurnEnd(n: number, usage?: { usedTokens: number; contextWindow?: number }): void {
		const now = Date.now();
		const elapsed = Math.max(1, now - this.turnStartTime);

		this.nodes.push({
			id: `stream-${n}-${now}`,
			turn: n,
			kind: "model_stream",
			label: `回复生成 (Turn #${n})`,
			status: "completed",
			startedAt: this.turnStartTime,
			endedAt: now,
			durationMs: elapsed,
			tokens: usage ? { total: usage.usedTokens } : undefined,
		});
		this.notify();
	}

	onError(msg: string): void {
		this.nodes.push({
			id: `err-${Date.now()}`,
			turn: this.currentTurnN,
			kind: "error",
			label: msg.slice(0, 50),
			status: "failed",
			startedAt: Date.now(),
			endedAt: Date.now(),
			durationMs: 0,
			error: msg,
		});
		this.notify();
	}

	onCompaction(summary: string, tokensBefore: number): void {
		this.nodes.push({
			id: `comp-${Date.now()}`,
			turn: this.currentTurnN,
			kind: "compaction",
			label: "会话历史压缩",
			status: "completed",
			startedAt: Date.now(),
			endedAt: Date.now(),
			durationMs: 0,
			resultPreview: summary.slice(0, 80),
			tokens: { total: tokensBefore },
		});
		this.notify();
	}

	aggregate(sortBy: "duration" | "tokens" | "errors" = "duration"): HotspotRow[] {
		const map = new Map<string, HotspotRow>();

		for (const n of this.nodes) {
			const key = `${n.kind}:${n.label}`;
			const existing = map.get(key);
			const dur = n.durationMs ?? (n.endedAt ? n.endedAt - n.startedAt : 0);
			const tok = n.tokens?.total ?? 0;
			const err = n.status === "failed" ? 1 : 0;

			if (existing) {
				existing.count++;
				existing.totalDurationMs += dur;
				existing.avgDurationMs = Math.round(existing.totalDurationMs / existing.count);
				existing.totalTokens += tok;
				existing.errors += err;
			} else {
				map.set(key, {
					kind: n.kind,
					name: n.label,
					count: 1,
					totalDurationMs: dur,
					avgDurationMs: dur,
					totalTokens: tok,
					errors: err,
				});
			}
		}

		const rows = Array.from(map.values());
		if (sortBy === "duration") {
			rows.sort((a, b) => b.totalDurationMs - a.totalDurationMs);
		} else if (sortBy === "tokens") {
			rows.sort((a, b) => b.totalTokens - a.totalTokens);
		} else if (sortBy === "errors") {
			rows.sort((a, b) => b.errors - a.errors);
		}
		return rows;
	}
}
