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

export class TranscriptContainer implements Component {
	private readonly historyTurns: TurnRecord[] = [];
	private currentTurn: TurnRecord | null = null;
	private thinkingCommitted = false;

	private compactions: CompactionRecord[] = [];
	private customEntries: CustomEntry[] = [];
	private systemNotices: string[] = [];

	private messageRenderers = new Map<string, MessageRenderer>();
	private entryRenderers = new Map<string, EntryRenderer>();

	setMessageRenderer(type: string, renderer: MessageRenderer): void {
		this.messageRenderers.set(type, renderer);
	}

	setEntryRenderer(type: string, renderer: EntryRenderer): void {
		this.entryRenderers.set(type, renderer);
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
	}

	addCustomMessage(msg: CustomMessage): void {
		if (this.currentTurn) {
			if (!this.currentTurn.customMessages) this.currentTurn.customMessages = [];
			this.currentTurn.customMessages.push(msg);
		}
	}

	addCustomEntry(entry: CustomEntry): void {
		this.customEntries.push(entry);
	}

	addNotice(text: string): void {
		this.systemNotices.push(`  ${C.blue}ℹ ${text}${C.reset}`);
	}

	addError(text: string): void {
		this.systemNotices.push(`  ${C.red}✗ [错误] ${text}${C.reset}`);
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

	loadHistory(messages: readonly import("../../../core/types.js").ChatMsg[]): void {
		let current: TurnRecord | null = null;
		let turnN = 0;

		for (const msg of messages) {
			if (msg.role === "user") {
				if (msg.content.startsWith("[历史摘要]")) {
					this.compactions.push({
						id: Date.now(),
						summary: msg.content.slice(6).trim(),
						turnsCount: turnN,
						tokensSaved: 0,
						collapsed: true,
						timestamp: Date.now(),
					});
					continue;
				}
				if (current) {
					this.historyTurns.push(current);
				}
				turnN++;
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
			} else if (msg.role === "tool") {
				if (current) {
					current.tools.push({
						name: "tool",
						result: msg.content,
						elapsedMs: 0,
					});
				}
			}
		}
		if (current) {
			this.historyTurns.push(current);
		}
	}

	clear(): void {
		this.historyTurns.length = 0;
		this.currentTurn = null;
		this.compactions.length = 0;
		this.customEntries.length = 0;
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
		const targetState = collapsed ?? !all.some((t) => !(t.thinkingCollapsed ?? true));
		for (const t of all) {
			if (t.thinkingText) {
				t.thinkingCollapsed = targetState;
			}
		}
	}

	private commitCurrentTurn(): void {
		if (this.currentTurn) {
			this.historyTurns.push(this.currentTurn);
			this.currentTurn = null;
		}
	}

	private formatUserLine(text: string, width: number): string[] {
		const lines: string[] = [""];
		const prefix = `  ${C.cyan}${C.bold}你 >${C.reset} `;
		const leadW = visibleWidth(prefix);
		const contentBudget = Math.max(10, width - leadW - 4);
		const wrapped = wrapTextWithAnsi(text, contentBudget);
		if (wrapped.length === 0) {
			lines.push(prefix);
		} else {
			lines.push(`${prefix}${wrapped[0]}`);
			const indent = " ".repeat(leadW);
			for (let i = 1; i < wrapped.length; i++) {
				lines.push(`${indent}${wrapped[i]}`);
			}
		}
		lines.push("");
		return lines;
	}

	private formatAssistantMarkdown(md: string, width: number): string[] {
		const formatted = formatFullMarkdown(md, width);
		return formatted.map((l) => (l ? `  ${l}` : ""));
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// 1. 系统通知
		for (const notice of this.systemNotices) {
			lines.push(notice);
		}

		// 2. 会话初始压缩记录
		const initialComps = this.compactions.filter((c) => !c.afterTurnN || c.afterTurnN === 0);
		for (const comp of initialComps) {
			lines.push(...formatCompactionCardLines(comp, width));
		}

		// 3. 历史轮次
		for (const turn of this.historyTurns) {
			this.renderTurn(turn, width, lines);
		}

		// 4. 当前进行中的轮次
		if (this.currentTurn) {
			this.renderTurn(this.currentTurn, width, lines, this.thinkingCommitted);
		}

		// 5. 独立的全局 CustomEntries
		for (const entry of this.customEntries) {
			const comp = new CustomEntryComponent(entry, this.entryRenderers.get(entry.customType));
			lines.push(...comp.render(width));
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
				const comp = new CustomMessageComponent(msg, this.messageRenderers.get(msg.customType));
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
