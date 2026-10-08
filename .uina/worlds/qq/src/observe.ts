import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";
import { decodeOneBotMessage } from "./message-codec.js";
import { parseConversationRef, parseMessageRef, type MessageFact } from "./types.js";
import { expandImages, imageSourcesFromFacts, imageSourcesFromOneBot, withImages } from "./media-fetch.js";
import { paginate } from "./pagination.js";
import * as render from "./render.js";

/** Read-only lookup: platform snapshots never become newly arrived journal messages. */
export async function readMessage(deps: QqAppDeps, ref: string, signal?: AbortSignal): Promise<MessageFact | null> {
	const parsed = parseMessageRef(ref);
	if (!parsed) return null;
	const saved = deps.journal.getMessage(ref);
	if (saved) return saved;
	const outcome = await deps.transport.call("get_msg", { message_id: parsed.messageId }, signal);
	if (outcome.status !== "ok") return null;
	const fact = decodeOneBotMessage(outcome.data, deps.selfId);
	return fact?.ref === ref ? fact : null;
}

function pageFooter(hasMore: boolean, nextCursor?: string): string {
	return `hasMore=${hasMore}${nextCursor ? `；nextCursor=${nextCursor}` : ""}`;
}

export async function observeContent(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const ref = typeof params.messageRef === "string" ? params.messageRef : "";
	const fact = await readMessage(deps, ref, signal);
	if (!fact) return worldFailed(`消息 ${render.quote(ref)} 不可用。`, { reason: "message_unavailable" });
	const index = params.segmentIndex;
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
		return worldFailed("segmentIndex 必须是非负整数。", { reason: "invalid_segment" });
	const segment = fact.segments[index];
	if (!segment) return worldFailed(`消息 ${ref} 没有分段 ${index}。`, { reason: "segment_unavailable" });
	const binding = {
		account: deps.selfId,
		scope: "content",
		messageRef: ref,
		segmentIndex: index,
		includeMedia: params.includeMedia === true,
	};
	const head = `messageRef=${ref} segmentIndex=${index} type=${segment.type}`;
	if (segment.type === "forward") {
		const outcome = await deps.transport.call("get_forward_msg", { id: segment.resId }, signal);
		if (outcome.status !== "ok")
			return worldFailed(`转发读取失败：${render.quote(outcome.reason)}`, { reason: "platform_query_failed", outcome });
		const raw = (outcome.data as { messages?: unknown } | null)?.messages;
		const nodes = Array.isArray(raw)
			? raw.filter(
					(node): node is Record<string, unknown> => typeof node === "object" && node !== null && !Array.isArray(node),
				)
			: [];
		const page = paginate(nodes, params, { ...binding, resId: segment.resId });
		if (!page.ok) return worldFailed(page.detail, { reason: page.reason });
		const startIndex = page.page.length ? nodes.indexOf(page.page[0]!) : 0;
		let text = [
			head,
			`节点 ${page.page.length}/${page.total}`,
			...render.renderForwardNodes(page.page, deps.display, startIndex),
			pageFooter(page.hasMore, page.nextCursor),
		].join("\n");
		let images: NonNullable<ToolExecutionResult["images"]> = [];
		if (params.includeMedia === true) {
			const sources = page.page.flatMap((node) =>
				imageSourcesFromOneBot([node]).map((source) => ({
					...source,
					messageRef: ref,
					segmentIndex: index,
					forwardNodeIndex: nodes.indexOf(node),
					nodeSegmentIndex: source.segmentIndex,
					alt: `messageRef=${ref} segmentIndex=${index} forwardNodeIndex=${nodes.indexOf(node)} nodeSegmentIndex=${source.segmentIndex}`,
				})),
			);
			const expanded = await expandImages(sources, signal);
			images = expanded.images;
			if (expanded.note) text += `\n${expanded.note}`;
		}
		return withImages(
			worldSucceeded(text, {
				total: page.total,
				count: page.page.length,
				hasMore: page.hasMore,
				nextCursor: page.nextCursor,
			}),
			images,
		);
	}
	if (segment.type === "json" || segment.type === "xml" || segment.type === "text") {
		const text = segment.type === "text" ? segment.text : segment.data;
		const page = paginate(Array.from(text), params, binding, 4096);
		if (!page.ok) return worldFailed(page.detail, { reason: page.reason });
		return worldSucceeded(
			[head, render.quote(page.page.join("")), pageFooter(page.hasMore, page.nextCursor)].join("\n"),
			{ total: page.total, count: page.page.length, hasMore: page.hasMore, nextCursor: page.nextCursor },
		);
	}
	if (params.cursor !== undefined) return worldFailed("该分段没有续页。", { reason: "cursor_invalid" });
	let result = worldSucceeded(
		`${head}\n${render.quote(render.segmentText([segment], undefined, deps.display?.faceNames))}`,
		{},
	);
	if (segment.type === "image" && params.includeMedia === true) {
		const source = imageSourcesFromFacts([fact]).filter((item) => item.segmentIndex === index);
		const expanded = await expandImages(source, signal);
		result = withImages({ ...result, result: `${result.result}\n${expanded.note}` }, expanded.images);
	}
	return result;
}

interface ConversationCursor {
	v: 2;
	sig: string;
	source: "platform" | "local";
	boundary: string | null;
	boundaryTime: string | null;
	messageDone: boolean;
	localThrough: number;
	localPosition: number;
	eventsThrough: number;
	eventPosition: number;
}

function decodeConversationCursor(raw: unknown, sig: string): ConversationCursor | null {
	if (
		typeof raw !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(raw) ||
		Buffer.from(raw, "base64url").toString("base64url") !== raw
	)
		return null;
	const decoded = render.decodeCursor(raw);
	if (!decoded.ok) return null;
	const c = decoded.value;
	if (
		c.v !== 2 ||
		c.sig !== sig ||
		!["platform", "local"].includes(String(c.source)) ||
		typeof c.messageDone !== "boolean"
	)
		return null;
	if (c.boundary !== null && (typeof c.boundary !== "string" || !parseMessageRef(c.boundary))) return null;
	if (c.boundaryTime !== null && (typeof c.boundaryTime !== "string" || !Number.isFinite(Date.parse(c.boundaryTime))))
		return null;
	for (const field of ["localThrough", "localPosition", "eventsThrough", "eventPosition"])
		if (!Number.isSafeInteger(c[field]) || Number(c[field]) < 0) return null;
	return c as unknown as ConversationCursor;
}

/** Compound cursor advances messages and events independently; no mutable query cache. */
export async function observeConversation(
	deps: QqAppDeps,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolExecutionResult> {
	const conv = typeof params.conversationRef === "string" ? params.conversationRef : "";
	const parsed = parseConversationRef(conv);
	if (!parsed) return worldFailed("会话引用非法。", { reason: "invalid_target" });
	const direction = String(params.direction ?? "latest");
	const limit = Math.min(Number(params.limit ?? 20), 200);
	if (!Number.isSafeInteger(limit) || limit < 1)
		return worldFailed("limit 必须是正整数。", { reason: "invalid_params" });
	if (!["latest", "before", "after", "around"].includes(direction))
		return worldFailed("direction 非法。", { reason: "invalid_params" });
	const initialAnchor = typeof params.anchorMessageRef === "string" ? params.anchorMessageRef : null;
	if (initialAnchor !== null && !parseMessageRef(initialAnchor))
		return worldFailed("anchorMessageRef 非法。", { reason: "invalid_target" });
	const sig = render.fingerprintCursor({
		account: deps.selfId,
		conv,
		direction,
		initialAnchor,
		limit,
		includeEvents: params.includeEvents === true,
		includeMedia: params.includeMedia === true,
	});
	const events = deps.journal.snapshot.events.get(conv) ?? [];
	let state: ConversationCursor = {
		v: 2,
		sig,
		source: "platform",
		boundary: null,
		boundaryTime: null,
		messageDone: false,
		localThrough: deps.journal.latestSequence(conv),
		localPosition: 0,
		eventsThrough: events.reduce((latest, e) => Math.max(latest, Number(e.ref.slice(1))), 0),
		eventPosition: 0,
	};
	if (params.cursor !== undefined) {
		const decoded = decodeConversationCursor(params.cursor, sig);
		if (!decoded)
			return worldFailed("cursor 无效：版本、载荷或查询条件不匹配，请重新读取首页。", { reason: "cursor_invalid" });
		state = decoded;
	}
	let facts: MessageFact[] = [],
		failure: string | undefined;
	if (!state.messageDone && state.source === "platform") {
		const boundary = state.boundary ?? (direction === "latest" ? null : initialAnchor);
		const excludeAnchor = state.boundary ?? (direction === "after" ? initialAnchor : null);
		const count = Math.min(200, limit + (excludeAnchor ? 1 : 0));
		const outcome = await deps.transport.call(
			parsed.kind === "group" ? "get_group_msg_history" : "get_friend_msg_history",
			{
				...(parsed.kind === "group"
					? { group_id: Number(parsed.key) }
					: { user_id: Number(/^(\d+)-g/.exec(parsed.key)?.[1] ?? parsed.key) }),
				count,
				message_id: boundary ? parseMessageRef(boundary)!.messageId : 0,
				reverse_order: direction !== "after",
			},
			signal,
		);
		if (outcome.status !== "ok") {
			if (params.cursor !== undefined)
				return worldFailed(`平台续页失败：${render.quote(outcome.reason)}；未切换来源。`, {
					reason: "platform_query_failed",
					outcome,
				});
			failure = outcome.reason;
			state.source = "local";
		} else {
			const messages = (outcome.data as { messages?: unknown } | null)?.messages;
			const raw = Array.isArray(messages) ? messages : [];
			const normalized = raw.map((m) => decodeOneBotMessage(m, deps.selfId, conv));
			if (normalized.some((f) => !f || f.conversationRef !== conv))
				return worldFailed("平台历史含无法核验的消息归属或时间。", { reason: "invalid_platform_message" });
			let window = normalized;
			if (excludeAnchor) {
				const position = normalized.findIndex((f) => f?.ref === excludeAnchor);
				if (position >= 0)
					window = direction === "after" ? normalized.slice(position + 1) : normalized.slice(0, position);
				else if (state.boundaryTime)
					window = normalized.filter(
						(f) =>
							f &&
							(direction === "after"
								? Date.parse(f.time) > Date.parse(state.boundaryTime!)
								: Date.parse(f.time) < Date.parse(state.boundaryTime!)),
					);
				else if (normalized.length)
					return worldFailed("平台未返回可核验的续页边界。", { reason: "cursor_not_progressing" });
			}
			const seen = new Set<string>();
			facts = window.filter((f): f is MessageFact => {
				if (!f || f.ref === state.boundary || seen.has(f.ref)) return false;
				seen.add(f.ref);
				return true;
			});
			facts = direction === "after" ? facts.slice(0, limit) : facts.slice(-limit);
			const nextBoundary = direction === "after" ? facts.at(-1)?.ref : facts[0]?.ref;
			const boundaryOnlyEnd = raw.length < count && normalized.every((f) => f?.ref === state.boundary);
			if (state.boundary && raw.length > 0 && !boundaryOnlyEnd && (!nextBoundary || nextBoundary === state.boundary))
				return worldFailed("平台历史续页没有推进，请重新读取首页。", { reason: "cursor_not_progressing" });
			state.boundary = nextBoundary ?? state.boundary;
			state.boundaryTime = (direction === "after" ? facts.at(-1)?.time : facts[0]?.time) ?? state.boundaryTime;
			state.messageDone = raw.length < count || facts.length === 0;
		}
	}
	if (!state.messageDone && state.source === "local") {
		const saved = deps.journal.snapshot.messages.get(conv) ?? [];
		if (saved.length === 0 && failure)
			return worldFailed(`平台读取失败且无本地事实：${render.quote(failure)}`, { reason: "platform_query_failed" });
		const anchor = initialAnchor ? deps.journal.getMessage(initialAnchor) : null;
		if (initialAnchor && anchor?.conversationRef !== conv)
			return worldFailed("本地锚点不可用或不属于该会话。", { reason: "anchor_unavailable" });
		const window = saved.filter(
			(f) =>
				f.sequence <= state.localThrough &&
				(!anchor ||
					direction === "latest" ||
					(direction === "after" ? f.sequence > anchor.sequence : f.sequence <= anchor.sequence)),
		);
		const ordered = direction === "after" ? window : [...window].reverse();
		facts = ordered.slice(state.localPosition, state.localPosition + limit);
		state.localPosition += facts.length;
		state.messageDone = state.localPosition >= ordered.length;
		if (direction !== "after") facts.reverse();
	}
	const eventWindow =
		params.includeEvents === true
			? [...events].filter((e) => Number(e.ref.slice(1)) <= state.eventsThrough).reverse()
			: [];
	if (state.eventPosition > eventWindow.length)
		return worldFailed("事件游标超出可读窗口。", { reason: "cursor_invalid" });
	const eventPage = eventWindow.slice(state.eventPosition, state.eventPosition + limit);
	state.eventPosition += eventPage.length;
	const hasMore = !state.messageDone || state.eventPosition < eventWindow.length;
	const nextCursor = hasMore ? render.encodeCursor({ ...state }) : undefined;
	const lines = facts.map((f) => ({
		ref: f.ref,
		timeIso: f.time,
		sender: render.senderLabel(f),
		senderRef: f.senderRef,
		senderDisplayName: f.senderDisplayName,
		direction: f.direction,
		text: render.segmentText(f.segments, undefined, deps.display?.faceNames),
		segments: f.segments,
		replyTo: f.replyTo,
	}));
	const page = render.renderConversationPage({
		conversationRef: conv,
		selfId: deps.selfId,
		direction,
		source: state.source,
		lines,
		events: eventPage.map((e) => ({ ...e, timeIso: e.time })),
		display: deps.display,
		journal: deps.journal,
		time: new render.TimeView(deps.display?.timezone),
	});
	let text = `${page.text}\n${pageFooter(hasMore, nextCursor)}`;
	if (failure) text += `\n平台读取失败：${render.quote(failure)}`;
	let images: NonNullable<ToolExecutionResult["images"]> = [];
	if (params.includeMedia === true) {
		const expanded = await expandImages(imageSourcesFromFacts(facts), signal);
		images = expanded.images;
		if (expanded.note) text += `\n${expanded.note}`;
	}
	return withImages(worldSucceeded(text, { count: facts.length, source: state.source, hasMore, nextCursor }), images);
}
