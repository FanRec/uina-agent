import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import type { QqAppDeps } from "./app.js";
import { decodeOneBotMessage } from "./message-codec.js";
import { parseMessageRef, type MessageFact } from "./types.js";
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

