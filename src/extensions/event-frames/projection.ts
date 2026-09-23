import type { AgentMessage, ChatMsg, InputProvenance, InputSource, ModelContextMeta } from '../../core/types.js';
import type { ImageContent } from '../../core/content.js';
import { createHash } from 'node:crypto';
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

const DEFAULT_FRAME_NOTICE = '[运行时通知] 收到一条外部事件；正文在随后的 external_event_frame 回执中。';

/** 瞬态快照类尾部帧（视口/具身状态等环境观测）的统一通知文案模板。 */
export function snapshotNotice(kind: string): string {
 return `[运行时通知] 以下为${kind}瞬态快照（环境感知信息，非用户输入，无需直接回应）；正文在随后的 external_event_frame 回执中。`;
}

/** 内容寻址 eventId：内容不变 ⇒ 同 eventId ⇒ 帧组逐字节稳定（尾部帧缓存语义的根基）。
 * namespace 隔离不同注入方（app-viewport / embodiment-state / ...），避免跨源撞号。 */
export function contentAddressedEventId(namespace: string, text: string): string {
 return `${namespace}:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
}

/** 标准尾部注入拼装：有帧则追加，无帧（undefined）则 0 修改透传。
 * 泛型以兼容 DeepReadonly 视图（hook 链消息是冻结快照，不要求可变 ChatMsg）。
 * 所有 tail 注入方（AppRegistry / embodiment / ...）共用，收敛“if (!frame) return undefined”样板。 */
export function appendTailFrame<T>(messages: readonly T[], frame: readonly T[] | undefined): { messages: readonly T[] } | undefined {
 if (!frame || frame.length === 0) return undefined;
 return { messages: [...messages, ...frame] };
}

export interface EventFrameGroupOptions {
 eventId: string;
	/** Canonical source entry represented by this frame; absent for transient tail frames. */
	entryId?: string;
 /** 回执正文（来自标明的外部来源 / 运行时合成的观测快照）。 */
 text: string;
 /** 覆盖默认通知文案；用于区分到达事件与瞬态快照等不同呈现。 */
 notice?: string;
 /** 缺省 { type: 'unknown', origin: 'external' }（与到达事件行为一致）。 */
 source?: InputSource;
 receivedAt?: string;
 /** 原样附加到回执消息（多模态正文）。 */
 images?: ImageContent[];
}

/**
 * 构造一组协议完整的 external_event_frame 三消息组：
 * [notice(user), 合成调用(assistant), 回执(tool)]，三消息共享原子分组元数据，
 * 可直接通过 assertEventFrameContext 校验。
 *
 * 深模块：调用方只需给出 eventId 与正文，分组/callId/来源标注机制全部在此封装。
 * 两类生产消费方：① encodeExternalInput（到达事件投影）；② 瞬态尾部帧注入
 * （应用视口 / 具身状态——运行时合成的环境观测，不落 Session 历史）。
 */
export function buildEventFrameGroup(options: EventFrameGroupOptions): ChatMsg[] {
 const { eventId, entryId, text: rawText, notice = DEFAULT_FRAME_NOTICE, source, receivedAt, images } = options;
 if (!eventId) throw new Error('外部事件帧缺少稳定 eventId');
 // 收口为 string：undefined 正文经 JSON.stringify 会丢失 text 字段，触发协议校验
 // “回执不是合法帧”回合失败——空正文帧仍合法，比回合崩溃正确。
 const text = String(rawText ?? '');
 const input: InputProvenance = { eventId, ...(source ? { source } : {}), ...(receivedAt ? { receivedAt } : {}) };
 const id = frameCallId(eventId);
 const context = (index: number): ModelContextMeta => ({ kind: EVENT_FRAME_KIND, input, ...(entryId ? { entryId } : {}),
  group: { id, index, size: 3 }, retain: true });
 const body = { eventId, ...(receivedAt ? { receivedAt } : {}),
  source: source ?? { type: 'unknown', origin: 'external' }, text };
 return [
  { role: 'user', content: notice, context: context(0) },
  { role: 'assistant', content: '', tool_calls: [{ id, name: EVENT_FRAME_TOOL_NAME, args: { eventId } }], context: context(1) },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(body), ...(images ? { images } : {}), context: context(2) },
 ];
}

export function encodeExternalInput(message: AgentMessage | ChatMsg): ChatMsg[] {
 const input = provenance(message) ?? { eventId: 'id' in message ? message.id ?? '' : '' };
 if (!input.eventId) {
  const preview = String(message.content ?? '').slice(0, 60).replace(/\s+/g, ' ');
  throw new Error(`外部事件缺少稳定 eventId，无法合成 external_event_frame 回执。` +
   `消息内容开头：「${preview}${String(message.content ?? '').length > 60 ? '…' : ''}」。` +
   `修复指引：turn.prepare 注入的 user 消息需带 context.kind 标注为内部信息；` +
   `需要作为外部事件呈现的输入必须在接入层提供 input 或 id 元数据。`);
 }
 return buildEventFrameGroup({
  eventId: input.eventId,
	entryId: "id" in message ? message.id : "context" in message ? message.context?.entryId : undefined,
  text: message.content,
  source: input.source,
  receivedAt: input.receivedAt,
  images: message.images,
 });
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
   // runtime-input 正文在接入层（projectInputMessage）已带 [运行时事件 …] 标注，
   // 且已落盘的旧 journal 同样如此；此处不再叠加 [内部信息] 前缀，避免双重标签浪费预算。
   const content = kind === 'runtime-input'
    ? m.content
    : `[内部信息 ${JSON.stringify(input?.source ?? { type: kind })}]\n${m.content}`;
   prepared.push({ role: 'user', content,
    ...(m.images ? { images: m.images } : {}), context: { ...('context' in m ? m.context : {}), kind, ...(input ? { input } : {}) } });
  } else prepared.push(m as ChatMsg);
 }
 return convertToLlm(prepared, options);
}
