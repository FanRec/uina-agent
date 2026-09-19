import type { HostEvent } from "../../../src/host/events.js";

/**
 * 宿主事件监听收集器（EventCollector / Spy）：
 * 按严格发生时序记录所有 HostEvent，并提供事件等待、类型过滤与时序断言。
 */
export class EventCollector {
	readonly events: HostEvent[] = [];

	get all(): readonly HostEvent[] {
		return this.events;
	}

	get errors(): Array<Extract<HostEvent, { type: "error" }>> {
		return this.filter("error");
	}
	private readonly waitQueue: Array<{
		predicate: (e: HostEvent) => boolean;
		resolve: (e: HostEvent) => void;
	}> = [];

	listener = (event: HostEvent): void => {
		this.events.push(event);

		// 检查是否有等待中的 Promise
		for (let i = this.waitQueue.length - 1; i >= 0; i--) {
			const item = this.waitQueue[i];
			if (item.predicate(event)) {
				this.waitQueue.splice(i, 1);
				item.resolve(event);
			}
		}
	};

	filter<T extends HostEvent["type"]>(type: T): Array<Extract<HostEvent, { type: T }>> {
		return this.events.filter((e): e is Extract<HostEvent, { type: T }> => e.type === type);
	}

	find<T extends HostEvent["type"]>(type: T): Extract<HostEvent, { type: T }> | undefined {
		return this.events.find((e): e is Extract<HostEvent, { type: T }> => e.type === type);
	}

	has(type: HostEvent["type"]): boolean {
		return this.events.some((e) => e.type === type);
	}

	/** 等待特定类型的事件产生 */
	waitFor<T extends HostEvent["type"]>(type: T, timeoutMs = 5000): Promise<Extract<HostEvent, { type: T }>> {
		// 如果此前已经发生过，是否立即返回？
		// 遵循事件流第一性：waitFor 默认等待下一个符合条件的事件，或者从已有中找？
		// 优化：如果有未消费的直接返回，否则入队等待
		return new Promise<Extract<HostEvent, { type: T }>>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waitQueue.findIndex((item) => item.resolve === (resolve as unknown));
				if (idx >= 0) this.waitQueue.splice(idx, 1);
				reject(new Error(`等待事件 '${type}' 超时 (${timeoutMs}ms)`));
			}, timeoutMs);

			this.waitQueue.push({
				predicate: (e) => e.type === type,
				resolve: (e) => {
					clearTimeout(timer);
					resolve(e as Extract<HostEvent, { type: T }>);
				},
			});
		});
	}

	clear(): void {
		this.events.length = 0;
	}
}
