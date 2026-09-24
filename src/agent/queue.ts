import { randomUUID } from "node:crypto";
import type { DeliveryMode } from "../core/types.js";
import type { QueuedInput } from "../session/types.js";

export type QueuedMessage = QueuedInput;

export class InputQueues {
	private order = 0;
	private readonly steer: QueuedMessage[] = [];
	private readonly followUp: QueuedMessage[] = [];

	create(text: string, mode: Exclude<DeliveryMode, "direct">, extra: Pick<QueuedMessage, "source" | "data" | "images" | "receivedAt"> = {}): QueuedMessage {
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
