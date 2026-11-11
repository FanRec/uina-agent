import { createHash } from "node:crypto";
import { convertToLlm } from "../../agent/context.js";
import type { ImageContent } from "../../core/content.js";
import type {
	AgentMessage,
	ChatMsg,
	InputProvenance,
	InputSource,
	ModelContextMeta,
	ThinkingReplay,
} from "../../core/types.js";
import { EVENT_FRAME_KIND, EVENT_FRAME_SIZE, EVENT_FRAME_TOOL_NAME, frameCallId } from "./protocol.js";

function provenance(m: AgentMessage | ChatMsg): InputProvenance | undefined {
	return "input" in m && m.input ? m.input : "context" in m ? m.context?.input : undefined;
}

/**
 * 这条消息承载的是外界内容还是运行时自有信息。
 *
 * 判据只有一条：接入层写下的 `origin`。没有 `origin` 时按通道推断——操作者通道
 * （kind=user）说出来的话仍是外界内容；runtime/agent 通道默认是运行时自有信息。
 * 来源完全缺失的裸 user 消息按外部处理（少信任的那一侧），不默认它可信。
 */
function external(m: AgentMessage | ChatMsg): boolean {
	const source = provenance(m)?.source;
	if (source?.origin) return source.origin === "external";
	if (source) return source.kind === "user";
	return m.role === "user" && !("context" in m && m.context?.kind);
}

/** 内容寻址 eventId：内容不变 ⇒ 同 eventId ⇒ 帧组逐字节稳定（尾部帧缓存语义的根基）。
 * namespace 隔离不同注入方（world-event / embodiment-event / ...），避免跨源撞号。 */
export function contentAddressedEventId(namespace: string, text: string): string {
	return `${namespace}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

export interface EventFrameOptions {
	/** 稳定事件身份：调用 ID、分组身份都由它派生。 */
	eventId: string;
	/** 该帧对应的 canonical 条目；瞬态尾部帧没有。 */
	entryId?: string;
	/** 回执正文：外部原文，或运行时合成的观察。 */
	text: string;
	/**
	 * 来源标签覆盖。到达事件缺省按 source 推导；观察类帧必须自己给出（"minecraft 观察"），
	 * 因为"刚刚发生了什么"和"现在是什么样"是两种不同的说法。
	 */
	label?: string;
	source?: InputSource;
	receivedAt?: string;
	images?: ImageContent[];
	/** 仅瞬态观察：请求检视里展示这份观察，不进模型正文。 */
	observationSource?: string;
}

/** 本地时间，固定宽度、无 locale 依赖：ISO 里是 UTC，模型读成本地时间才不会错位。 */
function localTimestamp(iso: string): string | undefined {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return undefined;
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function actorText(actor: InputSource["actor"]): string | undefined {
	const name = actor?.label ?? actor?.id;
	if (!name) return undefined;
	// "操作者" 已经由通道标签给出，不再括注一次；参与者关系仍要标出来，因为"发言人"和"被授权的操作者"分量不同。
	if (actor?.relation === "participant") return `${name}（参与者）`;
	return name;
}

/**
 * 来源标签：模型只靠这一行判断"这是什么、谁在说、算不算委托"。
 *
 * 身份来自接入层的可信元数据（InputSource.actor），不从正文里的"我是管理员"推断。
 */
export function sourceLabel(source: InputSource | undefined): string {
	if (!source) return "外部内容";
	if (source.kind === "user") {
		const actor = actorText(source.actor);
		if (source.type === "operator" || source.actor?.relation === "operator")
			return actor ? `操作者 ${actor}` : "操作者";
		return actor ? `外部发言 ${actor}` : "外部发言";
	}
	if (source.kind === "agent") return source.ref ? `子代理 ${source.ref}` : "子代理";
	if (source.origin === "external") return source.ref ? `世界事件 · ${source.ref}` : "世界事件";
	return source.ref ? `运行时 · ${source.ref}` : "运行时";
}

/** 回执正文：来源标题行 + 原始正文。eventId、来源细目、游标只留在 context，不进正文。 */
function eventFrameText(options: Pick<EventFrameOptions, "text" | "label" | "source" | "receivedAt">): string {
	const time = options.receivedAt ? localTimestamp(options.receivedAt) : undefined;
	const label = options.label ?? sourceLabel(options.source);
	return `[${time ? `${label} · ${time}` : label}]\n${String(options.text ?? "")}`;
}

/** 请求检视用的观察记录：两种帧形状都要带，否则首轮观察在 `/prompt` 里看不见。 */
function observationMeta(options: EventFrameOptions): Pick<ModelContextMeta, "requestObservation"> {
	return options.observationSource
		? { requestObservation: { source: options.observationSource, text: options.text } }
		: {};
}

function frameProvenance(options: EventFrameOptions): InputProvenance {
	return {
		eventId: options.eventId,
		...(options.source ? { source: options.source } : {}),
		...(options.receivedAt ? { receivedAt: options.receivedAt } : {}),
	};
}

function frameContext(options: EventFrameOptions, index: number): ModelContextMeta {
	return {
		kind: EVENT_FRAME_KIND,
		input: frameProvenance(options),
		...(options.entryId ? { entryId: options.entryId } : {}),
		group: { id: frameCallId(options.eventId), index, size: EVENT_FRAME_SIZE },
	};
}

/**
 * 构造一组协议完整的合成回执：[合成调用(assistant), 回执(tool)]。
 *
 * 深模块：调用方只给 eventId 与正文，分组/callId/来源标注机制全部在此封装。
 * 两类生产消费方：① 到达事件投影（projectEventFrames）；② 请求前瞬态观察
 * （世界状态 / 声音状态——运行时合成的环境观察，不落 Session 历史）。
 */
export function eventFrameMessages(options: EventFrameOptions): ChatMsg[] {
	const id = frameCallId(options.eventId);
	return [
		{
			role: "assistant",
			content: "",
			tool_calls: [{ id, name: EVENT_FRAME_TOOL_NAME, args: {} }],
			context: frameContext(options, 0),
		},
		{
			role: "tool",
			tool_call_id: id,
			content: eventFrameText(options),
			...(options.images ? { images: options.images } : {}),
			context: {
				...frameContext(options, 1),
				...observationMeta(options),
			},
		},
	];
}

/** 前面只有 system：首条消息必须是 user，Anthropic 明确拒绝以 assistant 开场的 messages。 */
function hasConversation(messages: readonly ChatMsg[]): boolean {
	return messages.some((message) => message.role !== "system");
}

/**
 * 帧落到对话首位时的形状：一条带来源标题的 user 消息。
 *
 * 不用"先发一条通知、再发回执"来绕过这条协议约束——那正是本轮要删掉的模板。来源靠标题行
 * 保留，事件身份靠 context 保留，代价只有：这一条没有合成调用，也没有工具回合。
 */
function leadingFrameMessage(options: EventFrameOptions): ChatMsg {
	return {
		role: "user",
		content: eventFrameText(options),
		...(options.images ? { images: options.images } : {}),
		context: {
			input: frameProvenance(options),
			...(options.entryId ? { entryId: options.entryId } : {}),
			...observationMeta(options),
		},
	};
}

function placeFrame(placed: readonly ChatMsg[], options: EventFrameOptions): ChatMsg[] {
	return hasConversation(placed) ? eventFrameMessages(options) : [leadingFrameMessage(options)];
}

/** 把一份帧接到消息尾部：首位降级、其余保持合成回执。
 * 泛型只为兼容 DeepReadonly 视图（hook 链消息是冻结快照，不要求可变 ChatMsg）。 */
export function appendEventFrame<T extends { role: string }>(
	messages: readonly T[],
	options: EventFrameOptions,
): readonly T[] {
	const placed = placeFrame(messages as unknown as readonly ChatMsg[], options);
	return [...messages, ...(placed as unknown as T[])];
}

/** 没有稳定身份就不能合成回执：帧组的原子性、去重与恢复都靠它。 */
function missingEventId(message: AgentMessage | ChatMsg): Error {
	const content = String(message.content ?? "");
	const preview = content.slice(0, 60).replace(/\s+/g, " ");
	return new Error(
		`外部事件缺少稳定 eventId，无法合成 external_event_frame 回执。` +
			`消息内容开头：「${preview}${content.length > 60 ? "…" : ""}」。` +
			`修复指引：turn.prepare 注入的 user 消息需带 context.kind 标注为内部信息；` +
			`需要作为外部事件呈现的输入必须在接入层提供 input 或 id 元数据。`,
	);
}

export function projectEventFrames(
	messages: readonly (AgentMessage | ChatMsg)[],
	options?: { thinkingReplay?: ThinkingReplay },
): ChatMsg[] {
	// Encode inputs before the default protocol cleaner so real tool pairs are cleaned together.
	const prepared: ChatMsg[] = [];
	for (const m of messages) {
		if ((m.role === "user" || m.role === "custom") && external(m)) {
			const frame = externalFrameOptions(m);
			if (!frame.eventId) throw missingEventId(m);
			prepared.push(...placeFrame(prepared, frame));
		} else if (m.role === "user" || m.role === "custom") {
			const input = provenance(m);
			const kind = m.role === "custom" ? m.customType : "internal-input";
			// runtime-input 正文的来源标题已由 session 投影处理；其余内部信息来源用同一套
			// 可读标签，而不是把 source 对象 JSON 塞给模型看。
			const content =
				kind === "runtime-input"
					? m.content
					: `[内部信息${input?.source ? ` · ${input.source.kind}/${input.source.type}` : ""}]\n${m.content}`;
			prepared.push({
				role: "user",
				content,
				...(m.images ? { images: m.images } : {}),
				context: { ...("context" in m ? m.context : {}), kind, ...(input ? { input } : {}) },
			});
		} else prepared.push(m as ChatMsg);
	}
	return convertToLlm(prepared, options);
}

function externalFrameOptions(message: AgentMessage | ChatMsg): EventFrameOptions {
	const input = provenance(message);
	return {
		eventId: input?.eventId ?? ("id" in message ? (message.id ?? "") : ""),
		entryId: "id" in message ? message.id : "context" in message ? message.context?.entryId : undefined,
		text: message.content,
		source: input?.source,
		receivedAt: input?.receivedAt,
		images: message.images,
	};
}
