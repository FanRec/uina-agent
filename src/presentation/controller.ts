/**
 * 展示控制器：事实、投影、轨迹、会话快照与动作的唯一协调者。
 *
 * 平台中立：这里不持有终端、宽度、颜色、布局或时钟；任何 Surface（TUI、未来的
 * Web）只从 `view()` / `subscribe()` 取数据，并把自己的输入经 `dispatch()` 发出。
 * 时间全部来自 `HostEventRecord.at` 或 journal 时间戳，缺失即未知。
 */

import type { HostEventRecord, HostSnapshot } from "../host/events.js";
import type { SessionCustomEntryRecord, SessionEntry, SessionEventRecord } from "../session/types.js";
import type { PresentationIntent } from "./actions.js";
import { FactStore } from "./facts.js";
import { ingestLive } from "./ingest-live.js";
import { ingestReplay } from "./ingest-replay.js";
import { PresentationProjection, type PresentationNode } from "./projection.js";
import { TrajectoryProjection, type TrajectoryNode } from "./trajectory.js";

export interface PresentationView {
	readonly transcript: readonly PresentationNode[];
	readonly trajectory: readonly TrajectoryNode[];
	readonly session?: HostSnapshot;
}

/** 增量变更：`append` 是新节点，`update` 是同一稳定 ID 的结算，`replace` 是恢复/回溯。 */
export type PresentationChange =
	| { readonly kind: "append"; readonly nodes: readonly PresentationNode[] }
	| { readonly kind: "update"; readonly node: PresentationNode }
	| { readonly kind: "replace"; readonly view: PresentationView };

export type PresentationChangeListener = (change: PresentationChange) => void;

export class PresentationController {
	private readonly facts = new FactStore();
	private readonly projection = new PresentationProjection();
	private readonly trajectoryProjection = new TrajectoryProjection();
	private readonly known = new Set<string>();
	private readonly listeners = new Set<PresentationChangeListener>();
	private intentSink?: (intent: PresentationIntent) => void;
	private session?: HostSnapshot;

	/**
	 * 摄取一条宿主事件记录：事实追加 → 投影 → 轨迹 → 变更通知。
	 * 返回本次产生或更新的节点，供 Surface 做事件级渲染决策。
	 */
	ingest(record: HostEventRecord): readonly PresentationNode[] {
		const changed: PresentationNode[] = [];
		for (const draft of ingestLive(record)) {
			const fact = this.facts.append(draft);
			for (const node of this.projection.apply(fact)) {
				changed.push(node);
				this.trajectoryProjection.apply(node);
				this.publish(node);
			}
			// 错误与压缩不是 PresentationNode：轨迹保留它们的审计事实，正文由 Surface 表达。
			if (fact.kind === "error") this.trajectoryProjection.onError(fact.text, fact.at);
			if (fact.kind === "compaction.ended" && fact.status === "completed") {
				this.trajectoryProjection.onCompaction(fact.summary ?? "会话已压缩", fact.tokensBefore, fact.at);
			}
		}
		return changed;
	}

	/**
	 * 恢复/回溯：用 journal 事实整段重建投影与轨迹，不保留旧节点。
	 * `activeTurn` 来自回溯事件载荷；缺失时保持重放派生的归属，不猜回合号。
	 */
	replaceAll(
		entries: readonly SessionEntry[],
		auxiliary: readonly (SessionEventRecord | SessionCustomEntryRecord)[] = [],
		activeTurn?: number,
	): PresentationView {
		this.facts.replaceAll(ingestReplay({ entries, auxiliary }));
		this.projection.reset();
		this.projection.applyAll(this.facts.list());
		if (activeTurn !== undefined) this.projection.continueTurn(activeTurn);
		this.trajectoryProjection.replaceAll(this.projection.list());
		this.known.clear();
		for (const node of this.projection.list()) this.known.add(node.id);
		const view = this.view();
		this.notify({ kind: "replace", view });
		return view;
	}

	/** 宿主快照只描述会话状态，不伪造展示节点。 */
	applySnapshot(snapshot: HostSnapshot): void {
		this.session = snapshot;
	}

	view(): PresentationView {
		return {
			transcript: this.projection.list(),
			trajectory: this.trajectoryProjection.list(),
			...(this.session === undefined ? {} : { session: this.session }),
		};
	}

	subscribe(listener: PresentationChangeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Surface 的输入出口；未接 sink 时动作丢弃（主体不依赖任何 Surface 存活）。 */
	onIntent(sink: (intent: PresentationIntent) => void): () => void {
		this.intentSink = sink;
		return () => {
			if (this.intentSink === sink) this.intentSink = undefined;
		};
	}

	dispatch(intent: PresentationIntent): void {
		this.intentSink?.(intent);
	}

	/** 轨迹看板的数据源；生命周期由控制器持有，Surface 只读。 */
	get trajectory(): TrajectoryProjection {
		return this.trajectoryProjection;
	}

	private publish(node: PresentationNode): void {
		if (this.known.has(node.id)) {
			this.notify({ kind: "update", node });
			return;
		}
		this.known.add(node.id);
		this.notify({ kind: "append", nodes: [node] });
	}

	private notify(change: PresentationChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
