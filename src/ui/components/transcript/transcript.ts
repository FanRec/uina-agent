/**
 * 会话转录区容器（TranscriptContainer）。
 * 集中管理用户轮次、思考流、助手 Markdown 回复、工具调用、差异比对、压缩卡片与扩展自定义消息。
 * 自身实现 Component 契约，支持动态根据可用列宽完整重流。
 */

import type { Component } from "../../core/types.js";
import { C, wrapTextWithAnsi, visibleWidth } from "../../core/utils.js";
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
	customMessages?: CustomMessage[];
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

	private compactions: CompactionRecord[] = [];
	private customEntries: CustomEntry[] = [];
	private standaloneCustomMessages: CustomMessage[] = [];
	private systemNotices: string[] = [];

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
		this.compactions.push(record);
		this.timeline.push({ kind: "compaction", record });
	}

	addCustomMessage(msg: CustomMessage): void {
		if (this.currentTurn) {
			if (!this.currentTurn.customMessages) this.currentTurn.customMessages = [];
			this.currentTurn.customMessages.push(msg);
		} else {
			this.standaloneCustomMessages.push(msg);
			this.timeline.push({ kind: "customMessage", message: msg });
		}
	}

	addCustomEntry(entry: CustomEntry): void {
		this.customEntries.push(entry);
		this.timeline.push({ kind: "customEntry", entry });
	}

	addNotice(text: string): void {
		const formatted = `  ${C.blue}ℹ ${text}${C.reset}`;
		this.systemNotices.push(formatted);
		this.timeline.push({ kind: "notice", text: formatted });
	}

	addError(text: string): void {
		const formatted = `  ${C.red}✗ [错误] ${text}${C.reset}`;
		this.systemNotices.push(formatted);
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

	loadHistory(history: readonly any[]): void {
		let turnN = 0;
		let current: TurnRecord | null = null;
		let pendingToolCalls: Array<{ id?: string; name: string }> = [];

		for (const msg of history) {
			if (msg.role === "user") {
				if (msg.meta?.type === "compaction") {
					const record: CompactionRecord = {
						id: Date.now(),
						summary: msg.content,
						turnsCount: turnN,
						tokensSaved: Math.max(0, (msg.meta.originalTokens ?? 0) - (msg.meta.compactedTokens ?? 0)),
						collapsed: true,
						timestamp: Date.now(),
						afterTurnN: turnN,
					};
					this.compactions.push(record);
					this.timeline.push({ kind: "compaction", record });
					continue;
				}
				if (current) {
					this.historyTurns.push(current);
					this.timeline.push({ kind: "turn", turn: current });
				}
				turnN++;
				pendingToolCalls = [];
				current = {
					n: turnN,
					userText: msg.content,
					assistantMarkdown: "",
					thinkingText: undefined,
					tools: [],
				};
			} else if (msg.role === "assistant") {
				if (!current) {
					turnN++;
					current = {
						n: turnN,
						userText: "",
						assistantMarkdown: "",
						tools: [],
					};
				}
				if (msg.thinking) {
					current.thinkingText = (current.thinkingText ? current.thinkingText + "\n" : "") + msg.thinking;
				}
				if (msg.content) {
					current.assistantMarkdown += msg.content;
				}
				if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
					pendingToolCalls = msg.tool_calls.map((tc: any) => ({
						id: tc.id,
						name: tc.name || "tool",
					}));
				}
			} else if (msg.role === "tool") {
				if (current) {
					let toolName = "tool";
					if (msg.tool_call_id) {
						const match = pendingToolCalls.find((tc) => tc.id === msg.tool_call_id);
						if (match) toolName = match.name;
					} else if (pendingToolCalls.length > 0) {
						toolName = pendingToolCalls.shift()!.name;
					}

					let elapsedMs = 0;
					try {
						const parsed = JSON.parse(msg.content);
						if (parsed && typeof parsed.elapsedMs === "number") {
							elapsedMs = parsed.elapsedMs;
						}
					} catch {
						// 忽略解析错误
					}

					current.tools.push({
						name: toolName,
						result: msg.content,
						elapsedMs,
					});
				}
			}
		}
		if (current) {
			this.historyTurns.push(current);
			this.timeline.push({ kind: "turn", turn: current });
		}
	}

	clear(): void {
		this.timeline.length = 0;
		this.historyTurns.length = 0;
		this.currentTurn = null;
		this.compactions.length = 0;
		this.customEntries.length = 0;
		this.standaloneCustomMessages.length = 0;
		this.systemNotices.length = 0;
	}

	toggleThinking(turnN?: number): boolean {
		const target = turnN !== undefined
			? this.historyTurns.find((t) => t.n === turnN) || (this.currentTurn?.n === turnN ? this.currentTurn : null)
			: (this.currentTurn?.thinkingText ? this.currentTurn : this.historyTurns.slice().reverse().find((t) => t.thinkingText));

		if (target && target.thinkingText) {
			target.thinkingCollapsed = !(target.thinkingCollapsed ?? true);
			return true;
		}
		return false;
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
		const prefix = `  ${C.yellow}${C.bold}❯${C.reset} ${C.bold}`;
		const leadW = visibleWidth("  ❯ ");
		const contentBudget = Math.max(10, width - leadW - 4);
		const wrapped = wrapTextWithAnsi(text, contentBudget);
		if (wrapped.length === 0) {
			lines.push(`${prefix}${C.reset}`);
		} else {
			lines.push(`${prefix}${wrapped[0]}${C.reset}`);
			const indent = " ".repeat(leadW);
			for (let i = 1; i < wrapped.length; i++) {
				lines.push(`${indent}${C.bold}${wrapped[i]}${C.reset}`);
			}
		}
		lines.push("");
		return lines;
	}

	private formatAssistantMarkdown(md: string, width: number): string[] {
		if (!md) return [];
		// 扣除 4 列悬挂缩进空间（"  ● " / "    "）
		const contentBudget = Math.max(20, width - 6);
		const rawLines = formatFullMarkdown(md, contentBudget);
		const formatted: string[] = [];
		let isFirstParagraph = true;

		for (const rawLine of rawLines) {
			if (!rawLine.trim()) {
				formatted.push("");
				continue;
			}

			// 如果是代码块边框或内联几何线，保持原样
			if (rawLine.startsWith("  ┌") || rawLine.startsWith("  │") || rawLine.startsWith("  └")) {
				formatted.push(rawLine);
				continue;
			}

			// 对段落行进行严格 word-wrap，确保任何行都不超出终端口宽顶格到第 0 列
			const wrapped = wrapTextWithAnsi(rawLine.trim(), contentBudget);
			for (let i = 0; i < wrapped.length; i++) {
				const piece = wrapped[i]!;
				if (isFirstParagraph && i === 0) {
					formatted.push(`  ${C.green}${C.bold}● ${C.reset}${piece}`);
					isFirstParagraph = false;
				} else {
					formatted.push(`    ${piece}`);
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
			this.renderTurn(this.currentTurn, width, lines, this.thinkingCommitted);
		}

		return lines;
	}

	private renderTurn(
		turn: TurnRecord,
		width: number,
		out: string[],
		showThinking = true,
	): void {
		out.push(...this.formatUserLine(turn.userText, width));

		if (turn.thinkingText && showThinking) {
			out.push(...formatThinkingLines(turn.thinkingText, turn.thinkingCollapsed ?? true, width));
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

		if (turn.customMessages) {
			for (const msg of turn.customMessages) {
				const comp = new CustomMessageComponent(msg, this.messageRenderer(msg.customType));
				out.push(...comp.render(width));
			}
		}

		// 跟随本轮之后的压缩卡片
		const comps = this.compactions.filter((c) => c.afterTurnN === turn.n);
		for (const comp of comps) {
			out.push("", ...formatCompactionCardLines(comp, width), "");
		}
	}

	invalidate(): void {}
}
