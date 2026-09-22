import type { AgentMessage, ChatMsg, InputProvenance, ModelContextMeta } from '../../core/types.js';
import { convertToLlm } from '../../agent/context.js';
import { EVENT_FRAME_KIND, EVENT_FRAME_TOOL_NAME, frameCallId } from './protocol.js';

function provenance(m: AgentMessage | ChatMsg): InputProvenance | undefined {
 return 'input' in m && m.input ? m.input : 'context' in m ? m.context?.input : undefined;
}
function external(m: AgentMessage | ChatMsg): boolean {
 const input = provenance(m);
 const source = input?.source;
 if (source?.origin) return source.origin === 'external';
 if (source) return source.kind === 'user';
 return m.role === 'user' && !('context' in m && m.context?.kind);
}

export function encodeExternalInput(message: AgentMessage | ChatMsg): ChatMsg[] {
 const input = provenance(message) ?? { eventId: 'id' in message ? message.id ?? '' : '' };
 const id = frameCallId(input.eventId);
 const context = (index: number): ModelContextMeta => ({ kind: EVENT_FRAME_KIND, input,
  group: { id, index, size: 3 }, retain: true });
 const body = { eventId: input.eventId, ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
  source: input.source ?? { type: 'unknown', origin: 'external' }, text: message.content };
 return [
  { role: 'user', content: '[运行时通知] 收到一条外部事件；正文在随后的 external_event_frame 回执中。', context: context(0) },
  { role: 'assistant', content: '', tool_calls: [{ id, name: EVENT_FRAME_TOOL_NAME, args: { eventId: input.eventId } }], context: context(1) },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(body), ...(message.images ? { images: message.images } : {}), context: context(2) },
 ];
}

export function projectEventFrames(messages: readonly (AgentMessage | ChatMsg)[], options?: { includeThinking?: boolean }): ChatMsg[] {
 // Encode inputs before the default protocol cleaner so real tool pairs are cleaned together.
 const prepared: ChatMsg[] = [];
 for (const m of messages) {
  if ((m.role === 'user' || m.role === 'custom') && external(m)) {
   prepared.push(...encodeExternalInput(m));
  } else if (m.role === 'user' || m.role === 'custom') {
   const input = provenance(m);
   const kind = m.role === 'custom' ? m.customType : 'internal-input';
   prepared.push({ role: 'user', content: `[内部信息 ${JSON.stringify(input?.source ?? { type: kind })}]\n${m.content}`,
    ...(m.images ? { images: m.images } : {}), context: { ...('context' in m ? m.context : {}), kind, ...(input ? { input } : {}) } });
  } else prepared.push(m as ChatMsg);
 }
 return convertToLlm(prepared, options);
}
