import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldCancelled, worldFailed, worldSucceeded, worldUnknown } from "../../../../src/extensions/world-framework/result.js";
import { checkMediaPath, toFileUri } from "./media-root.js";
import type { MediaStaging } from "./media.js";
import type { QqTransport, TransportCallOutcome } from "./transport.js";
import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { OperationLog } from "./operation-log.js";
import type { DeploymentGrants } from "./grants.js";
import { hasGrant } from "./grants.js";
import { requiredGrant } from "./grants-vocabulary.js";
import * as render from "./render.js";
import { messageRef, parseConversationRef, parseUserRef, refBelongsToAccount, userRef, type MessageFact } from "./types.js";
import { expandImages, imageSourcesFromFacts, imageSourcesFromOneBot, withImages } from "./media-fetch.js";
import type { ImageContent } from "../../../../src/core/content.js";

/**
 * QQ 应用层：动作执行、grant 中间件、目标校验与派发屏障。
 * 所有写动作走 validate → intent(durable) → 平台调用 → 回执结算 → 返回；
 * 超时/断开映射 unknown，不自动重发；grant 外拒绝为 failed+not_started，平台调用 0 次。
 */

export interface QqAppDeps {
	readonly selfId: string;
	readonly grants: DeploymentGrants;
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly ops: OperationLog;
	readonly transport: QqTransport;
	readonly now?: () => string;
	readonly media?: { readonly allowedRoots: readonly string[]; readonly staging: MediaStaging };
	/** 呈现选项（快照头时区）；批次现场经 scheduler 注入，observe 现场经此注入。 */
	readonly display?: render.DisplayOptions;
}

const CONVERSATION_REF = /^qq-conversation:(\d+):(private|group|temp):([^\s]+)$/;
const REF_USER = /^qq-user:(\d+):(\d+)$/;
/** SnowLuma 固定事实（交互合同 §1）：单次 history count 最多 200。 */
const SNOWLUMA_HISTORY_MAX = 200;

/** temp 会话 key（<uin>-g<groupId>）→ 对端 uin；读回执/历史按对端 user_id 路由，与 speak 共用语义。 */
function tempPeerUin(key: string): string {
	return /^(\d+)-g/.exec(key)?.[1] ?? key;
}

function nowIso(deps: QqAppDeps): string {
	return (deps.now ?? (() => new Date().toISOString()))();
}

/** 会话 ref 的账号边界校验；跨账号一律 account_mismatch。 */
function checkConversationRef(deps: QqAppDeps, ref: unknown): { ok: true; ref: string } | ToolExecutionResult {
	if (typeof ref !== "string" || !CONVERSATION_REF.test(ref)) {
		return worldFailed(`目标会话引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	if (!refBelongsToAccount(ref, deps.selfId)) {
		return worldFailed(`会话引用不属于绑定账号 ${deps.selfId}`, { reason: "account_mismatch" });
	}
	return { ok: true, ref };
}

function checkUserRef(deps: QqAppDeps, ref: unknown): { ok: true; ref: string; uin: string } | ToolExecutionResult {
	if (typeof ref !== "string" || !REF_USER.test(ref)) {
		return worldFailed(`用户引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	const parsed = parseUserRef(ref)!;
	if (parsed.accountId !== deps.selfId) {
		return worldFailed(`用户引用不属于绑定账号 ${deps.selfId}`, { reason: "account_mismatch" });
	}
	return { ok: true, ref, uin: parsed.uin };
}

function checkMessageRef(deps: QqAppDeps, ref: unknown): { ok: true; ref: string } | ToolExecutionResult {
	if (typeof ref !== "string" || !refBelongsToAccount(ref, deps.selfId) || !ref.startsWith("qq-message:")) {
		return worldFailed(`消息引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	return { ok: true, ref };
}

/** 平台在线状态查询（members 校验等用）。 */
async function isMemberOf(deps: QqAppDeps, groupKey: string, uin: string): Promise<boolean | null> {
	const outcome = await deps.transport.call("get_group_member_info", { group_id: Number(groupKey), user_id: Number(uin), no_cache: true });
	return outcome.status === "ok";
}

export async function handleQqCall(deps: QqAppDeps, rawAction: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
	// ---- grant 中间件（所有入口同一检查；拒绝时平台调用为 0） ----
	const grant = requiredGrant(rawAction, params);
	if (grant !== null && !hasGrant(deps.grants, grant)) {
		return worldFailed(`本实例未授 ${grant}；适配器可能有实现，但未调用平台。`, { reason: "grant_denied", effect: "not_started" });
	}
	if (signal?.aborted) return worldCancelled("cancelled / 未派发", { effect: "not_started" });

	switch (rawAction) {
		case "observe":
			return handleObserve(deps, params, signal);
		case "speak":
			return handleSpeak(deps, params, signal);
		case "gesture":
			return handleGesture(deps, params, signal);
		case "attention":
			return handleAttention(deps, params);
		case "follow_up":
			return handleFollowUp(deps, params);
		case "account":
			return handleAccount(deps, params, signal);
		default:
			return worldFailed(`未知动作：${rawAction}`, { reason: "unknown_action" });
	}
}

/* ---------- speak ---------- */

async function handleSpeak(deps: QqAppDeps, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
	const target = checkConversationRef(deps, params.conversationRef);
	if (!("ok" in target)) return target;
	const parsed = parseConversationRef(target.ref)!;
	const content = params.content;
	if (!Array.isArray(content) || content.length === 0) {
		return worldFailed("content 必须为非空分段数组。", { reason: "invalid_content" });
	}

	const replyTo = params.replyTo;
	if (replyTo !== undefined) {
		const reply = checkMessageRef(deps, replyTo);
		if (!("ok" in reply)) return reply;
		const belongs = await messageBelongsToConversation(deps, reply.ref, target.ref, signal);
		if (!belongs.ok) return belongs.result;
	}

	// mention 目标必须可核验：journal 成员证据或在线成员查询。
	for (const segment of content as unknown[]) {
		if (typeof segment !== "object" || segment === null) {
			return worldFailed("content 分段必须是对象。", { reason: "invalid_content" });
		}
		const seg = segment as Record<string, unknown>;
		if (seg.type === "mention") {
			const mention = checkUserRef(deps, seg.userRef);
			if (!("ok" in mention)) return mention;
			const verified = memberEvidence(deps, target.ref, mention.uin) ?? (parsed.kind === "group" ? await isMemberOf(deps, parsed.key, mention.uin) : null);
			if (verified === false) {
				return worldFailed(`mention 目标 ${mention.ref} 无法核验为该群成员。`, { reason: "mention_target_unverifiable", effect: "not_started" });
			}
		}
	}

	const segments = toOneBotSegments(deps, content as Record<string, unknown>[]);
	if (!segments.ok) return segments.result;

	// 路由：群→send_group_msg；私聊→user_id；temp→user_id+源群 group_id（key 形如 <uin>-g<groupId>）。
	let action: string;
	let sendParams: Record<string, unknown>;
	if (parsed.kind === "group") {
		action = "send_group_msg";
		sendParams = { group_id: Number(parsed.key) };
	} else {
		action = "send_private_msg";
		const tempSource = parsed.kind === "temp" ? /^(\d+)-g(\d+)$/.exec(parsed.key) : null;
		sendParams = tempSource
			? { user_id: Number(tempSource[1]!), group_id: Number(tempSource[2]!) }
			: { user_id: Number(parsed.key) };
	}
	// SnowLuma 把一次请求中的 file 移到非 file 之后，故按文件边界独立派发。
	// 每批独立 echo/operationRef；所有复制先完成，避免发出文字后才发现确定的复制错误。
	let batches: { ref: string; from: number; through: number; message: Record<string, unknown>[] }[];
	try {
		batches = segments.batches.map(batch => {
			const ref = deps.ops.newOperationRef();
			return { ref, from: batch.from, through: batch.through, message: batch.build(ref) };
		});
	} catch (error) {
		return worldFailed(`媒体复制失败，未调用平台：${errorMessage(error)}`, { reason: "media_staging_failed", effect: "not_started" });
	}
	const confirmedParts: { from: number; through: number; operationRef: string; messageRef?: string }[] = [];
	let lastResult: ToolExecutionResult | undefined;
	for (const batch of batches) {
		const result = await dispatchWrite(
		deps,
		"speak",
		action,
		{ ...sendParams, message: batch.message },
		target.ref,
		signal,
		(data) => {
			const messageId = (data as { message_id?: unknown })?.message_id;
			const messageRefValue = typeof messageId === "number" ? messageRef(deps.selfId, messageId) : undefined;
			return worldSucceeded(
				render.receipt.ok("sent", [`target=${target.ref}`, ...(messageRefValue ? [`messageRef=${messageRefValue}`] : [])]),
				{ target: target.ref, ...(messageRefValue ? { messageRef: messageRefValue } : {}) },
				"applied",
			);
		},
		undefined,
		batch.ref,
	);
		const details = result.details as Record<string, unknown> | undefined;
		if (result.status !== "succeeded") {
			return { ...result, result: `${result.result}\n已确认分段=${confirmedParts.map(p => `${p.from}-${p.through}:${p.messageRef ?? p.operationRef}`).join(", ") || "无"}\n停止于分段=${batch.from}；余下未派发，不整包重发。`,
				details: { ...details, confirmedParts, stoppedAt: batch.from, remainingFrom: batch.through + 1 } };
		}
		confirmedParts.push({ from: batch.from, through: batch.through, operationRef: batch.ref,
			...(typeof details?.messageRef === "string" ? { messageRef: details.messageRef } : {}) });
		lastResult = result;
	}
	return { ...lastResult!, result: `${lastResult!.result}${batches.length > 1 ? `\n已确认分段=${confirmedParts.map(p => `${p.from}-${p.through}:${p.messageRef ?? p.operationRef}`).join(", ")}` : ""}`,
		details: { ...(lastResult!.details as Record<string, unknown> | undefined), confirmedParts } };
}

/**
 * 消息归属核验：本地 journal 有记录直接比对；本地未持有（retention/未接收）
 * 在线 get_msg 重新核验；平台也查不到则明确不可用，不猜测归属。
 */
async function messageBelongsToConversation(
	deps: QqAppDeps,
	messageRefValue: string,
	conversationRefValue: string,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; result: ToolExecutionResult }> {
	const local = deps.journal.getMessage(messageRefValue);
	if (local) {
		if (local.conversationRef === conversationRefValue) return { ok: true };
		return {
			ok: false,
			result: worldFailed(`replyTo ${messageRefValue} 不属于目标会话，拒绝猜测归属。`, { reason: "reply_target_mismatch" }),
		};
	}
	const messageId = Number(messageRefValue.split(":")[2]);
	const outcome = await deps.transport.call("get_msg", { message_id: messageId }, signal);
	if (outcome.status !== "ok") {
		return {
			ok: false,
			result: worldFailed(`消息 ${messageRefValue} 本地未持有且平台不可寻址，不猜测归属。`, { reason: "reply_target_unverifiable", effect: "not_started" }),
		};
	}
	const data = outcome.data as { group_id?: unknown; user_id?: unknown; target_id?: unknown };
	const parsed = parseConversationRef(conversationRefValue)!;
	const belongs =
		parsed.kind === "group"
			? data.group_id === Number(parsed.key)
			: [data.user_id, data.target_id].includes(Number(parsed.key));
	if (!belongs) {
		return {
			ok: false,
			result: worldFailed(`replyTo ${messageRefValue} 经平台核验不属于目标会话。`, { reason: "reply_target_mismatch" }),
		};
	}
	return { ok: true };
}

function memberEvidence(deps: QqAppDeps, conversationRefValue: string, uin: string): boolean | null {
	const ref = userRef(deps.selfId, uin);
	for (const fact of deps.journal.snapshot.messages.get(conversationRefValue) ?? []) {
		if (fact.senderRef === ref) return true;
	}
	return null;
}

/** 先验证整个请求，再以同一个 operationRef 复制；任何确定的资源错误都不会部分派发。 */
function toOneBotSegments(deps: QqAppDeps, content: Record<string, unknown>[]):
	{ ok: true; build: (ref: string) => Record<string, unknown>[]; batches: { from: number; through: number; build: (ref: string) => Record<string, unknown>[] }[] } | { ok: false; result: ToolExecutionResult } {
	const out: ((ref: string) => Record<string, unknown>)[] = [];
	for (const seg of content) {
		switch (seg.type) {
			case "text":
				out.push(() => ({ type: "text", data: { text: seg.text } }));
				break;
			case "mention":
				out.push(() => ({ type: "at", data: { qq: Number(parseUserRef(String(seg.userRef))!.uin) } }));
				break;
			case "face":
				out.push(() => ({ type: "face", data: { id: Number(seg.faceId) } }));
				break;
			case "image":
			case "audio":
			case "video":
			case "file": {
				const resource = seg.resource as { kind?: unknown; path?: unknown; ref?: unknown } | undefined;
				const type = seg.type === "audio" ? "record" : seg.type;
				const name = seg.type === "file" && typeof seg.name === "string" ? { name: seg.name } : {};
				if (resource?.kind === "file" && typeof resource.path === "string") {
					if (!deps.media) return worldFailedResult("媒体配置尚未就绪。", { reason: "media_not_ready", effect: "not_started" });
					const checked = checkMediaPath(resource.path, { allowedRoots: deps.media.allowedRoots });
					if (!checked.ok) return worldFailedResult(checked.detail, { reason: checked.reason, effect: "not_started" });
					const staging = deps.media.staging;
					out.push(ref => ({ type, data: { file: toFileUri(staging.stage(checked.realPath, ref)), ...name } }));
				} else if (resource?.kind === "qq_media" && typeof resource.ref === "string") {
					if (!refBelongsToAccount(resource.ref, deps.selfId)) return worldFailedResult("媒体引用不属于绑定账号。", { reason: "account_mismatch", effect: "not_started" });
					const media = deps.journal.getMedia(resource.ref);
					if (!media) return worldFailedResult("媒体引用不存在或已不可寻址。", { reason: "media_unavailable", effect: "not_started" });
					if (media.type !== seg.type) return worldFailedResult("媒体类型与请求分段不符。", { reason: "media_type_mismatch", effect: "not_started" });
					// 平台 URL 才能直接引用；本地路径必须走资源根与 staging，不能借 qq_media 绕过。
					if (!media.url || !/^https?:\/\//i.test(media.url)) return worldFailedResult("媒体没有可引用的平台 HTTP(S) 地址。", { reason: "media_unavailable", effect: "not_started" });
					out.push(() => ({ type, data: { file: media.url, ...(seg.type === "file" && media.fileName ? { name: media.fileName } : {}), ...name } }));
				} else return worldFailedResult("媒体 resource 必须为 file 或 qq_media。", { reason: "invalid_resource", effect: "not_started" });
				break;
			}
			default:
				return worldFailedResult("未知消息分段。", { reason: "invalid_content", effect: "not_started" });
		}
	}
	const batches: { from: number; through: number; build: (ref: string) => Record<string, unknown>[] }[] = [];
	const batch = (from: number, through: number): void => {
		if (through < from) return;
		batches.push({ from, through, build: ref => out.slice(from, through + 1).map(build => build(ref)) });
	};
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i]!.type !== "file" && content[i]!.type !== "video") continue;
		batch(start, i - 1); batch(i, i); start = i + 1;
	}
	batch(start, content.length - 1);
	return { ok: true, build: ref => out.map(build => build(ref)), batches };
}

/* ---------- gesture ---------- */

async function handleGesture(deps: QqAppDeps, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
	if (params.kind === "react") {
		const message = checkMessageRef(deps, params.messageRef);
		if (!("ok" in message)) return message;
		const code = String(params.reactionCode ?? "");
		if (!/^[0-9]+$/.test(code)) {
			return worldFailed("reactionCode 必须复制 expressions 查询得到的数字编码。", { reason: "invalid_reaction_code" });
		}
		const fact = deps.journal.getMessage(message.ref);
		if (!fact || !fact.conversationRef.includes(":group:")) {
			return worldFailed(`消息 ${message.ref} 非群消息；回应路径未验证到私聊，不外推。`, { reason: "unsupported_target" });
		}
		const isSet = params.enabled === undefined ? true : Boolean(params.enabled);
		return dispatchWrite(
			deps,
			"gesture.react",
			"set_group_reaction",
			{ message_id: Number(message.ref.split(":")[2]), code, is_set: isSet },
			message.ref,
			signal,
			() => worldSucceeded(render.receipt.ok(`react ${isSet ? "set" : "unset"} code=${code}`, [`messageRef=${message.ref}`]), { messageRef: message.ref }, "applied"),
		);
	}
	if (params.kind === "poke") {
		const target = checkConversationRef(deps, params.conversationRef);
		if (!("ok" in target)) return target;
		const user = checkUserRef(deps, params.userRef);
		if (!("ok" in user)) return user;
		const parsed = parseConversationRef(target.ref)!;
		if (parsed.kind === "group") {
			return dispatchWrite(
				deps,
				"gesture.poke",
				"group_poke",
				{ group_id: Number(parsed.key), user_id: Number(user.uin) },
				target.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("poke", [`target=${target.ref}`, `userRef=${user.ref}`]), { target: target.ref }, "applied"),
			);
		}
		if (parsed.kind === "private") {
			return dispatchWrite(
				deps,
				"gesture.poke",
				"friend_poke",
				{ user_id: Number(user.uin) },
				target.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("poke", [`target=${target.ref}`, `userRef=${user.ref}`]), { target: target.ref }, "applied"),
			);
		}
		return worldFailed("temp 会话不路由 poke。", { reason: "unsupported_target" });
	}
	return worldFailed("gesture.kind 必须是 react 或 poke。", { reason: "invalid_kind" });
}

/* ---------- attention / follow_up ---------- */

function handleAttention(deps: QqAppDeps, params: Record<string, unknown>): ToolExecutionResult {
	const targetRaw = params.target;
	let target: string;
	if (targetRaw === "account") {
		target = "account";
	} else {
		const checked = checkConversationRef(deps, targetRaw);
		if (!("ok" in checked)) return checked;
		target = checked.ref;
	}
	try {
		if (params.operation === "clear") {
			const revision = deps.control.clearAttention(target);
			return worldSucceeded(
				render.receipt.ok("attention.clear", [`target=${target}`, `revision=${revision}；persisted=true`]),
				{ target, revision, persisted: true },
				"applied",
			);
		}
		if (params.operation === "set") {
			const patch: Record<string, unknown> = {};
			if (params.mode !== undefined) patch.mode = params.mode;
			if (params.priority !== undefined) patch.priority = params.priority;
			if (params.pausedUntil !== undefined) patch.pausedUntil = params.pausedUntil;
			const revision = deps.control.setAttention(target, patch);
			return worldSucceeded(
				render.receipt.ok("attention.set", [`target=${target}`, `revision=${revision}；persisted=true`]),
				{ target, revision, persisted: true },
				"applied",
			);
		}
		return worldFailed("attention.operation 必须是 set 或 clear。", { reason: "invalid_operation" });
	} catch (error) {
		return worldFailed(`attention 保存失败，保留旧控制状态：${errorMessage(error)}`, { reason: "control_persist_failed" });
	}
}

function handleFollowUp(deps: QqAppDeps, params: Record<string, unknown>): ToolExecutionResult {
	try {
		switch (params.operation) {
			case "create": {
				const target = checkConversationRef(deps, params.targetRef);
				if (!("ok" in target)) return target;
				const item = deps.control.createFollowUp({
					targetRef: target.ref,
					note: String(params.note ?? ""),
					evidenceRefs: Array.isArray(params.evidenceRefs) ? (params.evidenceRefs as string[]) : undefined,
					reviewAt: params.reviewAt === undefined ? null : (params.reviewAt as string | null),
				});
				return worldSucceeded(
					render.receipt.ok("follow_up.create", [`ref=${item.ref}`, `target=${item.targetRef}`, `reviewAt=${item.reviewAt ?? "null"}`]),
					{ ref: item.ref, revision: deps.control.revision, persisted: true },
					"applied",
				);
			}
			case "update": {
				const item = deps.control.updateFollowUp(String(params.ref ?? ""), {
					note: params.note === undefined ? undefined : String(params.note),
					evidenceRefs: params.evidenceRefs === undefined ? undefined : (params.evidenceRefs as string[]),
					reviewAt: params.reviewAt === undefined ? undefined : (params.reviewAt as string | null),
				});
				return worldSucceeded(render.receipt.ok("follow_up.update", [`ref=${item.ref}`, `reviewAt=${item.reviewAt ?? "null"}`]), { ref: item.ref, persisted: true }, "applied");
			}
			case "close":
			case "cancel": {
				const item = deps.control.settleFollowUp(String(params.ref ?? ""), String(params.resolution ?? ""), params.operation === "close" ? "closed" : "cancelled");
				return worldSucceeded(render.receipt.ok(`follow_up.${params.operation}`, [`ref=${item.ref}`, `state=${item.state}`]), { ref: item.ref, persisted: true }, "applied");
			}
			default:
				return worldFailed("follow_up.operation 必须是 create/update/close/cancel。", { reason: "invalid_operation" });
		}
	} catch (error) {
		return worldFailed(`follow_up 保存失败，保留旧控制状态：${errorMessage(error)}`, { reason: errorMessage(error).includes("不存在") ? "not_found" : "control_persist_failed" });
	}
}

/* ---------- account ---------- */

async function handleAccount(deps: QqAppDeps, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
	const operation = String(params.operation ?? "");
	switch (operation) {
		case "respond_request": {
			const requestRef = String(params.requestRef ?? "");
			if (!refBelongsToAccount(requestRef, deps.selfId)) {
				return worldFailed(`requestRef 非法：${requestRef}`, { reason: "invalid_target" });
			}
			const fact = deps.journal.snapshot.requests.get(requestRef);
			const flag = requestRef.split(":")[2]!;
			const approve = params.decision === "accept";
			const platformAction = fact?.kind === "friend" ? "set_friend_add_request" : "set_group_add_request";
			// OneBot v11 语义：群请求 sub_type=invite（邀请）/add（加群申请）是不同处理路径，
			// 必须按事实 kind 回传，不能一律 add（G9 才会暴露的参数错误）。
			const extraParams: Record<string, unknown> =
				platformAction === "set_group_add_request"
					? { sub_type: fact?.kind === "group_invite" ? "invite" : "add" }
					: {};
			return dispatchWrite(
				deps,
				`account.${operation}`,
				platformAction,
				{ flag, approve, ...extraParams },
				requestRef,
				signal,
				() => worldSucceeded(render.receipt.ok(`respond_request ${params.decision}`, [`requestRef=${requestRef}`]), { requestRef }, "applied"),
			);
		}
		case "retract": {
			const message = checkMessageRef(deps, params.messageRef);
			if (!("ok" in message)) return message;
			// 合同：确认是自己且可寻址。本地未持有的消息在线核验发送者，不盲发 delete_msg。
			const own = await isOwnMessageForRetract(deps, message.ref, signal);
			if (!own.ok) return own.result;
			return dispatchWrite(
				deps,
				`account.${operation}`,
				"delete_msg",
				{ message_id: Number(message.ref.split(":")[2]) },
				message.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("retract", [`messageRef=${message.ref}`]), { messageRef: message.ref }, "applied"),
			);
		}
		case "mark_read": {
			const target = checkConversationRef(deps, params.conversationRef);
			if (!("ok" in target)) return target;
			const parsed = parseConversationRef(target.ref)!;
			// temp 会话对端是 uin（key 形如 <uin>-g<groupId>）；读回执按对端 user_id 提交，不透传 NaN
			const platformAction =
				parsed.kind === "group" ? "mark_group_msg_as_read" : "mark_private_msg_as_read";
			const platformParams: Record<string, unknown> =
				parsed.kind === "group"
					? { group_id: Number(parsed.key) }
					: { user_id: Number(tempPeerUin(parsed.key)) };
			return dispatchWrite(
				deps,
				`account.${operation}`,
				platformAction,
				platformParams,
				target.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("mark_read", [`target=${target.ref}（会话级，不承诺只读冻结范围）`]), { target: target.ref }, "applied"),
			);
		}
		case "leave_group": {
			const target = checkConversationRef(deps, params.conversationRef);
			if (!("ok" in target)) return target;
			const parsed = parseConversationRef(target.ref)!;
			if (parsed.kind !== "group") {
				return worldFailed("leave_group 只接受群会话引用。", { reason: "invalid_target" });
			}
			return dispatchWrite(
				deps,
				`account.${operation}`,
				"set_group_leave",
				{ group_id: Number(parsed.key) },
				target.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("leave_group", [`target=${target.ref}`]), { target: target.ref }, "applied"),
			);
		}
		case "remove_contact": {
			const user = checkUserRef(deps, params.userRef);
			if (!("ok" in user)) return user;
			return dispatchWrite(
				deps,
				`account.${operation}`,
				"delete_friend",
				{ friend_id: Number(user.uin), block: Boolean(params.block ?? false), temp_block: 0 },
				user.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("remove_contact", [`userRef=${user.ref}（本地过去事实保留）`]), { userRef: user.ref }, "applied"),
			);
		}
		case "set_profile": {
			const calls: { name: string; params: Record<string, unknown>; label: string }[] = [];
			if (typeof params.nickname === "string") calls.push({ name: "set_qq_profile", params: { nickname: params.nickname }, label: "nickname" });
			if (typeof params.signature === "string") calls.push({ name: "set_self_longnick", params: { longNick: params.signature }, label: "signature" });
			if (calls.length === 0) return worldFailed("set_profile 至少提供 nickname 或 signature。", { reason: "invalid_params" });
			const results: string[] = [];
			for (const call of calls) {
				const outcome = await dispatchWriteRaw(deps, `account.${operation}`, call.name, call.params, "account", signal);
				if (!outcome.ok) {
					// 多字段非原子：返回已确认部分，不整包重发（合同 §3.2"多字段逐项回执"）。
					const confirmed = results.length > 0 ? `已确认部分：${results.join("；")}；` : "";
					const failedResult = outcome.result as { result?: string };
					return {
						...outcome.result,
						result: `${failedResult.result ?? ""}\n${confirmed}其余字段未执行，不整包重试。`,
					};
				}
				results.push(`${call.label}=${call.params.nickname ?? call.params.longNick}`);
			}
			return worldSucceeded(render.receipt.ok("set_profile", results), { changed: results }, "applied");
		}
		case "set_avatar": {
			const prepared = toOneBotSegments(deps, [{ type: "image", resource: params.resource }]);
			if (!prepared.ok) return prepared.result;
			return dispatchWrite(
				deps,
				`account.${operation}`,
				"set_qq_avatar",
				{},
				"account",
				signal,
				() => worldSucceeded(render.receipt.ok("set_avatar", []), {}, "applied"),
				(ref) => ({ file: (prepared.build(ref)[0]!.data as { file: string }).file }),
			);
		}
		case "set_presence": {
			return worldFailed("presenceRef 无已核实映射；不猜数字状态值。", { reason: "presence_mapping_unverified", effect: "not_started" });
		}
		case "set_group_card": {
			const target = checkConversationRef(deps, params.conversationRef);
			if (!("ok" in target)) return target;
			const parsed = parseConversationRef(target.ref)!;
			if (parsed.kind !== "group") return worldFailed("set_group_card 只接受群会话引用。", { reason: "invalid_target" });
			const card = String(params.card ?? "");
			return dispatchWrite(
				deps,
				`account.${operation}`,
				"set_group_card",
				{ group_id: Number(parsed.key), user_id: Number(deps.selfId), card },
				target.ref,
				signal,
				() => worldSucceeded(render.receipt.ok("set_group_card", [`target=${target.ref}`, `card=${card || "(清除)"}`]), { target: target.ref }, "applied"),
			);
		}
		default:
			return worldFailed(`未知 account.operation: ${operation}`, { reason: "unknown_operation" });
	}
}

/** 撤回前的所有权核验：本地 out 事实直接通过；否则 get_msg 比对发送者。 */
async function isOwnMessageForRetract(deps: QqAppDeps, ref: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; result: ToolExecutionResult }> {
	const local = deps.journal.getMessage(ref);
	if (local) {
		if (local.direction === "out") return { ok: true };
		return worldFailedResult(`消息 ${ref} 不是本账号发出的，不能撤回。`, { reason: "not_own_message" });
	}
	const outcome = await deps.transport.call("get_msg", { message_id: Number(ref.split(":")[2]) }, signal);
	if (outcome.status !== "ok") {
		return worldFailedResult(`消息 ${ref} 本地未持有且平台不可寻址，不执行撤回。`, { reason: "message_unaddressable", effect: "not_started" });
	}
	const senderId = (outcome.data as { user_id?: unknown }).user_id;
	if (senderId !== Number(deps.selfId)) {
		return worldFailedResult(`消息 ${ref} 经平台核验不是本账号发出，不能撤回。`, { reason: "not_own_message" });
	}
	return { ok: true };
}

function worldFailedResult(result: string, details: Record<string, unknown>): { ok: false; result: ToolExecutionResult } {
	return { ok: false, result: worldFailed(result, details) };
}

/** 平台只读查询失败的统一呈现：不倾倒原始回执正文，给一行原因与下一步；完整 outcome 进 details。 */
function queryFailed(label: string, outcome: TransportCallOutcome, next: string): ToolExecutionResult {
	const detail = outcome.status === "failed" ? `${outcome.kind}: ${outcome.reason}` : "unexpected_response";
	return worldFailed(
		render.receipt.fail(label, [`reason=${detail}`, `下一步：${next}`]),
		{ reason: "platform_query_failed", outcome: outcome as unknown },
	);
}

/** observe 现场的时区视图（快照头一次偏移标注；无头回执保持 UTC——合同：程序 UTC 不变）。 */
function timeView(deps: QqAppDeps): render.TimeView {
	return new render.TimeView(deps.display?.timezone);
}

/* ---------- includeMedia 装配（收集/抓取/附加在 media-fetch.ts） ---------- */

/** 本地事实页结果：includeMedia 时对页内图片段抓取附加。 */
async function localConversationResult(
	page: { text: string; hasMore: boolean; nextCursor?: string; pageFacts: MessageFact[] },
	params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	let text = `${page.text}\nhasMore=${page.hasMore ? "true" : "false"}${page.nextCursor ? `；nextCursor=${page.nextCursor}` : ""}`;
	let images: ImageContent[] = [];
	if (params.includeMedia === true) {
		const expanded = await expandImages(imageSourcesFromFacts(page.pageFacts));
		if (expanded.note) text += `\n${expanded.note}`;
		images = expanded.images;
	}
	return withImages(worldSucceeded(text, {}), images);
}

/** 合并转发一层展开：get_forward_msg 取节点；节点渲染归呈现层（render.ts）。 */
async function expandForward(deps: QqAppDeps, fact: MessageFact, lines: string[], signal?: AbortSignal): Promise<void> {
	for (const seg of fact.segments) {
		if (seg.type !== "forward") continue;
		const outcome = await deps.transport.call("get_forward_msg", { id: seg.resId }, signal);
		if (outcome.status !== "ok") {
			lines.push(render.forwardUnavailableLine(seg.resId));
			continue;
		}
		lines.push(...render.renderForwardNodes((outcome.data as { messages?: Record<string, unknown>[] })?.messages ?? []));
	}
}

/* ---------- 派发屏障 ---------- */

type DispatchOutcome = { ok: true; data: unknown; ref: string; diagnostic?: string } | { ok: false; result: ToolExecutionResult };

async function dispatchWriteRaw(
	deps: QqAppDeps,
	actionLabel: string,
	platformAction: string,
	platformParams: Record<string, unknown>,
	target: string,
	signal?: AbortSignal,
	prepare?: (ref: string) => Record<string, unknown>,
	reservedRef?: string,
): Promise<DispatchOutcome> {
	if (signal?.aborted) return { ok: false, result: worldCancelled("cancelled / 未派发", { effect: "not_started" }) };
	const ref = reservedRef ?? deps.ops.newOperationRef();
	const at = nowIso(deps);
	try {
		if (prepare) platformParams = prepare(ref);
	} catch (error) {
		return worldFailedResult(`媒体复制失败，未调用平台：${errorMessage(error)}`, { reason: "media_staging_failed", operationRef: ref, effect: "not_started" });
	}
	// will_dispatch durable barrier：意图先于平台调用真实落盘；echo=operationRef
	// 使迟到回执可凭 raw 观察归并回本操作。
	try {
		deps.ops.commitIntent({ ref, identity: `world:qq/${actionLabel}`, action: platformAction, target, outcome: "unknown", echo: ref, startedAt: at });
	} catch (error) {
		return worldFailedResult(`操作意图保存失败，未调用平台：${errorMessage(error)}`, { reason: "intent_commit_failed", operationRef: ref, effect: "not_started" });
	}
	let outcome: TransportCallOutcome;
	try {
		outcome = await deps.transport.call(platformAction, platformParams, signal, ref);
	} catch (error) {
		outcome = { status: "failed", kind: "connection", reason: errorMessage(error) };
	}
	// 平台结论优先；回执日志故障只加诊断。原 intent 保持 unknown，保留上传证据。
	const settle = (status: "succeeded" | "failed" | "unknown", extra: { reason?: string; receipt?: unknown }): string | undefined => {
		try { deps.ops.settle(ref, status, nowIso(deps), extra); }
		catch { return "operation_receipt_log_failed"; }
		return undefined;
	};
	if (outcome.status === "ok") {
		const diagnostic = settle("succeeded", { receipt: outcome.data });
		return { ok: true, data: outcome.data, ref, diagnostic };
	}
	if (outcome.kind === "rejected" || outcome.kind === "not_connected") {
		// 平台明确拒绝或确定未派发：真实结论是 failed，不夸大为未知。
		const diagnostic = settle("failed", { reason: `${outcome.kind}: ${outcome.reason}` });
		return {
			ok: false,
			result: worldFailed(
				render.receipt.fail(actionLabel, [
					`target=${target}`,
					`reason=${outcome.kind === "rejected" ? "platform_rejected" : "not_connected"}；${outcome.reason}`,
				]),
				{ reason: outcome.kind === "rejected" ? "platform_rejected" : "not_connected", operationRef: ref, ...(diagnostic ? { diagnostic } : {}) },
			),
		};
	}
	// 超时/断开：请求可能已到达，unknown 不自动重发。
	const diagnostic = settle("unknown", { reason: `${outcome.kind}: ${outcome.reason}` });
	// unknown 结论即将交付给主体；此后该操作的迟到回执升级需要通知（在途回执不需要）。
	deps.ops.markDeliveredUnknown(ref);
	return {
		ok: false,
		result: worldUnknown(
			render.receipt.unknown(actionLabel, [
				`operationRef=${ref}`,
				`回执未确认效果（${outcome.kind}），可能已经执行；不自动重发。`,
				render.RECEIPT_NOTES.verifyOperation(ref),
			]),
			{ operationRef: ref, effectStatus: "unknown", ...(diagnostic ? { diagnostic } : {}) },
		),
	};
}

async function dispatchWrite(
	deps: QqAppDeps,
	actionLabel: string,
	platformAction: string,
	platformParams: Record<string, unknown>,
	target: string,
	signal: AbortSignal | undefined,
	buildSuccess: (data: unknown) => ToolExecutionResult,
	prepare?: (ref: string) => Record<string, unknown>,
	reservedRef?: string,
): Promise<ToolExecutionResult> {
	const outcome = await dispatchWriteRaw(deps, actionLabel, platformAction, platformParams, target, signal, prepare, reservedRef);
	if (!outcome.ok) return outcome.result;
	const result = buildSuccess(outcome.data);
	return { ...result, result: `${result.result}\noperationRef=${outcome.ref}${outcome.diagnostic ? `\ndiagnostic=${outcome.diagnostic}；平台结果保持，日志待核验。` : ""}`,
		details: { ...(result.details as Record<string, unknown> | undefined), operationRef: outcome.ref, ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}) } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 本地列表 limit 截断：显式 hasMore，不静默丢弃（limit 缺省返回全量）。 */
function truncatePage<T>(items: readonly T[], limitRaw: unknown): { page: T[]; hasMore: boolean } {
	const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
	if (limit === undefined || items.length <= limit) return { page: [...items], hasMore: false };
	return { page: items.slice(0, limit), hasMore: true };
}

/* ---------- observe ---------- */

async function handleObserve(deps: QqAppDeps, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
	const scope = String(params.scope ?? "");
	switch (scope) {
		case "status":
			return worldSucceeded(
				render.receipt.ok("status", [
					`selfId=${deps.selfId}`,
					`grants=[${deps.grants.grants.join(", ") || "（空）"}]`,
					`事实会话数=${deps.journal.snapshot.messages.size}`,
					`unknown 操作数=${deps.ops.listUnknown().length}`,
				]),
				{},
			);
		case "capabilities": {
			const actionFilter = typeof params.action === "string" && params.action ? params.action : null;
			const media: Record<string, { supportedByAdapter: boolean | null; allowedByDeployment: boolean; availableNow: boolean | null }> = {};
			const probeTargets: [string, string][] = [["image", "can_send_image"], ["audio", "can_send_record"]];
			for (const [type, action] of actionFilter ? probeTargets.filter(([t]) => t === actionFilter) : probeTargets) {
				const probe = await deps.transport.call(action, {}, signal);
				const yes = probe.status === "ok" ? (probe.data as { yes?: unknown } | null)?.yes : undefined;
				media[type!] = { supportedByAdapter: typeof yes === "boolean" ? yes : null, allowedByDeployment: hasGrant(deps.grants, "messaging"), availableNow: typeof yes === "boolean" ? yes : null };
			}
			for (const type of actionFilter ? ["video", "file"].filter((t) => t === actionFilter) : ["video", "file"]) {
				media[type] = { supportedByAdapter: null, allowedByDeployment: hasGrant(deps.grants, "messaging"), availableNow: null };
			}
			return worldSucceeded(
				render.receipt.ok("capabilities", [
					render.RECEIPT_NOTES.capabilitiesHead,
					`本实例 grants=[${deps.grants.grants.join(", ") || "（空）"}]`,
					...Object.entries(media).map(([type, d]) => render.capabilityLine(type, d)),
					render.RECEIPT_NOTES.capabilitiesCaveat,
				]),
				{ media },
			);
		}
		case "attention": {
			const targetRaw = params.target === undefined || params.target === "account" ? "account" : String(params.target);
			const effective = deps.control.effectiveAttention(targetRaw);
			return worldSucceeded(
				render.receipt.ok("attention", [
					`target=${targetRaw}`,
					`mode=${effective.mode} priority=${effective.priority} pausedUntil=${effective.pausedUntil ?? "null"}`,
				]),
				{},
			);
		}
		case "follow_ups": {
			const items = deps.control.listFollowUps({
				targetRef: params.targetRef === undefined ? undefined : String(params.targetRef),
				state: (params.state as never) ?? "open",
			});
			const { page, hasMore } = truncatePage(items, params.limit);
			const lines = page.map((item) => render.followUpRow(item));
			return worldSucceeded(render.receipt.ok(`follow_ups（${page.length}）`, [...lines, ...(hasMore ? [`hasMore=true（本次呈现 ${page.length}/${items.length}，再用 limit 取余）`] : [])]), {});
		}
		case "operations": {
			if (typeof params.operationRef === "string") {
				const record = deps.ops.get(params.operationRef);
				if (!record) return worldFailed(`操作记录不存在：${params.operationRef}`, { reason: "not_found" });
				return worldSucceeded(render.receipt.ok("operations", render.operationRecordLines(record)), { record });
			}
			const state = String(params.state ?? "unknown");
			const records = state === "unknown" ? deps.ops.listUnknown() : deps.ops.recent(Number(params.limit ?? 20));
			const lines = records.map((r) => render.operationRow(r));
			return worldSucceeded(render.receipt.ok(`operations state=${state}（${records.length}）`, lines), {});
		}
		case "requests": {
			const state = String(params.state ?? "pending");
			const kindFilter = typeof params.kind === "string" ? params.kind : undefined;
			const all = [...deps.journal.snapshot.requests.values()]
				.filter((r) => (state === "all" ? true : r.state === state))
				.filter((r) => (kindFilter ? r.kind === kindFilter : true));
			const { page, hasMore } = truncatePage(all, params.limit);
			const lines = page.map((r) => render.requestRow(r));
			return worldSucceeded(
				render.receipt.ok(
					`requests（${page.length}）`,
					[...lines, ...(hasMore ? [`hasMore=true（本次呈现 ${page.length}/${all.length}，再用 limit 取余）`] : [])],
				),
				{},
			);
		}
		case "overview": {
			const snapshot = deps.journal.snapshot;
			const pendingRequests = [...snapshot.requests.values()].filter((r) => r.state === "pending").length;
			return worldSucceeded(
				render.receipt.ok("overview", [
					`selfId=${deps.selfId}`,
					`已知会话=${snapshot.messages.size}`,
					`pending 申请=${pendingRequests}`,
					`open follow_up=${deps.control.listFollowUps({ state: "open" }).length}`,
					`unknown 操作=${deps.ops.listUnknown().length}`,
					`近期账号事件=${snapshot.accountEvents.slice(-5).map((e) => `${e.kind}@${e.time}`).join(", ") || "（无）"}`,
				]),
				{},
			);
		}
		case "messages": {
			const refs = Array.isArray(params.messageRefs) ? (params.messageRefs as string[]) : [];
			const lines: string[] = [];
			const foundFacts: MessageFact[] = [];
			for (const ref of refs) {
				const checked = checkMessageRef(deps, ref);
				if (!("ok" in checked)) return checked;
				const fact = deps.journal.getMessage(checked.ref);
				if (fact) foundFacts.push(fact);
				lines.push(
					fact
						? render.messageRow(fact)
						: `${checked.ref} | 本地不可用（retention/未接收）；不伪造内容`,
				);
			}
			// 合并转发一层展开（转文本；不递归）。
			for (const fact of foundFacts) await expandForward(deps, fact, lines, signal);
			// includeMedia：抓取 image 段为 base64 附加（runtime tool-role 图片通道）。
			let images: ImageContent[] = [];
			if (params.includeMedia === true) {
				const expanded = await expandImages(imageSourcesFromFacts(foundFacts));
				if (expanded.note) lines.push(expanded.note);
				images = expanded.images;
			}
			return withImages(worldSucceeded(render.receipt.ok("messages", lines), {}), images);
		}
		case "conversation":
		case "members":
		case "contacts":
		case "groups":
		case "conversations":
		case "self":
		case "expressions":
			return observeOnline(deps, params, scope, signal);
		default:
			return worldFailed(`未知 observe scope：${scope}`, { reason: "unknown_scope" });
	}
}


/** 需要平台在线读取的 scope：在线尝试，失败如实说明，不伪造覆盖。 */
/** OneBot 历史消息对象 → 会话页行（展示层不铸造引用，@显示原编号）。 */
function conversationLineFromOneBot(selfId: string, m: Record<string, unknown>): render.ConversationPageLine {
	const mid = m.message_id as number;
	return {
		ref: `qq-message:${selfId}:${mid}`,
		timeIso: typeof m.time === "number" ? new Date(m.time * 1000).toISOString() : null,
		sender: render.oneBotSenderLabel(m.sender as { user_id?: number; nickname?: string; card?: string }, selfId),
		text: render.looseText(m.message),
	};
}

function conversationEventPage(deps: QqAppDeps, conversationRefValue: string, limit: number): { ref: string; kind: string; timeIso: string; summary?: string }[] {
	return (deps.journal.snapshot.events.get(conversationRefValue) ?? []).slice(-limit).map((e) => ({
		ref: e.ref,
		kind: e.kind,
		timeIso: e.time,
		summary: e.summary,
	}));
}

/** 离线回退：本地 journal 按 sequence 窗口分页；无事实返回 null（不冒充空页）。 */
function renderLocalConversationPage(
	deps: QqAppDeps,
	conversationRefValue: string,
	direction: string,
	limit: number,
	params: Record<string, unknown>,
): { text: string; hasMore: boolean; nextCursor?: string; pageFacts: MessageFact[] } | null {
	const all = deps.journal.snapshot.messages.get(conversationRefValue) ?? [];
	if (all.length === 0) return null;
	const time = timeView(deps);
	const anchorSeq = typeof params.anchorMessageRef === "string" ? (deps.journal.getMessage(params.anchorMessageRef)?.sequence ?? 0) : 0;
	const anchorId = direction === "latest" ? 0 : anchorSeq;
	let window = all;
	if (anchorId !== 0) {
		window = direction === "after" ? all.filter((m) => m.sequence > anchorId) : all.filter((m) => m.sequence <= anchorId);
	}
	const start = typeof params.cursor === "string" ? (() => {
		const decoded = render.decodeCursor(params.cursor);
		return decoded.ok && typeof decoded.value.pos === "number" ? decoded.value.pos : 0;
	})() : 0;
	const chronological = direction === "after" ? window : [...window].reverse(); // latest/before 从最新往回
	const page = chronological.slice(start, start + limit);
	const hasMore = start + limit < chronological.length;
	const nextCursor = hasMore
		? render.encodeCursor({
				v: 1, source: "local", scope: "conversation", conv: conversationRefValue, direction,
				anchor: anchorId, pos: start + limit,
				sig: render.fingerprintCursor({ scope: "conversation", conv: conversationRefValue, direction, anchor: params.anchorMessageRef, limit, includeEvents: params.includeEvents === true }),
			})
		: undefined;
	const pageData = render.renderConversationPage({
		conversationRef: conversationRefValue,
		direction,
		source: "local",
		time,
		lines: page.map((m) => ({
			ref: m.ref,
			timeIso: m.time,
			sender: render.senderLabel(m),
			text: render.segmentText(m.segments),
			replyTo: m.replyTo,
		})),
		events: params.includeEvents === true ? conversationEventPage(deps, conversationRefValue, limit) : undefined,
	});
	return { text: pageData.text, hasMore, nextCursor, pageFacts: page };
}

async function observeOnline(deps: QqAppDeps, params: Record<string, unknown>, scope: string, signal?: AbortSignal): Promise<ToolExecutionResult> {
	switch (scope) {
		case "members": {
			const target = checkConversationRef(deps, params.conversationRef);
			if (!("ok" in target)) return target;
			const parsed = parseConversationRef(target.ref)!;
			if (parsed.kind !== "group") return worldFailed("members 只接受群会话引用。", { reason: "invalid_target" });
			const outcome = await deps.transport.call("get_group_member_list", { group_id: Number(parsed.key) }, signal);
			if (outcome.status !== "ok") {
				return queryFailed("members", outcome, render.RECEIPT_NOTES.nextStatusCheck);
			}
			// SnowLuma 返回裸成员数组（group-info.ts returnsSchema type:'array'）；兼容 {member_list} 包装形状。
			const rawData: unknown = outcome.data;
			const members = Array.isArray(rawData) ? rawData : ((rawData as { member_list?: unknown[] } | null)?.member_list ?? []);
			const query = typeof params.query === "string" ? params.query : "";
			const matched = members
				.map((m) => m as { user_id: number; nickname?: string; card?: string; role?: string })
				.filter((m) => !query || [m.nickname, m.card, String(m.user_id)].some((v) => v?.includes(query)));
			const lines = matched.map(
				(m) => render.membersLine(deps.selfId, m),
			);
			return worldSucceeded(
				render.receipt.ok(
					`members；target=${target.ref}${query ? `\nquery="${query}"` : ""}`,
					[...(lines.length > 0 ? lines : [render.RECEIPT_NOTES.membersEmpty]), render.RECEIPT_NOTES.membersCaveat],
				),
				{ count: matched.length },
			);
		}
		case "conversation": {
			const target = checkConversationRef(deps, params.conversationRef);
			if (!("ok" in target)) return target;
			const parsed = parseConversationRef(target.ref)!;
			// SnowLuma 单次 history 最多 200（固定事实）；上限钳制，不透传超大 limit。
			const limit = Math.max(1, Math.min(Number(params.limit ?? 20) || 20, SNOWLUMA_HISTORY_MAX));
			const direction = String(params.direction ?? "latest");
			const querySig = render.fingerprintCursor({
				scope: "conversation", conv: target.ref, direction, anchor: params.anchorMessageRef, limit, includeEvents: params.includeEvents === true,
			});

			// cursor：优先在线锚点续页；离线回退用本地序号。跨源复用明确失效。
			let anchorId = direction === "latest" ? 0 : (typeof params.anchorMessageRef === "string" ? Number(params.anchorMessageRef.split(":")[2]) : 0);
			let source: "platform" | "local" = "platform";
			let cursorPayload: Record<string, unknown> | null = null;
			if (typeof params.cursor === "string") {
				const decoded = render.decodeCursor(params.cursor);
				if (!decoded.ok) return worldFailed(`cursor 无效：${decoded.error}`, { reason: "cursor_invalid" });
				cursorPayload = decoded.value;
				if (cursorPayload.sig !== querySig) {
					return worldFailed(`cursor 无效：绑定查询条件已变化，请重新发起首页查询`, { reason: "cursor_invalid" });
				}
				source = cursorPayload.source === "local" ? "local" : "platform";
				anchorId = typeof cursorPayload.anchor === "number" ? cursorPayload.anchor : 0;
			}

			if (source === "platform") {
				// 在线优先：锚点式历史；before/around → 锚点及更旧，after → 锚点及更新。
				const platformParams: Record<string, unknown> = { count: limit, message_id: anchorId, reverse_order: direction !== "after" };
				let platformAction: string;
				if (parsed.kind === "group") {
					platformAction = "get_group_msg_history";
					platformParams.group_id = Number(parsed.key);
				} else {
					// temp key（<uin>-g<groupId>）按对端 uin 路由，不透传 NaN
					platformAction = "get_friend_msg_history";
					platformParams.user_id = Number(tempPeerUin(parsed.key));
				}
				const outcome = await deps.transport.call(platformAction, platformParams, signal);
				if (outcome.status === "ok") {
					const rawMessages = (outcome.data as { messages?: Record<string, unknown>[] })?.messages ?? [];
					const time = timeView(deps);
					const page = render.renderConversationPage({
						conversationRef: target.ref,
						direction,
						source: "platform",
						time,
						lines: rawMessages.map((m) => conversationLineFromOneBot(deps.selfId, m)),
						events: params.includeEvents === true ? conversationEventPage(deps, target.ref, limit) : undefined,
					});
					let text = page.text;
					let images: ImageContent[] = [];
					if (params.includeMedia === true) {
						const expanded = await expandImages(imageSourcesFromOneBot(rawMessages));
						if (expanded.note) text += `\n${expanded.note}`;
						images = expanded.images;
					}
					const nextCursor =
						rawMessages.length === limit
							? render.encodeCursor({ v: 1, source: "platform", scope: "conversation", conv: target.ref, direction, anchor: Number(page.lastMessageRef?.split(":")[2]), sig: querySig })
							: undefined;
					return withImages(
						worldSucceeded(`${text}\n${nextCursor ? `hasMore=true；nextCursor=${nextCursor}` : `hasMore=false（该可读快照结束）`}`, { count: rawMessages.length }),
						images,
					);
				}
				// 在线失败 → 离线保存事实回退（标陈旧）；本地也无 → 明确不可用。
				const localPage = renderLocalConversationPage(deps, target.ref, direction, limit, params);
				if (!localPage) {
					return queryFailed("conversation", outcome, "本地无保存事实可回退；稍后重试，持续失败先 observe(scope=\"status\") 核验连接");
				}
				return await localConversationResult(localPage, params);
			}
			// cursor 指明 local 源：直接走本地页。
			const localPage = renderLocalConversationPage(deps, target.ref, direction, limit, params);
			if (!localPage) return worldFailed("本地无保存事实可分页。", { reason: "no_local_facts" });
			return await localConversationResult(localPage, params);
		}
		case "contacts":
		case "groups":
		case "conversations": {
			const platformAction = scope === "contacts" ? "get_friend_list" : "get_group_list";
			const outcome = await deps.transport.call(platformAction, {}, signal);
			if (outcome.status !== "ok") {
				return queryFailed(scope, outcome, render.RECEIPT_NOTES.nextStatusCheck);
			}
			const list = (outcome.data as unknown[]) ?? [];
			// conversations（合同：包括 silent/temp/历史会话）= 平台群列表 ∪ 本地保存会话；
			// 本地补充项显式标陈旧性，不冒充平台快照。
			const rows: { ref: string; detail: string; local: boolean }[] = list
				.map((item) => item as Record<string, unknown>)
				.map((item) =>
					scope === "contacts"
						? { ref: `qq-user:${deps.selfId}:${item.user_id}`, detail: `"${item.nickname ?? ""}" | remark="${item.remark ?? ""}"`, local: false }
						: { ref: `qq-conversation:${deps.selfId}:group:${item.group_id}`, detail: `"${item.group_name ?? ""}"`, local: false },
				);
			if (scope === "conversations") {
				const seen = new Set(rows.map((row) => row.ref));
				for (const ref of deps.journal.listConversationRefs()) {
					if (!seen.has(ref)) {
						seen.add(ref);
						rows.push({ ref, detail: "", local: true });
					}
				}
			}
			const query = typeof params.query === "string" ? params.query : "";
			const matched = rows.filter((row) => !query || row.ref.includes(query) || row.detail.includes(query));
			const { page, hasMore } = truncatePage(matched, params.limit);
			const lines = page.map((row) => `${row.ref}${row.detail ? ` | ${row.detail}` : ""}${row.local ? " | source=本地保存事实（陈旧性未核验）" : ""}`);
			return worldSucceeded(
				render.receipt.ok(
					`${scope}（${lines.length}）`,
					[
						...(lines.length > 0 ? lines : ["无匹配"]),
						...(hasMore ? [`hasMore=true（匹配 ${matched.length}，本次呈现 ${lines.length}，再用 limit 取余）`] : []),
						render.RECEIPT_NOTES.listCaveat,
					],
				),
				{},
			);
		}
		case "self": {
			const outcome = await deps.transport.call("get_login_info", {}, signal);
			if (outcome.status !== "ok") return queryFailed("self", outcome, render.RECEIPT_NOTES.nextStatusCheck);
			const data = outcome.data as { user_id: number; nickname: string };
			let lines = [`qq-user:${deps.selfId}:${data.user_id} | nickname="${data.nickname}"`];
			// includeGroups：所在群列表；groupConversationRef：自己在该群的名片与角色（get_group_member_info）。
			const groupRefRaw = typeof params.groupConversationRef === "string" ? params.groupConversationRef : undefined;
			if (groupRefRaw !== undefined) {
				const checked = checkConversationRef(deps, groupRefRaw);
				if (!("ok" in checked)) return checked;
				const parsed = parseConversationRef(checked.ref)!;
				if (parsed.kind !== "group") return worldFailed("groupConversationRef 只接受群会话引用。", { reason: "invalid_target" });
				const member = await deps.transport.call("get_group_member_info", { group_id: Number(parsed.key), user_id: Number(deps.selfId) }, signal);
				if (member.status !== "ok") return queryFailed("self", member, render.RECEIPT_NOTES.nextStatusCheck);
				const info = member.data as { card?: unknown; nickname?: unknown; role?: unknown };
				lines.push(
					`${checked.ref} | card="${String(info.card ?? "")}" | nickname="${String(info.nickname ?? "")}" | role=${String(info.role ?? "member")}（占位不作真实身份）`,
				);
			} else if (params.includeGroups === true) {
				const groups = await deps.transport.call("get_group_list", {}, signal);
				if (groups.status !== "ok") return queryFailed("self", groups, render.RECEIPT_NOTES.nextStatusCheck);
				const list = ((groups.data as unknown[]) ?? []).slice(0, 20).map((item) => item as { group_id?: unknown; group_name?: unknown });
				lines.push(
					`所在群（${list.length}，覆盖未知）：${list.map((g) => `qq-conversation:${deps.selfId}:group:${String(g.group_id ?? "?")} | "${String(g.group_name ?? "")}"`).join("；") || "（无）"}`,
				);
			}
			return worldSucceeded(render.receipt.ok("self", lines), {});
		}
		case "expressions":
			return handleExpressions(deps, params, signal);
		default:
			return worldFailed(`未知 observe scope：${scope}`, { reason: "unknown_scope" });
	}
}

/**
 * expressions：真实表情编码目录（fetch_sys_faces / search_sys_faces）。
 * faceId/reactionCode 只接受数字编码；非数字（Unicode emoji）不进 face/reaction，用 text 发送。
 */
async function handleExpressions(deps: QqAppDeps, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
	const kind = String(params.kind ?? "face");
	if (kind !== "face" && kind !== "reaction") {
		return worldFailed("expressions.kind 必须是 face 或 reaction。", { reason: "invalid_kind" });
	}
	const query = typeof params.query === "string" ? params.query.trim() : "";
	const limit = Math.max(1, Math.min(Number(params.limit ?? 50) || 50, 200));
	const outcome = query
		? await deps.transport.call("search_sys_faces", { query }, signal)
		: await deps.transport.call("fetch_sys_faces", {}, signal);
	if (outcome.status !== "ok") return queryFailed("expressions", outcome, render.RECEIPT_NOTES.nextStatusCheck);

	interface FaceEntry {
		q_sid?: unknown;
		q_des?: unknown;
		emoji_name_alias?: unknown;
		is_super?: unknown;
	}
	const rawFaces: FaceEntry[] = query
		? ((outcome.data as { faces?: FaceEntry[] })?.faces ?? [])
		: ((outcome.data as { packs?: { emojis?: FaceEntry[] }[] })?.packs ?? []).flatMap((pack) => pack.emojis ?? []);
	const faces = rawFaces.filter((face) => typeof face.q_sid === "string" && (face.q_sid as string).length > 0);
	const shown = faces.slice(0, limit);
	const lines = shown.map((face) => render.expressionLine(face));
	const overflowNote = faces.length > shown.length ? `，显示前 ${shown.length}；目录全量较大，优先用 query 搜索` : "";
	return worldSucceeded(
		render.receipt.ok(`expressions（${faces.length}${overflowNote}）`, [...(lines.length > 0 ? lines : ["无匹配"]), render.RECEIPT_NOTES.expressionsGuidance]),
		{ count: faces.length },
	);
}
