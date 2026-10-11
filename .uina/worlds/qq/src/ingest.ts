import { decodeOneBotMessage, decodeOneBotSegments, oneBotId, oneBotTime } from "./message-codec.js";
import {
	conversationRef,
	messageRef,
	userRef,
	type EventFact,
	type IngestedFact,
	type QQEventKind,
	type RequestFact,
} from "./types.js";
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
	/** 部署未授 observation 时被抑制的平台事件数（诊断）。 */
	suppressedByGrant: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function isoTime(unixSeconds: unknown): string {
	return oneBotTime(unixSeconds) ?? new Date().toISOString();
}

export class QqIngestion {
	private counters: IngestionCounters = { messages: 0, events: 0, requests: 0, unrecognized: 0, suppressedByGrant: 0 };

	constructor(
		private readonly selfId: string,
		private readonly journal: FactsJournal,
		/** 每条事实落库后的通知回调（调度层在此接单）。 */
		private readonly onFact?: (item: IngestedFact) => void,
		/**
		 * 部署未授 observation 时平台事实不入库、不进调度（grant 表：observation 覆盖
		 * "读取与新事实接收、自动场景"；合同：无 observation 不新保存聊天/申请内容）。
		 * 绑定健康与自身操作回执不经此通道，照常保留。
		 */
		private readonly observationAllowed = true,
	) {}

	get totals(): Readonly<IngestionCounters> {
		return this.counters;
	}

	/** 处理一条平台事件（transport event/raw 均可进入；raw 里的迟到回执由上层处理）。 */
	handleEvent(raw: unknown): void {
		if (!isObject(raw)) return;
		if (!this.observationAllowed) {
			this.counters.suppressedByGrant++;
			return;
		}
		const postType = asString(raw.post_type);
		const time = isoTime(raw.time);
		const selfIdValue = oneBotId(raw.self_id);
		if (raw.self_id !== undefined && selfIdValue !== this.selfId) {
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
		const decoded = decodeOneBotMessage({ ...raw, time }, this.selfId);
		if (!decoded) {
			this.counters.unrecognized++;
			this.journal.recordCoverageGap({
				id: `decode:${this.journal.mintEventRef()}`,
				from: time,
				to: time,
				reason: "message_decode_failed",
			});
			return;
		}
		if (this.journal.getMessage(decoded.ref)) return;
		const fact = this.journal.appendMessage({
			...decoded,
			...decodeOneBotSegments(raw.message ?? raw.raw_message, () => this.journal.mintMediaRef()),
			source: selfSent ? "echo" : "platform",
		});
		this.counters.messages++;
		this.onFact?.({ kind: "message", fact });
	}

	private handleNotice(raw: Record<string, unknown>, time: string): void {
		const noticeType = asString(raw.notice_type);
		const subType = asString(raw.sub_type);
		const groupId = oneBotId(raw.group_id);
		const mid = oneBotId(raw.message_id, true);
		const uinRef = (key: string): string | undefined => {
			const uin = oneBotId(raw[key]);
			return uin !== null ? userRef(uin) : undefined;
		};

		let kind: QQEventKind;
		switch (noticeType) {
			case "notify":
				kind = "other";
				if (subType === "poke") kind = "poke";
				else if (subType === "profile_like") kind = "profile_like";
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
			case "bot_offline":
				kind = "bot_offline";
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

		let actorRef = uinRef("operator_id") ?? uinRef("user_id");
		let targetRef = uinRef("target_id") ?? uinRef("invited_id");
		let authorRef: string | undefined;
		if (kind === "poke") actorRef = uinRef("sender_id") ?? uinRef("user_id");
		if (noticeType === "group_recall") {
			actorRef = uinRef("operator_id");
			authorRef = uinRef("user_id");
		}
		if (noticeType === "friend_recall") {
			// SnowLuma user_id identifies the peer, not the recall operator.
			actorRef = uinRef("operator_id");
			authorRef = mid ? (this.journal.getMessage(messageRef(mid))?.senderRef ?? undefined) : undefined;
		}
		if (["member_increase", "member_decrease", "ban", "role_change"].includes(kind)) targetRef = uinRef("user_id");
		let conv = groupId ? conversationRef("group", groupId) : undefined;
		const peer = oneBotId(raw.user_id);
		if (!conv && (kind === "poke" || noticeType === "friend_recall") && peer && peer !== this.selfId)
			conv = conversationRef("private", peer);
		if (!conv && noticeType === "friend_recall" && mid)
			conv = this.journal.getMessage(messageRef(mid))?.conversationRef;
		const likes = Array.isArray(raw.likes)
			? raw.likes.flatMap((item) => {
					if (!isObject(item)) return [];
					const code =
						asString(item.emoji_id) ??
						(typeof item.emoji_id === "number" && Number.isSafeInteger(item.emoji_id) ? String(item.emoji_id) : null);
					if (!code) return [];
					return [
						{
							code,
							count:
								typeof item.count === "number" && Number.isFinite(item.count) && item.count >= 0 ? item.count : null,
						},
					];
				})
			: [];
		const fact: EventFact = {
			ref: this.journal.mintEventRef(),
			kind,
			conversationRef: conv,
			time,
			actorRef,
			targetRef,
			authorRef,
			action: asString(raw.action) ?? undefined,
			suffix: asString(raw.suffix) ?? undefined,
			...(kind === "reaction"
				? { reaction: { operation: subType === "add" || subType === "remove" ? subType : null, likes } }
				: {}),
			messageRef: mid ? messageRef(mid) : undefined,
			summary: subType ? `${noticeType}/${subType}` : (noticeType ?? undefined),
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
		let kind: RequestFact["kind"];
		if (requestType === "friend") kind = "friend";
		else if (subType === "invite") kind = "group_invite";
		else kind = "group_join_request";
		const requesterUin = oneBotId(raw.user_id);
		const groupId = oneBotId(raw.group_id);
		const invitedId = oneBotId(raw.invited_id);
		const fact: RequestFact = {
			ref: this.journal.mintRequestRef(flag),
			platformFlag: flag,
			kind,
			state: "pending",
			requesterRef: requesterUin !== null ? userRef(requesterUin) : null,
			requesterDisplayName: null,
			targetConversationRef: groupId !== null ? conversationRef("group", groupId) : undefined,
			invitedRef: invitedId ? userRef(invitedId) : undefined,
			comment: asString(raw.comment),
			time,
		};
		this.journal.appendRequest(fact);
		this.counters.requests++;
		this.onFact?.({ kind: "request", fact });
	}
}
