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

interface SettledCache {
	width: number;
	hoveredThinkingTurnN: number | null;
	hoveredToolId: string | null;
	hoveredCompactionIndex: number | null;
	expandedToolIdsKey: string;
	lines: string[];
	turnStartMap: Map<number, number>;
	thinkingLocations: ThinkingLineLocation[];
	toolLocations: ToolLineLocation[];
	compactionLocations: CompactionLineLocation[];
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
	private settledCache: SettledCache | null = null;

	invalidate(): void {
		this.settledCache = null;
	}

	setHoveredThinkingTurn(turnN: number | null): boolean {
		if (this.hoveredThinkingTurnN !== turnN) {
			this.hoveredThinkingTurnN = turnN;
			this.invalidate();
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
			this.invalidate();
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
			this.invalidate();
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
		if (typeof targetOrId === "object") {
			targetItem = targetOrId;
		} else if (typeof targetOrId === "string") {
			for (const t of allTurns) {
				const found = t.items.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool" && (it.callId === targetOrId || it.name === targetOrId),
				);
				if (found) {
					targetItem = found;
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
			this.invalidate();

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
			this.invalidate();
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
			this.invalidate();
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

	private getSettledCache(width: number): SettledCache {
		const expandedKey = Array.from(this.expandedToolIds).sort().join(",");
		if (
			this.settledCache &&
			this.settledCache.width === width &&
			this.settledCache.hoveredThinkingTurnN === this.hoveredThinkingTurnN &&
			this.settledCache.hoveredToolId === this.hoveredToolId &&
			this.settledCache.hoveredCompactionIndex === this.hoveredCompactionIndex &&
			this.settledCache.expandedToolIdsKey === expandedKey
		) {
			return this.settledCache;
		}

		const lines: string[] = [];
		const turnStartMap = new Map<number, number>();
		const thinkingLocations: ThinkingLineLocation[] = [];
		const toolLocations: ToolLineLocation[] = [];
		const compactionLocations: CompactionLineLocation[] = [];
		const latestFailed = this.getLatestFailedTool();

		let compactionIndex = 0;
		for (const item of this.timeline) {
			switch (item.kind) {
				case "notice":
					lines.push(item.text);
					break;
				case "compaction": {
					const isHovered = this.hoveredCompactionIndex === compactionIndex;
					const cardLines = formatCompactionCardLines(item.record, width, isHovered);
					compactionLocations.push({
						index: compactionIndex,
						lineIndex: lines.length,
						lineCount: cardLines.length,
						record: item.record,
					});
					lines.push(...cardLines);
					compactionIndex++;
					break;
				}
				case "turn": {
					turnStartMap.set(item.turn.n, lines.length);
					const turn = item.turn;
					const turnStartLine = lines.length;
					this.renderTurn(turn, width, lines, true, false, latestFailed);

					const userLines = this.formatUserLine(turn.userText, width);
					let turnOffset = userLines.length;
					let hasText = false;
					for (const it of turn.items) {
						if (it.kind === "thinking") {
							const isHovered = this.hoveredThinkingTurnN === turn.n;
							const collapsed = it.collapsed ?? turn.thinkingCollapsed ?? true;
							const count = formatThinkingLines(it.text, collapsed, width, isHovered).length;
							thinkingLocations.push({ turnN: turn.n, lineIndex: turnStartLine + turnOffset, lineCount: count, turn });
							turnOffset += count;
						} else if (it.kind === "text") {
							turnOffset += this.formatAssistantMarkdown(it.text, width, !hasText).length;
							hasText = true;
						} else if (it.kind === "tool") {
							const toolId = it.callId || `tool-${it.name}`;
							const isExpanded = it.collapsed === false || this.expandedToolIds.has(toolId);
							const isHovered = this.hoveredToolId === toolId;
							const isNewestFailure = it === latestFailed;
							const cardLines = formatToolCardLines(it.name, it.result ?? "", it.elapsedMs ?? 0, width, it.status, it.args, {
								isExpanded,
								isHovered,
								isNewestFailure,
								startedAt: it.startedAt,
							});
							toolLocations.push({
								callId: toolId,
								lineIndex: turnStartLine + turnOffset,
								lineCount: cardLines.length,
								name: it.name,
								isExpanded,
								turn,
								item: it,
							});
							turnOffset += cardLines.length;
						} else if (it.kind === "diff") {
							turnOffset += formatDiffCardLines(it.oldText, it.newText, it.filename, it.collapsed ?? true, width).length;
						} else if (it.kind === "interrupt") {
							turnOffset += 1;
						}
					}
					break;
				}
				case "customMessage": {
					const comp = new CustomMessageComponent(item.message, this.messageRenderer(item.message.customType));
					lines.push(...comp.render(width));
					break;
				}
				case "customEntry": {
					const comp = new CustomEntryComponent(item.entry, this.entryRenderer(item.entry.customType));
					lines.push(...comp.render(width));
					break;
				}
			}
		}

		this.settledCache = {
			width,
			hoveredThinkingTurnN: this.hoveredThinkingTurnN,
			hoveredToolId: this.hoveredToolId,
			hoveredCompactionIndex: this.hoveredCompactionIndex,
			expandedToolIdsKey: expandedKey,
			lines,
			turnStartMap,
			thinkingLocations,
			toolLocations,
			compactionLocations,
		};
		return this.settledCache;
	}

	render(width: number): string[] {
		const cached = this.getSettledCache(width);
		if (!this.currentTurn) {
			return cached.lines.slice();
		}
		const lines = cached.lines.slice();
		this.renderTurn(this.currentTurn, width, lines, true, true);
		return lines;
	}

	private renderTurn(
		turn: TurnRecord,
		width: number,
		out: string[],
		showThinking = true,
		isCurrent = false,
		latestFailed?: Extract<TurnItem, { kind: "tool" }> | null,
	): void {
		if (turn.userText) out.push(...this.formatUserLine(turn.userText, width));

		let hasRenderedText = false;
		const activeFailed = latestFailed !== undefined ? latestFailed : this.getLatestFailedTool();

		for (const item of turn.items) {
			if (item.kind === "thinking") {
				if (showThinking) {
					const isHovered = this.hoveredThinkingTurnN === turn.n;
					const collapsed = item.collapsed ?? turn.thinkingCollapsed ?? true;
					out.push(...formatThinkingLines(item.text, collapsed, width, isHovered));
				}
			} else if (item.kind === "text") {
				const textToRender = isCurrent
					? this.smoothReveal.getRevealedText(`turn-${turn.n}-text`, item.text, true)
					: item.text;
				out.push(...this.formatAssistantMarkdown(textToRender, width, !hasRenderedText));
				hasRenderedText = true;
			} else if (item.kind === "tool") {
				const toolId = item.callId || `tool-${item.name}`;
				const isExpanded = item.collapsed === false || this.expandedToolIds.has(toolId);
				const isHovered = this.hoveredToolId === toolId;
				const isNewestFailure = item === activeFailed;
				out.push(...formatToolCardLines(item.name, item.result ?? "", item.elapsedMs ?? 0, width, item.status, item.args, {
					isExpanded,
					isHovered,
					isNewestFailure,
					startedAt: item.startedAt,
				}));
			} else if (item.kind === "diff") {
				out.push(...formatDiffCardLines(item.oldText, item.newText, item.filename, item.collapsed ?? true, width));
			} else if (item.kind === "interrupt") {
				out.push(`  \x1b[2m${item.text}\x1b[0m`);
			}
		}
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
	 * 获取每一轮次在转录完整行序列中的起始行号映射表（使用已结算行缓存，避免重复全量渲染）
	 */
	getTurnStartLines(width: number): Map<number, number> {
		const cached = this.getSettledCache(width);
		const map = new Map<number, number>(cached.turnStartMap);
		if (this.currentTurn) {
			map.set(this.currentTurn.n, cached.lines.length);
		}
		return map;
	}

	/**
	 * 获取所有思考折叠行在完整行序列中的索引位置（使用已结算行缓存）
	 */
	getThinkingLineIndices(width: number): ThinkingLineLocation[] {
		const cached = this.getSettledCache(width);
		if (!this.currentTurn) {
			return cached.thinkingLocations.slice();
		}
		const result = cached.thinkingLocations.slice();
		const currentLine = cached.lines.length;
		const turn = this.currentTurn;
		const userLines = this.formatUserLine(turn.userText, width);
		let turnOffset = userLines.length;
		let hasText = false;
		const latestFailed = this.getLatestFailedTool();

		for (const it of turn.items) {
			if (it.kind === "thinking") {
				const isHovered = this.hoveredThinkingTurnN === turn.n;
				const collapsed = it.collapsed ?? turn.thinkingCollapsed ?? true;
				const count = formatThinkingLines(it.text, collapsed, width, isHovered).length;
				result.push({ turnN: turn.n, lineIndex: currentLine + turnOffset, lineCount: count, turn });
				turnOffset += count;
			} else if (it.kind === "text") {
				turnOffset += this.formatAssistantMarkdown(it.text, width, !hasText).length;
				hasText = true;
			} else if (it.kind === "tool") {
				const toolId = it.callId || `tool-${it.name}`;
				const isExpanded = it.collapsed === false || this.expandedToolIds.has(toolId);
				const isHovered = this.hoveredToolId === toolId;
				const isNewestFailure = it === latestFailed;
				turnOffset += formatToolCardLines(it.name, it.result ?? "", it.elapsedMs ?? 0, width, it.status, it.args, {
					isExpanded,
					isHovered,
					isNewestFailure,
					startedAt: it.startedAt,
				}).length;
			} else if (it.kind === "diff") {
				turnOffset += formatDiffCardLines(it.oldText, it.newText, it.filename, it.collapsed ?? true, width).length;
			} else if (it.kind === "interrupt") {
				turnOffset += 1;
			}
		}

		return result;
	}

	/**
	 * 获取所有工具卡片行在完整行序列中的索引位置与元数据
	 */
	getToolLineIndices(width: number): ToolLineLocation[] {
		const cached = this.getSettledCache(width);
		if (!this.currentTurn) {
			return cached.toolLocations.slice();
		}
		const result = cached.toolLocations.slice();
		const currentLine = cached.lines.length;
		const turn = this.currentTurn;
		const userLines = this.formatUserLine(turn.userText, width);
		let turnOffset = userLines.length;
		let hasText = false;
		const latestFailed = this.getLatestFailedTool();

		for (const it of turn.items) {
			if (it.kind === "thinking") {
				const isHovered = this.hoveredThinkingTurnN === turn.n;
				const collapsed = it.collapsed ?? turn.thinkingCollapsed ?? true;
				turnOffset += formatThinkingLines(it.text, collapsed, width, isHovered).length;
			} else if (it.kind === "text") {
				turnOffset += this.formatAssistantMarkdown(it.text, width, !hasText).length;
				hasText = true;
			} else if (it.kind === "tool") {
				const toolId = it.callId || `tool-${it.name}`;
				const isExpanded = it.collapsed === false || this.expandedToolIds.has(toolId);
				const isHovered = this.hoveredToolId === toolId;
				const isNewestFailure = it === latestFailed;
				const cardLines = formatToolCardLines(it.name, it.result ?? "", it.elapsedMs ?? 0, width, it.status, it.args, {
					isExpanded,
					isHovered,
					isNewestFailure,
					startedAt: it.startedAt,
				});
				result.push({
					callId: toolId,
					lineIndex: currentLine + turnOffset,
					lineCount: cardLines.length,
					name: it.name,
					isExpanded,
					turn,
					item: it,
				});
				turnOffset += cardLines.length;
			} else if (it.kind === "diff") {
				turnOffset += formatDiffCardLines(it.oldText, it.newText, it.filename, it.collapsed ?? true, width).length;
			} else if (it.kind === "interrupt") {
				turnOffset += 1;
			}
		}

		return result;
	}

	/**
	 * 获取所有会话压缩卡片行在完整行序列中的索引位置与元数据
	 */
	getCompactionLineIndices(width: number): CompactionLineLocation[] {
		const cached = this.getSettledCache(width);
		return cached.compactionLocations.slice();
	}
}
