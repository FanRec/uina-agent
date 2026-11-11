import { defaultSystemPrompt } from "../../agent/context.js";
import type { ProjectionPolicy } from "../../agent/projection.js";
import { projectEventFrames } from "./projection.js";
import { assertEventFrameContext, EVENT_FRAME_PROMPT, EVENT_FRAME_TOOL, isEventFrame } from "./protocol.js";

export { appendEventFrame, contentAddressedEventId, eventFrameMessages, eventFrameText } from "./projection.js";
export {
	assertEventFrameContext,
	EVENT_FRAME_PROMPT,
	EVENT_FRAME_TOOL,
	EVENT_FRAME_TOOL_NAME,
	frameCallId,
	isEventFrame,
} from "./protocol.js";

/** One immutable policy owner per Subject; no executable tool or activation state. */
export function createEventFrameProfile(): {
	projection: ProjectionPolicy & { validateContext: typeof assertEventFrameContext };
	systemPrompt: string;
} {
	return {
		projection: {
			convertToLlm: projectEventFrames,
			contextTools: [structuredClone(EVENT_FRAME_TOOL)],
			// 声明跟随投影：没有帧的请求里，模型看不到一个"存在但不可调用"的工具。
			contextToolsRequired: (messages) => messages.some(isEventFrame),
			validateContext: assertEventFrameContext,
		},
		systemPrompt: `${defaultSystemPrompt()}\n\n${EVENT_FRAME_PROMPT}`,
	};
}
