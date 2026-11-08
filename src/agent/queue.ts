import { randomUUID } from "node:crypto";
import type { DeliveryMode } from "../core/types.js";
import type { QueuedInput } from "../session/types.js";

export type QueuedMessage = QueuedInput;

/** 一回合最多带多少条排队输入一起决策。 */
export const MAX_TURN_ITEMS = 8;
/** 一回合最多带多少字符正文；单条超长时仍会领走它，否则它永远出不去。 */
export const MAX_TURN_CHARS = 6000;

export interface TurnBatchPolicy {
	/** 一回合最多带多少条。 */
	maxItems: number;
	/** 一回合最多带多少字符正文。 */
	maxChars: number;
}

const DEFAULT_BATCH: TurnBatchPolicy = { maxItems: MAX_TURN_ITEMS, maxChars: MAX_TURN_CHARS };

/** Runtime 来源的 followUp：合批消费防事件风暴独占唯一 active run；合批依据是来源种类，不属于任何具体频道。 */
export function isRuntimeFollowUp(item: QueuedMessage): boolean {
	return item.mode === "followUp" && item.source?.kind === "runtime";
}

export class InputQueues {
	private order = 0;
	private readonly steer: QueuedMessage[] = [];
	private readonly followUp: QueuedMessage[] = [];

	create(
		text: string,
		mode: Exclude<DeliveryMode, "direct">,
		extra: Pick<QueuedMessage, "source" | "data" | "images" | "receivedAt"> = {},
	): QueuedMessage {
		return {
			id: randomUUID(),
			order: ++this.order,
			mode,
			text,
			receivedAt: new Date().toISOString(),
			...extra,
		};
	}

	add(item: QueuedMessage): void {
		// 按 order 插入：rollback 复用本方法，不能让回滚条目改变同 mode 的真实消费顺序
		//（peek 取原始数组头部，all() 的排序只美化快照、不修复 peek 的消费次序）。
		const queue = this.queueFor(item.mode);
		const index = queue.findIndex((existing) => existing.order > item.order);
		if (index >= 0) queue.splice(index, 0, { ...item });
		else queue.push({ ...item });
	}

	remove(id: string): QueuedMessage | undefined {
		for (const queue of [this.steer, this.followUp]) {
			const index = queue.findIndex((item) => item.id === id);
			if (index >= 0) return queue.splice(index, 1)[0];
		}
		return undefined;
	}

	peek(mode: Exclude<DeliveryMode, "direct">): QueuedMessage | undefined {
		return this.queueFor(mode)[0];
	}

	peekMany(mode: Exclude<DeliveryMode, "direct">): QueuedMessage[] {
		return [...this.queueFor(mode)];
	}

	seed(items: readonly QueuedMessage[]): void {
		for (const item of items) {
			this.order = Math.max(this.order, item.order);
			this.queueFor(item.mode).push({ ...item });
		}
		this.steer.sort((a, b) => a.order - b.order);
		this.followUp.sort((a, b) => a.order - b.order);
	}

	/**
	 * 算出这一回合要消费的条目，只算不改（所有权转移仍归 startRun 的移除点）。
	 *
	 * 三条边界：steer 先走且单独成批（它是立刻改变方向的一句话）；非运行时来源不合批
	 * （用户的真实发言不能被别的消息挤进同一句）；运行时来源只在同一世界内合并。
	 *
	 * 预算是硬边界：超了只领前缀，剩下的留在队列里等下一回合——回合成功后会自动续跑，
	 * 所以积压再深也不会把一次请求撑爆。预算只在已经领到东西之后才起作用：单条就超长时
	 * 也必须先领走，否则它永远出不去。
	 */
	batchForTurn(policy: TurnBatchPolicy = DEFAULT_BATCH): QueuedMessage[] | undefined {
		const first = this.steer[0] ?? this.followUp[0];
		if (!first) return undefined;
		if (!isRuntimeFollowUp(first)) return [first];
		const world = first.source?.ref;
		const batch: QueuedMessage[] = [];
		let chars = 0;
		for (const candidate of this.followUp) {
			if (!isRuntimeFollowUp(candidate)) break;
			if (world !== undefined && candidate.source?.ref !== world) break;
			const full = batch.length >= policy.maxItems || chars + candidate.text.length > policy.maxChars;
			if (batch.length > 0 && full) break;
			batch.push(candidate);
			chars += candidate.text.length;
		}
		return batch;
	}

	all(): QueuedMessage[] {
		const merged: QueuedMessage[] = [];
		let steerIndex = 0;
		let followUpIndex = 0;

		while (steerIndex < this.steer.length || followUpIndex < this.followUp.length) {
			const steer = this.steer[steerIndex];
			const followUp = this.followUp[followUpIndex];
			const takeFollowUp = !steer || (followUp !== undefined && followUp.order < steer.order);
			const next = takeFollowUp ? followUp : steer;
			if (!next) break;
			merged.push(next);
			if (takeFollowUp) {
				followUpIndex++;
			} else {
				steerIndex++;
			}
		}

		return merged;
	}

	takeAll(): QueuedMessage[] {
		const items = this.all();
		this.steer.length = 0;
		this.followUp.length = 0;
		return items;
	}

	get size(): number {
		return this.steer.length + this.followUp.length;
	}

	oldestAgeMs(now = Date.now()): number | undefined {
		const steer = this.steer[0];
		const followUp = this.followUp[0];
		const oldest = this.oldestByReceivedAt(steer, followUp);
		if (!oldest) return undefined;
		const receivedAt = oldest.receivedAt ? Date.parse(oldest.receivedAt) : Number.NaN;
		return Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : undefined;
	}

	has(id: string): boolean {
		return this.steer.some((item) => item.id === id) || this.followUp.some((item) => item.id === id);
	}

	private oldestByReceivedAt(first?: QueuedMessage, second?: QueuedMessage): QueuedMessage | undefined {
		if (!first) return second;
		if (!second) return first;
		const firstTime = Date.parse(first.receivedAt ?? "");
		const secondTime = Date.parse(second.receivedAt ?? "");
		if (!Number.isFinite(firstTime)) return second;
		if (!Number.isFinite(secondTime)) return first;
		return firstTime <= secondTime ? first : second;
	}

	private queueFor(mode: Exclude<DeliveryMode, "direct">): QueuedMessage[] {
		return mode === "steer" ? this.steer : this.followUp;
	}
}
