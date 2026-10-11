import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import {
	worldCancelled,
	worldFailed,
	worldSucceeded,
	worldUnknown,
} from "../../../../src/extensions/world-framework/result.js";
import { checkMediaPath, toFileUri } from "./media-root.js";
import type { MediaStaging } from "./media.js";
import type { QqTransport, TransportCallOutcome } from "./transport.js";
import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { OperationLog } from "./operation-log.js";
import type { DeploymentGrants } from "./grants.js";
import { hasGrant } from "./grants.js";
import { requiredGrants } from "./grants-vocabulary.js";
import type { AttentionModel } from "./attention.js";
import type { ConversationLocks } from "./conversation-lock.js";
import { handleBrowse, handleInbox, handleRead, handleSkip } from "./reader.js";
import * as render from "./render.js";
import {
	messageRef,
	parseConversationRef,
	parseUserRef,
	parseMessageRef,
	REF_PATTERNS,
	userRef,
	type OperationRecord,
	type RequestFact,
} from "./types.js";
import { paginate } from "./pagination.js";
import { oneBotId, oneBotObject } from "./message-codec.js";
import { handlePeople, handleExpressions, handleFiles, handleSearch } from "./discovery.js";
import { queryFailure } from "./platform-query.js";
import { handleFetch } from "./resource-fetch.js";

/**
 * QQ 应用层：动作执行、grant 中间件、目标校验与派发屏障。
 * 所有写动作走 validate → intent(durable) → 平台调用 → 回执结算 → 返回；
 * 超时/断开映射 unknown，不自动重发；grant 外拒绝为 failed+not_started，平台调用 0 次。
 */

export interface QqAppDeps {
	readonly selfId: string;
	readonly signal?: AbortSignal;
	readonly onConsumption?: (conversationRef: string) => void;
	readonly grants: DeploymentGrants;
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly ops: OperationLog;
	readonly transport: QqTransport;
	readonly attention: AttentionModel;
	readonly locks: ConversationLocks;
	readonly now?: () => string;
	readonly media?: { readonly allowedRoots: readonly string[]; readonly staging: MediaStaging };
	/** 呈现选项（快照头时区）；批次现场经 scheduler 注入，observe 现场经此注入。 */
	readonly display?: render.DisplayOptions;
	readonly faceNames?: Map<string, string>;
	readonly requestTimeoutMs?: number;
}

/** temp 会话 key（<uin>-g<groupId>）→ 对端 uin；读回执/历史按对端 user_id 路由，与 speak 共用语义。 */
function tempPeerUin(key: string): string {
	return /^(\d+)-g/.exec(key)?.[1] ?? key;
}

function nowIso(deps: QqAppDeps): string {
	const now = deps.now;
	return now ? now() : new Date().toISOString();
}

/** 会话 ref 的账号边界校验；跨账号一律 account_mismatch。 */
function checkConversationRef(_deps: QqAppDeps, ref: unknown): { ok: true; ref: string } | ToolExecutionResult {
	const parsed = typeof ref === "string" ? parseConversationRef(ref) : null;
	if (typeof ref !== "string" || !parsed) {
		return worldFailed(`目标会话引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	return { ok: true, ref };
}

function checkUserRef(_deps: QqAppDeps, ref: unknown): { ok: true; ref: string; uin: string } | ToolExecutionResult {
	const parsed = typeof ref === "string" ? parseUserRef(ref) : null;
	if (typeof ref !== "string" || !parsed) {
		return worldFailed(`用户引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	return { ok: true, ref, uin: parsed.uin };
}

function checkMessageRef(_deps: QqAppDeps, ref: unknown): { ok: true; ref: string } | ToolExecutionResult {
	if (typeof ref !== "string" || !parseMessageRef(ref)) {
		return worldFailed(`消息引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	return { ok: true, ref };
}

/** 平台在线状态查询（members 校验等用）。 */
async function isMemberOf(deps: QqAppDeps, groupKey: string, uin: string): Promise<boolean | null> {
	const outcome = await deps.transport.call("get_group_member_info", {
		group_id: Number(groupKey),
		user_id: Number(uin),
		no_cache: true,
	});
	return outcome.status === "ok";
}

export async function handleQqCall(
	deps: QqAppDeps,
	rawAction: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	// ---- grant 中间件（所有入口同一检查；拒绝时平台调用为 0） ----
	const grant = requiredGrants(rawAction, params).find((name) => !hasGrant(deps.grants, name));
	if (grant) {
		return worldFailed(`本实例未授 ${grant}；适配器可能有实现，但未调用平台。`, {
			reason: "grant_denied",
			effect: "not_started",
		});
	}
	if (signal?.aborted) return worldCancelled("cancelled / 未派发", { effect: "not_started" });
	if (["people", "expressions", "files", "search", "fetch"].includes(rawAction)) {
		const querySignal = AbortSignal.any([...(signal ? [signal] : []), ...(deps.signal ? [deps.signal] : [])]);
		try {
			querySignal.throwIfAborted();
			switch (rawAction) {
				case "people":
					return await handlePeople(deps, params, querySignal);
				case "expressions":
					return await handleExpressions(deps, params, querySignal);
				case "files":
					return await handleFiles(deps, params, querySignal);
				case "search":
					return handleSearch(deps, params);
				case "fetch":
					return await handleFetch(deps, params, querySignal);
			}
		} catch (error) {
			return queryFailure(deps, error, querySignal);
		}
	}

	switch (rawAction) {
		case "inbox":
			return handleInbox(deps, params, signal);
		case "read":
			return handleRead(deps, params, signal);
		case "skip":
			return handleSkip(deps, params, signal);
		case "browse":
			return handleBrowse(deps, params, signal);
		case "send":
			return handleSend(deps, params, signal);
		case "interact":
			return handleInteract(deps, params, signal);
		case "remind":
			return handleRemind(deps, params);
		case "requests":
			return handleRequests(deps, params, signal);
		case "profile":
			return handleProfile(deps, params, signal);
		default:
			return worldFailed(`未知动作：${rawAction}`, { reason: "unknown_action" });
	}
}

/* ---------- speak ---------- */

async function handleSend(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
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
			const verified =
				memberEvidence(deps, target.ref, mention.uin) ??
				(parsed.kind === "group" ? await isMemberOf(deps, parsed.key, mention.uin) : null);
			if (verified === false) {
				return worldFailed(`mention 目标 ${mention.ref} 无法核验为该群成员。`, {
					reason: "mention_target_unverifiable",
					effect: "not_started",
				});
			}
		}
	}

	const segments = toOneBotSegments(deps, content as Record<string, unknown>[]);
	if (!segments.ok) return segments.result;
	const replyBatch =
		typeof replyTo === "string"
			? segments.batches.findIndex((batch) =>
					content.slice(batch.from, batch.through + 1).some((seg) => (seg as { type?: unknown }).type !== "file"),
				)
			: -1;
	if (typeof replyTo === "string" && replyBatch < 0) {
		return worldFailed("当前组合没有可保留引用的消息；请单独发送引用回复。", {
			reason: "reply_unsupported",
			effect: "not_started",
		});
	}

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
		batches = segments.batches.map((batch, index) => {
			const ref = deps.ops.newOperationRef();
			const message = batch.build(ref);
			if (index === replyBatch)
				message.unshift({ type: "reply", data: { id: String(parseMessageRef(String(replyTo))!.messageId) } });
			return { ref, from: batch.from, through: batch.through, message };
		});
	} catch (error) {
		return worldFailed(`媒体复制失败，未调用平台：${errorMessage(error)}`, {
			reason: "media_staging_failed",
			effect: "not_started",
		});
	}
	const confirmedParts: { from: number; through: number; operationRef: string; messageRef?: string }[] = [];
	function confirmedSummary(): string {
		return confirmedParts
			.map((part) => `${part.from}-${part.through}:${part.messageRef ?? part.operationRef}`)
			.join(", ");
	}
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
				const messageRefValue = oneBotId(messageId, true) ? messageRef(oneBotId(messageId, true)!) : undefined;
				return worldSucceeded(
					render.receipt.ok("sent", [
						`target=${target.ref}`,
						...(messageRefValue ? [`messageRef=${messageRefValue}`] : []),
					]),
					{ target: target.ref, ...(messageRefValue ? { messageRef: messageRefValue } : {}) },
					"applied",
				);
			},
			undefined,
			batch.ref,
			{
				partRange: { from: batch.from, through: batch.through },
				...(batch.message[0]?.type === "reply" ? { replyTo: String(replyTo) } : {}),
			},
		);
		const details = result.details as Record<string, unknown> | undefined;
		if (result.status !== "succeeded") {
			return {
				...result,
				result: `${result.result}\n已确认分段=${confirmedSummary() || "无"}\n停止于分段=${batch.from}；余下未派发，不整包重发。`,
				details: { ...details, confirmedParts, stoppedAt: batch.from, remainingFrom: batch.through + 1 },
			};
		}
		confirmedParts.push({
			from: batch.from,
			through: batch.through,
			operationRef: batch.ref,
			...(typeof details?.messageRef === "string" ? { messageRef: details.messageRef } : {}),
		});
		lastResult = result;
	}
	return {
		...lastResult!,
		result: `${lastResult!.result}${batches.length > 1 ? `\n已确认分段=${confirmedSummary()}` : ""}${replyBatch >= 0 ? `\n引用 ${replyTo} 的消息=${confirmedParts[replyBatch]?.messageRef ?? confirmedParts[replyBatch]?.operationRef}` : ""}`,
		details: { ...(lastResult!.details as Record<string, unknown> | undefined), confirmedParts },
	};
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
			result: worldFailed(`replyTo ${messageRefValue} 不属于目标会话，拒绝猜测归属。`, {
				reason: "reply_target_mismatch",
			}),
		};
	}
	const messageId = parseMessageRef(messageRefValue)!.messageId;
	const outcome = await deps.transport.call("get_msg", { message_id: messageId }, signal);
	if (outcome.status !== "ok") {
		return {
			ok: false,
			result: worldFailed(`消息 ${messageRefValue} 本地未持有且平台不可寻址，不猜测归属。`, {
				reason: "reply_target_unverifiable",
				effect: "not_started",
			}),
		};
	}
	const data = oneBotObject(outcome.data) ?? {};
	const sender = oneBotObject(data.sender) ?? {};
	if (
		oneBotId(data.message_id, true) !== String(messageId) ||
		(data.self_id !== undefined && oneBotId(data.self_id) !== deps.selfId)
	) {
		return { ok: false, result: worldFailed("平台返回的消息编号或账号不匹配。", { reason: "reply_target_mismatch" }) };
	}
	const parsed = parseConversationRef(conversationRefValue)!;
	const temp = parsed.kind === "temp" ? /^(\d+)-g(\d+)$/.exec(parsed.key) : null;
	const belongs =
		parsed.kind === "group"
			? data.message_type !== "private" && oneBotId(data.group_id) === parsed.key
			: data.message_type !== "group" &&
				[data.user_id, data.target_id, sender.user_id].some((value) => oneBotId(value) === tempPeerUin(parsed.key)) &&
				(parsed.kind !== "private" || (data.sub_type !== "group" && !oneBotId(data.group_id))) &&
				(!temp || (oneBotId(sender.group_id) ?? oneBotId(data.group_id)) === temp[2]);
	if (!belongs) {
		return {
			ok: false,
			result: worldFailed(`replyTo ${messageRefValue} 经平台核验不属于目标会话。`, { reason: "reply_target_mismatch" }),
		};
	}
	return { ok: true };
}

function memberEvidence(deps: QqAppDeps, conversationRefValue: string, uin: string): boolean | null {
	const ref = userRef(uin);
	for (const fact of deps.journal.snapshot.messages.get(conversationRefValue) ?? []) {
		if (fact.senderRef === ref) return true;
	}
	return null;
}

/** 先验证整个请求，再以同一个 operationRef 复制；任何确定的资源错误都不会部分派发。 */
function toOneBotSegments(
	deps: QqAppDeps,
	content: Record<string, unknown>[],
):
	| {
			ok: true;
			build: (ref: string) => Record<string, unknown>[];
			batches: { from: number; through: number; build: (ref: string) => Record<string, unknown>[] }[];
	  }
	| { ok: false; result: ToolExecutionResult } {
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
				const resource = (typeof seg.path === "string" ? { kind: "file", path: seg.path } : seg.resource) as
					| { kind?: unknown; path?: unknown; ref?: unknown }
					| undefined;
				const type = seg.type === "audio" ? "record" : seg.type;
				const name = seg.type === "file" && typeof seg.name === "string" ? { name: seg.name } : {};
				if (resource?.kind === "file" && typeof resource.path === "string") {
					if (!deps.media)
						return worldFailedResult("媒体配置尚未就绪。", { reason: "media_not_ready", effect: "not_started" });
					const checked = checkMediaPath(resource.path, { allowedRoots: deps.media.allowedRoots });
					if (!checked.ok) return worldFailedResult(checked.detail, { reason: checked.reason, effect: "not_started" });
					const staging = deps.media.staging;
					out.push((ref) => ({ type, data: { file: toFileUri(staging.stage(checked.realPath, ref)), ...name } }));
				} else if (resource?.kind === "qq_media" && typeof resource.ref === "string") {
					if (!REF_PATTERNS.media.test(resource.ref))
						return worldFailedResult("媒体引用格式非法。", { reason: "account_mismatch", effect: "not_started" });
					const media = deps.journal.getMedia(resource.ref);
					if (!media)
						return worldFailedResult("媒体引用不存在或已不可寻址。", {
							reason: "media_unavailable",
							effect: "not_started",
						});
					if (media.type !== seg.type)
						return worldFailedResult("媒体类型与请求分段不符。", {
							reason: "media_type_mismatch",
							effect: "not_started",
						});
					// 平台 URL 才能直接引用；本地路径必须走资源根与 staging，不能借 qq_media 绕过。
					if (!media.url || !/^https?:\/\//i.test(media.url))
						return worldFailedResult("媒体没有可引用的平台 HTTP(S) 地址。", {
							reason: "media_unavailable",
							effect: "not_started",
						});
					out.push(() => ({
						type,
						data: {
							file: media.url,
							...(seg.type === "file" && media.fileName ? { name: media.fileName } : {}),
							...name,
						},
					}));
				} else
					return worldFailedResult("媒体 resource 必须为 file 或 qq_media。", {
						reason: "invalid_resource",
						effect: "not_started",
					});
				break;
			}
			default:
				return worldFailedResult("未知消息分段。", { reason: "invalid_content", effect: "not_started" });
		}
	}
	const batches: { from: number; through: number; build: (ref: string) => Record<string, unknown>[] }[] = [];
	const batch = (from: number, through: number): void => {
		if (through < from) return;
		batches.push({ from, through, build: (ref) => out.slice(from, through + 1).map((build) => build(ref)) });
	};
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i]!.type !== "file" && content[i]!.type !== "video") continue;
		batch(start, i - 1);
		batch(i, i);
		start = i + 1;
	}
	batch(start, content.length - 1);
	return { ok: true, build: (ref) => out.map((build) => build(ref)), batches };
}

/* ---------- gesture ---------- */

async function handleGesture(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	if (params.action === "react") {
		const message = checkMessageRef(deps, params.messageRef);
		if (!("ok" in message)) return message;
		const code = String(params.reactionCode ?? "");
		if (!/^[0-9]+$/.test(code)) {
			return worldFailed("reactionCode 必须复制 expressions 查询得到的数字编码。", { reason: "invalid_reaction_code" });
		}
		const fact = deps.journal.getMessage(message.ref);
		if (!fact || parseConversationRef(fact.conversationRef)?.kind !== "group") {
			return worldFailed(`消息 ${message.ref} 非群消息；回应路径未验证到私聊，不外推。`, {
				reason: "unsupported_target",
			});
		}
		const isSet = params.enabled === undefined ? true : Boolean(params.enabled);
		return dispatchWrite(
			deps,
			"gesture.react",
			"set_group_reaction",
			{ message_id: parseMessageRef(message.ref)!.messageId, code, is_set: isSet },
			message.ref,
			signal,
			() =>
				worldSucceeded(
					render.receipt.ok(`react ${isSet ? "set" : "unset"} code=${code}`, [`messageRef=${message.ref}`]),
					{ messageRef: message.ref },
					"applied",
				),
		);
	}
	if (params.action === "poke") {
		const target = checkConversationRef(deps, params.conversationRef);
		if (!("ok" in target)) return target;
		const user = checkUserRef(deps, params.userRef);
		if (!("ok" in user)) return user;
		const parsed = parseConversationRef(target.ref)!;
		if (parsed.kind === "temp") {
			return worldFailed("temp 会话不路由 poke。", { reason: "unsupported_target" });
		}
		const platformAction = parsed.kind === "group" ? "group_poke" : "friend_poke";
		const platformParams =
			parsed.kind === "group"
				? { group_id: Number(parsed.key), user_id: Number(user.uin) }
				: { user_id: Number(user.uin) };
		return dispatchWrite(deps, "gesture.poke", platformAction, platformParams, target.ref, signal, () =>
			worldSucceeded(
				render.receipt.ok("poke", [`target=${target.ref}`, `userRef=${user.ref}`]),
				{ target: target.ref },
				"applied",
			),
		);
	}
	return worldFailed("interact.action 必须是 poke/react/retract。", { reason: "invalid_action" });
}

/* ---------- follow_up ---------- */

function handleFollowUp(deps: QqAppDeps, params: Record<string, unknown>): ToolExecutionResult {
	try {
		switch (params.action) {
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
					render.receipt.ok("follow_up.create", [
						`ref=${item.ref}`,
						`target=${item.targetRef}`,
						`reviewAt=${item.reviewAt ?? "null"}`,
					]),
					{ ref: item.ref, revision: deps.control.revision, persisted: true },
					"applied",
				);
			}
			case "resolve": {
				const item = deps.control.settleFollowUp(
					String(params.remindRef ?? ""),
					String(params.resolution ?? ""),
					"closed",
				);
				return worldSucceeded(
					render.receipt.ok("follow_up.close", [`ref=${item.ref}`, `state=${item.state}`]),
					{ ref: item.ref, persisted: true },
					"applied",
				);
			}
			default:
				return worldFailed("remind.action 必须是 list/create/resolve。", { reason: "invalid_operation" });
		}
	} catch (error) {
		return worldFailed(`follow_up 保存失败，保留旧控制状态：${errorMessage(error)}`, {
			reason: errorMessage(error).includes("不存在") ? "not_found" : "control_persist_failed",
		});
	}
}

/* ---------- account ---------- */

async function handleRequestResponse(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const requestRef = String(params.requestRef ?? "");
	if (!REF_PATTERNS.request.test(requestRef)) {
		return worldFailed(`requestRef 非法：${requestRef}`, { reason: "invalid_target" });
	}
	const fact = deps.journal.snapshot.requests.get(requestRef);
	if (!fact)
		return worldFailed(`申请 ${requestRef} 未取得，不猜测平台flag。`, {
			reason: "not_found",
			effect: "not_started",
		});
	const state = requestState(deps, fact).state;
	if (state !== "pending")
		return worldFailed(`申请 ${requestRef} 状态为 ${state}；先核验关联操作，不重复处理。`, {
			reason: "request_already_handled",
			effect: "not_started",
		});
	const flag = fact.platformFlag;
	const approve = params.decision === "accept";
	const platformAction = fact?.kind === "friend" ? "set_friend_add_request" : "set_group_add_request";
	// OneBot v11 语义：群请求 sub_type=invite（邀请）/add（加群申请）是不同处理路径，
	// 必须按事实 kind 回传，不能一律 add（G9 才会暴露的参数错误）。
	const extraParams: Record<string, unknown> =
		platformAction === "set_group_add_request" ? { sub_type: fact?.kind === "group_invite" ? "invite" : "add" } : {};
	return dispatchWrite(
		deps,
		"account.respond_request",
		platformAction,
		{ flag, approve, ...extraParams },
		requestRef,
		signal,
		() =>
			worldSucceeded(
				render.receipt.ok(`respond_request ${params.decision}`, [`requestRef=${requestRef}`]),
				{ requestRef },
				"applied",
			),
		undefined,
		undefined,
		{ requestDecision: approve ? "accept" : "decline" },
	);
}

async function handleRetract(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const message = checkMessageRef(deps, params.messageRef);
	if (!("ok" in message)) return message;
	// 合同：确认是自己且可寻址。本地未持有的消息在线核验发送者，不盲发 delete_msg。
	const own = await isOwnMessageForRetract(deps, message.ref, signal);
	if (!own.ok) return own.result;
	return dispatchWrite(
		deps,
		"account.retract",
		"delete_msg",
		{ message_id: parseMessageRef(message.ref)!.messageId },
		message.ref,
		signal,
		() =>
			worldSucceeded(
				render.receipt.ok("retract", [`messageRef=${message.ref}`]),
				{ messageRef: message.ref },
				"applied",
			),
	);
}

async function handleProfileUpdate(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const calls: { name: string; params: Record<string, unknown>; label: string }[] = [];
	if (typeof params.nickname === "string")
		calls.push({ name: "set_qq_profile", params: { nickname: params.nickname }, label: "nickname" });
	if (typeof params.signature === "string")
		calls.push({ name: "set_self_longnick", params: { longNick: params.signature }, label: "signature" });
	if (calls.length === 0)
		return worldFailed("set_profile 至少提供 nickname 或 signature。", { reason: "invalid_params" });
	const results: string[] = [];
	for (const call of calls) {
		const outcome = await dispatchWriteRaw(deps, "account.set_profile", call.name, call.params, "account", signal);
		if (!outcome.ok) {
			// 多字段非原子：返回已确认部分，不整包重发（合同 §3.2"多字段逐项回执"）。
			const confirmed = results.length > 0 ? `已确认部分：${results.join("；")}；` : "";
			return {
				...outcome.result,
				result: `${outcome.result.result}\n${confirmed}其余字段未执行，不整包重试。`,
			};
		}
		results.push(`${call.label}=${render.quote(String(call.params.nickname ?? call.params.longNick))}`);
	}
	return worldSucceeded(render.receipt.ok("set_profile", results), { changed: results }, "applied");
}

async function handleAvatarUpdate(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const prepared = toOneBotSegments(deps, [{ type: "image", path: params.avatarPath }]);
	if (!prepared.ok) return prepared.result;
	return dispatchWrite(
		deps,
		"account.set_avatar",
		"set_qq_avatar",
		{},
		"account",
		signal,
		() => worldSucceeded(render.receipt.ok("set_avatar", []), {}, "applied"),
		(ref) => ({ file: (prepared.build(ref)[0]!.data as { file: string }).file }),
	);
}

async function handleCardUpdate(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const target = checkConversationRef(deps, params.conversationRef);
	if (!("ok" in target)) return target;
	const parsed = parseConversationRef(target.ref)!;
	if (parsed.kind !== "group") return worldFailed("set_group_card 只接受群会话引用。", { reason: "invalid_target" });
	const card = String(params.card ?? "");
	return dispatchWrite(
		deps,
		"account.set_group_card",
		"set_group_card",
		{ group_id: Number(parsed.key), user_id: Number(deps.selfId), card },
		target.ref,
		signal,
		() =>
			worldSucceeded(
				render.receipt.ok("set_group_card", [`target=${target.ref}`, `card=${render.quote(card || "(清除)")}`]),
				{ target: target.ref },
				"applied",
			),
	);
}

/** 撤回前的所有权核验：本地 out 事实直接通过；否则 get_msg 比对发送者。 */
async function isOwnMessageForRetract(
	deps: QqAppDeps,
	ref: string,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; result: ToolExecutionResult }> {
	const local = deps.journal.getMessage(ref);
	if (local) {
		if (local.direction === "out") return { ok: true };
		return worldFailedResult(`消息 ${ref} 不是本账号发出的，不能撤回。`, { reason: "not_own_message" });
	}
	const outcome = await deps.transport.call("get_msg", { message_id: parseMessageRef(ref)!.messageId }, signal);
	if (outcome.status !== "ok") {
		return worldFailedResult(`消息 ${ref} 本地未持有且平台不可寻址，不执行撤回。`, {
			reason: "message_unaddressable",
			effect: "not_started",
		});
	}
	const senderId = (outcome.data as { user_id?: unknown }).user_id;
	if (senderId !== Number(deps.selfId)) {
		return worldFailedResult(`消息 ${ref} 经平台核验不是本账号发出，不能撤回。`, { reason: "not_own_message" });
	}
	return { ok: true };
}

function worldFailedResult(
	result: string,
	details: Record<string, unknown>,
): { ok: false; result: ToolExecutionResult } {
	return { ok: false, result: worldFailed(result, details) };
}

/** 平台只读查询失败的统一呈现：不倾倒原始回执正文，给一行原因与下一步；完整 outcome 进 details。 */
function queryFailed(label: string, outcome: TransportCallOutcome, next: string): ToolExecutionResult {
	const detail = outcome.status === "failed" ? `${outcome.kind}: ${outcome.reason}` : "unexpected_response";
	return worldFailed(render.receipt.fail(label, [`reason=${render.quote(detail)}`, `下一步：${next}`]), {
		reason: "platform_query_failed",
		outcome,
	});
}

/* ---------- 派发屏障 ---------- */

type DispatchOutcome =
	| { ok: true; data: unknown; ref: string; diagnostic?: string }
	| { ok: false; result: ToolExecutionResult };

export function requestState(deps: Pick<QqAppDeps, "ops">, fact: RequestFact): RequestFact {
	const attempts = deps.ops
		.all()
		.filter((record) => record.target === fact.ref && record.identity === "world:qq/account.respond_request");
	const confirmed = attempts.some((record) => record.outcome === "succeeded");
	const unknown = attempts.some((record) => record.outcome === "unknown");
	return { ...fact, state: confirmed ? "confirmed" : unknown ? "unknown" : fact.state };
}

async function dispatchWriteRaw(
	deps: QqAppDeps,
	actionLabel: string,
	platformAction: string,
	platformParams: Record<string, unknown>,
	target: string,
	signal?: AbortSignal,
	prepare?: (ref: string) => Record<string, unknown>,
	reservedRef?: string,
	context?: Pick<OperationRecord, "replyTo" | "partRange" | "requestDecision">,
): Promise<DispatchOutcome> {
	if (signal?.aborted) return { ok: false, result: worldCancelled("cancelled / 未派发", { effect: "not_started" }) };
	const ref = reservedRef ?? deps.ops.newOperationRef();
	const at = nowIso(deps);
	try {
		if (prepare) platformParams = prepare(ref);
	} catch (error) {
		return worldFailedResult(`媒体复制失败，未调用平台：${errorMessage(error)}`, {
			reason: "media_staging_failed",
			operationRef: ref,
			effect: "not_started",
		});
	}
	// will_dispatch durable barrier：意图先于平台调用真实落盘；echo=operationRef
	// 使迟到回执可凭 raw 观察归并回本操作。
	try {
		deps.ops.commitIntent({
			ref,
			identity: `world:qq/${actionLabel}`,
			action: platformAction,
			target,
			outcome: "unknown",
			echo: `${deps.selfId}/${ref}`,
			startedAt: at,
			...context,
		});
	} catch (error) {
		return worldFailedResult(`操作意图保存失败，未调用平台：${errorMessage(error)}`, {
			reason: "intent_commit_failed",
			operationRef: ref,
			effect: "not_started",
		});
	}
	let outcome: TransportCallOutcome;
	try {
		outcome = await deps.transport.call(platformAction, platformParams, signal, `${deps.selfId}/${ref}`);
	} catch (error) {
		outcome = { status: "failed", kind: "connection", reason: errorMessage(error) };
	}
	const confirmed = deps.ops.get(ref);
	if (confirmed?.outcome === "succeeded") {
		const receipt = oneBotObject(confirmed.receipt);
		return { ok: true, data: receipt && "status" in receipt ? receipt.data : confirmed.receipt, ref };
	}
	if (confirmed?.outcome === "failed") {
		return worldFailedResult(`平台已确定拒绝 ${actionLabel}，target=${target}。`, {
			reason: "platform_rejected",
			operationRef: ref,
		});
	}
	// 平台结论优先；回执日志故障只加诊断。原 intent 保持 unknown，保留上传证据。
	const settle = (
		status: "succeeded" | "failed" | "unknown",
		extra: { messageRef?: string; reason?: string; receipt?: unknown },
	): string | undefined => {
		try {
			deps.ops.settle(ref, status, nowIso(deps), extra);
		} catch {
			return "operation_receipt_log_failed";
		}
		return undefined;
	};
	if (outcome.status === "ok") {
		const mid = (outcome.data as { message_id?: unknown } | null)?.message_id;
		const diagnostic = settle("succeeded", {
			receipt: outcome.data,
			...(typeof mid === "number" && Number.isSafeInteger(mid) && mid !== 0 ? { messageRef: messageRef(mid) } : {}),
		});
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
					`reason=${outcome.kind === "rejected" ? "platform_rejected" : "not_connected"}；${render.quote(outcome.reason)}`,
				]),
				{
					reason: outcome.kind === "rejected" ? "platform_rejected" : "not_connected",
					operationRef: ref,
					...(diagnostic ? { diagnostic } : {}),
				},
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
	context?: Pick<OperationRecord, "replyTo" | "partRange" | "requestDecision">,
): Promise<ToolExecutionResult> {
	const outcome = await dispatchWriteRaw(
		deps,
		actionLabel,
		platformAction,
		platformParams,
		target,
		signal,
		prepare,
		reservedRef,
		context,
	);
	if (!outcome.ok) return outcome.result;
	const result = buildSuccess(outcome.data);
	return {
		...result,
		result: `${result.result}${outcome.diagnostic ? `\noperationRef=${outcome.ref} diagnostic=${outcome.diagnostic}；平台结果保持，日志待核验。` : ""}`,
		details: {
			...(result.details as Record<string, unknown> | undefined),
			operationRef: outcome.ref,
			...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function listResult<T>(
	deps: QqAppDeps,
	scope: string,
	items: readonly T[],
	params: Record<string, unknown>,
	row: (item: T) => string,
): ToolExecutionResult {
	const binding: Record<string, unknown> = { ...params, account: deps.selfId, scope };
	delete binding.cursor;
	delete binding.limit;
	const result = paginate(items, params, binding);
	if (!result.ok) return worldFailed(result.detail, { reason: result.reason });
	return worldSucceeded(
		render.receipt.ok(`${scope}（${result.page.length}/${result.total}）`, [
			...result.page.map(row),
			...(result.page.length === 0 ? ["本次未取得匹配条目。"] : []),
			...(result.nextCursor
				? [
						scope === "requests"
							? `续页：${JSON.stringify({ action: "requests", params: { action: "list", limit: params.limit ?? 20, cursor: result.nextCursor } })}`
							: `nextCursor=${result.nextCursor}`,
					]
				: []),
		]),
		{ count: result.page.length, total: result.total, hasMore: result.hasMore, nextCursor: result.nextCursor },
	);
}

/* ---------- observe ---------- */

/**
 * 查询内部入口（不再直接对外暴露）：
 * requests（requests 积木 list）、self（profile 积木 get）、expressions（启动目录 enrichment）。
 * 历史 observe scope 随旧 action 退役（R2 裁剪清单）。
 */
export async function handleObserve(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const scope = String(params.scope ?? "");
	switch (scope) {
		case "requests": {
			const state = String(params.state ?? "pending");
			const kindFilter = typeof params.kind === "string" ? params.kind : undefined;
			const items = [...deps.journal.snapshot.requests.values()]
				.map((r) => requestState(deps, r))
				.filter((r) => (state === "all" || r.state === state) && (!kindFilter || r.kind === kindFilter))
				.sort((a, b) => a.time.localeCompare(b.time) || a.ref.localeCompare(b.ref, "en", { numeric: true }));
			return listResult(deps, scope, items, params, render.requestRow);
		}
		case "self": {
			const outcome = await deps.transport.call("get_login_info", {}, signal);
			if (outcome.status !== "ok") return queryFailed("self", outcome, render.RECEIPT_NOTES.nextStatusCheck);
			const data = outcome.data as { user_id: number; nickname: string };
			return worldSucceeded(
				render.receipt.ok("self", [`${userRef(data.user_id)} | nickname=${render.quote(data.nickname)}`]),
				{},
			);
		}
		case "expressions":
			try {
				return await handleExpressions(deps, params, signal);
			} catch (error) {
				return queryFailure(deps, error, signal);
			}
		default:
			return worldFailed(`未知 observe scope：${scope}`, { reason: "unknown_scope" });
	}
}

/* ---------- 行动积木（设计 §4.5~§4.9）：领域选择器，平台派发与审计单源复用 ---------- */

/** qq_interact：poke/react 复用 gesture，retract 复用 account.retract（所有权核验同源）。 */
async function handleInteract(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	if (params.action === "retract") return handleRetract(deps, params, signal);
	return handleGesture(deps, params, signal);
}

/** qq_remind：f{n} 空间沿用 follow_up；list 纯本地（open 事项）。 */
function handleRemind(deps: QqAppDeps, params: Record<string, unknown>): ToolExecutionResult {
	switch (params.action ?? "list") {
		case "list": {
			const items = deps.control.listFollowUps({ state: "open" });
			return worldSucceeded(
				render.receipt.ok("remind", items.length > 0 ? items.map(render.followUpRow) : ["（无 open 事项）"]),
				{ count: items.length, items },
			);
		}
		case "create":
		case "resolve":
			return handleFollowUp(deps, params);
		default:
			return worldFailed("remind.action 必须是 list/create/resolve。", { reason: "invalid_action" });
	}
}

/** qq_requests：list 复用 observe requests（平台快照口径）；respond 复用 respond_request 链路。 */
async function handleRequests(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	switch (params.action ?? "list") {
		case "list":
			return handleObserve(deps, { scope: "requests", limit: params.limit, cursor: params.cursor }, signal);
		case "respond": {
			const result = await handleRequestResponse(deps, params, signal);
			// 拒绝理由平台无对应字段：只做本地备注呈现，不伪装为平台副作用。
			if (
				typeof params.reason === "string" &&
				params.reason !== "" &&
				(result.status === "succeeded" || result.status === "unknown")
			) {
				return {
					...result,
					result: `${result.result}\nreason=${render.quote(params.reason)}（本地备注；平台拒绝无理由字段）`,
				};
			}
			return result;
		}
		default:
			return worldFailed("requests.action 必须是 list/respond。", { reason: "invalid_action" });
	}
}

/** qq_profile：get 复用 observe self；三个写操作复用 account 对应链路。 */
async function handleProfile(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	switch (params.action ?? "get") {
		case "get":
			return handleObserve(deps, { scope: "self" }, signal);
		case "set_card":
			return handleCardUpdate(deps, params, signal);
		case "set_profile":
			return handleProfileUpdate(deps, params, signal);
		case "set_avatar":
			return handleAvatarUpdate(deps, params, signal);
		default:
			return worldFailed("profile.action 必须是 get/set_card/set_profile/set_avatar。", { reason: "invalid_action" });
	}
}
