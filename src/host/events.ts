import type { ContextSegments, ToolResultStatus } from "../core/types.js";
import type { QueuedMessage } from "../agent/queue.js";
import type { CustomEntry, CustomMessage } from "../extensions/ui-contract.js";

/**
 * 宿主 → 消费者的有序事件流。
 *
 * 这是主体对外**唯一**的观察面。任何消费者（TUI、stdio、未来的 TTS 或远程观察者）
 * 都通过 subscribe() 收到同一份序列；宿主不知道谁在监听，也不引用任何 UI 类型。
 * 消费者可以随时接入或断开，主体的生命期不受影响。
 */
export type HostEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "turn_start"; n: number; text: string; images?: readonly import("../core/content.js").ImageContent[] }
	| {
			type: "turn_end";
			n: number;
			usage?: {
				usedTokens: number;
				contextWindow?: number;
				actual?: boolean;
				cacheRead?: number;
				cacheWrite?: number;
				inputTokens?: number;
				outputTokens?: number;
				segments?: ContextSegments;
			};
		}
	| { type: "error"; text: string }
	| { type: "notice"; text: string }
	| { type: "turn_aborted"; n: number }
	| { type: "tool_start"; name: string; args: unknown; callId?: string }
	| {
			type: "tool_done";
			name: string;
			result: string;
   images?: import("../core/content.js").ImageContent[];
   details?: unknown;
			status?: ToolResultStatus;
			callId?: string;
			/** 工具开始时刻，由宿主测量，消费者不再自行维护计时表。 */
			ts?: number;
			elapsedMs?: number;
		}
	| { type: "queue"; items: readonly QueuedMessage[] }
	| { type: "custom_message"; message: CustomMessage }
	| { type: "custom_entry"; entry: CustomEntry };

export type HostEventListener = (event: HostEvent) => void;
