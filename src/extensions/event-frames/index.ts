import type { ProjectionPolicy } from "../../agent/projection.js";
import { projectEventFrames } from "./projection.js";
import { assertEventFrameContext, EVENT_FRAME_TOOL, isEventFrame } from "./protocol.js";

export { contentAddressedEventId, eventFrameMessages, projectEventFrames } from "./projection.js";
export {
	assertEventFrameContext,
	EVENT_FRAME_PROMPT,
	EVENT_FRAME_TOOL,
	EVENT_FRAME_TOOL_NAME,
	frameCallId,
	isEventFrame,
} from "./protocol.js";

/**
 * Event Frame 投影 profile：只交付投影策略与协议指导，不再拼装完整主体 System
 * （S1 协议边界——避免两个默认 Prompt 所有者）。完整 role=system 正文只在 Host 的
 * 同一装配入口形成：所选主体 System 段 + 默认投影启用时的 EVENT_FRAME_PROMPT。
 * 裸 Subject 独立创建时的 defaultSystemPrompt() 兼容回退保留在 Subject 构造器。
 */
export function createEventFrameProfile(): {
	projection: ProjectionPolicy & { validateContext: typeof assertEventFrameContext };
} {
	return {
		projection: {
			convertToLlm: projectEventFrames,
			contextTools: [structuredClone(EVENT_FRAME_TOOL)],
			// 声明跟随投影：没有帧的请求里，模型看不到一个"存在但不可调用"的工具。
			contextToolsRequired: (messages) => messages.some(isEventFrame),
			validateContext: assertEventFrameContext,
		},
	};
}
