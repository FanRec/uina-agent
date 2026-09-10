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
import { formatThinkingLines } from "./thinking-view.js";
import { sanitizeRenderText } from "../../format.js";
import { formatToolCardLines } from "./tool-view.js";
import { formatFullMarkdown } from "./stream-markdown.js";
import { formatDiffCardLines } from "./diff-view.js";
import { formatCompactionCardLines, type CompactionRecord } from "./compact-view.js";
import { SmoothRevealController } from "./smooth-reveal.js";
import { CustomMessageComponent } from "./custom-message.js";
import { CustomEntryComponent } from "./custom-entry.js";
import type { CustomMessage, CustomEntry, MessageRenderer, EntryRenderer } from "../../extensions/types.js";

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
	| { kind: "thinking"; text: string; collapsed?: boolean }
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			name: string;
			args?: unknown;
			result?: string;
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

export interface TurnRecord {
	n: number;
	userText: string;
	items: TurnItem[];
	thinkingCollapsed?: boolean;
	readonly assistantMarkdown: string;
	readonly thinkingText?: string;
	readonly tools: ToolRecord[];
	readonly diffs?: DiffRecord[];
}

export function createTurnRecord(n: number, userText = ""): TurnRecord {
	const items: TurnItem[] = [];
	return {
		n,
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
	turnStartMap: Map<number, number>;
	thinkingLocations: ThinkingLineLocation[];
	toolLocations: ToolLineLocation[];
	compactionLocations: CompactionLineLocation[];
	turnRanges: Map<number, { start: number; end: number }>;
}

export class TranscriptContainer implements Component {
	readonly smoothReveal = new SmoothRevealController();
	private readonly timeline: TimelineItem[] = [];
	private readonly historyTurns: TurnRecord[] = [];
	private currentTurn: TurnRecord | null = null;
	private thinkingCommitted = false;
	private hoveredThinkingTurnN: number | null = null;
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
	invalidateTurn(turnN: number): void {
		if (!this.settledBlocks) return; // a full build will pick the change up
		this.settledBlocks.staleTurns.add(turnN);
		this.hoveredBlockCache.clear();
	}

	/** Rebuild only one compaction card. */
	invalidateCompaction(index: number): void {
		if (!this.settledBlocks) return;
		this.settledBlocks.staleCompactions.add(index);
	}

	setHoveredThinkingTurn(turnN: number | null): boolean {
		if (this.hoveredThinkingTurnN !== turnN) {
			this.hoveredThinkingTurnN = turnN;
			// Hover is applied at assembly time, so only the per-turn hover cache
			// is dropped; settled blocks stay valid.
			this.hoveredBlockCache.clear();
			return true;
		}
		return false;
	}

	getHoveredThinkingTurn(): number | null {
		return this.hoveredThinkingTurnN;
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
			const beforeCount = formatToolCardLines(targetItem.name, targetItem.result ?? "", targetItem.elapsedMs ?? 0, width, targetItem.status, targetItem.args, {
				isExpanded: wasExpanded,
				startedAt: targetItem.startedAt,
			}).length;

			targetItem.collapsed = wasExpanded;
			if (wasExpanded) {
				this.expandedToolIds.delete(callId);
			} else {
				this.expandedToolIds.add(callId);
			}
			if (ownerTurn) this.invalidateTurn(ownerTurn.n);
			else this.invalidate();

			const afterCount = formatToolCardLines(targetItem.name, targetItem.result ?? "", targetItem.elapsedMs ?? 0, width, targetItem.status, targetItem.args, {
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

	private messageRenderer: (type: string) => MessageRenderer | undefined = () => undefined;
	private entryRenderer: (type: string) => EntryRenderer | undefined = () => undefined;

	setMessageRenderer(type: string, renderer: MessageRenderer): void {
		const previous = this.messageRenderer;
		this.messageRenderer = (candidate) => candidate === type ? renderer : previous(candidate);
		this.invalidate();
	}

	setEntryRenderer(type: string, renderer: EntryRenderer): void {
		const previous = this.entryRenderer;
		this.entryRenderer = (candidate) => candidate === type ? renderer : previous(candidate);
		this.invalidate();
	}

	setRendererResolver(resolve: { message(type: string): MessageRenderer | undefined; entry(type: string): EntryRenderer | undefined }): void {
		this.messageRenderer = resolve.message;
		this.entryRenderer = resolve.entry;
		this.invalidate();
	}

	startTurn(n: number, userText: string): void {
		if (this.currentTurn) {
			this.commitCurrentTurn();
		}
		this.currentTurn = createTurnRecord(n, userText);
		this.thinkingCommitted = false;
	}

	appendToken(token: string): void {
		if (!this.currentTurn) return;
		const last = this.currentTurn.items.at(-1);
		if (last && last.kind === "text") {
			last.text += token;
			this.smoothReveal.feed(`turn-${this.currentTurn.n}-text`, last.text);
		} else {
			this.currentTurn.items.push({ kind: "text", text: token });
			this.smoothReveal.feed(`turn-${this.currentTurn.n}-text`, token);
		}
	}

	appendThinking(text: string): void {
		if (!this.currentTurn) return;
		const last = this.currentTurn.items.at(-1);
		if (last && last.kind === "thinking") {
			last.text += text;
		} else {
			this.currentTurn.items.push({ kind: "thinking", text });
		}
	}

	commitThinking(): void {
		this.thinkingCommitted = true;
	}

	isThinkingCommitted(): boolean {
		return this.thinkingCommitted;
	}

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

	addToolDone(name: string, result: string, elapsedMs = 0, status: ToolResultStatus = "unknown", callId?: string, args?: unknown): void {
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
				elapsedMs,
				status: status,
				callId,
			});
		}
		this.invalidate();
	}

	addDiff(oldText: string, newText: string, filename: string, collapsed = true): void {
		if (!this.currentTurn) {
			this.startTurn(this.historyTurns.length + 1, "");
		}
		this.currentTurn?.items.push({ oldText, newText, filename, collapsed, kind: "diff" });
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
			return createTurnRecord(turnN, userText);
		};

		for (const entry of entries) {
			if ((entry as any).kind === "event") continue;
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
			} else if (msg.role === "assistant") {
				current ??= createTurn();
				if (msg.thinking) {
					current.items.push({ kind: "thinking", text: msg.thinking });
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

	toggleThinking(targetOrN?: number | TurnRecord, width = 80): { toggled: boolean; lineDelta: number } {
		const target =
			targetOrN !== undefined && typeof targetOrN === "object"
				? targetOrN
				: targetOrN !== undefined
					? this.historyTurns.find((t) => t.n === targetOrN) || (this.currentTurn?.n === targetOrN ? this.currentTurn : null)
					: (this.currentTurn?.thinkingText ? this.currentTurn : this.historyTurns.slice().reverse().find((t) => t.thinkingText));

		if (target && target.thinkingText) {
			const wasCollapsed = target.thinkingCollapsed ?? true;
			const beforeCount = formatThinkingLines(target.thinkingText, wasCollapsed, width).length;
			target.thinkingCollapsed = !wasCollapsed;
			for (const it of target.items) {
				if (it.kind === "thinking") {
					it.collapsed = !wasCollapsed;
				}
			}
			this.invalidateTurn(target.n);
			const afterCount = formatThinkingLines(target.thinkingText, !wasCollapsed, width).length;
			return { toggled: true, lineDelta: afterCount - beforeCount };
		}
		return { toggled: false, lineDelta: 0 };
	}

	toggleAllThinking(collapsed?: boolean): void {
		const all = [...this.historyTurns];
		if (this.currentTurn) all.push(this.currentTurn);
		const anyExpanded = all.some((t) => t.thinkingText && t.thinkingCollapsed === false);
		const targetState = collapsed ?? anyExpanded;
		for (const t of all) {
			if (t.thinkingText) {
				t.thinkingCollapsed = targetState;
				for (const it of t.items) {
					if (it.kind === "thinking") {
						it.collapsed = targetState;
					}
				}
			}
		}
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
			this.smoothReveal.snapToLatest(`turn-${this.currentTurn.n}-text`);
			this.historyTurns.push(this.currentTurn);
			this.timeline.push({ kind: "turn", turn: this.currentTurn });
			this.currentTurn = null;
			this.invalidate();
		}
	}

	private formatUserLine(text: string, width: number): string[] {
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

	private formatAssistantMarkdown(md: string, width: number, isFirstParagraph = true): string[] {
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
				if (block.kind === "turn" && cache.staleTurns.has(block.turn.n)) {
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

		if (turn.userText) out.push(...this.formatUserLine(turn.userText, width));

		let hasRenderedText = false;
		for (const item of turn.items) {
			if (item.kind === "thinking") {
				const isHovered = hover && this.hoveredThinkingTurnN === turn.n;
				const collapsed = item.collapsed ?? turn.thinkingCollapsed ?? true;
				const lines = formatThinkingLines(item.text, collapsed, width, isHovered);
				sink.thinking.push({ turnN: turn.n, lineIndex: out.length, lineCount: lines.length, turn });
				out.push(...lines);
			} else if (item.kind === "text") {
				const textToRender = isCurrent
					? this.smoothReveal.getRevealedText(`turn-${turn.n}-text`, item.text, true)
					: item.text;
				out.push(...this.formatAssistantMarkdown(textToRender, width, !hasRenderedText));
				hasRenderedText = true;
			} else if (item.kind === "tool") {
				const toolId = item.callId || `tool-${item.name}`;
				const isExpanded = item.collapsed === false || this.expandedToolIds.has(toolId);
				const isHovered = hover && this.hoveredToolId === toolId;
				const isNewestFailure = item === activeFailed;
				const lines = formatToolCardLines(item.name, item.result ?? "", item.elapsedMs ?? 0, width, item.status, item.args, {
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
		const hoveredThinkingHere = this.hoveredThinkingTurnN === base.turn.n;
		const hoveredToolHere = this.hoveredToolId !== null && base.tools.some((tool) => tool.callId === this.hoveredToolId);
		if (!hoveredThinkingHere && !hoveredToolHere) return base;
		const key = `${width}:${base.turn.n}:${this.hoveredToolId ?? ""}:${this.hoveredThinkingTurnN ?? ""}`;
		const cached = this.hoveredBlockCache.get(key);
		if (cached) return cached;
		const rebuilt = this.buildTurnBlock(base.turn, width, true, this.getLatestFailedTool());
		this.hoveredBlockCache.clear();
		this.hoveredBlockCache.set(key, rebuilt);
		return rebuilt;
	}

	private assemble(blocks: readonly SettledBlock[], width: number): LineModel {
		const lines: string[] = [];
		const turnStartMap = new Map<number, number>();
		const thinkingLocations: ThinkingLineLocation[] = [];
		const toolLocations: ToolLineLocation[] = [];
		const compactionLocations: CompactionLineLocation[] = [];
		const turnRanges = new Map<number, { start: number; end: number }>();

		for (const block of blocks) {
			const start = lines.length;
			if (block.kind === "turn") {
				const rendered = this.turnBlockFor(block, width);
				turnStartMap.set(block.turn.n, start);
				lines.push(...rendered.lines);
				for (const loc of rendered.thinking) thinkingLocations.push({ ...loc, lineIndex: start + loc.lineIndex });
				for (const loc of rendered.tools) toolLocations.push({ ...loc, lineIndex: start + loc.lineIndex });
				turnRanges.set(block.turn.n, { start, end: lines.length });
			} else if (block.kind === "compaction") {
				const cardLines = this.hoveredCompactionIndex === block.index ? formatCompactionCardLines(block.record, width, true) : block.lines;
				compactionLocations.push({ index: block.index, lineIndex: start, lineCount: cardLines.length, record: block.record });
				lines.push(...cardLines);
			} else {
				lines.push(...block.lines);
			}
		}
		return { lines, turnStartMap, thinkingLocations, toolLocations, compactionLocations, turnRanges };
	}

	/** The single line model consumed by render, scrolling and hit zones. */
	private ensureModel(width: number): LineModel {
		const model = this.assemble(this.buildSettledBlocks(width), width);
		if (this.currentTurn) {
			const start = model.lines.length;
			const sink: LayoutSink = { thinking: [], tools: [] };
			this.layoutTurn(this.currentTurn, width, model.lines, sink, { isCurrent: true, hover: true });
			model.turnStartMap.set(this.currentTurn.n, start);
			model.thinkingLocations.push(...sink.thinking);
			model.toolLocations.push(...sink.tools);
			model.turnRanges.set(this.currentTurn.n, { start, end: model.lines.length });
		}
		return model;
	}

	render(width: number): string[] {
		return this.ensureModel(width).lines.slice();
	}

	getTimelineTurns(): Array<{ n: number; userText: string }> {
		const result: Array<{ n: number; userText: string }> = [];
		for (const t of this.historyTurns) {
			result.push({ n: t.n, userText: t.userText });
		}
		if (this.currentTurn) {
			result.push({ n: this.currentTurn.n, userText: this.currentTurn.userText });
		}
		return result;
	}

	/**
	 * 获取每一轮次在转录完整行序列中的起始行号映射表
	 */
	getTurnStartLines(width: number): Map<number, number> {
		return new Map(this.ensureModel(width).turnStartMap);
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
