/**
 * QQ World 领域类型与稳定引用。
 * ref 含账号边界（第二段 = 绑定账号 selfId），全部从实际结果铸造，模型只复制不构造。
 */

export const REF_PATTERNS = {
	user: /^qq-user:(\d+):(\d+)$/,
	conversation: /^qq-conversation:(\d+):(private|group|temp):([^\s]+)$/,
	groupConversation: /^qq-conversation:(\d+):group:([^\s]+)$/,
	message: /^qq-message:(\d+):([^\s]+)$/,
	event: /^qq-event:(\d+):([^\s]+)$/,
	request: /^qq-request:(\d+):([^\s]+)$/,
	followUp: /^qq-follow-up:(\d+):([^\s]+)$/,
	operation: /^qq-operation:(\d+):([^\s]+)$/,
	media: /^qq-media:(\d+):([^\s]+)$/,
	presence: /^qq-presence:(\d+):([^\s]+)$/,
} as const;

export type ConversationKind = "private" | "group" | "temp";

export interface ParsedConversationRef {
	readonly accountId: string;
	readonly kind: ConversationKind;
	readonly key: string;
}

export function parseConversationRef(ref: string): ParsedConversationRef | null {
	const match = REF_PATTERNS.conversation.exec(ref);
	if (!match) return null;
	return { accountId: match[1]!, kind: match[2] as ConversationKind, key: match[3]! };
}

export function parseUserRef(ref: string): { accountId: string; uin: string } | null {
	const match = REF_PATTERNS.user.exec(ref);
	if (!match) return null;
	return { accountId: match[1]!, uin: match[2]! };
}

/** ref 账号段与绑定账号是否一致（跨账号一律 account_mismatch）。 */
export function refBelongsToAccount(ref: string, selfId: string): boolean {
	const parts = ref.split(":");
	return parts.length >= 2 && parts[1] === selfId;
}

export function userRef(selfId: string, uin: string | number): string {
	return `qq-user:${selfId}:${uin}`;
}

export function conversationRef(selfId: string, kind: ConversationKind, key: string | number): string {
	return `qq-conversation:${selfId}:${kind}:${key}`;
}

export function messageRef(selfId: string, id: string | number): string {
	return `qq-message:${selfId}:${id}`;
}

export function operationRef(selfId: string, id: string | number): string {
	return `qq-operation:${selfId}:${id}`;
}

/* ---------- 平台事实（World 持有的带来源/时间观察） ---------- */

/** 消息分段（speak 内容与入站正文共用形状；json/xml/forward 仅入站）。 */
export type MessageSegment =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "mention"; readonly userRef: string; readonly displayName?: string }
	| { readonly type: "face"; readonly faceId: string }
	| {
			readonly type: "image" | "audio" | "video" | "file";
			readonly mediaRef?: string;
			readonly url?: string;
			readonly fileName?: string;
			/** 能力未知保持未知；不伪转写/不伪理解。 */
			readonly understood: false;
	  }
	/** 卡片原文（ark/json、xml）；不解析语义，只保留原文。 */
	| { readonly type: "json" | "xml"; readonly data: string }
	/** 合并转发；resId 经 get_forward_msg 解析，不嵌套展开。 */
	| { readonly type: "forward"; readonly resId: string };

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
	readonly targetRef?: string;
	readonly messageRef?: string;
	readonly summary?: string;
	readonly source: "platform" | "internal";
}

export type RequestState = "pending" | "confirmed" | "unknown";

export interface RequestFact {
	readonly ref: string;
	readonly kind: "friend" | "group_invite" | "group_join_request";
	readonly state: RequestState;
	readonly requesterRef: string | null;
	readonly requesterDisplayName: string | null;
	readonly targetConversationRef?: string;
	readonly comment: string | null;
	readonly time: string;
}

/* ---------- 控制状态（单写方，持久提交成功后才报告成功） ---------- */

export type AttentionMode = "normal" | "direct_only" | "silent";
export type AttentionPriority = "normal" | "preferred";

/** 单一目标的显式覆盖；attention.set 只改提供的字段。 */
export interface AttentionOverride {
	readonly mode?: AttentionMode;
	readonly priority?: AttentionPriority;
	/** 带时区 ISO 时间规范化 UTC；null = 提前恢复。 */
	readonly pausedUntil?: string | null;
}

export interface AttentionRule {
	readonly target: string;
	readonly override: AttentionOverride;
}

/** 从安装初值 + 账号覆盖 + 会话覆盖计算的当前生效规则（非存储态）。 */
export interface EffectiveAttention {
	readonly mode: AttentionMode;
	readonly priority: AttentionPriority;
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
export function classifyPlatformReceipt(response: { status?: unknown; retcode?: unknown }): "succeeded" | "failed" | "unknown" {
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
