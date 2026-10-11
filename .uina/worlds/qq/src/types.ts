/** QQ World 短引用。账号边界由账号数据目录与存储所有者保证。 */
export const REF_PATTERNS = {
	user: /^u([1-9]\d*)$/,
	conversation: /^(?:g[1-9]\d*|p[1-9]\d*|t[1-9]\d*(?:-g[1-9]\d*)?)$/,
	groupConversation: /^g([1-9]\d*)$/,
	message: /^m(-?[1-9]\d*)$/,
	event: /^e([1-9]\d*)$/,
	request: /^r([1-9]\d*)$/,
	followUp: /^f([1-9]\d*)$/,
	operation: /^o([1-9]\d*)$/,
	media: /^a([1-9]\d*)$/,
} as const;
export type ConversationKind = "private" | "group" | "temp";
export interface ParsedConversationRef {
	readonly kind: ConversationKind;
	readonly key: string;
}
export function parseConversationRef(ref: string): ParsedConversationRef | null {
	if (!REF_PATTERNS.conversation.test(ref)) return null;
	return { kind: ref[0] === "g" ? "group" : ref[0] === "p" ? "private" : "temp", key: ref.slice(1) };
}
export function parseUserRef(ref: string): { uin: string } | null {
	const match = REF_PATTERNS.user.exec(ref);
	return match ? { uin: match[1]! } : null;
}
export function parseMessageRef(ref: string): { messageId: number } | null {
	const match = REF_PATTERNS.message.exec(ref);
	if (!match) return null;
	const messageId = Number(match[1]);
	return Number.isSafeInteger(messageId) ? { messageId } : null;
}
export function userRef(uin: string | number): string {
	const ref = `u${uin}`;
	if (!REF_PATTERNS.user.test(ref)) throw new Error("非法 QQ 用户标识");
	return ref;
}
export function conversationRef(kind: ConversationKind, key: string | number): string {
	const ref = `${kind === "group" ? "g" : kind === "private" ? "p" : "t"}${key}`;
	if (!REF_PATTERNS.conversation.test(ref)) throw new Error("非法 QQ 会话标识");
	return ref;
}
export function messageRef(id: string | number): string {
	const ref = `m${id}`;
	if (!parseMessageRef(ref)) throw new Error("非法 QQ 消息标识");
	return ref;
}
export function operationRef(id: string | number): string {
	const ref = `o${id}`;
	if (!REF_PATTERNS.operation.test(ref)) throw new Error("非法 QQ 操作标识");
	return ref;
}

/* ---------- 平台事实（World 持有的带来源/时间观察） ---------- */

/** 消息分段（speak 内容与入站正文共用形状；json/xml/forward 仅入站）。 */
export type MessageSegment =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "mention"; readonly userRef: string; readonly displayName?: string }
	/** 仅入站：真实全体成员提及，不构造用户引用。 */
	| { readonly type: "mention_all" }
	| { readonly type: "face"; readonly faceId: string }
	| {
			readonly type: "image" | "audio" | "video" | "file";
			readonly mediaRef?: string;
			readonly url?: string;
			readonly fileName?: string;
			readonly locator?: AttachmentLocator;
			/** 能力未知保持未知；不伪转写/不伪理解。 */
			readonly understood: false;
	  }
	/** 卡片原文（ark/json、xml）；不解析语义，只保留原文。 */
	| { readonly type: "json" | "xml"; readonly data: string }
	/** 合并转发；resId 经 get_forward_msg 解析，不嵌套展开。 */
	| { readonly type: "forward"; readonly resId: string }
	/** 未识别分段：只保留原始类型名，呈现文字由 render 单源。 */
	| { readonly type: "unknown"; readonly rawType: string };

export interface MessageFact {
	readonly ref: string;
	readonly conversationRef: string;
	readonly senderRef: string | null;
	readonly senderDisplayName: string | null;
	readonly direction: "in" | "out";
	readonly sequence: number;
	readonly time: string;
	readonly segments: readonly MessageSegment[];
	readonly replyTo?: string;
	readonly source: "platform" | "echo" | "history";
}

/** 派生媒体索引的值；事实仍由 MessageFact 持有，索引可从 journal 重放。 */
export interface MediaFact {
	readonly type: "image" | "audio" | "video" | "file";
	readonly url?: string;
	readonly fileName?: string;
	readonly locator?: AttachmentLocator;
	readonly origin?: {
		readonly messageRef: string;
		readonly conversationRef: string;
		readonly segmentIndex: number;
		readonly forwardNodeIndex?: number;
		readonly nodeSegmentIndex?: number;
	};
}

/** Only platform addressing fields; never a model-selected local destination. */
export interface AttachmentLocator {
	readonly file?: string;
	readonly fileId?: string;
	readonly fileHash?: string;
	readonly busid?: number;
}

/** A signed URL may change; known source positions and platform object IDs may not. */
export function sameAttachment(expected: MediaFact, candidate: MediaFact): boolean {
	const origin = expected.origin;
	const next = candidate.origin;
	if (!origin || !next || expected.type !== candidate.type) return false;
	if (
		origin.messageRef !== next.messageRef ||
		origin.conversationRef !== next.conversationRef ||
		origin.segmentIndex !== next.segmentIndex ||
		origin.forwardNodeIndex !== next.forwardNodeIndex ||
		origin.nodeSegmentIndex !== next.nodeSegmentIndex
	)
		return false;
	const locator = expected.locator;
	if (locator?.fileId && locator.fileId !== candidate.locator?.fileId) return false;
	if (locator?.fileHash && locator.fileHash !== candidate.locator?.fileHash) return false;
	if (!locator?.fileId && !locator?.fileHash) {
		if (locator?.file && locator.file !== candidate.locator?.file) return false;
		if (expected.fileName && expected.fileName !== candidate.fileName) return false;
	}
	return true;
}

export type QQEventKind =
	| "poke"
	| "recall"
	| "member_increase"
	| "member_decrease"
	| "role_change"
	| "ban"
	| "reaction"
	| "other"
	| "friend_request"
	| "group_invite"
	| "group_join_request"
	| "profile_like"
	| "bot_status"
	| "bot_offline"
	| "transport_disconnected"
	| "transport_recovered";

export interface EventFact {
	readonly ref: string;
	readonly kind: QQEventKind;
	readonly conversationRef?: string;
	readonly time: string;
	readonly actorRef?: string;
	readonly authorRef?: string;
	readonly targetRef?: string;
	readonly action?: string;
	readonly suffix?: string;
	readonly reaction?: {
		readonly operation: "add" | "remove" | null;
		readonly likes: readonly { readonly code: string; readonly count: number | null }[];
	};
	readonly messageRef?: string;
	readonly summary?: string;
	readonly source: "platform" | "internal";
}

export type RequestState = "pending" | "confirmed" | "unknown";

export interface RequestFact {
	/** 平台申请凭据，仅内部派发使用，不进入呈现。 */
	readonly platformFlag: string;
	readonly ref: string;
	readonly kind: "friend" | "group_invite" | "group_join_request";
	readonly state: RequestState;
	readonly requesterRef: string | null;
	readonly requesterDisplayName: string | null;
	readonly targetConversationRef?: string;
	readonly invitedRef?: string;
	readonly comment: string | null;
	readonly time: string;
}

/** 摄取、事实日志与调度共用的带类型事实。 */
export type IngestedFact =
	| { kind: "message"; fact: MessageFact }
	| { kind: "event"; fact: EventFact }
	| { kind: "request"; fact: RequestFact };

/* ---------- 旧 attention 覆盖（仅迁移读取；现行推送偏好见下节） ---------- */

export type AttentionMode = "normal" | "direct_only" | "silent";

/** 旧版单一目标覆盖；随旧 action 退役（R2），仅在 ControlStore.load 一次性迁移为 PushPreference。 */
export interface AttentionOverride {
	readonly mode?: AttentionMode;
	/** 带时区 ISO 时间规范化 UTC；null = 提前恢复。 */
	readonly pausedUntil?: string | null;
}

/* ---------- 推送偏好（阅读/关注重构 v2；R5 一次性迁移自 AttentionOverride） ---------- */

/** 推送模式：off 静默 / digest 摘要纸条 / follow 正文跟读 / inherit 继承账号。 */
export type PushMode = "off" | "digest" | "follow" | "inherit";
/** 提醒过滤：all 全部 / direct 仅直接互动 / inherit 继承账号。 */
export type PushFilter = "all" | "direct" | "inherit";

/** 单一目标的推送偏好；setPush 只改提供的字段。省略字段 = 不修改。 */
export interface PushPreference {
	readonly mode?: PushMode;
	readonly filter?: PushFilter;
	readonly pausedUntil?: string | null;
}

/** 继承解析后的生效推送偏好（mode/filter 不含 inherit；非存储态）。 */
export interface EffectivePush {
	readonly mode: Exclude<PushMode, "inherit">;
	readonly filter: Exclude<PushFilter, "inherit">;
	readonly pausedUntil: string | null;
}

export type FollowUpState = "open" | "closed" | "cancelled";

export interface FollowUpItem {
	readonly ref: string;
	readonly targetRef: string;
	readonly note: string;
	readonly evidenceRefs: readonly string[];
	/** null = 未预约；改期才建立新预约。 */
	readonly reviewAt: string | null;
	/** 该 ref+reviewAt 预约是否已通知过；只改 note 不重建预约。 */
	readonly reviewNotified: boolean;
	readonly state: FollowUpState;
	readonly formedAt: string;
	readonly resolution?: string;
	readonly settledAt?: string;
}

/* ---------- 操作记录（外部结果与 unknown 核验） ---------- */

export type OperationOutcome = "succeeded" | "failed" | "unknown" | "not_started" | "cancelled";

/** SnowLuma 将 bridge 抛错也包装为 failed/100；负回执不自动证明未生效。
 * 固定源码 RETCODE 1400/1404 是参数/动作前置拒绝，其余负回执保持 unknown。
 * 普通调用和迟到 raw 共享分类，避免重启清掉未确认的媒体副本。
 */
export function classifyPlatformReceipt(response: {
	status?: unknown;
	retcode?: unknown;
}): "succeeded" | "failed" | "unknown" {
	if (response.status === "ok" && (response.retcode === undefined || response.retcode === 0)) return "succeeded";
	if (response.status === "failed" && (response.retcode === 1400 || response.retcode === 1404)) return "failed";
	return "unknown";
}

export interface OperationRecord {
	readonly ref: string;
	readonly identity: string;
	readonly action: string;
	readonly target?: string;
	readonly outcome: OperationOutcome;
	readonly messageRef?: string;
	readonly replyTo?: string;
	readonly partRange?: { readonly from: number; readonly through: number };
	readonly requestDecision?: "accept" | "decline";
	readonly echo?: string;
	readonly reason?: string;
	readonly startedAt: string;
	readonly settledAt?: string;
	/** 迟到回执可能把 unknown 升级为 succeeded/failed；每个回执各记一条。 */
	readonly receipt?: unknown;
}

/* ---------- 能力三维（capabilities 固定返回） ---------- */

export interface CapabilityDimension {
	readonly supportedByAdapter: boolean | null;
	readonly allowedByDeployment: boolean;
	readonly availableNow: boolean | null;
}
