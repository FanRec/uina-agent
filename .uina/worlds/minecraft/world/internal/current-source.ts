/**
 * Driver 当前事实源的水位跟踪（docs/proposals/mc/modules/world.md §9.2）。
 *
 * 对每个当前事实源维护：
 * - H：最新观察到的同 epoch stamp；
 * - C：已连续精确分类或已保守覆盖的源水位。
 *
 * 一个恰好接续 C 的 changed notice 可按其范围精确分类；合并、跳号、乱序或
 * 检查点 H>C 而无法证明 (C,H] 范围完整时，先发布一次全源保守失效，再把 C 推到 H。
 * 同一 H 的保守失效只入账一次；迟到的 <=C 范围只细化，不重复分配失效水位。
 * reset 仅用于 epoch/来源断裂（gap 走保守失效，不用 reset 补事实）。
 */

import type { ClientFactNotice, ClientFactStamp } from "../../contracts/client-facts.js";
import type { Ref } from "../../contracts/values.js";

export interface CurrentSourceEvents {
	/** 精确分类的当前变化（连续 notice）。 */
	preciseChanged(refs: Ref[]): void;
	/** 全源保守失效（范围未知；refs 为空不承诺穷举）。 */
	conservativeInvalidation(): void;
	/** 源 epoch/实例断裂，当前 cursor 无法对账。 */
	sourceEpochChanged(reason: "epoch_changed" | "stream_changed"): void;
}

interface SourceState {
	epoch: string;
	/** 已连续分类或保守覆盖的水位。 */
	classifiedThrough: number;
	/** 是否已观察过该源（首次观察只建立基线，不发布失效）。 */
	observed: boolean;
}

export class CurrentSourceTracker {
	private sources = new Map<string, SourceState>();
	private closed = false;

	constructor(private readonly events: CurrentSourceEvents) {}

	/** 订阅/采样得到的 stamp：纳入水位，必要时保守失效。 */
	observeStamp(stamp: ClientFactStamp): void {
		if (this.closed) return;
		const state = this.sources.get(stamp.source);
		if (!state || state.epoch !== stamp.epoch) {
			// 新源或新 epoch：若此前观察过旧 epoch，当前 cursor 无法对账 → reset。
			if (state) this.events.sourceEpochChanged("epoch_changed");
			this.sources.set(stamp.source, {
				epoch: stamp.epoch,
				classifiedThrough: stamp.sequence,
				observed: true,
			});
			return;
		}
		if (stamp.sequence > state.classifiedThrough) {
			// 检查点 H>C，无法证明 (C,H] 范围完整 → 保守失效后推进。
			this.events.conservativeInvalidation();
			state.classifiedThrough = stamp.sequence;
			return;
		}
		if (stamp.sequence < state.classifiedThrough) {
			// stamp 回退：协议异常；不回退水位，仅忽略（不伪造分类）。
			return;
		}
		// sequence === C：已纳入，无新失效。
	}

	/** Driver 通知：精确分类或保守覆盖。 */
	observeNotice(notice: ClientFactNotice): void {
		if (this.closed) return;
		if (notice.kind === "evidence" || notice.kind === "evidence_gap" || notice.kind === "evidence_end") {
			return; // 证据路径归接收引擎，不参与当前水位。
		}
		if (notice.kind === "reset") {
			if (notice.reason === "gap") {
				// gap 不用 reset 补事实：保守失效后以新 stamp 重新基线。
				this.observeStamp(notice.stamp);
				return;
			}
			// connection/incarnation/source_rebuilt：当前事实源实例断裂。
			// 统一走 observeStamp：epoch 变化触发 sourceEpochChanged；
			// epoch 未变但连接重建时 Driver 已声明通知连续性断裂，仍需保守失效。
			const state = this.sources.get(notice.stamp.source);
			const epochChanged = !state || state.epoch !== notice.stamp.epoch;
			this.observeStamp(notice.stamp);
			if (!epochChanged) this.events.conservativeInvalidation();
			return;
		}
		// changed：精确分类的前提是恰好接续 C。
		const state = this.sources.get(notice.stamp.source);
		if (!state || state.epoch !== notice.stamp.epoch) {
			// 未见过的源/epoch：先建立基线（含可能的 epoch reset），再按跳号规则处理。
			this.observeStamp(notice.stamp);
			return;
		}
		if (notice.stamp.sequence === state.classifiedThrough + 1) {
			state.classifiedThrough = notice.stamp.sequence;
			this.events.preciseChanged(notice.changed);
			return;
		}
		if (notice.stamp.sequence > state.classifiedThrough + 1) {
			// 跳号/合并：无法证明 (C,H] 完整 → 保守。
			this.events.conservativeInvalidation();
			state.classifiedThrough = notice.stamp.sequence;
			return;
		}
		// 迟到的 <=C 通知：只细化，不重复分配失效（调用方若保存了精确索引可自行细化）。
	}
}
