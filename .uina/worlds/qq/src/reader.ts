import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";
import type { AttentionModel } from "./attention.js";
import type { ConversationLocks } from "./conversation-lock.js";
import { consumptionThrough, pendingCountOf } from "./scheduler.js";
import { expandImages, imageSourcesFromFacts, withImages } from "./media-fetch.js";
import type { ImageContent } from "../../../../src/core/content.js";
import { observeContent } from "./observe.js";
import * as render from "./render.js";
import { parseConversationRef, parseMessageRef, type MessageFact, type MessageSegment } from "./types.js";

/**
 * 查询与消费积木（设计 §4.1~§4.4，P4）：
 * - inbox：读写合一——focus/push 显式才修改（省略严格不动），查询如实返回 effectiveFollow；
 * - read：消费锁内顺序消费，成功交付后推进 body_dispatched 书签（与 follow 共锁同书签）；
 * - skip：锁内放下积压，审计记录 + Math.max 单调推进消费位；
 * - browse：纯只读（contentTarget > messageRefs > direction 三级裁决），绝不移动书签。
 * 绑定账号由 World 运行时注入（设计 §4：积木不再要求模型重复填写 account）。
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

/* ---------- P4.1 inbox ---------- */

const PUSH_MODES = ["off", "digest", "follow", "inherit"] as const;
const PUSH_FILTERS = ["all", "direct", "inherit"] as const;

export function handleInbox(deps: QqAppDeps, params: Record<string, unknown>): ToolExecutionResult {
	// 写入先行（显式参数才修改；省略严格 = 不动）。
	if (params.focus !== undefined) {
		const focus = params.focus;
		if (!Array.isArray(focus) || focus.some((ref) => typeof ref !== "string")) {
			return worldFailed("focus 必须是会话引用数组；传 [] 放下所有关注。", { reason: "invalid_focus" });
		}
		try {
			deps.attention.setFocus(focus as string[]);
		} catch (error) {
			return worldFailed(`focus 保存失败：${error instanceof Error ? error.message : String(error)}`, {
				reason: "invalid_focus",
			});
		}
	}
	if (params.push !== undefined) {
		const push = params.push as Record<string, unknown>;
		const target = push.target;
		if (typeof target !== "string" || (target !== "account" && !parseConversationRef(target))) {
			return worldFailed(`push.target 必须是会话引用或 "account"。`, { reason: "invalid_target" });
		}
		const mode = push.mode;
		if (mode !== undefined && !(PUSH_MODES as readonly unknown[]).includes(mode)) {
			return worldFailed(`push.mode 必须是 ${PUSH_MODES.join("/")}。`, { reason: "invalid_push_mode" });
		}
		const filter = push.filter;
		if (filter !== undefined && !(PUSH_FILTERS as readonly unknown[]).includes(filter)) {
			return worldFailed(`push.filter 必须是 ${PUSH_FILTERS.join("/")}。`, { reason: "invalid_push_filter" });
		}
		try {
			deps.control.setPush(target, {
				...(mode !== undefined ? { mode: mode as (typeof PUSH_MODES)[number] } : {}),
				...(filter !== undefined ? { filter: filter as (typeof PUSH_FILTERS)[number] } : {}),
				...(push.pausedUntil !== undefined ? { pausedUntil: push.pausedUntil as string | null } : {}),
			});
		} catch (error) {
			return worldFailed(`push 保存失败，保留旧偏好：${error instanceof Error ? error.message : String(error)}`, {
				reason: "control_persist_failed",
			});
		}
	}

	// 查询（消费位口径；会话名不在本地事实中，如实只给引用与类型）。
	const limit = clampInt(params.limit, 20, 1, 50);
	if (limit === null) return worldFailed("limit 必须是 1~50 的整数。", { reason: "invalid_params" });
	const pendingOnly = params.pendingOnly === true;
	const rows = [...deps.journal.snapshot.messages.keys()]
		.map((conv) => {
			const list = deps.journal.snapshot.messages.get(conv) ?? [];
			const last = list.at(-1);
			const baseline = deps.control.baselineOf(conv) ?? 0;
			return {
				conversationRef: conv,
				kind: KIND_LABELS[parseConversationRef(conv)?.kind ?? ""] ?? "会话",
				pendingCount: pendingCountOf(deps.journal, deps.control, conv),
				archivedCount: list.filter((m) => m.sequence <= baseline).length,
				lastTime: last?.time ?? null,
				preview: last ? previewOf(last) : null,
				pushMode: deps.control.effectivePush(conv).mode,
				focused: deps.attention.isFocused(conv),
				effectiveFollow: deps.attention.effectiveFollow(conv),
			};
		})
		.filter((row) => (pendingOnly ? row.pendingCount > 0 : true))
		.sort((a, b) => (b.lastTime ?? "").localeCompare(a.lastTime ?? "") || a.conversationRef.localeCompare(b.conversationRef));
	const page = rows.slice(0, limit);
	const accountPush = deps.control.effectivePush("account");
	const time = new render.TimeView(deps.display?.timezone);
	const lines = [
		`收件箱 snapshot=${time.header(nowIso(deps))}；selfId=${deps.selfId}`,
		`关注=[${deps.attention.focusList().join(", ") || "（无）"}]；账号推送 mode=${accountPush.mode} filter=${accountPush.filter} pausedUntil=${accountPush.pausedUntil ?? "null"}`,
		...page.map(
			(row) =>
				`${row.conversationRef} | ${row.kind} | 待处理 ${row.pendingCount} 条 | 封存 ${row.archivedCount} 条${row.lastTime ? ` | 最后 ${time.line(row.lastTime)}` : ""}${row.preview ? ` | ${render.quote(row.preview)}` : ""} | push=${row.pushMode} | 关注=${row.focused ? "是" : "否"} | follow=${row.effectiveFollow ? "是" : "否"}`,
		),
		...(page.length === 0 ? ["（无匹配会话）"] : []),
		...(rows.length > page.length ? [`（其余 ${rows.length - page.length} 个会话未显示；可用 limit 调整）`] : []),
	];
	return worldSucceeded(render.receipt.ok("inbox", lines), {
		focus: deps.attention.focusList(),
		accountPush,
		conversations: page,
		total: rows.length,
	});
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
			return worldFailed("未指定 conversationRef 且当前没有关注会话；请先 qq_inbox 查看或显式指定。", {
				reason: "target_required",
			});
		}
		if (focus.length > 1) {
			return worldFailed(`当前关注 ${focus.length} 个会话，请显式指定 conversationRef。`, { reason: "target_ambiguous" });
		}
		conv = focus[0]!;
	}
	const limit = clampInt(params.limit, 20, 1, 100);
	if (limit === null) return worldFailed("limit 必须是 1~100 的整数。", { reason: "invalid_params" });
	const budgetChars = clampInt(params.budgetChars, 14000, 512, 32768);
	if (budgetChars === null) return worldFailed("budgetChars 必须是 512~32768 的整数。", { reason: "invalid_params" });
	if (signal?.aborted) return worldFailed("已取消。", { reason: "cancelled", effect: "not_started" });

	// 消费锁内：重读最新书签 → 渲染增量 → 成功交付后推进书签（与 follow 共锁同书签，§2.1）。
	const outcome = await deps.locks.run(conv, async () => {
		const window = render.renderReadWindow(conv, renderDeps(deps), { limit, budgetChars });
		if (window.delivered.length > 0) {
			deps.journal.recordDispatched(conv, window.deliveredThrough, "read", nowIso(deps));
		}
		return window;
	});
	let text = outcome.text;
	let images: ImageContent[] = [];
	if (params.includeMedia === true && outcome.delivered.length > 0) {
		const expanded = await expandImages(imageSourcesFromFacts([...outcome.delivered]), signal);
		if (expanded.note) text += `\n${expanded.note}`;
		images = expanded.images;
	}
	return withImages(
		worldSucceeded(text, {
			conversationRef: conv,
			deliveredCount: outcome.delivered.length,
			deliveredThrough: outcome.delivered.at(-1)?.ref ?? null,
			remainingPendingCount: outcome.remaining,
		}),
		images,
	);
}

/* ---------- P4.3 skip ---------- */

export async function handleSkip(deps: QqAppDeps, params: Record<string, unknown>): Promise<ToolExecutionResult> {
	const checked = checkConversation(params.conversationRef);
	if (!("ok" in checked)) return checked;
	const conv = checked.ref;
	const reason = typeof params.reason === "string" && params.reason ? params.reason : "主动放下积压";
	const rawThrough = params.throughMessageRef;
	if (rawThrough !== undefined && (typeof rawThrough !== "string" || (rawThrough !== "latest" && !parseMessageRef(rawThrough)))) {
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
	const outcome = await deps.locks.run(conv, async () => {
		const through = consumptionThrough(deps.journal, deps.control, conv);
		const targetSeq = anchorSeq ?? deps.journal.latestSequence(conv);
		const newBookmark = Math.max(through, targetSeq);
		const skippedCount =
			targetSeq > through
				? (deps.journal.snapshot.messages.get(conv) ?? []).filter((m) => m.sequence > through && m.sequence <= targetSeq)
						.length
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
		return result.status === "succeeded"
			? { ...result, result: `${result.result}\n（历史浏览；书签未移动）` }
			: result;
	}

	const refs = params.messageRefs;
	if (Array.isArray(refs) && refs.length > 0) {
		const found: MessageFact[] = [];
		const missing: string[] = [];
		for (const ref of refs) {
			if (typeof ref !== "string" || !parseMessageRef(ref)) {
				return worldFailed(`消息引用非法：${String(ref)}`, { reason: "invalid_target" });
			}
			const fact = deps.journal.getMessage(ref);
			if (fact) found.push(fact);
			else missing.push(ref);
		}
		const body = found.length > 0 ? render.renderMessageFacts(found, deps.selfId, deps.display, deps.journal) : [];
		const text = [
			`[QQ 点查] snapshot=${new render.TimeView(deps.display?.timezone).header(nowIso(deps))}`,
			...body,
			...missing.map((ref) => `${ref} | 本地未持有（不伪造内容；本地事实库无此消息）`),
			`coverage=${missing.length === 0 ? "continuous" : "partial"}；历史浏览；书签未移动`,
		].join("\n");
		return worldSucceeded(text, { found: found.map((f) => f.ref), missing, bookmarkMoved: false });
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
	const archiveBefore = deps.journal.snapshot.archiveBefore;
	const gapDetected = archiveBefore !== null && window.some((m) => m.time < archiveBefore);
	const body = window.length > 0 ? render.renderMessageFacts(window, deps.selfId, deps.display, deps.journal) : ["（窗口内无本地消息）"];
	const edgeNote =
		direction !== "after" && window.length > 0 && window[0]!.ref === list[0]?.ref && (direction !== "latest" || list.length >= limit)
			? "（本地最早持有至此；更早历史未持有，可能已归档）"
			: null;
	const text = [
		`[QQ 历史] conversationRef=${conv}；direction=${direction}${anchorSeq !== null ? `；anchor=${anchorRefRaw}` : ""}；snapshot=${new render.TimeView(deps.display?.timezone).header(nowIso(deps))}`,
		...body,
		...(edgeNote ? [edgeNote] : []),
		...(window.length > 0
			? [
					`翻页线索：最旧 ${window[0]!.ref} / 最新 ${window.at(-1)!.ref}；before/after 以消息引用为锚继续翻页。`,
				]
			: []),
		`coverage=${gapDetected ? "gap_detected（区间存在归档/断线缺口，非平台无损历史）" : "continuous"}；历史浏览；书签未移动`,
	].join("\n");
	return worldSucceeded(text, {
		conversationRef: conv,
		count: window.length,
		coverage: gapDetected ? "gap_detected" : "continuous",
		oldest: window[0]?.ref ?? null,
		newest: window.at(-1)?.ref ?? null,
		bookmarkMoved: false,
	});
}

/* ---------- P4.5 qq_status（仅 CLI/内部自检；不注册模型工具） ---------- */

export function qqStatusLines(
	deps: Pick<QqAppDeps, "selfId" | "journal" | "control" | "ops">,
	attention?: AttentionModel,
	locks?: ConversationLocks,
): string[] {
	const lines = [
		`selfId=${deps.selfId}；unknown 操作数=${deps.ops.listUnknown().length}`,
		`关注=[${attention?.focusList().join(", ") || "（无）"}]；消费锁=${locks ? "就绪" : "未就绪"}`,
	];
	for (const conv of deps.journal.listConversationRefs()) {
		const baseline = deps.control.baselineOf(conv) ?? "?";
		lines.push(
			`${conv} | 消费位=${deps.journal.dispatchedThroughOf(conv)} | 基线=${baseline} | 通知位=${deps.journal.snapshot.notifiedThrough.get(conv) ?? "无"} | 待处理=${pendingCountOf(deps.journal, deps.control, conv)} | 最新seq=${deps.journal.latestSequence(conv)} | push=${deps.control.effectivePush(conv).mode}`,
		);
	}
	const skips = deps.journal.skipRecords().slice(-5);
	if (skips.length > 0) {
		lines.push("最近跳过审计：");
		for (const skip of skips) lines.push(`  ${skip.at} | ${skip.conversationRef} | through=${skip.throughSequence} | ${render.quote(skip.reason)}`);
	}
	return lines;
}
