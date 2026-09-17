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
