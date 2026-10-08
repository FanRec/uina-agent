import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { MessageFact, MessageSegment, OperationRecord, RequestFact, FollowUpItem, EventFact } from "./types.js";
import { parseConversationRef } from "./types.js";
import { decodeOneBotSegments, oneBotTime } from "./message-codec.js";
import type { PendingCandidate } from "./scheduler.js";
/**
 * QQ World 呈现层（唯一 owner，交互合同 §5/§6）。
 * 纯函数：消费规范 facts 与只读快照，产出模型可见正文；不触 transport、不写 store。
 * 测试哲学（合同：词序/排版不是逐字标准）：断言必须信息存在、禁止项不存在、性质成立。
 *
 * 时间：事实一律 UTC 存储；仅在渲染层按 display.timezone 转换，快照标题标注偏移一次。
 * 转义：含引号/换行的值经 JSON.stringify 保持行结构。
 */

export interface DisplayOptions {
	/** IANA 时区名；缺省宿主时区。 */
	readonly timezone?: string;
	/** 批次软文本预算（字符），默认 14000。 */
	readonly batchBudgetChars?: number;
	readonly faceNames?: ReadonlyMap<string, string>;
}

/* ---------- 时间视图 ---------- */

export class TimeView {
	private readonly formatter: Intl.DateTimeFormat;
	private readonly offsetFormatter: Intl.DateTimeFormat;
	readonly offsetLabel: string;
	readonly timezone: string;

	constructor(timezone?: string) {
		const resolved = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		this.timezone = resolved;
		this.formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: resolved,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		this.offsetFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: resolved, timeZoneName: "longOffset" });
		this.offsetLabel = this.normalizedOffset(this.offsetFormatter.formatToParts(new Date()));
	}

	private normalizedOffset(parts: Intl.DateTimeFormatPart[]): string {
		const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
		// "GMT+8" / "GMT+08:00" → 统一 "GMT+08:00"
		const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
		if (!match) return raw;
		const [, sign, hours, minutes] = match;
		return `GMT${sign}${hours!.padStart(2, "0")}:${minutes ?? "00"}`;
	}

	/** 快照标题：完整本地时间 + 偏移标注（一次）。 */
	header(iso: string): string {
		return `${this.localParts(iso)} ${this.normalizedOffset(this.offsetFormatter.formatToParts(new Date(iso)))}`;
	}

	/** 行内时间：同日只显 HH:mm，跨日显 MM-DD HH:mm。 */
	line(iso: string, previousIso?: string): string {
		const current = this.localParts(iso);
		if (!previousIso) return current;
		return current.slice(0, 10) === this.localParts(previousIso).slice(0, 10)
			? current.slice(11)
			: current.slice(0, 16);
	}

	/** "YYYY-MM-DD HH:mm"（本地时区）。 */
	private localParts(iso: string): string {
		const parts = this.formatter.formatToParts(new Date(iso));
		const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
		return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
	}
}

/* ---------- 转义 ---------- */

/** 属性/正文引值：JSON.stringify 维持引号与换行的行结构。 */
export function quote(value: string): string {
	return JSON.stringify(value);
}

/* ---------- 批次现场（合同 §5.2 第二示例） ---------- */

export interface BatchRenderDeps {
	readonly journal: FactsJournal;
	readonly control: ControlStore;
	readonly now: () => string;
	readonly display?: DisplayOptions;
	/** 迟到回执升级的 unknown 操作（调度层收集；committed 后清理）。 */
	readonly settledUnknowns?: readonly OperationRecord[];
}

/** 消息行组：渲染与预算削减的单位。 */
interface MessageLines {
	readonly ref: string;
	readonly sequence: number;
	readonly lines: string[];
	readonly isAnchor: boolean;
	readonly isText: boolean;
	readonly text: string;
	readonly partial: boolean;
}

function conversationKindLabel(conversationRef: string): string {
	const kind = parseConversationRef(conversationRef)?.kind;
	if (kind === "group") return "QQ 群聊";
	if (kind === "temp") return "QQ 临时会话";
	return "QQ 私聊";
}

export function senderLabel(fact: MessageFact): string {
	if (fact.direction === "out") return `${fact.senderRef ?? "?"} ${fact.source === "echo" ? "我（已确认发言）" : "我"}`;
	const name = fact.senderDisplayName ? ` ${quote(fact.senderDisplayName)}` : "";
	return `${fact.senderRef ?? "?"}${name}`;
}

interface ScenePerson {
	readonly senderRef?: string | null;
	readonly senderDisplayName?: string | null;
	readonly direction?: "in" | "out";
	readonly segments?: readonly MessageSegment[];
	readonly rawMessage?: unknown;
}

type PersonLookup = (ref: string, displayName?: string) => string;

/** 只读取结构化 at；纯文本中的号码保持原文，all 不作为一个人物。 */
function rawMentionPeople(raw: unknown): ScenePerson[] {
	return decodeOneBotSegments(raw).segments.flatMap((seg) =>
		seg.type === "mention" ? [{ senderRef: seg.userRef, senderDisplayName: seg.displayName }] : [],
	);
}

/** 页内身份表：同一账号仅一项；标签保留昵称，并避开同名、我和真实昵称与生成标签的碰撞。 */
function scenePeople(
	people: readonly ScenePerson[],
	selfId: string,
): {
	label: (person: ScenePerson) => string;
	mention: PersonLookup;
	lines: (conversationRef: string) => string[];
} {
	const keyOf = (p: ScenePerson): string => (p.direction === "out" && selfId ? `u${selfId}` : (p.senderRef ?? ""));
	const entries = new Map<string, { name: string; own: boolean }>();
	const mentioned: ScenePerson[] = people.flatMap((p) => [
		...(p.segments ?? []).flatMap((seg) =>
			seg.type === "mention" ? [{ senderRef: seg.userRef, senderDisplayName: seg.displayName }] : [],
		),
		...rawMentionPeople(p.rawMessage),
	]);
	for (const p of [...people, ...mentioned]) {
		const key = keyOf(p);
		if (!key) continue;
		const own = p.direction === "out" || (!!selfId && key === `u${selfId}`);
		const name = own ? "我" : p.senderDisplayName?.trim() || "未署名";
		const previous = entries.get(key);
		if (!previous || (!previous.own && (own || (previous.name === "未署名" && name !== "未署名")))) {
			entries.set(key, { name, own });
		}
	}
	const names = new Map<string, number>();
	for (const { name } of entries.values()) names.set(name, (names.get(name) ?? 0) + 1);
	const used = new Set([...names.keys(), "我"]);
	const labels = new Map<string, string>();
	let ordinal = 0;
	for (const key of [...entries.keys()].sort()) {
		const { name, own } = entries.get(key)!;
		let label = name;
		if (!own && ((names.get(name) ?? 0) > 1 || name === "我" || name === "未署名")) {
			do {
				label = `${name}（人物${++ordinal}）`;
			} while (used.has(label));
		}
		used.add(label);
		labels.set(key, label);
	}
	return {
		label: (p) => labels.get(keyOf(p)) ?? (p.direction === "out" ? "我" : p.senderDisplayName?.trim() || "未署名"),
		mention: (ref, name) => labels.get(ref) ?? name ?? ref,
		lines: (conv) => {
			if (labels.size === 0) return [];
			const items = [...entries.keys()].map((key) => `${quote(labels.get(key)!)}=${key}`);
			const conversation = parseConversationRef(conv);
			if (conversation?.kind === "private") {
				const peers = [...entries.keys()].filter((key) => key === `u${conversation.key}` && !entries.get(key)!.own);
				const others = [...entries.keys()].filter((key) => !peers.includes(key));
				return [
					...(peers.length ? [`对方：${peers.map((key) => `${quote(labels.get(key)!)}=${key}`).join("；")}`] : []),
					...(others.length ? [`人物：${others.map((key) => `${quote(labels.get(key)!)}=${key}`).join("；")}`] : []),
				];
			}
			return [`人物：${items.join("；")}`];
		},
	};
}

/** 超长原文截断（卡片等载荷只保留前缀，完整原文在事实里）。 */
function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/** 卡片原文展示（json/xml 共用，单源格式）。 */
const CARD_PREVIEW_CHARS = 240;

function cardText(type: "json" | "xml", data: string, limit: number | null): string {
	return `[${type === "json" ? "卡片" : "XML 卡片"}] ${limit === null ? data : truncate(data, limit)}`;
}

/** 合并转发段展示（单源格式）。 */
function forwardText(resId: string): string {
	return `[合并转发 resId=${resId}（observe scope="messages" 用 messageRef 展开）]`;
}

/** OneBot sender → 稳定 ref + 展示名；空白群名片/昵称回落（与 ingest 入库规则一致）。 */
export function oneBotSenderLabel(
	sender: { user_id?: number; nickname?: string; card?: string } | undefined,
	selfId: string,
): string {
	const s = sender ?? {};
	const name = s.card?.trim() || s.nickname?.trim() || "?";
	return `${s.user_id === undefined ? "?" : `u${s.user_id}`} ${String(s.user_id) === selfId ? "我 " : ""}${quote(name)}`;
}

export function segmentText(
	segments: readonly MessageSegment[],
	mentionLabel?: PersonLookup,
	faceNames?: ReadonlyMap<string, string>,
): string {
	return renderSegments(segments, mentionLabel, faceNames, CARD_PREVIEW_CHARS);
}

function renderSegments(
	segments: readonly MessageSegment[],
	mentionLabel: PersonLookup | undefined,
	faceNames: ReadonlyMap<string, string> | undefined,
	cardLimit: number | null,
): string {
	return segments
		.map((seg) => {
			switch (seg.type) {
				case "text":
					return seg.text;
				case "mention":
					return `@${mentionLabel ? mentionLabel(seg.userRef, seg.displayName) : (seg.displayName ?? seg.userRef)}`;
				case "mention_all":
					return "@全体成员";
				case "face":
					return `[face:${seg.faceId}${faceNames?.get(seg.faceId) ? ` ${faceNames.get(seg.faceId)}` : ""}]`;
				case "json":
				case "xml":
					return cardText(seg.type, seg.data, cardLimit);
				case "forward":
					return forwardText(seg.resId);
				case "unknown":
					return `[未知分段 type=${seg.rawType}]`;
				default:
					return `[${seg.type}${seg.fileName ? ` ${seg.fileName}` : ""}${seg.mediaRef ? ` ref=${seg.mediaRef}` : ""}（未展开）]`;
			}
		})
		.join("");
}

/** OneBot 原始消息数组 → 纯展示文本（不铸造引用；@显示原编号；reply 是结构引用不进正文）。 */
export function looseText(raw: unknown, mentionLabel?: PersonLookup, faceNames?: ReadonlyMap<string, string>): string {
	return segmentText(decodeOneBotSegments(raw).segments, mentionLabel, faceNames);
}

/** 首场景尾部呈现起点（合同 §6 呈现起点，非事实/能力上限）。 */
const FIRST_SCENE_TAIL = 16;

/** 显式合并转发内容页：完整呈现本页节点载荷，仅一层，不递归展开。 */
export function renderForwardNodes(
	nodes: readonly Record<string, unknown>[],
	display?: DisplayOptions,
	startIndex = 0,
): string[] {
	const time = new TimeView(display?.timezone);
	const lines = [`合并转发（${nodes.length} 条，仅一层不递归）：`];
	const decoded = nodes.map((node) => decodeOneBotSegments(node.message ?? node.content));
	const senders = nodes.map((node, index) => {
		const sender = node.sender as { user_id?: number | string; nickname?: string; card?: string } | undefined;
		return {
			senderRef: sender?.user_id === undefined ? null : `u${sender.user_id}`,
			senderDisplayName:
				sender?.card?.trim() || sender?.nickname?.trim() || (typeof node.name === "string" ? node.name : "?"),
			segments: decoded[index]!.segments,
		};
	});
	const people = scenePeople(senders, "");
	lines.push(...people.lines(""));
	let previousIso: string | undefined;
	for (let index = 0; index < nodes.length; index++) {
		const iso = oneBotTime(nodes[index]!.time);
		const reply = decoded[index]!.replyTo;
		lines.push(
			`  nodeIndex=${startIndex + index} | ${iso ? time.line(iso, previousIso) : "time=unknown"} | ${quote(people.label(senders[index]!))}${reply ? ` | replyTo=${reply}` : ""}：${quote(renderSegments(decoded[index]!.segments, people.mention, display?.faceNames, null))}`,
		);
		if (iso) previousIso = iso;
	}
	return lines;
}

/** 合并转发展开失败的呈现（原样保留，不伪造内容）。 */
export function forwardUnavailableLine(resId: string): string {
	return `合并转发（resId=${resId}）展开失败：平台未返回内容；原样保留`;
}

function messageLines(
	fact: MessageFact,
	time: TimeView,
	previousIso: string | undefined,
	prefix: "新增" | "必要前文",
	label: string,
	mentionLabel: PersonLookup,
	display?: DisplayOptions,
	withdrawn = false,
): MessageLines {
	const replyNote = fact.replyTo ? ` | replyTo=${fact.replyTo}` : "";
	const meta = `${prefix}：${time.line(fact.time, previousIso)} | ${fact.ref} | ${quote(label)}${replyNote}${withdrawn ? " | 已撤回（保存原文）" : ""}`;
	const text = segmentText(fact.segments, mentionLabel, display?.faceNames);
	const lines = [meta];
	if (text !== "") lines.push(quote(text));
	lines.push(...contentSelectors(fact));
	const partial = fact.segments.some(
		(seg) => (seg.type === "json" || seg.type === "xml") && seg.data.length > CARD_PREVIEW_CHARS,
	);
	return { ref: fact.ref, sequence: fact.sequence, lines, isAnchor: false, isText: text !== "", text, partial };
}

function contentSelectors(fact: MessageFact): string[] {
	return fact.segments.flatMap((seg, segmentIndex) => {
		if (["text", "mention", "mention_all", "face", "unknown"].includes(seg.type)) return [];
		return [
			`content：observe scope="content" messageRef=${fact.ref} segmentIndex=${segmentIndex}${"mediaRef" in seg && seg.mediaRef ? ` mediaRef=${seg.mediaRef}` : ""}`,
		];
	});
}

function isWithdrawn(fact: MessageFact, journal: FactsJournal): boolean {
	return (journal.snapshot.events.get(fact.conversationRef) ?? []).some(
		(e) => e.kind === "recall" && e.messageRef === fact.ref,
	);
}

export function renderEventFact(fact: EventFact, journal?: FactsJournal, display?: DisplayOptions): string {
	const time = new TimeView(display?.timezone);
	const fields = [`${time.line(fact.time)} | ${fact.ref} | ${fact.kind}`, `source=${fact.source}`];
	if (fact.conversationRef) fields.push(`conversationRef=${fact.conversationRef}`);
	if (fact.actorRef) fields.push(`actor=${fact.actorRef}`);
	if (fact.authorRef) fields.push(`author=${fact.authorRef}`);
	if (fact.targetRef) fields.push(`target=${fact.targetRef}`);
	if (fact.messageRef) fields.push(`messageRef=${fact.messageRef}`);
	if (fact.action) fields.push(`action=${quote(fact.action)}`);
	if (fact.suffix) fields.push(`suffix=${quote(fact.suffix)}`);
	if (fact.summary) fields.push(`summary=${quote(fact.summary)}`);
	if (fact.reaction) {
		fields.push(`operation=${fact.reaction.operation ?? "unknown"}`);
		fields.push(
			`likes=${fact.reaction.likes.map((like) => `${like.code}${display?.faceNames?.get(like.code) ? `(${quote(display.faceNames.get(like.code)!)})` : ""}:count=${like.count ?? "unknown"}`).join(", ")}`,
		);
	}
	if (fact.kind === "recall") {
		fields.push("已撤回");
		const original = fact.messageRef && journal?.getMessage(fact.messageRef);
		if (original) fields.push(`保存原文=${quote(segmentText(original.segments, undefined, display?.faceNames))}`);
		else fields.push("原文未保存");
	}
	return fields.join(" | ");
}

export function renderRequestFact(fact: RequestFact, display?: DisplayOptions): string {
	const time = new TimeView(display?.timezone);
	return `${time.line(fact.time)} | ${fact.ref} | kind=${fact.kind} | state=${fact.state} | requester=${fact.requesterRef ?? "unknown"}${fact.requesterDisplayName ? ` name=${quote(fact.requesterDisplayName)}` : ""}${fact.targetConversationRef ? ` | targetConversationRef=${fact.targetConversationRef}` : ""}${fact.invitedRef ? ` | invited=${fact.invitedRef}` : ""} | comment=${fact.comment === null ? "null" : quote(fact.comment)}`;
}

/** 批次正文：首场景尾部起点 16；续场景新增 + reply anchor 必要前文；预算削减显式标注。 */
export function renderBatch(candidate: PendingCandidate, deps: BatchRenderDeps): string {
	if (candidate.conversationRef === "qq-follow-ups") return renderFollowUpBatch(deps);
	if (candidate.conversationRef === "qq-event-account") return renderAccountEventBatch(deps, candidate);
	if (candidate.conversationRef === "qq-request-account") return renderRequestBatch(deps, candidate);
	if (candidate.conversationRef === "qq-backlog") return renderBacklogBatch(deps);
	if (candidate.conversationRef === "qq-operations") return renderOperationsBatch(deps);

	const time = new TimeView(deps.display?.timezone);
	const snapshot = deps.journal.snapshot;
	const conv = candidate.conversationRef;
	const all = snapshot.messages.get(conv) ?? [];
	const through = snapshot.notifiedThrough.get(conv);

	// 窗口：首场景（从未通知）尾部起点 FIRST_SCENE_TAIL；续场景 = 新增 + reply anchor 前文。
	// 首场景超出起点时只呈现尾部，更早部分以显式省略行交付（§4.1"相应正文或明确
	// 省略说明已交给 canonical 输入"），冻结仍推进到最新序号，不重复投递。
	const firstScene = through === undefined;
	const unnotified = all.filter((m) => m.sequence > (through ?? 0));
	let omittedEarlier = firstScene ? Math.max(0, unnotified.length - FIRST_SCENE_TAIL) : 0;
	const fresh = omittedEarlier > 0 ? unnotified.slice(-FIRST_SCENE_TAIL) : unnotified;
	const anchorRefs = new Set(fresh.map((m) => m.replyTo).filter((ref): ref is string => ref !== undefined));
	const anchorFacts: MessageFact[] = [...anchorRefs]
		.map((ref: string) => all.find((m) => m.ref === ref))
		.filter((m): m is MessageFact => m !== undefined && !fresh.includes(m));
	const prefixMessages = anchorFacts;
	if (firstScene)
		omittedEarlier = Math.max(0, omittedEarlier - anchorFacts.filter((m) => unnotified.includes(m)).length);
	const missingAnchors = [...anchorRefs].filter((ref) => !all.some((m) => m.ref === ref));

	// 行组构建（预算削减的单位）。
	const people = scenePeople([...prefixMessages, ...fresh], deps.journal.selfId);
	const lines: string[] = [
		`[${conversationKindLabel(conv)}] snapshot=${time.header(deps.now())}`,
		`conversationRef=${conv}；trigger=${candidate.trigger ?? candidate.cls}`,
		...people.lines(conv),
		...candidateFacts(candidate, deps),
		...missingAnchors.map((ref) => `必要前文：replyTo=${ref}（原文不可用）`),
	];
	const prefixLineGroups = prefixMessages.map((m) => ({
		...messageLines(
			m,
			time,
			previousOf([...prefixMessages, ...fresh], m),
			"必要前文",
			people.label(m),
			people.mention,
			deps.display,
			isWithdrawn(m, deps.journal),
		),
		isAnchor: anchorRefs.has(m.ref),
	}));
	const freshLineGroups = fresh.map((m) =>
		messageLines(
			m,
			time,
			previousOf([...prefixMessages, ...fresh], m),
			"新增",
			people.label(m),
			people.mention,
			deps.display,
			isWithdrawn(m, deps.journal),
		),
	);

	const followUps = deps.control.listFollowUps({ targetRef: conv, state: "open" });
	const backgroundCount = countBackground(deps, candidate);
	const omittedNote =
		omittedEarlier > 0
			? `（更早 ${omittedEarlier} 条未呈现，可用 observe(scope="conversation", conversationRef="${conv}") 读取）`
			: null;

	const budget = deps.display?.batchBudgetChars ?? 14000;
	const assembled = assembleBatch(
		lines,
		prefixLineGroups,
		freshLineGroups,
		followUps,
		backgroundCount,
		Math.max(0, budget - 180),
		omittedNote,
	);

	let coverage: string;
	if (assembled.truncated || assembled.previewPartial) {
		let reason = assembled.truncated ? "因预算截断" : "卡片原文仅呈现预览";
		if (assembled.truncated && assembled.previewPartial) reason += "，且卡片原文仅呈现预览";
		const cardGuidance = assembled.previewPartial ? "卡片完整原文请按上方 content 入口读取；" : "";
		coverage = `coverage=${reason}：新增 ${fresh.length} 条中完整呈现 ${assembled.freshShown} 条，部分呈现 ${assembled.freshPartial} 条；hasMore=true（${cardGuidance}用 observe(scope="conversation", conversationRef="${conv}") 继续读取）。`;
	} else if (omittedNote) {
		coverage = `coverage=本次呈现尾部 ${fresh.length} 条，更早 ${omittedEarlier} 条已省略；hasMore=true（用 observe(scope="conversation", conversationRef="${conv}") 继续读取）。`;
	} else {
		coverage = `coverage=本次新增完整（${fresh.length} 条），前文为必要窗口；hasMore=false`;
	}
	return [...assembled.lines, coverage].join("\n");
}

function previousOf(all: readonly MessageFact[], fact: MessageFact): string | undefined {
	const index = all.indexOf(fact);
	return index > 0 ? all[index - 1]!.time : undefined;
}

function countBackground(deps: BatchRenderDeps, candidate: PendingCandidate): number {
	let total = 0;
	for (const conv of deps.journal.snapshot.messages.keys()) {
		if (conv !== candidate.conversationRef) total += deps.journal.unreadCount(conv);
	}
	return total;
}

interface AssembledBatch {
	readonly lines: string[];
	readonly truncated: boolean;
	readonly freshShown: number;
	readonly freshPartial: number;
	readonly previewPartial: boolean;
}

/** 组装 + 软预算：削减顺序 = 背景 → 前文（最旧非 anchor 优先）→ 超长原文分片。 */
function assembleBatch(
	header: string[],
	prefixGroups: MessageLines[],
	freshGroups: MessageLines[],
	followUps: { ref: string; note: string }[],
	backgroundCount: number,
	budget: number,
	omittedNote: string | null,
): AssembledBatch {
	let droppedBackground = false;
	let droppedPrefix = 0;
	const truncatedTexts = new Map<MessageLines, string>();
	const appendGroup = (out: string[], group: MessageLines): void => {
		const truncatedText = truncatedTexts.get(group);
		if (truncatedText !== undefined) out.push(group.lines[0]!, quote(truncatedText), ...group.lines.slice(2));
		else out.push(...group.lines);
	};

	const buildAll = (): string[] => {
		const out: string[] = [];
		if (prefixGroups.length - droppedPrefix > 0) {
			out.push(`必要前文：`);
			for (const group of prefixGroups.slice(droppedPrefix)) appendGroup(out, group);
		}
		out.push(`新增：`);
		for (const group of freshGroups) appendGroup(out, group);
		if (omittedNote) out.push(omittedNote);
		for (const item of followUps) out.push(`待跟进 ${item.ref}：note=${quote(item.note)}`);
		if (droppedBackground && backgroundCount > 0) out.push(`背景：${backgroundCount} 条普通事实已省略（可观察获取）。`);
		else if (backgroundCount > 0) out.push(`背景：另有 ${backgroundCount} 条普通事实待合并（可观察获取）。`);
		return out;
	};

	const totalSize = (): number => [...header, ...buildAll()].join("\n").length;
	droppedBackground = totalSize() > budget;
	// 前文按最旧优先丢弃，但 reply anchor（isAnchor）保留到最后一刻。
	while (totalSize() > budget && droppedPrefix < prefixGroups.length && !prefixGroups[droppedPrefix]!.isAnchor)
		droppedPrefix++;
	// 原文分片：每轮挑最长的未截断文本，按"超出量"精确截断，直到入预算或无可截。
	let truncated = false;
	while (totalSize() > budget) {
		let longestGroup: MessageLines | undefined;
		let longestLen = 0;
		[...prefixGroups.slice(droppedPrefix), ...freshGroups].forEach((group) => {
			if (truncatedTexts.has(group) || !group.isText) return;
			const len = quote(group.text).length;
			if (len > longestLen) {
				longestLen = len;
				longestGroup = group;
			}
		});
		if (!longestGroup) break;
		const text = longestGroup.text;
		const excess = totalSize() - budget;
		let keep = Math.max(0, text.length - excess - "[truncated]…".length - 8);
		while (keep > 0 && quote(text.slice(0, keep) + "…[truncated]").length > Math.max(0, longestLen - excess)) keep--;
		truncatedTexts.set(longestGroup, text.slice(0, keep) + "…[truncated]");
		truncated = true;
	}
	return {
		lines: [...header, ...buildAll()],
		truncated,
		freshShown: freshGroups.filter((group) => !group.partial && !truncatedTexts.has(group)).length,
		freshPartial: freshGroups.filter((group) => group.partial || truncatedTexts.has(group)).length,
		previewPartial: [...prefixGroups.slice(droppedPrefix), ...freshGroups].some((group) => group.partial),
	};
}

function renderFollowUpBatch(deps: BatchRenderDeps): string {
	const time = new TimeView(deps.display?.timezone);
	const due = deps.control.dueFollowUps();
	const lines = due.map(
		(item) =>
			`ref=${item.ref} | state=${item.state} | target=${item.targetRef} | note=${quote(item.note)} | reviewAt=${item.reviewAt ? time.header(item.reviewAt) : "null"} | evidenceRefs=[${item.evidenceRefs.join(", ")}]`,
	);
	return [
		`[QQ 待跟进] snapshot=${time.header(deps.now())}；source=主体保存的事项`,
		...lines,
		`不自动执行；仍 open 可随时主动查。`,
	].join("\n");
}

function candidateFacts(candidate: PendingCandidate, deps: BatchRenderDeps): string[] {
	const snapshot = deps.journal.snapshot;
	const events = [...snapshot.accountEvents, ...[...snapshot.events.values()].flat()];
	return [
		...(candidate.eventRefs ?? []).flatMap((ref) => {
			const event = events.find((e) => e.ref === ref);
			return event ? [renderEventFact(event, deps.journal, deps.display)] : [`eventRef=${ref}（事实不可用）`];
		}),
		...(candidate.requestRefs ?? []).flatMap((ref) => {
			const request = snapshot.requests.get(ref);
			return request ? [renderRequestFact(request, deps.display)] : [`requestRef=${ref}（事实不可用）`];
		}),
	];
}

function renderRequestBatch(deps: BatchRenderDeps, candidate: PendingCandidate): string {
	const time = new TimeView(deps.display?.timezone);
	return [`[QQ 申请] snapshot=${time.header(deps.now())}；source=平台申请`, ...candidateFacts(candidate, deps)].join(
		"\n",
	);
}

function renderAccountEventBatch(deps: BatchRenderDeps, candidate: PendingCandidate): string {
	const time = new TimeView(deps.display?.timezone);
	const lines = candidate.eventRefs?.length
		? candidateFacts(candidate, deps)
		: deps.journal.snapshot.accountEvents.slice(-5).map((e) => renderEventFact(e, deps.journal, deps.display));
	return [
		`[QQ 状态事件] snapshot=${time.header(deps.now())}；source=内部连接/账号状态`,
		...lines,
		`用 observe(scope="status") 核验当前事实。`,
	].join("\n");
}

/** 迟到回执更新批次（入站表：同 operation 更新，无新派发 | internal）。 */
function renderOperationsBatch(deps: BatchRenderDeps): string {
	const time = new TimeView(deps.display?.timezone);
	const records = deps.settledUnknowns ?? [];
	const lines = records.map((r) => operationRecordLines(r).join(" | "));
	return [
		`[QQ 操作回执更新] snapshot=${time.header(deps.now())}；source=迟到回执归并`,
		...(lines.length > 0 ? lines : ["无待呈现更新"]),
		`unknown 已升级为上述结论；查询不重执行，不自动重发。`,
	].join("\n");
}

/** 暂停结束积压摘要（合同 §4：一次摘要，允许事实优先；无逐条 replay，不新增主消息计账）。 */
function renderBacklogBatch(deps: BatchRenderDeps): string {
	const time = new TimeView(deps.display?.timezone);
	const lines: string[] = [];
	for (const conv of deps.journal.snapshot.messages.keys()) {
		const unread = deps.journal.unreadCount(conv);
		if (unread > 0) {
			const earliest = deps.journal.firstUnreadTime(conv);
			lines.push(`${conv}：${unread} 条未读${earliest ? `（最早 ${time.line(earliest)}）` : ""}`);
		}
	}
	return [
		`[QQ 暂停结束摘要] snapshot=${time.header(deps.now())}；source=控制状态；暂停已到期恢复原规则`,
		...(lines.length > 0 ? lines : ["无积压"]),
		`一次摘要不逐条补发；需要现场用 observe(scope="conversation") 读取。`,
	].join("\n");
}

/* ---------- cursor（observe 分页；ToolDef：原样复制且绑定过滤/窗口） ---------- */

/** FNV-1a 指纹：cursor 绑定查询条件，条件变化即失效。 */
export function fingerprintCursor(fields: Record<string, unknown>): string {
	const json = JSON.stringify(fields);
	let hash = 0x811c9dc5;
	for (let i = 0; i < json.length; i++) {
		hash ^= json.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function encodeCursor(payload: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(
	raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
	if (typeof raw !== "string" || raw === "") return { ok: false, error: "cursor 缺失或非字符串" };
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, error: "cursor 载荷非法" };
		}
		return { ok: true, value: parsed as Record<string, unknown> };
	} catch {
		return { ok: false, error: "cursor 不是合法编码" };
	}
}

/* ---------- 会话现场页（observe scope=conversation） ---------- */

export interface ConversationPageLine {
	readonly ref: string;
	readonly timeIso: string | null;
	readonly sender: string;
	readonly senderRef?: string | null;
	readonly senderDisplayName?: string | null;
	readonly direction?: "in" | "out";
	readonly text: string;
	readonly rawMessage?: unknown;
	readonly segments?: readonly MessageSegment[];
	readonly replyTo?: string;
}

export interface ConversationPageInput {
	readonly conversationRef: string;
	readonly selfId?: string;
	readonly direction: string;
	/** platform=在线历史；local=离线保存事实（标陈旧）。 */
	readonly source: "platform" | "local";
	readonly lines: readonly ConversationPageLine[];
	readonly events?: readonly (Omit<Partial<EventFact>, "kind"> & {
		ref: string;
		kind: string;
		timeIso?: string;
		time?: string;
	})[];
	readonly time: TimeView;
	readonly display?: DisplayOptions;
	readonly journal?: FactsJournal;
}

/** 会话现场：快照头 + 消息行 + 可选事件页 + coverage/hasMore。返回正文与末条引用（cursor 用）。 */
export function renderConversationPage(input: ConversationPageInput): { text: string; lastMessageRef: string | null } {
	const kindLabel = conversationKindLabel(input.conversationRef);
	const sourceNote = input.source === "local" ? "；source=离线保存事实（陈旧性未核验）" : "；source=平台快照";
	const people = scenePeople(input.lines, input.selfId ?? "");
	const head = [
		`[${kindLabel}现场] snapshot=${input.time.header(new Date().toISOString())}${sourceNote}`,
		`conversationRef=${input.conversationRef}；direction=${input.direction}`,
		...people.lines(input.conversationRef),
	];
	let previousIso: string | undefined;
	const body = input.lines.map((line) => {
		const time = line.timeIso ? input.time.line(line.timeIso, previousIso) : "?";
		if (line.timeIso) previousIso = line.timeIso;
		const decoded = line.rawMessage === undefined ? undefined : decodeOneBotSegments(line.rawMessage);
		const replyTo = line.replyTo ?? decoded?.replyTo;
		const reply = replyTo ? ` | replyTo=${replyTo}` : "";
		const segments = line.segments ?? decoded?.segments;
		const text = segments ? segmentText(segments, people.mention, input.display?.faceNames) : line.text;
		const content = text !== "" ? `\n${quote(text)}` : "";
		const label = line.senderRef || line.direction === "out" ? people.label(line) : line.sender;
		const withdrawn =
			input.events?.some((e) => e.kind === "recall" && e.messageRef === line.ref) ||
			(input.journal?.snapshot.events.get(input.conversationRef) ?? []).some(
				(e) => e.kind === "recall" && e.messageRef === line.ref,
			);
		const selectors = segments ? contentSelectors({ ref: line.ref, segments } as MessageFact).join("\n") : "";
		return `${time} | ${line.ref} | ${quote(label)}${reply}${withdrawn ? " | 已撤回（保存原文）" : ""}${content}${selectors ? `\n${selectors}` : ""}`;
	});
	const eventLines: string[] = [];
	if (input.events && input.events.length > 0) {
		eventLines.push(`recentEvents：`);
		for (const e of input.events) {
			const iso = e.time ?? e.timeIso;
			if (iso)
				eventLines.push(
					renderEventFact(
						{ ...e, time: iso, kind: e.kind as EventFact["kind"], source: e.source ?? "platform" },
						input.journal,
						{ ...input.display, timezone: input.time.timezone },
					),
				);
			else eventLines.push(`time=unknown | ${e.ref} | ${e.kind}${e.summary ? ` | ${quote(e.summary)}` : ""}`);
		}
	}
	const text = [
		...head,
		...(body.length > 0 ? body : ["（无记录）"]),
		...eventLines,
		`coverage=${input.source === "platform" ? "平台快照" : "本地事实窗口"} ${input.direction}；完整覆盖未知`,
	].join("\n");
	const lastMessageRef = input.lines.length > 0 ? input.lines[input.lines.length - 1]!.ref : null;
	return { text, lastMessageRef };
}

/* ---------- 工具回执正文（唯一 owner：三态头、集合行、指引与注记） ---------- */

/**
 * 三态回执头：唯一前缀格式（succeeded/failed/unknown + label）。
 * app.ts 备数据并包 worldSucceeded/Failed/Unknown（结构层），这里只产正文。
 */
function successLabel(label: string): string {
	const labels: Readonly<Record<string, string>> = {
		sent: "已发送",
		poke: "已戳一戳",
		retract: "已撤回",
		mark_read: "已标记已读",
		"attention.clear": "已清除关注覆盖",
		"attention.set": "已更新关注规则",
		"follow_up.create": "已保存待跟进事项",
		"follow_up.update": "已更新待跟进事项",
		"follow_up.close": "已关闭待跟进事项",
		"follow_up.cancel": "已取消待跟进事项",
		leave_group: "已退出群聊",
		remove_contact: "已移除联系人",
		set_profile: "已更新个人资料",
		set_avatar: "已更新头像",
		set_group_card: "已更新群名片",
		status: "QQ 状态",
		capabilities: "QQ 能力",
		attention: "关注规则",
		operations: "操作记录",
		overview: "QQ 概览",
		messages: "消息",
		self: "我的资料",
		requests: "申请",
		members: "群成员",
		contacts: "联系人",
		groups: "群聊",
		expressions: "表情目录",
		follow_ups: "待跟进事项",
	};
	if (label.startsWith("respond_request ")) return label.endsWith("accept") ? "已接受申请" : "已拒绝申请";
	if (label.startsWith("react set ")) return `已添加表情回应 ${label.slice(10)}`;
	if (label.startsWith("react unset ")) return `已移除表情回应 ${label.slice(12)}`;
	const key = /^[a-z_.]+/.exec(label)?.[0] ?? label;
	return labels[key] ? `${labels[key]}${label.slice(key.length)}` : label;
}

export const receipt = {
	ok: (label: string, lines: readonly string[]): string => [successLabel(label), ...lines].join("\n"),
	fail: (label: string, lines: readonly string[]): string => [`failed / ${label}`, ...lines].join("\n"),
	unknown: (label: string, lines: readonly string[]): string => [`unknown / ${label}`, ...lines].join("\n"),
};

/** 回执内的标准指引/注记文案（漂移高危集中地，禁止在 app.ts 重写）。 */
export const RECEIPT_NOTES = {
	nextStatusCheck: `若持续失败，先 observe(scope="status") 核验连接，再原样重试本查询`,
	verifyOperation: (operationRef: string): string =>
		`核验：observe(scope="operations", operationRef="${operationRef}")`,
	capabilitiesHead: `三维能力 supportedByAdapter / allowedByDeployment / availableNow`,
	capabilitiesCaveat: `探测不证明具体媒体格式或对端呈现；includeMedia=true 时 observe 抓取可靠图片附加 base64，音视频不转写。`,
	membersCaveat: `source=平台快照；完整覆盖/新鲜度未知`,
	membersEmpty: `本次未见匹配成员；覆盖未知不推出非成员`,
	listCaveat: `source=平台快照；完整覆盖未知`,
	expressionsGuidance: `speak face.faceId 与 gesture.react reactionCode 只接受此处数字编码；非数字（Unicode emoji 形态）不进 face/reaction，改用 text 发送。kind=reaction 与 face 同源数字编码；个别编码可用性由平台回执判断。`,
	unknownScope: (scope: string): string => `未知 observe scope: ${scope}`,
};

/** 成员行：nickname/card 显式并列，占位 role 不作真实身份。 */
export function membersLine(
	selfId: string,
	m: { user_id: number; nickname?: string; card?: string; role?: string },
): string {
	return `u${m.user_id}${String(m.user_id) === selfId ? " | 我" : ""} | nickname=${quote(m.nickname ?? "")} | card=${quote(m.card ?? "")} | role=${quote(m.role ?? "member（占位不作真实身份）")}`;
}

/** 能力行：三维一排，冒号后同排 k=v。 */
export function capabilityLine(
	type: string,
	d: { supportedByAdapter: boolean | null; allowedByDeployment: boolean; availableNow: boolean | null },
): string {
	return `${type}: supportedByAdapter=${d.supportedByAdapter} allowedByDeployment=${d.allowedByDeployment} availableNow=${d.availableNow}`;
}

/** 操作列表行。 */
export function operationRow(r: Pick<OperationRecord, "ref" | "action" | "outcome" | "reason">): string {
	return `${r.ref} | ${r.action} | ${r.outcome}${r.reason ? ` | ${quote(r.reason)}` : ""}`;
}

/** 单条操作记录正文（按行拆分，ref 独占首行）。 */
export function operationRecordLines(
	r: Pick<
		OperationRecord,
		| "ref"
		| "action"
		| "target"
		| "outcome"
		| "reason"
		| "settledAt"
		| "messageRef"
		| "replyTo"
		| "partRange"
		| "requestDecision"
	>,
): string[] {
	return [
		`ref=${r.ref}`,
		`action=${r.action} target=${r.target ?? "-"}`,
		`outcome=${r.outcome}${r.reason ? ` reason=${quote(r.reason)}` : ""}${r.settledAt ? ` settledAt=${r.settledAt}` : ""}`,
		...(r.messageRef ? [`messageRef=${r.messageRef}`] : []),
		...(r.replyTo ? [`replyTo=${r.replyTo}`] : []),
		...(r.partRange ? [`partRange=${r.partRange.from}..${r.partRange.through}`] : []),
		...(r.requestDecision ? [`requestDecision=${r.requestDecision}`] : []),
	];
}

/** 申请行：时间保持原始 UTC（无快照头的回执：程序 UTC 不变）。 */
export function requestRow(r: RequestFact): string {
	return `${r.ref} | kind=${r.kind} | state=${r.state} | requester=${r.requesterRef ?? "?"}${r.requesterDisplayName ? ` name=${quote(r.requesterDisplayName)}` : ""}${r.targetConversationRef ? ` | targetConversationRef=${r.targetConversationRef}` : ""}${r.invitedRef ? ` | invited=${r.invitedRef}` : ""} | comment=${quote(r.comment ?? "")} | ${r.time}`;
}

/** 事项行。 */
export function followUpRow(item: Pick<FollowUpItem, "ref" | "state" | "targetRef" | "note" | "reviewAt">): string {
	return `${item.ref} | state=${item.state} | target=${item.targetRef} | note=${quote(item.note)} | reviewAt=${item.reviewAt ?? "null"}`;
}

/** 表情目录行。 */
export function expressionLine(face: {
	q_sid?: unknown;
	q_des?: unknown;
	emoji_name_alias?: unknown;
	is_super?: unknown;
}): string {
	const aliases = Array.isArray(face.emoji_name_alias)
		? face.emoji_name_alias.filter((a): a is string => typeof a === "string")
		: [];
	return `id=${face.q_sid} | ${quote(String(face.q_des ?? ""))}${aliases.length ? ` | 别名=${quote(aliases.join("/"))}` : ""}${face.is_super === true ? " | super" : ""}`;
}

/** messages 点查行：时间保持原始 UTC（无快照头）。 */
export function messageRow(fact: MessageFact): string {
	return [
		`${fact.ref} | ${fact.time} | ${senderLabel(fact)}${fact.replyTo ? ` | replyTo=${fact.replyTo}` : ""} | ${quote(segmentText(fact.segments))}`,
		...contentSelectors(fact),
	].join("\n");
}

/** messages 查询：保持原始顺序，以连续会话块呈现；每块拥有自己的完整人物映射。 */
export function renderMessageFacts(
	facts: readonly MessageFact[],
	selfId: string,
	display?: DisplayOptions,
	journal?: FactsJournal,
): string[] {
	const time = new TimeView(display?.timezone);
	const lines: string[] = [];
	for (let start = 0; start < facts.length; ) {
		const conv = facts[start]!.conversationRef;
		let end = start + 1;
		while (end < facts.length && facts[end]!.conversationRef === conv) end++;
		const block = facts.slice(start, end);
		const people = scenePeople(block, selfId);
		lines.push(
			`[${conversationKindLabel(conv)}] conversationRef=${conv}；时间=${time.header(block[0]!.time)}`,
			...people.lines(conv),
		);
		let previousIso: string | undefined;
		for (const fact of block) {
			const reply = fact.replyTo ? ` | replyTo=${fact.replyTo}` : "";
			lines.push(
				`${time.line(fact.time, previousIso)} | ${fact.ref} | ${quote(people.label(fact))}${reply}${journal && isWithdrawn(fact, journal) ? " | 已撤回（保存原文）" : ""}`,
			);
			const text = segmentText(fact.segments, people.mention, display?.faceNames);
			if (text) lines.push(quote(text));
			lines.push(...contentSelectors(fact));
			previousIso = fact.time;
		}
		start = end;
	}
	return lines;
}
