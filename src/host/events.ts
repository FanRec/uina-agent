import type { QueuedMessage } from "../agent/queue.js";
import type { ContextSnapshot, ThinkingLevel } from "../core/types.js";
import type { RuntimeEvent } from "../runtime/events.js";

/**
 * 宿主 → 消费者的有序事件流。
 *
 * 主体对外**唯一**的观察面 = 事实单流（RuntimeEvent，1:1 透传，不做任何翻译）
 * 加一个宿主域事件（notice：宿主生命周期提示，如扩展重载进度——它不是主体的
 * 事实，主体词汇表不收它）。任何消费者（TUI、stdio、未来的 TTS 或远程观察者）
 * 都通过 subscribe() 收到同一份序列；宿主不知道谁在监听，也不引用任何 UI 类型。
 * 消费者可以随时接入或断开，主体的生命期不受影响。
 */
export type HostEvent = RuntimeEvent | HostNoticeEvent;

export interface HostNoticeEvent {
	readonly type: "notice";
	readonly text: string;
}

export type HostEventListener = (event: HostEvent) => void;

/**
 * 事件 + 宿主派发时刻。`at` 是唯一权威的时间事实：消费者不得再用接收时刻
 * 替代（Presentation Core 的 ingest 直接读取它）。包装不改变 `event` 本身。
 */
export interface HostEventRecord {
	readonly at: number;
	readonly event: HostEvent;
}

export type HostEventRecordListener = (record: HostEventRecord) => void;

/** Consumer snapshot: stable Host facts, independent of any UI implementation. */
export interface HostSnapshot {
	readonly modelName: string;
	readonly thinkingLevels?: readonly ThinkingLevel[];
	readonly thinkingLevel?: ThinkingLevel;
	readonly context?: ContextSnapshot;
	readonly busy: boolean;
	readonly queue: readonly QueuedMessage[];
	readonly queueDepth: number;
	readonly queueOldestAgeMs?: number;
}
