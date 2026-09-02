import { randomUUID } from "node:crypto";
import type { DeliveryMode, QueueMode } from "../core/types.js";
import type { QueuedInput } from "../session/types.js";

export type QueuedMessage = QueuedInput;

export class InputQueues {
	private order = 0;
	private readonly steer: QueuedMessage[] = [];
	private readonly followUp: QueuedMessage[] = [];

	enqueue(text: string, mode: Exclude<DeliveryMode, "direct">): QueuedMessage {
		const item = this.create(text, mode);
		this.add(item);
		return item;
	}

	create(text: string, mode: Exclude<DeliveryMode, "direct">): QueuedMessage {
		return {
			id: randomUUID(),
			order: ++this.order,
			mode,
			text,
		};
	}

	add(item: QueuedMessage): void {
		this.queueFor(item.mode).push({ ...item });
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

	peekMany(mode: Exclude<DeliveryMode, "direct">, queueMode: QueueMode): QueuedMessage[] {
		const queue = this.queueFor(mode);
		return queueMode === "all" ? [...queue] : queue.slice(0, 1);
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
		return [...this.steer, ...this.followUp].sort((a, b) => a.order - b.order);
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

	private queueFor(mode: Exclude<DeliveryMode, "direct">): QueuedMessage[] {
		return mode === "steer" ? this.steer : this.followUp;
	}
}
