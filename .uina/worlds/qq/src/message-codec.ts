import { parseSegments } from "./vendor/snowluma-sdk/messages/cq.js";
import { parseConversationRef, REF_PATTERNS, type MessageFact, type MessageSegment } from "./types.js";

export function oneBotObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Keep identifiers exact; unsafe numeric values cannot be recovered from a rounded JS number. */
export function oneBotId(value: unknown, signed = false): string | null {
	let text = "";
	if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
	else if (typeof value === "string") text = value;
	const pattern = signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/;
	return pattern.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

export function oneBotTime(value: unknown): string | null {
	let milliseconds: number;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) milliseconds = value * 1000;
	else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0)
		milliseconds = Number(value) * 1000;
	else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
		milliseconds = Date.parse(value);
	else return null;
	return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15
		? new Date(milliseconds).toISOString()
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function decodeOneBotSegments(
	raw: unknown,
	mintMediaRef?: () => string,
): { segments: MessageSegment[]; replyTo?: string } {
	if (typeof raw === "string") {
		if (!/\[CQ:[a-zA-Z0-9_.-]+(?:,|\])/.test(raw)) return { segments: raw ? [{ type: "text", text: raw }] : [] };
		try {
			return decodeOneBotSegments(parseSegments(raw), mintMediaRef);
		} catch {
			return { segments: [{ type: "text", text: raw }] };
		}
	}
	if (!Array.isArray(raw)) return { segments: [] };
	const segments: MessageSegment[] = [];
	let replyTo: string | undefined;
	for (const rawItem of raw) {
		const item = oneBotObject(rawItem);
		if (!item) {
			segments.push({ type: "unknown", rawType: "?" });
			continue;
		}
		const type = text(item.type) ?? "?";
		const data = oneBotObject(item.data) ?? {};
		switch (type) {
			case "text":
				if (text(data.text)) segments.push({ type: "text", text: data.text as string });
				break;
			case "at": {
				const id = oneBotId(data.qq);
				if (data.qq === "all") segments.push({ type: "mention_all" });
				else if (id)
					segments.push({
						type: "mention",
						userRef: `u${id}`,
						displayName: text(data.name)?.trim() || text(data.nickname)?.trim() || undefined,
					});
				else segments.push({ type: "unknown", rawType: type });
				break;
			}
			case "reply": {
				const id = oneBotId(data.id, true);
				if (id) replyTo = `m${id}`;
				else segments.push({ type: "unknown", rawType: type });
				break;
			}
			case "face": {
				let id = "";
				if (typeof data.id === "string") id = data.id;
				else if (typeof data.id === "number" && Number.isSafeInteger(data.id)) id = String(data.id);
				if (/^(?:0|[1-9]\d*)$/.test(id) && Number.isSafeInteger(Number(id)))
					segments.push({ type: "face", faceId: id });
				else segments.push({ type: "unknown", rawType: type });
				break;
			}
			case "json":
			case "xml": {
				const dataText = text(data.data) ?? text(data.text);
				if (dataText !== undefined) segments.push({ type, data: dataText });
				else segments.push({ type: "unknown", rawType: type });
				break;
			}
			case "forward": {
				const resId = text(data.id) ?? text(data.res_id) ?? text(data.forward_id);
				if (resId) segments.push({ type: "forward", resId });
				else segments.push({ type: "unknown", rawType: type });
				break;
			}
			case "image":
			case "record":
			case "video":
			case "file": {
				const locator = {
					file: text(data.file),
					fileId:
						text(data.file_id) ??
						(typeof data.file_id === "number" && Number.isSafeInteger(data.file_id) ? String(data.file_id) : undefined),
					fileHash: text(data.file_hash),
					busid:
						typeof data.busid === "number" && Number.isSafeInteger(data.busid) && data.busid >= 0
							? data.busid
							: undefined,
				};
				segments.push({
					type: type === "record" ? "audio" : type,
					...(mintMediaRef ? { mediaRef: mintMediaRef() } : {}),
					url: text(data.url),
					fileName: text(data.name) ?? text(data.file),
					...(Object.values(locator).some((value) => value !== undefined) ? { locator } : {}),
					understood: false,
				});
				break;
			}
			default:
				segments.push({ type: "unknown", rawType: type });
		}
	}
	return { segments, ...(replyTo ? { replyTo } : {}) };
}

/** Read-only history decoding: it never mints journal sequence or media references. */
export function decodeOneBotMessage(raw: unknown, selfId: string, conversationRefHint?: string): MessageFact | null {
	const message = oneBotObject(raw);
	if (!message || !oneBotId(selfId)) return null;
	const declaredSelf = oneBotId(message.self_id);
	if (message.self_id !== undefined && declaredSelf !== selfId) return null;
	const id = oneBotId(message.message_id, true);
	const time = oneBotTime(message.time ?? message.timestamp);
	if (!id || !time) return null;
	const sender = oneBotObject(message.sender) ?? {};
	const senderId = oneBotId(sender.user_id) ?? oneBotId(message.user_id);
	const outgoing = message.post_type === "message_sent" || senderId === selfId;
	const hint =
		conversationRefHint && REF_PATTERNS.conversation.test(conversationRefHint) ? conversationRefHint : undefined;
	const messageType = text(message.message_type);
	const groupId = oneBotId(message.group_id);
	const hintKind = hint ? parseConversationRef(hint)?.kind : undefined;
	let conv: string | undefined;
	if (messageType === "group" || (!messageType && (groupId || hintKind === "group"))) {
		if (message.group_id !== undefined && !groupId) return null;
		if (groupId) conv = `g${groupId}`;
		else if (hint && parseConversationRef(hint)?.kind === "group") conv = hint;
	} else if (messageType === "private" || !messageType) {
		const target = oneBotId(message.target_id);
		let peer = senderId;
		if (outgoing) peer = target && target !== selfId ? target : null;
		const sourceGroup = oneBotId(sender.group_id) ?? (message.sub_type === "group" ? groupId : null);
		if (peer && peer !== selfId) {
			const temporary = message.sub_type === "group" || (!messageType && hintKind === "temp");
			conv = temporary ? `t${peer}${sourceGroup ? `-g${sourceGroup}` : ""}` : `p${peer}`;
			if (temporary && !sourceGroup && hint?.startsWith(`t${peer}-g`)) conv = hint;
		} else if (hint && parseConversationRef(hint)?.kind !== "group") conv = hint;
	}
	if (!conv || (hint && conv !== hint)) return null;
	return {
		ref: `m${id}`,
		conversationRef: conv,
		senderRef: senderId ? `u${senderId}` : null,
		senderDisplayName: text(sender.card)?.trim() || text(sender.nickname)?.trim() || null,
		direction: outgoing ? "out" : "in",
		sequence: 0,
		time,
		...decodeOneBotSegments(message.message ?? message.raw_message),
		source: "history",
	};
}
