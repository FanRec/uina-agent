import { conversationRef, messageRef, userRef, type EventFact, type MessageFact, type MessageSegment, type QQEventKind, type RequestFact } from "./types.js";
import type { FactsJournal } from "./facts-journal.js";

/**
 * 事件摄取：OneBot v11 事件 → 规范 QQ facts（唯一入库点）。
 * 摄取只记录事实与来源，不判断提醒资格（候选派生归调度层）。
 * SnowLuma 事实（源码 87527cb）：temp=private+sub_type:'group' 且 sender.group_id
 * 保留源群；self 回送 post_type='message_sent' 且私聊带 target_id 指向对方；
 * 群 sender.role 缺省占位 'member' 不作真实身份。
 */

export interface IngestionCounters {
	messages: number;
	events: number;
	requests: number;
	unrecognized: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoTime(unixSeconds: unknown): string {
	const n = asNumber(unixSeconds);
	return new Date((n && n > 0 ? n * 1000 : Date.now())).toISOString();
}

/** OneBot 消息数组 → 规范分段 + 回复引用；未识别类型保留说明并标未理解。 */
function toSegments(raw: unknown, selfId: string, mintMediaRef: () => string): { segments: MessageSegment[]; replyTo?: string } {
	if (Array.isArray(raw) === false) {
		const text = asString(raw);
		return { segments: text ? [{ type: "text", text }] : [] };
	}
	const segments: MessageSegment[] = [];
	let replyTo: string | undefined;
	for (const item of raw) {
		if (!isObject(item)) continue;
		const type = asString(item.type);
		const data = isObject(item.data) ? item.data : {};
		switch (type) {
			case "text": {
				const text = asString(data.text);
				if (text) segments.push({ type: "text", text });
				break;
			}
			case "at": {
				const qq = asNumber(data.qq) ?? asString(data.qq);
				if (qq !== null) segments.push({ type: "mention", userRef: userRef(selfId, qq), displayName: asString(data.nickname) ?? undefined });
				break;
			}
			case "reply": {
				// 回复是结构引用不是内容分段：提取 replyTo，不进正文。
				const id = asNumber(data.id);
				if (id !== null) replyTo = messageRef(selfId, id);
				break;
			}
			case "face": {
				const id = asNumber(data.id);
				if (id !== null) segments.push({ type: "face", faceId: String(id) });
				break;
			}
			case "json":
			case "xml": {
				// 卡片原文（SnowLuma: data.data）；保留原文不解析语义。
				const payload = asString(data.data) ?? asString(data.text);
				if (payload) segments.push({ type, data: payload });
				break;
			}
			case "forward": {
				// 合并转发（SnowLuma: data.id）；resId 留给 get_forward_msg 解析。
				const resId = asString(data.id) ?? asString(data.res_id) ?? asString(data.forward_id);
				if (resId) segments.push({ type: "forward", resId });
				break;
			}
			case "image":
			case "record":
			case "video":
			case "file": {
				const mapped = type === "record" ? "audio" : type;
				segments.push({
					type: mapped as "image" | "audio" | "video" | "file",
					mediaRef: mintMediaRef(),
					url: asString(data.url) ?? undefined,
					fileName: asString(data.file) ?? undefined,
					understood: false,
				});
				break;
			}
			default: {
				segments.push({ type: "text", text: `[未知分段 type=${type ?? "?"}]` });
				break;
			}
		}
	}
	return { segments, replyTo };
}

export class QqIngestion {
	private counters: IngestionCounters = { messages: 0, events: 0, requests: 0, unrecognized: 0 };
	private eventSeq = 0;

	constructor(
		private readonly selfId: string,
		private readonly journal: FactsJournal,
		/** 每条事实落库后的通知回调（调度层在此接单）。 */
		private readonly onFact?: (item: { kind: "message" | "event" | "request"; fact: unknown }) => void,
	) {}

	get totals(): Readonly<IngestionCounters> {
		return this.counters;
	}

	private mintEventRef(time: string): string {
		this.eventSeq++;
		const epoch = Number.isFinite(Date.parse(time)) ? Date.parse(time) : Date.now();
		return `qq-event:${this.selfId}:e-${epoch}-${this.eventSeq}`;
	}

	/** 处理一条平台事件（transport event/raw 均可进入；raw 里的迟到回执由上层处理）。 */
	handleEvent(raw: unknown): void {
		if (!isObject(raw)) return;
		const postType = asString(raw.post_type);
		const time = isoTime(raw.time);
		const selfIdNum = asNumber(raw.self_id);
		if (selfIdNum !== null && String(selfIdNum) !== this.selfId) {
			// 平台身份与绑定账号不符：不入库（启动时身份核验失败会直接阻止连接）。
			return;
		}
		switch (postType) {
			case "message":
				this.handleMessage(raw, time, false);
				return;
			case "message_sent":
				this.handleMessage(raw, time, true);
				return;
			case "notice":
				this.handleNotice(raw, time);
				return;
			case "request":
				this.handleRequest(raw, time);
				return;
			default:
				this.counters.unrecognized++;
				return;
		}
	}

	private handleMessage(raw: Record<string, unknown>, time: string, selfSent: boolean): void {
		const messageType = asString(raw.message_type);
		const messageId = asNumber(raw.message_id);
		if (!messageType || messageId === null) {
			this.counters.unrecognized++;
			return;
		}
		const sender = isObject(raw.sender) ? raw.sender : {};
		const senderUin = asNumber(sender.user_id) ?? asNumber(raw.user_id);
		if (senderUin === null) {
			this.counters.unrecognized++;
			return;
		}

		let conversationRefValue: string;
		if (messageType === "group") {
			const groupId = asNumber(raw.group_id);
			if (groupId === null) {
				this.counters.unrecognized++;
				return;
			}
			conversationRefValue = conversationRef(this.selfId, "group", groupId);
		} else {
			const subType = asString(raw.sub_type);
			if (subType === "group") {
				// temp 会话：保留源群；sender.group_id 为源群（SnowLuma 事实）。
				const sourceGroup = asNumber(sender.group_id);
				conversationRefValue = conversationRef(
					this.selfId,
					"temp",
					sourceGroup !== null ? `${senderUin}-g${sourceGroup}` : String(senderUin),
				);
			} else {
				// friend：self 回送时 user_id 是自己，对方取 target_id（SnowLuma 事实）。
				const peer = selfSent ? (asNumber(raw.target_id) ?? senderUin) : senderUin;
				conversationRefValue = conversationRef(this.selfId, "private", peer === Number(this.selfId) ? String(senderUin) : String(peer));
			}
		}
		const senderRef = userRef(this.selfId, senderUin);
		const direction: "in" | "out" = selfSent ? "out" : "in";

		// 重复平台事件不重复铸造媒体引用；序号从 facts 重建，重启不撞号。
		if (this.journal.getMessage(messageRef(this.selfId, messageId))) return;
		const { segments, replyTo } = toSegments(raw.message, this.selfId, () => this.journal.mintMediaRef());
		const fact: Omit<MessageFact, "sequence"> = {
			ref: messageRef(this.selfId, messageId),
			conversationRef: conversationRefValue,
			senderRef,
			// 空白群名片/昵称一律回落（"" 非 nullish，?? 不会回落；实证 53/77 条 displayName="" 遮蔽昵称）。
			senderDisplayName: asString(sender.card)?.trim() || asString(sender.nickname)?.trim() || null,
			direction,
			time,
			segments,
			replyTo,
			source: selfSent ? "echo" : "platform",
		};
		const stored = this.journal.appendMessage(fact);
		this.counters.messages++;
		this.onFact?.({ kind: "message", fact: stored });
	}

	private handleNotice(raw: Record<string, unknown>, time: string): void {
		const noticeType = asString(raw.notice_type);
		const subType = asString(raw.sub_type);
		const groupRef = () => {
			const groupId = asNumber(raw.group_id);
			return groupId !== null ? conversationRef(this.selfId, "group", groupId) : undefined;
		};
		const uinRef = (key: string) => {
			const uin = asNumber(raw[key]);
			return uin !== null ? userRef(this.selfId, uin) : undefined;
		};

		let kind: QQEventKind;
		switch (noticeType) {
			case "notify":
				kind = subType === "poke" ? "poke" : "reaction";
				break;
			case "friend_recall":
			case "group_recall":
				kind = "recall";
				break;
			case "group_increase":
				kind = "member_increase";
				break;
			case "group_decrease":
				kind = "member_decrease";
				break;
			case "group_admin":
				kind = "role_change";
				break;
			case "group_ban":
				kind = "ban";
				break;
			case "bot_status":
				kind = subType === "offline" ? "bot_offline" : "bot_status";
				break;
			case "profile_like":
				kind = "profile_like";
				break;
			case "group_msg_emoji_like":
				kind = "reaction";
				break;
			default:
				// 未识别 notice 仍是有来源事实；kind 归入 other，summary 保留原始类型。
				kind = "other";
				break;
		}

		const fact: EventFact = {
			ref: this.mintEventRef(time),
			kind,
			conversationRef: groupRef(),
			time,
			actorRef: uinRef("user_id") ?? uinRef("operator_id"),
			targetRef: uinRef("target_id") ?? uinRef("invited_id"),
			messageRef: (() => {
				const mid = asNumber(raw.message_id);
				return mid !== null ? messageRef(this.selfId, mid) : undefined;
			})(),
			summary: subType ? `${noticeType}/${subType}` : noticeType ?? undefined,
			source: "platform",
		};
		this.journal.appendEvent(fact);
		this.counters.events++;
		this.onFact?.({ kind: "event", fact });
	}

	private handleRequest(raw: Record<string, unknown>, time: string): void {
		const requestType = asString(raw.request_type);
		const subType = asString(raw.sub_type);
		const flag = asString(raw.flag);
		if (!requestType || !flag) {
			this.counters.unrecognized++;
			return;
		}
		const kind: RequestFact["kind"] =
			requestType === "friend" ? "friend" : subType === "invite" ? "group_invite" : "group_join_request";
		const requesterUin = asNumber(raw.user_id);
		const fact: RequestFact = {
			ref: `qq-request:${this.selfId}:${flag}`,
			kind,
			state: "pending",
			requesterRef: requesterUin !== null ? userRef(this.selfId, requesterUin) : null,
			requesterDisplayName: null,
			targetConversationRef: (() => {
				const groupId = asNumber(raw.group_id);
				return groupId !== null ? conversationRef(this.selfId, "group", groupId) : undefined;
			})(),
			comment: asString(raw.comment),
			time,
		};
		this.journal.appendRequest(fact);
		this.counters.requests++;
		this.onFact?.({ kind: "request", fact });
	}
}
