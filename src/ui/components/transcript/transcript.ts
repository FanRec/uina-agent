/**
 * 会话转录区容器（TranscriptContainer）。
 * 集中管理用户轮次、思考流、助手 Markdown 回复、工具调用、差异比对、压缩卡片与扩展自定义消息。
 * 自身实现 Component 契约，支持动态根据可用列宽完整重流。
 */

import type { Component } from "../../core/types.js";
import type { ChatMsg } from "../../../core/types.js";
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
			status: "running" | "completed" | "failed";
			elapsedMs?: number;
			callId?: string;
	  }
	| {
			kind: "diff";
			oldText: string;
			newText: string;
			filename: string;
			collapsed?: boolean;
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
	readonly smoothReveal = new SmoothRevealController();
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
			callId,
		});
	}

	addToolDone(name: string, result: string, elapsedMs = 0, isError = false, callId?: string): void {
		if (!this.currentTurn) {
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
			runningTool.status = isError ? "failed" : "completed";
			runningTool.result = result;
			runningTool.elapsedMs = elapsedMs;
		} else {
			this.currentTurn.items.push({
				kind: "tool",
				name,
				result,
				elapsedMs,
				status: isError ? "failed" : "completed",
				callId,
			});
		}
	}

	addDiff(oldText: string, newText: string, filename: string, collapsed = true): void {
		if (!this.currentTurn) {
			this.startTurn(this.historyTurns.length + 1, "");
		}
		this.currentTurn?.items.push({ oldText, newText, filename, collapsed, kind: "diff" });
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

			if ((entry as { kind: string }).kind !== "message") continue;
			const msg = entry.message;
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
					current.items.push({ kind: "text", text: msg.content });
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
				current.items.push({
					kind: "tool",
					name: toolName,
					result: msg.content,
					elapsedMs,
					status: "completed",
					callId: msg.tool_call_id,
				});
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
			for (const it of target.items) {
				if (it.kind === "thinking") {
					it.collapsed = !wasCollapsed;
				}
			}
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
	}

	private commitCurrentTurn(): void {
		if (this.currentTurn) {
			this.smoothReveal.snapToLatest(`turn-${this.currentTurn.n}-text`);
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
			this.renderTurn(this.currentTurn, width, lines, true, true);
		}

		return lines;
	}

	private renderTurn(
		turn: TurnRecord,
		width: number,
		out: string[],
		showThinking = true,
		isCurrent = false,
	): void {
		if (turn.userText) out.push(...this.formatUserLine(turn.userText, width));

		let hasRenderedText = false;

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
				out.push(...formatToolCardLines(item.name, item.result ?? "", item.elapsedMs ?? 0, width, item.status, item.args));
			} else if (item.kind === "diff") {
				out.push(...formatDiffCardLines(item.oldText, item.newText, item.filename, item.collapsed ?? true, width));
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
			} else if (item.kind === "customMessage") {
				const comp = new CustomMessageComponent(item.message, this.messageRenderer(item.message.customType));
				lineCount += comp.render(width).length;
			} else if (item.kind === "customEntry") {
				const comp = new CustomEntryComponent(item.entry, this.entryRenderer(item.entry.customType));
				lineCount += comp.render(width).length;
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
				let turnOffset = userLines.length;
				let hasText = false;
				for (const it of turn.items) {
					if (it.kind === "thinking") {
						result.push({ turnN: turn.n, lineIndex: currentLine + turnOffset, turn });
						const isHovered = this.hoveredThinkingTurnN === turn.n;
						const collapsed = it.collapsed ?? turn.thinkingCollapsed ?? true;
						turnOffset += formatThinkingLines(it.text, collapsed, width, isHovered).length;
					} else if (it.kind === "text") {
						turnOffset += this.formatAssistantMarkdown(it.text, width, !hasText).length;
						hasText = true;
					} else if (it.kind === "tool") {
						turnOffset += formatToolCardLines(it.name, it.result ?? "", it.elapsedMs ?? 0, width, it.status, it.args).length;
					} else if (it.kind === "diff") {
						turnOffset += formatDiffCardLines(it.oldText, it.newText, it.filename, it.collapsed ?? true, width).length;
					}
				}
				const turnLines: string[] = [];
				this.renderTurn(turn, width, turnLines);
				currentLine += turnLines.length;
			} else if (item.kind === "notice") {
				currentLine += 1;
			} else if (item.kind === "compaction") {
				currentLine += formatCompactionCardLines(item.record, width).length;
			} else if (item.kind === "customMessage") {
				const comp = new CustomMessageComponent(item.message, this.messageRenderer(item.message.customType));
				currentLine += comp.render(width).length;
			} else if (item.kind === "customEntry") {
				const comp = new CustomEntryComponent(item.entry, this.entryRenderer(item.entry.customType));
				currentLine += comp.render(width).length;
			}
		}

		if (this.currentTurn) {
			const turn = this.currentTurn;
			const userLines = this.formatUserLine(turn.userText, width);
			let turnOffset = userLines.length;
			let hasText = false;
			for (const it of turn.items) {
				if (it.kind === "thinking") {
					result.push({ turnN: turn.n, lineIndex: currentLine + turnOffset, turn });
					const isHovered = this.hoveredThinkingTurnN === turn.n;
					const collapsed = it.collapsed ?? turn.thinkingCollapsed ?? true;
					turnOffset += formatThinkingLines(it.text, collapsed, width, isHovered).length;
				} else if (it.kind === "text") {
					turnOffset += this.formatAssistantMarkdown(it.text, width, !hasText).length;
					hasText = true;
				} else if (it.kind === "tool") {
					turnOffset += formatToolCardLines(it.name, it.result ?? "", it.elapsedMs ?? 0, width, it.status, it.args).length;
				} else if (it.kind === "diff") {
					turnOffset += formatDiffCardLines(it.oldText, it.newText, it.filename, it.collapsed ?? true, width).length;
				}
			}
		}

		return result;
	}

	invalidate(): void {}
}
