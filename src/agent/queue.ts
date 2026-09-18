import { randomUUID } from "node:crypto";
import type { DeliveryMode } from "../core/types.js";
import type { QueuedInput } from "../session/types.js";

export type QueuedMessage = QueuedInput;

export class InputQueues {
	private order = 0;
	private readonly enqueuedAt = new Map<string, number>();
	private readonly steer: QueuedMessage[] = [];
	private readonly followUp: QueuedMessage[] = [];

	create(text: string, mode: Exclude<DeliveryMode, "direct">, extra: Pick<QueuedMessage, "source" | "data" | "images"> = {}): QueuedMessage {
		return {
			id: randomUUID(),
			order: ++this.order,
			mode,
			text,
			...extra,
		};
	}

	add(item: QueuedMessage): void {
		this.queueFor(item.mode).push({ ...item });
		this.enqueuedAt.set(item.id, Date.now());
	}

	remove(id: string): QueuedMessage | undefined {
		for (const queue of [this.steer, this.followUp]) {
			const index = queue.findIndex((item) => item.id === id);
			if (index >= 0) { this.enqueuedAt.delete(id); return queue.splice(index, 1)[0]; }
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
			this.enqueuedAt.set(item.id, Date.now());
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
		this.enqueuedAt.clear();
		return items;
	}

	get size(): number {
		return this.steer.length + this.followUp.length;
	}

	oldestAgeMs(now = Date.now()): number | undefined {
		const oldest = this.all()[0];
		const created = oldest ? this.enqueuedAt.get(oldest.id) : undefined;
		return created === undefined ? undefined : Math.max(0, now - created);
	}

	private queueFor(mode: Exclude<DeliveryMode, "direct">): QueuedMessage[] {
		return mode === "steer" ? this.steer : this.followUp;
	}
}
