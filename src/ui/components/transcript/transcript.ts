import { imageNotice } from "../../../core/content.js";
/**
 * 会话转录区容器（TranscriptContainer）。
 * 集中管理用户轮次、思考流、助手 Markdown 回复、工具调用、差异比对、压缩卡片与扩展自定义消息。
 * 自身实现 Component 契约，支持动态根据可用列宽完整重流。
 */

import type { Component } from "../../core/types.js";
import { projectInputMessage } from "../../../session/recovery.js";
import type { ChatMsg, ToolResultStatus } from "../../../core/types.js";
import type { SessionEntry } from "../../../session/types.js";
import { C, wrapTextWithAnsi, stripAnsi } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import { formatToolCardLines } from "./tool-view.js";
import { formatFullMarkdown } from "./stream-markdown.js";
import { formatDiffCardLines } from "./diff-view.js";
import {
	formatThinkingLines,
	formatCompactionCardLines,
	type CompactionRecord,
	CustomMessageComponent,
	CustomEntryComponent,
} from "./cards.js";
import { SmoothRevealController } from "./smooth-reveal.js";
import type { CustomMessage, CustomEntry, MessageRenderer, EntryRenderer, ToolRenderer, MarkdownTransformer } from "../../../extensions/ui-contract.js";

export interface ToolRecord {
	name: string;
	result: string;
	elapsedMs: number;
}

export interface DiffRecord {
	oldText: string;
	newText: string;
	filename: string;
	collapsed?: boolean;
}

export type TurnItem =
	| {
			kind: "thinking";
			text: string;
			collapsed?: boolean;
			/** 块级身份。一个轮次可以有多个思考块（thinking → 工具 → thinking），
			 * 折叠状态与 hover 必须落在块上；落在轮次上会让整轮的思考一起亮、一起展开。 */
			uid: number;
	  }
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			name: string;
			args?: unknown;
			result?: string;
   images?: import("../../../core/content.js").ImageContent[];
   details?: unknown;
			status: "running" | ToolResultStatus;
			elapsedMs?: number;
			startedAt?: number;
			callId?: string;
			collapsed?: boolean;
	  }
	| {
			kind: "diff";
			oldText: string;
			newText: string;
			filename: string;
			collapsed?: boolean;
	  }
	| {
			kind: "interrupt";
			text: string;
	  };

/** 单个思考块。折叠与 hover 的身份单位。 */
export type ThinkingItem = Extract<TurnItem, { kind: "thinking" }>;

export interface TurnRecord {
	n: number;
	/** 由容器签发的唯一票据。n 来自「引擎 turnSeq」与「恢复期局部计数」两套互不
	 * 共享的计数器（loop.ts turnSeq 从不从会话播种），撞号是常态；因此凡是把轮次
	 * 当键的地方——hover、块缓存、失效集合、typewriter、滚动定位、导航轨——一律
	 * 用 uid，n 只作为显示用的轮次编号。 */
	readonly uid: number;
	userText: string;
 userImages?: readonly import("../../../core/content.js").ImageContent[];
	items: TurnItem[];
	readonly assistantMarkdown: string;
	readonly thinkingText?: string;
	readonly tools: ToolRecord[];
	readonly diffs?: DiffRecord[];
}

export function createTurnRecord(n: number, uid: number, userText = ""): TurnRecord {
	const items: TurnItem[] = [];
	return {
		n,
		uid,
		userText,
		items,
		get assistantMarkdown(): string {
			return items
				.filter((it): it is Extract<TurnItem, { kind: "text" }> => it.kind === "text")
				.map((it) => it.text)
				.join("");
		},
		get thinkingText(): string | undefined {
			const texts = items
				.filter((it): it is Extract<TurnItem, { kind: "thinking" }> => it.kind === "thinking")
				.map((it) => it.text);
			return texts.length > 0 ? texts.join("\n") : undefined;
		},
		get tools(): ToolRecord[] {
			return items
				.filter((it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool")
				.map((t) => ({ name: t.name, result: t.result ?? "", elapsedMs: t.elapsedMs ?? 0 }));
		},
		get diffs(): DiffRecord[] {
			return items
				.filter((it): it is Extract<TurnItem, { kind: "diff" }> => it.kind === "diff")
				.map((d) => ({ oldText: d.oldText, newText: d.newText, filename: d.filename, collapsed: d.collapsed }));
		},
	};
}

export interface ThinkingLineLocation {
	turnN: number;
	lineIndex: number;
	lineCount?: number;
	/** 精确指向该 thinking 所属的轮次，不能只依赖可能重复的 turnN。 */
	turn: TurnRecord;
	/** 该行属于哪个思考块。一个轮次可有多个思考块，热区与折叠都以它为身份。 */
	item: ThinkingItem;
}

export interface ToolLineLocation {
	callId: string;
	lineIndex: number;
	lineCount: number;
	name: string;
	isExpanded: boolean;
	turn: TurnRecord;
	item: Extract<TurnItem, { kind: "tool" }>;
}

export interface CompactionLineLocation {
	index: number;
	lineIndex: number;
	lineCount: number;
	record: CompactionRecord;
}

export type TimelineItem =
	| { kind: "turn"; turn: TurnRecord }
	| { kind: "notice"; text: string }
	| { kind: "compaction"; record: CompactionRecord }
	| { kind: "customMessage"; message: CustomMessage }
	| { kind: "customEntry"; entry: CustomEntry };

/** One settled turn rendered as a self-contained block. Location indices are
 * block-relative; the assembler rebases them onto the final line array. */
interface TurnBlock {
	kind: "turn";
	turn: TurnRecord;
	lines: string[];
	thinking: ThinkingLineLocation[];
	tools: ToolLineLocation[];
}

interface StaticBlock {
	kind: "static";
	lines: string[];
}

interface CompactionBlock {
	kind: "compaction";
	index: number;
	record: CompactionRecord;
	lines: string[];
}

type SettledBlock = TurnBlock | StaticBlock | CompactionBlock;

/** Layout output collected while one turn is rendered. */
interface LayoutSink {
	thinking: ThinkingLineLocation[];
	tools: ToolLineLocation[];
}

/** The single line model consumed by rendering, scrolling and mouse hit zones. */
interface LineModel {
	lines: string[];
	/** uid → 该轮次起始行号（相对转录区，不含 banner）。 */
	turnStartByUid: Map<number, number>;
	thinkingLocations: ThinkingLineLocation[];
	toolLocations: ToolLineLocation[];
	compactionLocations: CompactionLineLocation[];
	/** uid → 该轮次的行区间。当前无任何消费方，仅为与 uid 身份保持一致。 */
	turnRanges: Map<number, { start: number; end: number }>;
}

export class TranscriptContainer implements Component {
	readonly smoothReveal = new SmoothRevealController();
	private readonly timeline: TimelineItem[] = [];
	private readonly historyTurns: TurnRecord[] = [];
	private currentTurn: TurnRecord | null = null;
	/** uid 的唯一签发点（轮次与思考块共用）：只在本容器内递增，绝不重复。 */
	private uidSeq = 0;
	/** 被悬停的思考【块】uid。一个轮次可以有多个思考块，故不能存轮次身份。 */
	private hoveredThinkingUid: number | null = null;
	private hoveredToolId: string | null = null;
	private hoveredCompactionIndex: number | null = null;
	private readonly expandedToolIds = new Set<string>();
	/** Settled timeline blocks, keyed by width + expansion state only.
	 * Hover is applied per block at assembly time so a mouse move never
	 * invalidates every settled turn. */
	private settledBlocks: { width: number; blocks: SettledBlock[]; staleTurns: Set<number>; staleCompactions: Set<number> } | null = null;
	private hoveredBlockCache = new Map<string, TurnBlock>();

	invalidate(): void {
		this.settledBlocks = null;
		this.hoveredBlockCache.clear();
	}

	/** Rebuild only one settled turn's block; the rest of the cache stays valid. */
	invalidateTurn(turnUid: number): void {
		if (!this.settledBlocks) return; // a full build will pick the change up
		this.settledBlocks.staleTurns.add(turnUid);
		this.hoveredBlockCache.clear();
	}

	/** Rebuild only one compaction card. */
	invalidateCompaction(index: number): void {
		if (!this.settledBlocks) return;
		this.settledBlocks.staleCompactions.add(index);
	}

	/** @param thinkingUid 思考块的 uid（块级身份，一个轮次可有多个块）。 */
	setHoveredThinkingUid(thinkingUid: number | null): boolean {
		if (this.hoveredThinkingUid !== thinkingUid) {
			this.hoveredThinkingUid = thinkingUid;
			// Hover is applied at assembly time, so only the hover cache is
			// dropped; settled blocks stay valid.
			this.hoveredBlockCache.clear();
			return true;
		}
		return false;
	}

	getHoveredThinkingUid(): number | null {
		return this.hoveredThinkingUid;
	}

	setHoveredToolId(toolId: string | null): boolean {
		if (this.hoveredToolId !== toolId) {
			this.hoveredToolId = toolId;
			this.hoveredBlockCache.clear();
			return true;
		}
		return false;
	}

	getHoveredToolId(): string | null {
		return this.hoveredToolId;
	}

	setHoveredCompaction(index: number | null): boolean {
		if (this.hoveredCompactionIndex !== index) {
			this.hoveredCompactionIndex = index;
			return true;
		}
		return false;
	}

	getHoveredCompaction(): number | null {
		return this.hoveredCompactionIndex;
	}

	hasRunningTools(): boolean {
		if (this.currentTurn?.items.some((it) => it.kind === "tool" && it.status === "running")) {
			return true;
		}
		for (const t of this.historyTurns) {
			if (t.items.some((it) => it.kind === "tool" && it.status === "running")) {
				return true;
			}
		}
		return false;
	}

	getLatestFailedTool(): Extract<TurnItem, { kind: "tool" }> | null {
		if (this.currentTurn) {
			for (let i = this.currentTurn.items.length - 1; i >= 0; i--) {
				const it = this.currentTurn.items[i]!;
				if (it.kind === "tool" && it.status === "failed") return it;
			}
		}
		for (let t = this.historyTurns.length - 1; t >= 0; t--) {
			const turn = this.historyTurns[t]!;
			for (let i = turn.items.length - 1; i >= 0; i--) {
				const it = turn.items[i]!;
				if (it.kind === "tool" && it.status === "failed") return it;
			}
		}
		return null;
	}

	toggleTool(targetOrId?: string | Extract<TurnItem, { kind: "tool" }>, width = 80): { toggled: boolean; lineDelta: number } {
		const allTurns = [...this.historyTurns];
		if (this.currentTurn) allTurns.push(this.currentTurn);

		let targetItem: Extract<TurnItem, { kind: "tool" }> | undefined;
		let ownerTurn: TurnRecord | undefined;
		if (typeof targetOrId === "object") {
			targetItem = targetOrId;
			ownerTurn = allTurns.find((t) => t.items.includes(targetOrId));
		} else if (typeof targetOrId === "string") {
			for (const t of allTurns) {
				const found = t.items.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool" && (it.callId === targetOrId || it.name === targetOrId),
				);
				if (found) {
					targetItem = found;
					ownerTurn = t;
					break;
				}
			}
		} else {
			for (let i = allTurns.length - 1; i >= 0; i--) {
				const found = allTurns[i]!.items.slice().reverse().find(
					(it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool",
				);
				if (found) {
					targetItem = found;
					ownerTurn = allTurns[i];
					break;
				}
			}
		}

		if (targetItem) {
			const callId = targetItem.callId || `tool-${targetItem.name}`;
			const wasExpanded = targetItem.collapsed === false || this.expandedToolIds.has(callId);
			const beforeCount = this.renderTool(targetItem, width, {
				isExpanded: wasExpanded,
				startedAt: targetItem.startedAt,
			}).length;

			targetItem.collapsed = wasExpanded;
			if (wasExpanded) {
				this.expandedToolIds.delete(callId);
			} else {
				this.expandedToolIds.add(callId);
			}
			if (ownerTurn) this.invalidateTurn(ownerTurn.uid);
			else this.invalidate();

			const afterCount = this.renderTool(targetItem, width, {
				isExpanded: !wasExpanded,
				startedAt: targetItem.startedAt,
			}).length;

			return { toggled: true, lineDelta: afterCount - beforeCount };
		}

		return { toggled: false, lineDelta: 0 };
	}

	toggleAllTools(collapsed?: boolean): void {
		const allTurns = [...this.historyTurns];
		if (this.currentTurn) allTurns.push(this.currentTurn);

		const allToolItems: Array<Extract<TurnItem, { kind: "tool" }>> = [];
		for (const t of allTurns) {
			for (const it of t.items) {
				if (it.kind === "tool") allToolItems.push(it);
			}
		}

		if (allToolItems.length === 0) return;

		const anyExpanded = allToolItems.some(
			(it) => it.collapsed === false || (it.callId && this.expandedToolIds.has(it.callId)),
		);
		const targetExpanded = collapsed !== undefined ? !collapsed : !anyExpanded;

		for (const it of allToolItems) {
			it.collapsed = !targetExpanded;
			const id = it.callId || `tool-${it.name}`;
			if (targetExpanded) {
				this.expandedToolIds.add(id);
			} else {
				this.expandedToolIds.delete(id);
			}
		}
		this.invalidate();
	}

	private toolRenderer: (name: string) => ToolRenderer | undefined = () => undefined;
 private markdownTransformer: MarkdownTransformer = text => text;
 private renderTool(item: Extract<TurnItem, { kind: 'tool' }>, width: number, options: import('./tool-view.js').ToolCardRenderOptions): string[] {
  let failure: string | undefined;
  try {
   const component = this.toolRenderer(item.name)?.(structuredClone(item), { width, expanded: options.isExpanded ?? false, hovered: options.isHovered ?? false, elapsedMs: item.elapsedMs ?? 0 });
   if (component) return component.render(width);
  } catch (error) { failure = '[tool renderer ' + item.name + ': ' + String(error) + ']'; }
  const text = item.result ?? '';
  const lines = formatToolCardLines(item.name, text, item.elapsedMs ?? 0, width, item.status, item.args, options);
  if (item.images?.length) lines.push('  [图片 ' + item.images.map(image => image.mimeType).join(', ') + '；终端显示元数据]');
  if (failure) lines.push(failure);
  return lines;
 }
 private transformMarkdown(text: string, role: 'user' | 'assistant', width: number, streaming: boolean): string {
  try { return this.markdownTransformer(text, { role, width, streaming }); }
  catch (error) { return text + '\n[markdown renderer: ' + String(error) + ']'; }
 }
 private messageRenderer: (type: string) => MessageRenderer | undefined = () => undefined;
	private entryRenderer: (type: string) => EntryRenderer | undefined = () => undefined;

	setRendererResolver(resolve: { message(type: string): MessageRenderer | undefined; entry(type: string): EntryRenderer | undefined; tool?(name: string): ToolRenderer | undefined; markdown?: MarkdownTransformer }): void {
		this.messageRenderer = resolve.message;
		this.entryRenderer = resolve.entry;
  this.toolRenderer = resolve.tool ?? (() => undefined);
  this.markdownTransformer = resolve.markdown ?? (text => text);
		this.invalidate();
	}

	startTurn(n: number, userText: string, images?: readonly import("../../../core/content.js").ImageContent[]): void {
		if (this.currentTurn) {
			this.commitCurrentTurn();
		}
		this.currentTurn = createTurnRecord(n, ++this.uidSeq, userText);
  this.currentTurn.userImages = images;
	}

	appendToken(token: string): void {
		if (!this.currentTurn) return;
		const last = this.currentTurn.items.at(-1);
		if (last && last.kind === "text") {
			last.text += token;
			this.smoothReveal.feed(`turn-${this.currentTurn.uid}-text`, last.text);
		} else {
			this.currentTurn.items.push({ kind: "text", text: token });
			this.smoothReveal.feed(`turn-${this.currentTurn.uid}-text`, token);
		}
	}

	appendThinking(text: string): void {
		if (!this.currentTurn) return;
		const last = this.currentTurn.items.at(-1);
		if (last && last.kind === "thinking") {
			last.text += text;
		} else {
			this.currentTurn.items.push({ kind: "thinking", text, uid: ++this.uidSeq });
		}
	}

	commitThinking(): void {}

	startTool(name: string, args?: unknown, callId?: string): void {
		if (!this.currentTurn) {
			this.startTurn(this.historyTurns.length + 1, "");
		}
		this.currentTurn?.items.push({
			kind: "tool",
			name,
			args,
			status: "running",
			startedAt: Date.now(),
			callId,
		});
		this.invalidate();
	}

	addToolDone(name: string, result: string, elapsedMs = 0, status: ToolResultStatus = "unknown", callId?: string, args?: unknown, attachments?: { images?: import("../../../core/content.js").ImageContent[]; details?: unknown }): void {
		result = sanitizeRenderText(result);
		if (!this.currentTurn) {
			const lastTurn = this.historyTurns[this.historyTurns.length - 1];
			if (lastTurn) {
				const existingTool = lastTurn.items.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> =>
						it.kind === "tool" && (callId ? it.callId === callId : it.name === name),
				);
				if (existingTool) {
					// 该工具属于已结算/打断的上一轮，严禁开辟新轮次或生成重复工具卡
					Object.assign(existingTool, attachments);
     existingTool.status = status;
					existingTool.result = result;
					existingTool.elapsedMs = elapsedMs;
					this.invalidate();
					return;
				}
			}
			this.startTurn(this.historyTurns.length + 1, "");
		}
		if (!this.currentTurn) return;

		let runningTool: Extract<TurnItem, { kind: "tool" }> | undefined;
		if (callId) {
			runningTool = this.currentTurn.items.find(
				(it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool" && it.callId === callId,
			);
		}
		if (!runningTool) {
			runningTool = this.currentTurn.items
				.slice()
				.reverse()
				.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> =>
						it.kind === "tool" && it.status === "running" && it.name === name,
				);
		}

		if (runningTool) {
			Object.assign(runningTool, attachments);
   runningTool.status = status;
			runningTool.result = result;
			runningTool.elapsedMs = elapsedMs;
			if (args !== undefined && runningTool.args === undefined) {
				runningTool.args = args;
			}
		} else {
			this.currentTurn.items.push({
				kind: "tool",
				name,
				args,
				result,
    ...attachments,
				elapsedMs,
				status: status,
				callId,
			});
		}
		this.invalidate();
	}

	addCompaction(record: CompactionRecord): void {
		this.timeline.push({ kind: "compaction", record });
		this.invalidate();
	}

	addCustomMessage(msg: CustomMessage): void {
		if (msg.display === false) return;
		this.timeline.push({ kind: "customMessage", message: msg });
		this.invalidate();
	}

	addCustomEntry(entry: CustomEntry): void {
		this.timeline.push({ kind: "customEntry", entry });
		this.invalidate();
	}

	addNotice(text: string): void {
		const formatted = `  ${C.blue}ℹ ${text}${C.reset}`;
		this.timeline.push({ kind: "notice", text: formatted });
		this.invalidate();
	}

	addError(text: string): void {
		const formatted = `  ${C.red}✗ [错误] ${text}${C.reset}`;
		this.timeline.push({ kind: "notice", text: formatted });
		this.invalidate();
	}

	finishTurn(): void {
		this.commitCurrentTurn();
	}

	interruptTurn(modelName?: string): void {
		this.smoothReveal.snapToLatest();
		this.commitThinking();
		const name = modelName || "Uina";
		const notice = `已打断 · 接下来想让 ${name} 做什么？`;
		if (this.currentTurn) {
			if (this.currentTurn.items.some((it) => it.kind === "interrupt")) {
				return;
			}
			for (const item of this.currentTurn.items) {
				if (item.kind === "tool" && item.status === "running") {
					item.status = "unknown";
					item.result = "已请求中断，工具结果尚未确认";
				}
			}
			this.currentTurn.items.push({ kind: "interrupt", text: notice });
			this.finishTurn();
		} else {
			const lastTurn = this.historyTurns[this.historyTurns.length - 1];
			if (lastTurn && lastTurn.items.some((it) => it.kind === "interrupt")) {
				return;
			}
			this.timeline.push({ kind: "notice", text: `  \x1b[2m${notice}\x1b[0m` });
			this.invalidate();
		}
	}

	getCurrentTurn(): TurnRecord | null {
		return this.currentTurn;
	}

	getHistory(): readonly TurnRecord[] {
		return this.historyTurns;
	}

	loadHistory(history: readonly ChatMsg[]): void {
		this.loadSession(history.map((message) => ({ kind: "message", message })));
	}

	/** Restores the display projection from the same ordered entries used to
	 * build provider history. Operational events never become transcript rows. */
	loadSession(entries: readonly SessionEntry[]): void {
		let turnN = 0;
		let current: TurnRecord | null = null;
		let pendingToolCalls: Array<{ id: string; name: string; args?: unknown }> = [];
		const commit = (): void => {
			if (!current) return;
			this.historyTurns.push(current);
			this.timeline.push({ kind: "turn", turn: current });
			current = null;
		};
		const createTurn = (userText = ""): TurnRecord => {
			turnN++;
			return createTurnRecord(turnN, ++this.uidSeq, userText);
		};

		for (const entry of entries) {
			if ((entry as any).kind === "event") continue;
			if (entry.kind === "rewind") {
				commit();
				this.timeline.push({
					kind: "customMessage",
					message: {
						customType: "session-rewind",
						content: entry.notice + "\n[当前主线从此处继续]" + (entry.record.summary ? `\n[经验摘要] ${entry.record.summary}` : ""),
						details: { record: entry.record, effects: entry.effects },
					},
				});
				if (entry.record.compaction) {
					this.timeline.push({ kind: "compaction", record: { summary: entry.record.compaction.summary, turnsCount: turnN, tokensSaved: entry.record.compaction.tokensBefore, collapsed: true } });
				}
				continue;
			}
			if (entry.kind === "custom_message") {
				if (entry.display === false) continue;
				commit();
				this.timeline.push({
					kind: "customMessage",
					message: {
						customType: entry.customType,
						content: entry.content,
						...(entry.details === undefined ? {} : { details: entry.details }),
					},
				});
				continue;
			}
			if (entry.kind === "custom_entry") {
				commit();
				this.timeline.push({
					kind: "customEntry",
					entry: {
						customType: entry.customType,
						...(entry.data === undefined ? {} : { data: entry.data }),
					},
				});
				continue;
			}
			if (entry.kind === "compaction") {
				commit();
				this.timeline.push({
					kind: "compaction",
					record: {
						summary: entry.summary,
						turnsCount: turnN,
						tokensSaved: entry.tokensBefore,
						collapsed: true,
					},
				});
				continue;
			}

			const msg = entry.kind === "input" ? projectInputMessage(entry.input) : entry.kind === "message" ? entry.message : undefined;
			if (!msg) continue;
			if (msg.role === "user") {
				commit();
				pendingToolCalls = [];
				current = createTurn(msg.content);
    current.userImages = msg.images;
			} else if (msg.role === "assistant") {
				current ??= createTurn();
				if (msg.thinking) {
					current.items.push({ kind: "thinking", text: msg.thinking, uid: ++this.uidSeq });
				}
				if (msg.content) {
					if (msg.status === "aborted" && msg.content.includes("已打断")) {
						current.items.push({ kind: "interrupt", text: msg.content.trim() });
					} else {
						current.items.push({ kind: "text", text: msg.content });
					}
				}
				if (msg.tool_calls) {
					pendingToolCalls = msg.tool_calls.map((call) => ({
						id: call.id,
						name: call.name || "tool",
						args: call.args,
					}));
				}
			} else if (msg.role === "tool") {
				current ??= createTurn();
				const pending = pendingToolCalls.find((call) => call.id === msg.tool_call_id);
				const toolName = pending?.name ?? "tool";
				const toolArgs = pending?.args;
				let elapsedMs = 0;
				try {
					const parsed = JSON.parse(msg.content) as { elapsedMs?: unknown };
					if (typeof parsed?.elapsedMs === "number") elapsedMs = parsed.elapsedMs;
				} catch {
					// Plain-text tool results have no elapsed metadata.
				}
				current.items.push({
					kind: "tool",
					name: toolName,
					args: toolArgs,
					result: msg.content,
     images: msg.images,
     details: msg.details,
					elapsedMs,
					status: msg.status ?? "unknown",
					callId: msg.tool_call_id,
				});
			}
		}
		commit();
		this.invalidate();
	}

	clear(): void {
		this.timeline.length = 0;
		this.historyTurns.length = 0;
		this.currentTurn = null;
		this.invalidate();
	}

	/** 全量轮次（历史 + 当前）。 */
	private allTurns(): TurnRecord[] {
		const all = [...this.historyTurns];
		if (this.currentTurn) all.push(this.currentTurn);
		return all;
	}

	/**
	 * 解析目标思考块及其所属轮次。
	 * @param target 指定块时按对象浅查找（顺带校验它确实属于本容器）；省略则取最后一个思考块。
	 */
	private resolveThinking(target?: ThinkingItem): { turn: TurnRecord; item: ThinkingItem } | null {
		const all = this.allTurns();
		if (target) {
			for (const turn of all) {
				for (const item of turn.items) {
					if (item === target && item.kind === "thinking") return { turn, item };
				}
			}
			return null;
		}
		for (let i = all.length - 1; i >= 0; i--) {
			const turn = all[i]!;
			for (let j = turn.items.length - 1; j >= 0; j--) {
				const item = turn.items[j]!;
				if (item.kind === "thinking") return { turn, item };
			}
		}
		return null;
	}

	/**
	 * 折叠/展开【单个】思考块。
	 * @param target 目标块；省略时取最后一个思考块（Ctrl+O 语义）。
	 * 一个轮次可以有多个思考块，故这里绝不做轮次级批量切换——那会让整轮一起展开。
	 */
	toggleThinking(target?: ThinkingItem, width = 80): { toggled: boolean; lineDelta: number } {
		const resolved = this.resolveThinking(target);
		if (!resolved) return { toggled: false, lineDelta: 0 };
		const { turn, item } = resolved;
		const wasCollapsed = item.collapsed ?? true;
		const beforeCount = formatThinkingLines(item.text, wasCollapsed, width).length;
		item.collapsed = !wasCollapsed;
		this.invalidateTurn(turn.uid);
		const afterCount = formatThinkingLines(item.text, !wasCollapsed, width).length;
		return { toggled: true, lineDelta: afterCount - beforeCount };
	}

	/** 全展开/全折叠（alt+o）：唯一的轮次级批量入口，但逐块写入块状态。 */
	toggleAllThinking(collapsed?: boolean): void {
		const items = this.allTurns()
			.flatMap((turn) => turn.items)
			.filter((item): item is ThinkingItem => item.kind === "thinking");
		if (items.length === 0) return;
		const targetState = collapsed ?? items.some((item) => item.collapsed === false);
		for (const item of items) item.collapsed = targetState;
		this.invalidate();
	}

	toggleCompaction(index?: number): boolean {
		const compactions = this.timeline.filter(
			(it): it is Extract<TimelineItem, { kind: "compaction" }> => it.kind === "compaction",
		);
		if (compactions.length === 0) return false;
		const target = index !== undefined ? compactions[index] : compactions.at(-1);
		if (target) {
			target.record.collapsed = !target.record.collapsed;
			const targetIndex = index !== undefined ? index : compactions.length - 1;
			this.invalidateCompaction(targetIndex);
			return true;
		}
		return false;
	}

	private commitCurrentTurn(): void {
		if (this.currentTurn) {
			this.smoothReveal.snapToLatest(`turn-${this.currentTurn.uid}-text`);
			this.historyTurns.push(this.currentTurn);
			this.timeline.push({ kind: "turn", turn: this.currentTurn });
			this.currentTurn = null;
			this.invalidate();
		}
	}

	private formatUserLine(text: string, width: number): string[] {
  text = this.transformMarkdown(text, "user", width, false);
		const lines: string[] = [""];
		const prefix = `${C.bold}${C.briefLabelYou}❯ ${C.reset}`;
		const leadW = 2; // "❯ " 占 2 列
		const contentBudget = Math.max(10, width - leadW - 2);
		const wrapped = wrapTextWithAnsi(text, contentBudget);
		if (wrapped.length === 0) {
			lines.push(`${prefix}`);
		} else {
			lines.push(`${prefix}${C.bold}${C.briefLabelYou}${wrapped[0]}${C.reset}`);
			const indent = "  ";
			for (let i = 1; i < wrapped.length; i++) {
				lines.push(`${indent}${C.bold}${C.briefLabelYou}${wrapped[i]}${C.reset}`);
			}
		}
		lines.push("");
		return lines;
	}

	private formatAssistantMarkdown(md: string, width: number, isFirstParagraph = true, streaming = false): string[] {
  md = this.transformMarkdown(md, "assistant", width, streaming);
		md = sanitizeRenderText(md);
		if (!md) return [];
		const contentBudget = Math.max(20, width - 2);
		const rawLines = formatFullMarkdown(md, contentBudget);
		const formatted: string[] = [];
		let isFirst = isFirstParagraph;

		for (const rawLine of rawLines) {
			if (!rawLine.trim()) {
				formatted.push("");
				continue;
			}

			// 剥离 ANSI 转义码后再判断是否为代码块或制表符边框
			const clean = stripAnsi(rawLine).trimStart();
			if (
				clean.startsWith("┌") || clean.startsWith("│") || clean.startsWith("└") ||
				clean.startsWith("├") || clean.startsWith("┼") || clean.startsWith("┴") || clean.startsWith("┬")
			) {
				formatted.push(rawLine.trimStart());
				continue;
			}

			// 对段落行进行严格 word-wrap
			const wrapped = wrapTextWithAnsi(rawLine.trim(), contentBudget);
			for (let i = 0; i < wrapped.length; i++) {
				const piece = wrapped[i]!;
				if (isFirst && i === 0) {
					formatted.push(`${C.bold}${C.text}● ${C.reset}${piece}`);
					isFirst = false;
				} else {
					formatted.push(piece);
				}
			}
		}
		formatted.push("");
		return formatted;
	}

	private buildSettledBlocks(width: number): SettledBlock[] {
		const cache = this.settledBlocks;
		if (cache && cache.width === width) {
			if (cache.staleTurns.size === 0 && cache.staleCompactions.size === 0) return cache.blocks;
			// Incremental: only the stale turn/compaction blocks are re-rendered.
			const latestFailed = this.getLatestFailedTool();
			cache.blocks = cache.blocks.map((block) => {
				if (block.kind === "turn" && cache.staleTurns.has(block.turn.uid)) {
					return this.buildTurnBlock(block.turn, width, false, latestFailed);
				}
				if (block.kind === "compaction" && cache.staleCompactions.has(block.index)) {
					return { ...block, lines: formatCompactionCardLines(block.record, width, false) };
				}
				return block;
			});
			cache.staleTurns.clear();
			cache.staleCompactions.clear();
			this.hoveredBlockCache.clear();
			return cache.blocks;
		}
		const blocks: SettledBlock[] = [];
		const latestFailed = this.getLatestFailedTool();
		let compactionIndex = 0;
		for (const item of this.timeline) {
			switch (item.kind) {
				case "notice":
					blocks.push({ kind: "static", lines: [item.text] });
					break;
				case "compaction": {
					blocks.push({
						kind: "compaction",
						index: compactionIndex,
						record: item.record,
						lines: formatCompactionCardLines(item.record, width, false),
					});
					compactionIndex++;
					break;
				}
				case "turn":
					blocks.push(this.buildTurnBlock(item.turn, width, false, latestFailed));
					break;
				case "customMessage": {
					const comp = new CustomMessageComponent(item.message, this.messageRenderer(item.message.customType));
					blocks.push({ kind: "static", lines: comp.render(width) });
					break;
				}
				case "customEntry": {
					const comp = new CustomEntryComponent(item.entry, this.entryRenderer(item.entry.customType));
					blocks.push({ kind: "static", lines: comp.render(width) });
					break;
				}
			}
		}
		this.settledBlocks = { width, blocks, staleTurns: new Set(), staleCompactions: new Set() };
		this.hoveredBlockCache.clear();
		return blocks;
	}

	/** Render one turn exactly once: lines and hit-zone metadata come from the
	 * same pass, so streaming and settled turns can never disagree. */
	private buildTurnBlock(turn: TurnRecord, width: number, hover: boolean, latestFailed: Extract<TurnItem, { kind: "tool" }> | null): TurnBlock {
		const lines: string[] = [];
		const sink: LayoutSink = { thinking: [], tools: [] };
		this.layoutTurn(turn, width, lines, sink, { hover, latestFailed });
		return { kind: "turn", turn, lines, thinking: sink.thinking, tools: sink.tools };
	}

	private layoutTurn(
		turn: TurnRecord,
		width: number,
		out: string[],
		sink: LayoutSink,
		opts: { isCurrent?: boolean; hover?: boolean; latestFailed?: Extract<TurnItem, { kind: "tool" }> | null } = {},
	): void {
		const isCurrent = opts.isCurrent ?? false;
		const hover = opts.hover ?? false;
		const activeFailed = opts.latestFailed !== undefined ? opts.latestFailed : this.getLatestFailedTool();

		if (turn.userText || turn.userImages?.length) out.push(...this.formatUserLine(turn.userText + imageNotice(turn.userImages), width));

		let hasRenderedText = false;
		for (const item of turn.items) {
			if (item.kind === "thinking") {
				const isHovered = hover && this.hoveredThinkingUid === item.uid;
				const collapsed = item.collapsed ?? true;
				const lines = formatThinkingLines(item.text, collapsed, width, isHovered);
				sink.thinking.push({ turnN: turn.n, lineIndex: out.length, lineCount: lines.length, turn, item });
				out.push(...lines);
			} else if (item.kind === "text") {
				const textToRender = isCurrent
					? this.smoothReveal.getRevealedText(`turn-${turn.uid}-text`, item.text, true)
					: item.text;
				out.push(...this.formatAssistantMarkdown(textToRender, width, !hasRenderedText, isCurrent));
				hasRenderedText = true;
			} else if (item.kind === "tool") {
				const toolId = item.callId || `tool-${item.name}`;
				const isExpanded = item.collapsed === false || this.expandedToolIds.has(toolId);
				const isHovered = hover && this.hoveredToolId === toolId;
				const isNewestFailure = item === activeFailed;
				const lines = this.renderTool(item, width, {
					isExpanded,
					isHovered,
					isNewestFailure,
					startedAt: item.startedAt,
				});
				sink.tools.push({ callId: toolId, lineIndex: out.length, lineCount: lines.length, name: item.name, isExpanded, turn, item });
				out.push(...lines);
			} else if (item.kind === "diff") {
				out.push(...formatDiffCardLines(item.oldText, item.newText, item.filename, item.collapsed ?? true, width));
			} else if (item.kind === "interrupt") {
				out.push(`  \x1b[2m${item.text}\x1b[0m`);
			}
		}
	}

	/** Hover on settled turns rebuilds only the affected block. */
	private turnBlockFor(base: TurnBlock, width: number): TurnBlock {
		const hoveredThinkingHere =
			this.hoveredThinkingUid !== null &&
			base.turn.items.some((it) => it.kind === "thinking" && it.uid === this.hoveredThinkingUid);
		const hoveredToolHere = this.hoveredToolId !== null && base.tools.some((tool) => tool.callId === this.hoveredToolId);
		if (!hoveredThinkingHere && !hoveredToolHere) return base;
		const key = `${width}:${base.turn.uid}:${this.hoveredToolId ?? ""}:${this.hoveredThinkingUid ?? ""}`;
		const cached = this.hoveredBlockCache.get(key);
		if (cached) return cached;
		const rebuilt = this.buildTurnBlock(base.turn, width, true, this.getLatestFailedTool());
		this.hoveredBlockCache.clear();
		this.hoveredBlockCache.set(key, rebuilt);
		return rebuilt;
	}

	private assemble(blocks: readonly SettledBlock[], width: number): LineModel {
		const lines: string[] = [];
		const turnStartByUid = new Map<number, number>();
		const thinkingLocations: ThinkingLineLocation[] = [];
		const toolLocations: ToolLineLocation[] = [];
		const compactionLocations: CompactionLineLocation[] = [];
		const turnRanges = new Map<number, { start: number; end: number }>();

		for (const block of blocks) {
			const start = lines.length;
			if (block.kind === "turn") {
				const rendered = this.turnBlockFor(block, width);
				turnStartByUid.set(block.turn.uid, start);
				lines.push(...rendered.lines);
				for (const loc of rendered.thinking) thinkingLocations.push({ ...loc, lineIndex: start + loc.lineIndex });
				for (const loc of rendered.tools) toolLocations.push({ ...loc, lineIndex: start + loc.lineIndex });
				turnRanges.set(block.turn.uid, { start, end: lines.length });
			} else if (block.kind === "compaction") {
				const cardLines = this.hoveredCompactionIndex === block.index ? formatCompactionCardLines(block.record, width, true) : block.lines;
				compactionLocations.push({ index: block.index, lineIndex: start, lineCount: cardLines.length, record: block.record });
				lines.push(...cardLines);
			} else {
				lines.push(...block.lines);
			}
		}
		return { lines, turnStartByUid, thinkingLocations, toolLocations, compactionLocations, turnRanges };
	}

	/** The single line model consumed by render, scrolling and hit zones. */
	private ensureModel(width: number): LineModel {
		const model = this.assemble(this.buildSettledBlocks(width), width);
		if (this.currentTurn) {
			const start = model.lines.length;
			const sink: LayoutSink = { thinking: [], tools: [] };
			this.layoutTurn(this.currentTurn, width, model.lines, sink, { isCurrent: true, hover: true });
			model.turnStartByUid.set(this.currentTurn.uid, start);
			model.thinkingLocations.push(...sink.thinking);
			model.toolLocations.push(...sink.tools);
			model.turnRanges.set(this.currentTurn.uid, { start, end: model.lines.length });
		}
		return model;
	}

	render(width: number): string[] {
		return this.ensureModel(width).lines.slice();
	}

	getTimelineTurns(): Array<{ uid: number; n: number; userText: string }> {
		const result: Array<{ uid: number; n: number; userText: string }> = [];
		for (const t of this.historyTurns) {
			result.push({ uid: t.uid, n: t.n, userText: t.userText });
		}
		if (this.currentTurn) {
			result.push({ uid: this.currentTurn.uid, n: this.currentTurn.n, userText: this.currentTurn.userText });
		}
		return result;
	}

	/**
	 * 获取每一轮次在转录完整行序列中的起始行号映射表。
	 *
	 * 键是轮次的 uid（身份），不是 n（可能撞号的显示编号）。用 n 当键会让
	 * 同号轮次互相覆盖，表里只剩最后一个，▲/▼ 导航会整轮丢失、刻度跳错轮次。
	 */
	getTurnStartLinesByUid(width: number): Map<number, number> {
		return new Map(this.ensureModel(width).turnStartByUid);
	}

	/**
	 * 获取所有思考折叠行在完整行序列中的索引位置
	 */
	getThinkingLineIndices(width: number): ThinkingLineLocation[] {
		return this.ensureModel(width).thinkingLocations.slice();
	}

	/**
	 * 获取所有工具卡片行在完整行序列中的索引位置与元数据
	 */
	getToolLineIndices(width: number): ToolLineLocation[] {
		return this.ensureModel(width).toolLocations.slice();
	}

	/**
	 * 获取所有会话压缩卡片行在完整行序列中的索引位置与元数据
	 */
	getCompactionLineIndices(width: number): CompactionLineLocation[] {
		return this.ensureModel(width).compactionLocations.slice();
	}
}
