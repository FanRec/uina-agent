import { randomUUID } from "node:crypto";
import type { DeliveryMode } from "../core/types.js";
import type { QueuedInput } from "../session/types.js";

export type QueuedMessage = QueuedInput;

export class InputQueues {
	private order = 0;
	private readonly steer: QueuedMessage[] = [];
	private readonly followUp: QueuedMessage[] = [];

	enqueue(text: string, mode: Exclude<DeliveryMode, "direct">): QueuedMessage {
		const item: QueuedMessage = {
			id: randomUUID(),
			order: ++this.order,
			mode,
			text,
		};
		(mode === "steer" ? this.steer : this.followUp).push(item);
		return item;
	}

	seed(items: readonly QueuedMessage[]): void {
		for (const item of items) {
			this.order = Math.max(this.order, item.order);
			(this[item.mode] as QueuedMessage[]).push({ ...item });
		}
		this.steer.sort((a, b) => a.order - b.order);
		this.followUp.sort((a, b) => a.order - b.order);
	}

	drainSteer(): QueuedMessage[] {
		return this.steer.splice(0);
	}

	takeSteer(): QueuedMessage | undefined {
		return this.steer.shift();
	}

	drainFollowUp(): QueuedMessage[] {
		return this.followUp.splice(0);
	}

	takeFollowUp(): QueuedMessage | undefined {
		return this.followUp.shift();
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
}
