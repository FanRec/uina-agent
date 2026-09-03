/**
 * 会话转录区容器（TranscriptContainer）。
 * 集中管理用户轮次、思考流、助手 Markdown 回复、工具调用、差异比对、压缩卡片与扩展自定义消息。
 * 自身实现 Component 契约，支持动态根据可用列宽完整重流。
 */

import type { Component } from "../../core/types.js";
import type { ChatMsg } from "../../../core/types.js";
import type { SessionEntry } from "../../../session/types.js";
import { C, wrapTextWithAnsi } from "../../core/utils.js";
import { formatThinkingLines } from "./thinking-view.js";
import { formatToolCardLines } from "./tool-view.js";
import { formatFullMarkdown } from "./stream-markdown.js";
import { formatUnifiedDiffCardLines } from "./diff-view.js";
import { formatCompactionCardLines, type CompactionRecord } from "./compact-view.js";
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

export interface TurnRecord {
	n: number;
	userText: string;
	assistantMarkdown: string;
	thinkingText?: string;
	thinkingCollapsed?: boolean;
	tools: ToolRecord[];
	diffs?: DiffRecord[];
}

export interface ThinkingLineLocation {
	turnN: number;
	lineIndex: number;
	/** 精确指向该 thinking 所属的轮次，不能只依赖可能重复的 turnN。 */
	turn: TurnRecord;
}

export type TimelineItem =
	| { kind: "turn"; turn: TurnRecord }
	| { kind: "notice"; text: string }
	| { kind: "compaction"; record: CompactionRecord }
	| { kind: "customMessage"; message: CustomMessage }
	| { kind: "customEntry"; entry: CustomEntry };

export class TranscriptContainer implements Component {
	private readonly timeline: TimelineItem[] = [];
	private readonly historyTurns: TurnRecord[] = [];
	private currentTurn: TurnRecord | null = null;
	private thinkingCommitted = false;
	private hoveredThinkingTurnN: number | null = null;

	setHoveredThinkingTurn(turnN: number | null): boolean {
		if (this.hoveredThinkingTurnN !== turnN) {
			this.hoveredThinkingTurnN = turnN;
			return true;
		}
		return false;
	}

	getHoveredThinkingTurn(): number | null {
		return this.hoveredThinkingTurnN;
	}

	private messageRenderer: (type: string) => MessageRenderer | undefined = () => undefined;
	private entryRenderer: (type: string) => EntryRenderer | undefined = () => undefined;

	setMessageRenderer(type: string, renderer: MessageRenderer): void {
		const previous = this.messageRenderer;
		this.messageRenderer = (candidate) => candidate === type ? renderer : previous(candidate);
	}

	setEntryRenderer(type: string, renderer: EntryRenderer): void {
		const previous = this.entryRenderer;
		this.entryRenderer = (candidate) => candidate === type ? renderer : previous(candidate);
	}

	setRendererResolver(resolve: { message(type: string): MessageRenderer | undefined; entry(type: string): EntryRenderer | undefined }): void {
		this.messageRenderer = resolve.message;
		this.entryRenderer = resolve.entry;
	}

	startTurn(n: number, userText: string): void {
		if (this.currentTurn) {
			this.commitCurrentTurn();
		}
		this.currentTurn = {
			n,
			userText,
			assistantMarkdown: "",
			tools: [],
		};
		this.thinkingCommitted = false;
	}

	appendToken(token: string): void {
		if (this.currentTurn) {
			this.currentTurn.assistantMarkdown += token;
		}
	}

	appendThinking(text: string): void {
		if (this.currentTurn) {
			this.currentTurn.thinkingText = (this.currentTurn.thinkingText ?? "") + text;
		}
	}

	commitThinking(): void {
		this.thinkingCommitted = true;
	}

	isThinkingCommitted(): boolean {
		return this.thinkingCommitted;
	}

	addToolDone(name: string, result: string, elapsedMs = 0): void {
		if (this.currentTurn) {
			this.currentTurn.tools.push({ name, result, elapsedMs });
		}
	}

	addDiff(oldText: string, newText: string, filename: string, collapsed = true): void {
		if (this.currentTurn) {
			if (!this.currentTurn.diffs) this.currentTurn.diffs = [];
			this.currentTurn.diffs.push({ oldText, newText, filename, collapsed });
		}
	}

	addCompaction(record: CompactionRecord): void {
		this.timeline.push({ kind: "compaction", record });
	}

	addCustomMessage(msg: CustomMessage): void {
		if (msg.display === false) return;
		this.timeline.push({ kind: "customMessage", message: msg });
	}

	addCustomEntry(entry: CustomEntry): void {
		this.timeline.push({ kind: "customEntry", entry });
	}

	addNotice(text: string): void {
		const formatted = `  ${C.blue}ℹ ${text}${C.reset}`;
		this.timeline.push({ kind: "notice", text: formatted });
	}

	addError(text: string): void {
		const formatted = `  ${C.red}✗ [错误] ${text}${C.reset}`;
		this.timeline.push({ kind: "notice", text: formatted });
	}

	finishTurn(): void {
		this.commitCurrentTurn();
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
		let pendingToolCalls: Array<{ id: string; name: string }> = [];
		const commit = (): void => {
			if (!current) return;
			this.historyTurns.push(current);
			this.timeline.push({ kind: "turn", turn: current });
			current = null;
		};
		const createTurn = (userText = ""): TurnRecord => {
			turnN++;
			return { n: turnN, userText, assistantMarkdown: "", tools: [] };
		};

		for (const entry of entries) {
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

			const msg = entry.message;
			if (msg.role === "user") {
				commit();
				pendingToolCalls = [];
				current = createTurn(msg.content);
			} else if (msg.role === "assistant") {
				current ??= createTurn();
				if (msg.thinking) {
					current.thinkingText = (current.thinkingText ? current.thinkingText + "\n" : "") + msg.thinking;
				}
				if (msg.content) {
					current.assistantMarkdown += msg.content;
				}
				if (msg.tool_calls) {
					pendingToolCalls = msg.tool_calls.map((call) => ({
						id: call.id,
						name: call.name || "tool",
					}));
				}
			} else if (msg.role === "tool") {
				current ??= createTurn();
				const toolName = pendingToolCalls.find((call) => call.id === msg.tool_call_id)?.name ?? "tool";
				let elapsedMs = 0;
				try {
					const parsed = JSON.parse(msg.content) as { elapsedMs?: unknown };
					if (typeof parsed?.elapsedMs === "number") elapsedMs = parsed.elapsedMs;
				} catch {
					// Plain-text tool results have no elapsed metadata.
				}
				current.tools.push({ name: toolName, result: msg.content, elapsedMs });
			}
		}
		commit();
	}

	clear(): void {
		this.timeline.length = 0;
		this.historyTurns.length = 0;
		this.currentTurn = null;
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
			}
		}
	}

	private commitCurrentTurn(): void {
		if (this.currentTurn) {
			this.historyTurns.push(this.currentTurn);
			this.timeline.push({ kind: "turn", turn: this.currentTurn });
			this.currentTurn = null;
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

	private formatAssistantMarkdown(md: string, width: number): string[] {
		if (!md) return [];
		const contentBudget = Math.max(20, width - 2);
		const rawLines = formatFullMarkdown(md, contentBudget);
		const formatted: string[] = [];
		let isFirstParagraph = true;

		for (const rawLine of rawLines) {
			if (!rawLine.trim()) {
				formatted.push("");
				continue;
			}

			// 如果是代码块边框或内联几何线，保持顶格
			if (
				rawLine.startsWith("┌") || rawLine.startsWith("│") || rawLine.startsWith("└") ||
				rawLine.startsWith("  ┌") || rawLine.startsWith("  │") || rawLine.startsWith("  └")
			) {
				formatted.push(rawLine.trimStart());
				continue;
			}

			// 对段落行进行严格 word-wrap
			const wrapped = wrapTextWithAnsi(rawLine.trim(), contentBudget);
			for (let i = 0; i < wrapped.length; i++) {
				const piece = wrapped[i]!;
				if (isFirstParagraph && i === 0) {
					formatted.push(`${C.bold}${C.text}● ${C.reset}${piece}`);
					isFirstParagraph = false;
				} else {
					// 严格零边距左对齐，去除前导 "  " 多余空格，杜绝复制污染
					formatted.push(piece);
				}
			}
		}
		formatted.push("");
		return formatted;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// 按真实时间线严格线性渲染已结算历史
		for (const item of this.timeline) {
			switch (item.kind) {
				case "notice":
					lines.push(item.text);
					break;
				case "compaction":
					lines.push(...formatCompactionCardLines(item.record, width));
					break;
				case "turn":
					this.renderTurn(item.turn, width, lines);
					break;
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

		// 当前正在生成的活动轮次
		if (this.currentTurn) {
			// thinking 是当前轮次的实时输出，第一段内容到达时就应当
			// 显示；thinkingCommitted 只记录它是否已经进入工具阶段，
			// 不能拿来阻塞流式思考的可见性。
			this.renderTurn(this.currentTurn, width, lines, true);
		}

		return lines;
	}

	private renderTurn(
		turn: TurnRecord,
		width: number,
		out: string[],
		showThinking = true,
	): void {
		if (turn.userText) out.push(...this.formatUserLine(turn.userText, width));

		if (turn.thinkingText && showThinking) {
			const isHovered = this.hoveredThinkingTurnN === turn.n;
			out.push(...formatThinkingLines(turn.thinkingText, turn.thinkingCollapsed ?? true, width, isHovered));
		}

		if (turn.assistantMarkdown) {
			out.push(...this.formatAssistantMarkdown(turn.assistantMarkdown, width));
		}

		for (const tool of turn.tools) {
			out.push(...formatToolCardLines(tool.name, tool.result, tool.elapsedMs, width));
		}

		if (turn.diffs) {
			for (const d of turn.diffs) {
				out.push(...formatUnifiedDiffCardLines(d.oldText, d.newText, d.filename, d.collapsed ?? true, width));
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
	 * 获取每一轮次在转录完整行序列中的起始行号映射表
	 */
	getTurnStartLines(width: number): Map<number, number> {
		const map = new Map<number, number>();
		let lineCount = 0;

		for (const item of this.timeline) {
			if (item.kind === "turn") {
				map.set(item.turn.n, lineCount);
				const turnLines: string[] = [];
				this.renderTurn(item.turn, width, turnLines);
				lineCount += turnLines.length;
			} else if (item.kind === "notice") {
				lineCount += 1;
			} else if (item.kind === "compaction") {
				lineCount += formatCompactionCardLines(item.record, width).length;
			}
		}

		if (this.currentTurn) {
			map.set(this.currentTurn.n, lineCount);
		}

		return map;
	}

	/**
	 * 获取所有思考折叠行在完整行序列中的索引位置
	 */
	getThinkingLineIndices(width: number): ThinkingLineLocation[] {
		const result: ThinkingLineLocation[] = [];
		let currentLine = 0;

		for (const item of this.timeline) {
			if (item.kind === "turn") {
				const turn = item.turn;
				const userLines = this.formatUserLine(turn.userText, width);
				if (turn.thinkingText) {
					result.push({ turnN: turn.n, lineIndex: currentLine + userLines.length, turn });
				}
				const turnLines: string[] = [];
				this.renderTurn(turn, width, turnLines);
				currentLine += turnLines.length;
			} else if (item.kind === "notice") {
				currentLine += 1;
			} else if (item.kind === "compaction") {
				currentLine += formatCompactionCardLines(item.record, width).length;
			}
		}

		if (this.currentTurn && this.currentTurn.thinkingText) {
			const userLines = this.formatUserLine(this.currentTurn.userText, width);
			result.push({ turnN: this.currentTurn.n, lineIndex: currentLine + userLines.length, turn: this.currentTurn });
		}

		return result;
	}

	invalidate(): void {}
}
