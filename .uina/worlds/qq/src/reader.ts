import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldCancelled, worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";
import type { AttentionModel } from "./attention.js";
import type { ConversationLocks } from "./conversation-lock.js";
import { consumptionThrough, pendingCountOf, archivedCountOf } from "./consumption.js";
import { expandImages, imageSourcesFromFacts, withImages } from "./media-fetch.js";
import type { ImageContent } from "../../../../src/core/content.js";
import { paginate } from "./pagination.js";
import { decodeOneBotMessage, oneBotId } from "./message-codec.js";
import { observeContent, readMessage } from "./observe.js";
import * as render from "./render.js";
import { parseConversationRef, parseMessageRef, type MessageFact, type MessageSegment } from "./types.js";

/**
 * 查询与消费积木（v3 哑手机）：
 * - inbox：看手机（红点列表 + 会话设置）——focus（开窗）与 push（静音）显式才修改，省略严格不动；
 * - read：点开聊天——消费锁内顺序消费，成功交付后推进书签；
 * - skip：已读不看——锁内放下积压，审计记录 + Math.max 单调推进消费位；
 * - browse：翻历史（contentTarget > messageRefs > direction 三级裁决），绝不移动书签。
 * 绑定账号由 World 运行时注入（积木不要求模型重复填写 account）。
 */

const KIND_LABELS: Record<string, string> = { group: "群聊", private: "私聊", temp: "临时会话" };

function nowIso(deps: QqAppDeps): string {
	return deps.now ? deps.now() : new Date().toISOString();
}

function renderDeps(deps: QqAppDeps): render.BatchRenderDeps {
	return { journal: deps.journal, control: deps.control, now: () => nowIso(deps), display: deps.display };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number | null {
	const n = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(n) || n < min || n > max) return null;
	return n;
}

function previewOf(fact: { segments: readonly MessageSegment[] }): string {
	const textSeg = fact.segments.find((s): s is Extract<MessageSegment, { type: "text" }> => s.type === "text");
	const raw = textSeg?.text ?? `（${fact.segments[0]?.type ?? "message"}）`;
	return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
}

function checkConversation(ref: unknown): { ok: true; ref: string } | ToolExecutionResult {
	if (typeof ref !== "string" || !parseConversationRef(ref)) {
		return worldFailed(`会话引用非法：${String(ref)}`, { reason: "invalid_target" });
	}
	return { ok: true, ref };
}

/* ---------- inbox ---------- */

export async function handleInbox(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	signal = activeSignal(deps, signal);
	const limit = clampInt(params.limit, 20, 1, 50);
	if (limit === null) return worldFailed("limit 必须是 1~50 的整数。", { reason: "invalid_params" });
	const focus = params.focus;
	if (
		focus !== undefined &&
		(!Array.isArray(focus) || focus.some((ref) => typeof ref !== "string" || !parseConversationRef(ref)))
	) {
		return worldFailed("focus 必须是合法会话引用数组。", { reason: "invalid_focus" });
	}
	const push = params.push as Record<string, unknown> | undefined;
	if (push !== undefined) {
		if (
			!push ||
			typeof push !== "object" ||
			typeof push.target !== "string" ||
			(push.target !== "account" && !parseConversationRef(push.target))
		)
			return worldFailed("push.target 必须是会话引用或 account。", { reason: "invalid_target" });
		if (push.off !== undefined && typeof push.off !== "boolean") {
			return worldFailed("off 必须是布尔值。", { reason: "invalid_params" });
		}
		if (
			push.pausedUntil !== undefined &&
			push.pausedUntil !== null &&
			(typeof push.pausedUntil !== "string" || !Number.isFinite(Date.parse(push.pausedUntil)))
		)
			return worldFailed("pausedUntil 必须是 ISO 时间或 null。", { reason: "invalid_params" });
	}
	// 在线目录 best-effort：名称未知保持 unknown，不阻塞红点一瞥（瞥一眼必须廉价）。
	const names = new Map<string, string | null>();
	let directoryOnline = true;
	try {
		const [friends, groups] = await Promise.all([
			deps.transport.call("get_friend_list", {}, signal),
			deps.transport.call("get_group_list", {}, signal),
		]);
		if (signal?.aborted) return worldCancelled("收件箱查询已取消。", { effect: "not_started" });
		if (
			friends.status === "ok" &&
			groups.status === "ok" &&
			Array.isArray(friends.data) &&
			Array.isArray(groups.data)
		) {
			for (const raw of friends.data as Record<string, unknown>[]) {
				const id = oneBotId(raw.user_id);
				if (id)
					names.set(
						`p${id}`,
						typeof raw.remark === "string" && raw.remark
							? raw.remark
							: typeof raw.nickname === "string"
								? raw.nickname
								: null,
					);
			}
			for (const raw of groups.data as Record<string, unknown>[]) {
				const id = oneBotId(raw.group_id);
				if (id) names.set(`g${id}`, typeof raw.group_name === "string" ? raw.group_name : null);
			}
		} else directoryOnline = false;
	} catch (error) {
		if (signal?.aborted) return worldCancelled("收件箱查询已取消。", { effect: "not_started" });
		directoryOnline = false;
	}
	const refs = new Set([
		...names.keys(),
		...deps.journal.listConversationRefs(),
		...deps.attention.focusList(),
		...deps.control.pushTargets(),
		...((focus as string[] | undefined) ?? []),
	]);
	if (push?.target !== undefined && push.target !== "account") refs.add(push.target as string);
	const identities = [...refs]
		.sort()
		.filter((ref) => params.pendingOnly !== true || pendingCountOf(deps.journal, deps.control, ref) > 0)
		.map((ref) => ({ ref, name: names.get(ref) ?? null }));
	const page = paginate(
		identities,
		{ limit, cursor: params.cursor },
		{ selfId: deps.selfId, scope: "inbox", pendingOnly: params.pendingOnly === true },
	);
	if (!page.ok) return worldFailed(page.detail, { reason: page.reason });
	if (signal?.aborted) return worldCancelled("收件箱查询已取消。", { effect: "not_started" });
	try {
		if (push) deps.control.setPush(push.target as string, push as import("./types.js").PushPreference);
		if (focus !== undefined) deps.attention.setFocus(focus as string[]);
	} catch (error) {
		return worldFailed(`配置保存失败，保留旧状态：${String(error)}`, { reason: "control_persist_failed" });
	}
	const rows = page.page.map(({ ref, name }) => {
		const last = (deps.journal.snapshot.messages.get(ref) ?? []).at(-1);
		return {
			conversationRef: ref,
			name,
			nameKnown: name !== null,
			kind: KIND_LABELS[parseConversationRef(ref)?.kind ?? ""] ?? "会话",
			pendingCount: pendingCountOf(deps.journal, deps.control, ref),
			archivedCount: archivedCountOf(deps.journal, deps.control, ref),
			lastTime: last?.time ?? null,
			preview: last ? previewOf(last) : null,
			pushOff: deps.control.effectivePush(ref).off,
			focused: deps.attention.isFocused(ref),
		};
	});
	const accountPush = deps.control.effectivePush("account");
	return worldSucceeded(
		render.receipt.ok("inbox", [
			`在线收件箱 snapshot=${new render.TimeView(deps.display?.timezone).header(nowIso(deps))}；selfId=${deps.selfId}${directoryOnline ? "" : "；在线目录不可用，名称以本地为准"}`,
			`关注=[${deps.attention.focusList().join(", ")}]；账号静音=${accountPush.off ? "是" : "否"}`,
			...rows.map(
				(row) =>
					`${row.conversationRef} | name=${row.name === null ? "unknown" : render.quote(row.name)} | ${row.kind} | 待处理 ${row.pendingCount} 条 | 封存 ${row.archivedCount} 条 | push=${row.pushOff ? "off" : "on"} | 窗口=${row.focused ? "开" : "关"}${row.preview ? ` | ${render.quote(row.preview)}` : ""}`,
			),
			...(page.nextCursor
				? [
						`续页：${JSON.stringify({ action: "inbox", params: { limit, pendingOnly: params.pendingOnly === true, cursor: page.nextCursor } })}`,
					]
				: []),
		]),
		{
			focus: deps.attention.focusList(),
			accountPush,
			conversations: rows,
			total: page.total,
			hasMore: page.hasMore,
			nextCursor: page.nextCursor,
		},
	);
}

function activeSignal(deps: QqAppDeps, signal?: AbortSignal): AbortSignal | undefined {
	const signals = [deps.signal, signal].filter((item): item is AbortSignal => item !== undefined);
	return signals.length > 0 ? AbortSignal.any(signals) : undefined;
}

/* ---------- P4.2 read ---------- */

export async function handleRead(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	let conv: string;
	if (params.conversationRef !== undefined) {
		const checked = checkConversation(params.conversationRef);
		if (!("ok" in checked)) return checked;
		conv = checked.ref;
	} else {
		// 省略时：恰只关注一个会话才可直读（设计 §4.2）。
		const focus = deps.attention.focusList();
		if (focus.length === 0) {
			return worldFailed("未指定 conversationRef 且当前没有关注会话；请先调用 inbox 查看或显式指定。", {
				reason: "target_required",
			});
		}
		if (focus.length > 1) {
			return worldFailed(`当前关注 ${focus.length} 个会话，请显式指定 conversationRef。`, {
				reason: "target_ambiguous",
			});
		}
		conv = focus[0]!;
	}
	const limit = clampInt(params.limit, 20, 1, 100);
	if (limit === null) return worldFailed("limit 必须是 1~100 的整数。", { reason: "invalid_params" });
	const budgetChars = clampInt(params.budgetChars, 14000, 512, 32768);
	if (budgetChars === null) return worldFailed("budgetChars 必须是 512~32768 的整数。", { reason: "invalid_params" });
	signal = activeSignal(deps, signal);
	return deps.locks.run(conv, async () => {
		if (signal?.aborted) return worldCancelled("阅读已取消。", { effect: "not_started" });
		const window = render.renderReadWindow(conv, renderDeps(deps), { limit, budgetChars });
		let text = window.text;
		let images: ImageContent[] = [];
		if (params.includeMedia === true && window.delivered.length > 0) {
			const expanded = await expandImages(imageSourcesFromFacts([...window.delivered]), signal);
			if (expanded.note) text += `\n${expanded.note}`;
			images = expanded.images;
		}
		if (signal?.aborted) return worldCancelled("阅读已取消。", { effect: "not_started" });
		const result = withImages(
			worldSucceeded(text, {
				conversationRef: conv,
				deliveredCount: window.delivered.length,
				deliveredThrough: window.delivered.at(-1)?.ref ?? null,
				remainingPendingCount: window.remaining,
			}),
			images,
		);
		if (window.delivered.length > 0) deps.journal.recordDispatched(conv, window.deliveredThrough, "read", nowIso(deps));
		return result;
	});
}

/* ---------- P4.3 skip ---------- */

export async function handleSkip(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const checked = checkConversation(params.conversationRef);
	if (!("ok" in checked)) return checked;
	const conv = checked.ref;
	const reason = typeof params.reason === "string" && params.reason ? params.reason : "主动放下积压";
	const rawThrough = params.throughMessageRef;
	if (
		rawThrough !== undefined &&
		(typeof rawThrough !== "string" || (rawThrough !== "latest" && !parseMessageRef(rawThrough)))
	) {
		return worldFailed(`throughMessageRef 必须是消息引用或 "latest"。`, { reason: "invalid_target" });
	}

	// ref→sequence 映射不可变（R3 事实索引），锁前解析即可；消费位推进仍在锁内重读。
	let anchorSeq: number | null = null;
	if (rawThrough !== undefined && rawThrough !== "latest") {
		const fact = deps.journal.getMessage(rawThrough);
		if (!fact || fact.conversationRef !== conv) {
			return worldFailed(`消息引用 ${rawThrough} 不存在或不属目标会话。`, { reason: "not_found" });
		}
		anchorSeq = fact.sequence;
	}
	signal = activeSignal(deps, signal);
	const outcome = await deps.locks.run(conv, async () => {
		if (signal?.aborted) return null;
		const through = consumptionThrough(deps.journal, deps.control, conv);
		const targetSeq = anchorSeq ?? deps.journal.latestSequence(conv);
		const newBookmark = Math.max(through, targetSeq);
		const skippedCount =
			targetSeq > through
				? (deps.journal.snapshot.messages.get(conv) ?? []).filter(
						(m) => m.direction === "in" && m.sequence > through && m.sequence <= targetSeq,
					).length
				: 0;
		if (newBookmark > through) deps.journal.recordSkipped(conv, newBookmark, reason, nowIso(deps));
		const bookmarkFact = (deps.journal.snapshot.messages.get(conv) ?? []).find((m) => m.sequence === newBookmark);
		return {
			skippedCount,
			remaining: pendingCountOf(deps.journal, deps.control, conv),
			newBookmark,
			bookmarkRef: bookmarkFact?.ref ?? null,
		};
	});
	if (!outcome) return worldCancelled("跳过已取消。", { effect: "not_started" });
	return worldSucceeded(
		render.receipt.ok("skip", [
			`skippedCount=${outcome.skippedCount}`,
			`remainingPendingCount=${outcome.remaining}`,
			`newBookmark=${outcome.bookmarkRef ?? outcome.newBookmark}（seq ${outcome.newBookmark}）`,
			`reason=${render.quote(reason)}`,
		]),
		{
			skippedCount: outcome.skippedCount,
			remainingPendingCount: outcome.remaining,
			newBookmark: outcome.newBookmark,
		},
	);
}

/* ---------- P4.4 browse ---------- */

export async function handleBrowse(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	signal = activeSignal(deps, signal);
	// 三级优先级裁决（§4.4）：contentTarget > messageRefs > direction+anchor。
	if (params.contentTarget !== undefined) {
		const target = params.contentTarget as Record<string, unknown>;
		if (typeof target !== "object" || target === null || typeof target.messageRef !== "string") {
			return worldFailed("contentTarget.messageRef 必须是消息引用。", { reason: "invalid_target" });
		}
		const result = await observeContent(
			deps,
			{
				messageRef: target.messageRef,
				segmentIndex: target.segmentIndex ?? 0,
				includeMedia: params.includeMedia,
				...(typeof target.cursor === "string" && target.cursor !== "" ? { cursor: target.cursor } : {}),
			},
			signal,
		);
		if (signal?.aborted) return worldCancelled("浏览已取消。", { effect: "not_started" });
		return result.status === "succeeded" ? { ...result, result: `${result.result}\n（历史浏览；书签未移动）` } : result;
	}

	const refs = params.messageRefs;
	if (Array.isArray(refs) && refs.length > 0) {
		const found: MessageFact[] = [];
		const missing: string[] = [];
		for (const ref of refs) {
			if (typeof ref !== "string" || !parseMessageRef(ref)) {
				return worldFailed(`消息引用非法：${String(ref)}`, { reason: "invalid_target" });
			}
			const fact = await readMessage(deps, ref, signal);
			if (signal?.aborted) return worldCancelled("浏览已取消。", { effect: "not_started" });
			if (fact) found.push(fact);
			else missing.push(ref);
		}
		const body = found.length > 0 ? render.renderMessageFacts(found, deps.selfId, deps.display, deps.journal) : [];
		const text = [
			`[QQ 点查] snapshot=${new render.TimeView(deps.display?.timezone).header(nowIso(deps))}`,
			...body,
			...missing.map((ref) => `${ref} | 本地未持有，平台亦未取得（不伪造内容）`),
			`coverage=${missing.length === 0 ? "local_or_platform_observed" : "partial"}；历史浏览；书签未移动`,
		].join("\n");
		return browseResult(
			deps,
			found,
			text,
			{ found: found.map((f) => f.ref), missing, bookmarkMoved: false },
			params.includeMedia === true,
			signal,
		);
	}

	// direction + anchor 时空漫游（纯本地只读；绝对不移动书签）。
	const checked = checkConversation(params.conversationRef);
	if (!("ok" in checked)) return checked;
	const conv = checked.ref;
	const direction = typeof params.direction === "string" ? params.direction : "latest";
	if (!["latest", "before", "after", "around"].includes(direction)) {
		return worldFailed(`direction 必须是 latest/before/after/around。`, { reason: "invalid_params" });
	}
	const limit = clampInt(params.limit, 20, 1, 100);
	if (limit === null) return worldFailed("limit 必须是 1~100 的整数。", { reason: "invalid_params" });
	const anchorRefRaw = params.anchorMessageRef;
	if (anchorRefRaw !== undefined && (typeof anchorRefRaw !== "string" || !parseMessageRef(anchorRefRaw))) {
		return worldFailed(`anchorMessageRef 非法：${String(anchorRefRaw)}`, { reason: "invalid_target" });
	}
	const source = params.source ?? "local";
	if (source !== "local" && source !== "platform")
		return worldFailed("source 必须是 local/platform。", { reason: "invalid_params" });
	if (source === "platform")
		return platformHistory(
			deps,
			conv,
			direction,
			anchorRefRaw as string | undefined,
			limit,
			params.includeMedia === true,
			signal,
		);
	let anchorSeq: number | null = null;
	if (typeof anchorRefRaw === "string") {
		const anchor = deps.journal.getMessage(anchorRefRaw);
		if (!anchor || anchor.conversationRef !== conv) {
			return worldFailed(`锚点 ${anchorRefRaw} 本地未持有或不属于该会话。`, { reason: "anchor_unavailable" });
		}
		anchorSeq = anchor.sequence;
	}
	if (direction !== "latest" && anchorSeq === null) {
		return worldFailed(`direction=${direction} 需要 anchorMessageRef 锚点。`, { reason: "anchor_required" });
	}
	const list = deps.journal.snapshot.messages.get(conv) ?? [];
	let window: MessageFact[];
	if (direction === "latest") window = list.slice(-limit);
	else if (direction === "before") window = list.filter((m) => m.sequence < anchorSeq!).slice(-limit);
	else if (direction === "after") window = list.filter((m) => m.sequence > anchorSeq!).slice(0, limit);
	else {
		const before = list.filter((m) => m.sequence < anchorSeq!).slice(-Math.floor(limit / 2));
		const after = list.filter((m) => m.sequence > anchorSeq!).slice(0, Math.max(0, limit - before.length - 1));
		window = [...before, list.find((m) => m.sequence === anchorSeq!)!, ...after];
	}
	const coverage = coverageOf(deps, conv, window);
	const body =
		window.length > 0
			? render.renderMessageFacts(window, deps.selfId, deps.display, deps.journal)
			: ["（窗口内无本地消息）"];
	const edgeNote =
		direction !== "after" &&
		window.length > 0 &&
		window[0]!.ref === list[0]?.ref &&
		(direction !== "latest" || list.length >= limit)
			? "（本地最早持有至此；更早历史未持有，可能已归档）"
			: null;
	const text = [
		`[QQ 历史] conversationRef=${conv}；direction=${direction}${anchorSeq !== null ? `；anchor=${anchorRefRaw}` : ""}；snapshot=${new render.TimeView(deps.display?.timezone).header(nowIso(deps))}`,
		...body,
		...(edgeNote ? [edgeNote] : []),
		...(window.length > 0
			? [
					`续页：${JSON.stringify({ action: "browse", params: { conversationRef: conv, source: "local", direction: "before", anchorMessageRef: window[0]!.ref, limit } })}；向后：${JSON.stringify({ action: "browse", params: { conversationRef: conv, source: "local", direction: "after", anchorMessageRef: window.at(-1)!.ref, limit } })}`,
				]
			: []),
		`coverage=${coverage.gaps.length > 0 ? "gap_detected" : "local_observed"}；archived=${coverage.archived}；平台完整性未知；历史浏览；书签未移动`,
	].join("\n");
	return browseResult(
		deps,
		window,
		text,
		{
			conversationRef: conv,
			count: window.length,
			coverage: coverage.gaps.length > 0 ? "gap_detected" : "local_observed",
			coverageGaps: coverage.gaps,
			archived: coverage.archived,
			oldest: window[0]?.ref ?? null,
			newest: window.at(-1)?.ref ?? null,
			bookmarkMoved: false,
		},
		params.includeMedia === true,
		signal,
	);
}

function coverageOf(
	deps: QqAppDeps,
	conv: string,
	facts: readonly MessageFact[],
): { gaps: import("./facts-journal.js").FactsSnapshot["coverageGaps"]; archived: boolean } {
	const times = facts.map((fact) => Date.parse(fact.time)).sort((a, b) => a - b);
	const first = times[0] ?? Date.parse(nowIso(deps));
	const last = times.at(-1) ?? first;
	const gaps = deps.journal.snapshot.coverageGaps.filter(
		(gap) =>
			(!gap.conversationRef || gap.conversationRef === conv) &&
			Date.parse(gap.from) <= last &&
			(gap.to === null || Date.parse(gap.to) >= first),
	);
	return {
		gaps,
		archived: deps.journal.snapshot.archiveBefore !== null && first < Date.parse(deps.journal.snapshot.archiveBefore),
	};
}

async function browseResult(
	deps: QqAppDeps,
	facts: MessageFact[],
	text: string,
	details: Record<string, unknown>,
	includeMedia: boolean,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const scopes = [...new Set(facts.map((fact) => fact.conversationRef))].map((conv) => ({
		conversationRef: conv,
		...coverageOf(
			deps,
			conv,
			facts.filter((fact) => fact.conversationRef === conv),
		),
	}));
	const gaps = scopes.flatMap((scope) => scope.gaps);
	if (gaps.length > 0) text += `\n覆盖风险：${JSON.stringify(gaps)}`;
	text += "\n覆盖范围仅限本次窗口；平台完整性未知。";
	if (signal?.aborted) return worldCancelled("浏览已取消。", { effect: "not_started" });
	if (!includeMedia) return worldSucceeded(text, { ...details, coverageScopes: scopes });
	const expanded = await expandImages(imageSourcesFromFacts(facts), signal);
	if (signal?.aborted) return worldCancelled("浏览已取消。", { effect: "not_started" });
	return withImages(
		worldSucceeded(`${text}${expanded.note ? `\n${expanded.note}` : ""}`, { ...details, coverageScopes: scopes }),
		expanded.images,
	);
}

async function platformHistory(
	deps: QqAppDeps,
	conv: string,
	direction: string,
	anchor: string | undefined,
	limit: number,
	includeMedia: boolean,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	if (direction !== "latest" && !anchor)
		return worldFailed("此方向需要 anchorMessageRef。", { reason: "anchor_required" });
	const parsed = parseConversationRef(conv)!;
	const action = parsed.kind === "group" ? "get_group_msg_history" : "get_friend_msg_history";
	const target =
		parsed.kind === "group"
			? { group_id: Number(parsed.key) }
			: { user_id: Number(/^(\d+)-g/.exec(parsed.key)?.[1] ?? parsed.key) };
	async function fetchSide(older: boolean): Promise<MessageFact[]> {
		const outcome = await deps.transport.call(
			action,
			{
				...target,
				message_id: anchor ? parseMessageRef(anchor)!.messageId : 0,
				count: limit + (anchor ? 1 : 0),
				reverse_order: older,
			},
			signal,
		);
		if (outcome.status !== "ok") throw new Error(outcome.reason);
		const raw = (outcome.data as { messages?: unknown } | null)?.messages;
		if (!Array.isArray(raw)) throw new Error("平台历史响应形状非法");
		const decoded = raw.map((item) => decodeOneBotMessage(item, deps.selfId, conv));
		if (decoded.some((item) => item === null)) throw new Error("平台历史含不可核验的消息");
		return [...new Map((decoded as MessageFact[]).map((fact) => [fact.ref, fact])).values()].sort((a, b) =>
			a.time.localeCompare(b.time),
		);
	}
	try {
		let facts: MessageFact[];
		if (direction === "around") {
			const [older, newer] = await Promise.all([fetchSide(true), fetchSide(false)]);
			const center = older.find((fact) => fact.ref === anchor) ?? newer.find((fact) => fact.ref === anchor);
			if (!center) return worldFailed("平台未返回锚点。", { reason: "anchor_unavailable" });
			const before = older.filter((fact) => fact.ref !== anchor).slice(-Math.floor(limit / 2));
			const after = newer.filter((fact) => fact.ref !== anchor).slice(0, limit - before.length - 1);
			facts = [...new Map([...before, center, ...after].map((fact) => [fact.ref, fact])).values()];
		} else {
			facts = await fetchSide(direction !== "after");
			if (anchor) facts = facts.filter((fact) => fact.ref !== anchor);
			facts = direction === "after" ? facts.slice(0, limit) : facts.slice(-limit);
		}
		return browseResult(
			deps,
			facts,
			[
				`[QQ 平台历史] conversationRef=${conv}；direction=${direction}`,
				...render.renderMessageFacts(facts, deps.selfId, deps.display, deps.journal),
				"source=platform；历史浏览；书签未移动",
				...(facts.length > 0
					? [
							`续页：${JSON.stringify({ action: "browse", params: { conversationRef: conv, source: "platform", direction: "before", anchorMessageRef: facts[0]!.ref, limit } })}；向后：${JSON.stringify({ action: "browse", params: { conversationRef: conv, source: "platform", direction: "after", anchorMessageRef: facts.at(-1)!.ref, limit } })}`,
						]
					: []),
			].join("\n"),
			{
				conversationRef: conv,
				source: "platform",
				count: facts.length,
				oldest: facts[0]?.ref ?? null,
				newest: facts.at(-1)?.ref ?? null,
				bookmarkMoved: false,
			},
			includeMedia,
			signal,
		);
	} catch (error) {
		if (signal?.aborted) return worldCancelled("平台历史查询已取消。", { effect: "not_started" });
		return worldFailed(`平台历史查询失败：${String(error)}`, { reason: "platform_query_failed" });
	}
}

/* ---------- P4.5 qq_status（仅 CLI/内部自检；不注册模型工具） ---------- */

export function qqStatusLines(
	deps: Pick<QqAppDeps, "selfId" | "journal" | "control" | "ops">,
	attention?: AttentionModel,
	locks?: ConversationLocks,
): string[] {
	const lines = [
		`selfId=${deps.selfId}；unknown 操作数=${deps.ops.listUnknown().length}`,
		`关注=[${attention ? attention.focusList().join(", ") || "（无）" : "unknown"}]；消费锁=${locks ? "就绪" : "未就绪"}`,
	];
	for (const conv of deps.journal.listConversationRefs()) {
		const baseline = deps.control.baselineOf(conv) ?? "?";
		lines.push(
			`${conv} | 消费位=${deps.journal.dispatchedThroughOf(conv)} | 基线=${baseline} | 待处理=${pendingCountOf(deps.journal, deps.control, conv)} | 最新seq=${deps.journal.latestSequence(conv)} | push=${deps.control.effectivePush(conv).off ? "off" : "on"}`,
		);
	}
	const skips = deps.journal.skipRecords().slice(-5);
	if (skips.length > 0) {
		lines.push("最近跳过审计：");
		for (const skip of skips)
			lines.push(
				`  ${skip.at} | ${skip.conversationRef} | through=${skip.throughSequence} | ${render.quote(skip.reason)}`,
			);
	}
	return lines;
}
