import type { FactsJournal } from "./facts-journal.js";
import type { ControlStore } from "./control-store.js";
import type { MessageFact, MessageSegment, OperationRecord, RequestFact, FollowUpItem, EventFact } from "./types.js";
import { parseConversationRef } from "./types.js";
import { decodeOneBotSegments, oneBotTime } from "./message-codec.js";
import type { PendingCandidate } from "./scheduler.js";
import { consumptionThrough, pendingCountOf, pendingFacts, pendingConversations } from "./consumption.js";
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
	return `[合并转发 resId=${resId}（browse contentTarget 展开）]`;
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
			`展开：${JSON.stringify({ action: "browse", params: { contentTarget: { messageRef: fact.ref, segmentIndex } } })}`,
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

/** Ordinary notifications carry facts and references; read/follow own body delivery. */
export function renderBatch(candidate: PendingCandidate, deps: BatchRenderDeps): string {
	const candidates = candidate.related ?? [candidate];
	const facts = candidates.flatMap((item) => {
		switch (item.conversationRef) {
			case "qq-follow-ups":
				return [renderFollowUpBatch(deps)];
			case "qq-event-account":
				return [renderAccountEventBatch(deps, item)];
			case "qq-request-account":
				return [renderRequestBatch(deps, item)];
			case "qq-backlog":
				return [renderBacklogBatch(deps)];
			case "qq-operations":
				return [renderOperationsBatch(deps)];
			default:
				return [
					`${conversationKindLabel(item.conversationRef)} conversationRef=${item.conversationRef}；trigger=${item.trigger ?? item.cls}`,
					...candidateFacts(item, deps),
					...(item.messageRefs ?? []).map((ref) => {
						const fact = deps.journal.getMessage(ref);
						return `触发 messageRef=${ref}${fact ? ` | sender=${fact.senderRef ?? "unknown"} | ${quote(segmentText(fact.segments, undefined, deps.display?.faceNames).slice(0, 60))}` : ""}`;
					}),
				];
		}
	});
	return [
		`[QQ 动态提示] snapshot=${new TimeView(deps.display?.timezone).header(deps.now())}`,
		...facts,
		...situationalOverview(deps),
	].join("\n");
}

function previousOf(all: readonly MessageFact[], fact: MessageFact): string | undefined {
	const index = all.indexOf(fact);
	return index > 0 ? all[index - 1]!.time : undefined;
}

/**
 * 全局待处理概览（设计 §5.2 一瞥态势）：所有有待处理消息的会话一行一条，
 * 待处理数以消费位（max(throughSeq, 基线)）为准。纸条让主体当场做出全局裁决，
 * 免去额外查询轮次。
 */
function situationalOverview(deps: BatchRenderDeps): string[] {
	const refs = pendingConversations(deps.journal, deps.control);
	if (refs.length === 0) return [];
	const budget = deps.display?.batchBudgetChars ?? 14000;
	const previewLimit = Math.max(0, Math.min(40, Math.floor(budget / refs.length) - 70));
	return [
		"当前待处理概览：",
		...refs.map((ref) => {
			const last = pendingFacts(deps.journal, deps.control, ref).at(-1)!;
			const preview = last.segments.find((segment) => segment.type === "text")?.text ?? "";
			return `• ${ref} ｜ 待处理 ${pendingCountOf(deps.journal, deps.control, ref)} 条${previewLimit > 0 ? ` ｜ ${quote(preview.slice(0, previewLimit))}` : ""}`;
		}),
		`正文按会话读取：${JSON.stringify({ action: "read", params: { conversationRef: refs[0] } })}；放下积压使用 skip。`,
	];
}

/* ---------- 顺序正文消费渲染（设计 §4.2 qq_read） ---------- */

/** 单条超长文本折叠阈值（设计 §4.2：>2,000 字折叠首尾，不阻塞书签推进）。 */
export const READ_FOLD_THRESHOLD = 2000;

export interface ReadWindowResult {
	readonly text: string;
	/** 本次完整交付到的会话序号（书签推进依据；无可读为当前消费位）。 */
	readonly deliveredThrough: number;
	readonly delivered: readonly MessageFact[];
	/** 本次消费后剩余待处理条数。 */
	readonly remaining: number;
}

/**
 * 顺序正文窗口（§4.2）：自消费位起按序取 limit 条，软预算内整条交付，
 * 超预算从"下一条"截断（已呈现才算交付——书签只推进到最后一条完整交付的消息）；
 * 单条超长文本折叠首尾并标注 hasMoreSegment（完整原文经 qq_browse contentTarget 展开），
 * 不阻塞书签推进。空窗口诚实返回，不伪造正文。
 */
export function renderReadWindow(
	conversationRef: string,
	deps: BatchRenderDeps,
	opts: { readonly limit: number; readonly budgetChars: number },
): ReadWindowResult {
	const time = new TimeView(deps.display?.timezone);
	const through = consumptionThrough(deps.journal, deps.control, conversationRef);
	const fresh = pendingFacts(deps.journal, deps.control, conversationRef);
	const remainingOf = (count: number): number => fresh.length - count;
	if (fresh.length === 0) {
		return {
			text: `[QQ 阅读] conversationRef=${conversationRef}\n（无未消费正文；consumedThrough=${through}）`,
			deliveredThrough: through,
			delivered: [],
			remaining: 0,
		};
	}
	const window = fresh.slice(0, opts.limit);
	const all = deps.journal.snapshot.messages.get(conversationRef) ?? [];
	const anchorRefs = [...new Set(window.flatMap((fact) => (fact.replyTo ? [fact.replyTo] : [])))].filter(
		(ref) => !window.some((fact) => fact.ref === ref),
	);
	const anchors = anchorRefs.flatMap((ref) => all.find((fact) => fact.ref === ref) ?? []);
	const people = scenePeople([...anchors, ...window], deps.journal.selfId);
	const anchorLines = anchorRefs.map((ref) => {
		const fact = anchors.find((item) => item.ref === ref);
		if (!fact) return `必要前文：replyTo=${ref}（原文不可用）`;
		const text = segmentText(fact.segments, people.mention, deps.display?.faceNames);
		const max = Math.min(200, Math.floor(opts.budgetChars / 8));
		return `必要前文：replyTo=${ref} | ${people.label(fact)}：${quote(text.slice(0, max))}${text.length > max ? ` [truncated]；${JSON.stringify({ action: "browse", params: { messageRefs: [ref] } })}` : ""}`;
	});
	const groups = window.map((m) =>
		messageLines(
			m,
			time,
			previousOf(window, m),
			"新增",
			people.label(m),
			people.mention,
			deps.display,
			isWithdrawn(m, deps.journal),
		),
	);
	// 超长折叠：> READ_FOLD_THRESHOLD 的文本保留首尾，中段显式省略（完整原文可点查展开）。
	const folded = new Map<MessageLines, string[]>();
	for (const group of groups) {
		if (group.text.length <= READ_FOLD_THRESHOLD) continue;
		const keep = Math.floor((READ_FOLD_THRESHOLD - 60) / 2);
		const foldedText = `${group.text.slice(0, keep)}\n…（中段折叠 ${group.text.length - keep * 2} 字）…\n${group.text.slice(-keep)}`;
		folded.set(group, [
			group.lines[0]!,
			quote(foldedText),
			`hasMoreSegment: true（${JSON.stringify({ action: "browse", params: { messageRefs: [group.ref] } })} 查看完整消息）`,
			...group.lines.slice(2),
		]);
	}
	const lineOf = (group: MessageLines): string[] => folded.get(group) ?? group.lines;
	const head = [
		`[QQ 阅读] conversationRef=${conversationRef}；snapshot=${time.header(deps.now())}`,
		...people.lines(conversationRef),
	];
	// 软预算：至少交付一条；单条自身超预算时硬截断文本并标注（该条仍算已交付）。
	const body = (): string[] => {
		const out = [...head, ...anchorLines, "新增："];
		for (const group of shown) out.push(...lineOf(group));
		return out;
	};
	let shown = groups;
	while (shown.length > 1 && body().join("\n").length > opts.budgetChars) shown = shown.slice(0, -1);
	if (shown.length === 1 && body().join("\n").length > opts.budgetChars) {
		const group = shown[0]!;
		const excess = body().join("\n").length - opts.budgetChars;
		const text = group.text;
		const keep = Math.max(0, text.length - excess - "[truncated]".length - 20);
		folded.set(group, [
			group.lines[0]!,
			quote(`${text.slice(0, keep)}…[truncated]`),
			`hasMoreSegment: true（${JSON.stringify({ action: "browse", params: { messageRefs: [group.ref] } })} 查看完整消息）`,
			...group.lines.slice(2),
		]);
	}
	const delivered = shown.map((group) => window[groups.indexOf(group)]!);
	const deliveredThrough = delivered.at(-1)!.sequence;
	const omitted = remainingOf(delivered.length);
	const note =
		omitted > 0
			? `（余下 ${omitted} 条未交付；调用 ${JSON.stringify({ action: "read", params: { conversationRef } })} 接续）`
			: null;
	const text = [
		...body(),
		...(note ? [note] : []),
		`coverage=顺序交付；完整呈现 ${shown.filter((group) => !group.partial && !folded.has(group)).length} 条，部分呈现 ${shown.filter((group) => group.partial || folded.has(group)).length} 条；hasMore=${omitted > 0 || shown.some((group) => group.partial || folded.has(group))}`,
		`deliveredThrough=${delivered.at(-1)!.ref}（seq ${deliveredThrough}）；本次交付 ${delivered.length} 条；剩余待处理 ${omitted} 条`,
	].join("\n");
	return { text, deliveredThrough, delivered, remaining: omitted };
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
		`连接与账号事实由 World 状态与 scripts/qq-status.mts（只读）核验。`,
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
	for (const conv of pendingConversations(deps.journal, deps.control)) {
		const unread = pendingCountOf(deps.journal, deps.control, conv);
		if (unread > 0) {
			const earliest = pendingFacts(deps.journal, deps.control, conv)[0]?.time;
			lines.push(`${conv}：${unread} 条未读${earliest ? `（最早 ${time.line(earliest)}）` : ""}`);
		}
	}
	return [
		`[QQ 暂停结束摘要] snapshot=${time.header(deps.now())}；source=控制状态；暂停已到期恢复原规则`,
		...(lines.length > 0 ? lines : ["无积压"]),
		`一次摘要不逐条补发；需要现场用 qq 工具 read/browse 读取。`,
	].join("\n");
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
		"follow_up.create": "已保存待跟进事项",
		"follow_up.close": "已关闭待跟进事项",
		"follow_up.cancel": "已取消待跟进事项",
		set_profile: "已更新个人资料",
		set_avatar: "已更新头像",
		set_group_card: "已更新群名片",
		self: "我的资料",
		requests: "申请",
		expressions: "表情目录",
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
	nextStatusCheck: `若持续失败，先核验连接与登录状态，再原样重试本查询`,
	verifyOperation: (operationRef: string): string => `核验：operationRef=${operationRef}；操作日志保留派发与回执全记录`,
	expressionsGuidance: `send 的 face 段与 interact 的 react 只接受此处数字编码；非数字（Unicode emoji 形态）不进 face/react，改用 text 发送。react 与 face 同源数字编码；个别编码可用性由平台回执判断。`,
};

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
