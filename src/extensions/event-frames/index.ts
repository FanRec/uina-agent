import type { ProjectionPolicy } from '../../agent/projection.js';
import { defaultSystemPrompt } from '../../agent/context.js';
import { projectEventFrames } from './projection.js';
import { assertEventFrameContext, EVENT_FRAME_PROMPT, EVENT_FRAME_TOOL } from './protocol.js';
export { EVENT_FRAME_PROMPT, EVENT_FRAME_TOOL_NAME, frameCallId } from './protocol.js';
export { buildEventFrameGroup } from './projection.js';

/** One immutable policy owner per Subject; no executable tool or activation state. */
export function createEventFrameProfile(): { projection: ProjectionPolicy & { validateContext: typeof assertEventFrameContext }; systemPrompt: string } {
 return {
  projection: { convertToLlm: projectEventFrames, contextTools: [structuredClone(EVENT_FRAME_TOOL)], validateContext: assertEventFrameContext },
  systemPrompt: `${defaultSystemPrompt()}\n\n${EVENT_FRAME_PROMPT}`,
 };
}
