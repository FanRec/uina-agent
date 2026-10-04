import type { ImageContent } from "../../../core/content.js";
import type { InputSource } from "../../../core/types.js";
import type { InjectionProvenance } from "../../../runtime/events.js";
import { imageNotice } from "../../../core/content.js";
import { C, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";

export interface PromptContextCardData {
	kind: "prompt";
	id?: string;
	turnNumber: number;
	systemPrompt: string;
	injections: readonly InjectionProvenance[];
	previousSystemPrompt?: string;
}

export interface ExternalContextCardData {
	kind: "external";
	inputId: string;
	source: InputSource;
	receivedAt: string;
	text: string;
	images?: readonly ImageContent[];
}

export type ContextCardData = PromptContextCardData | ExternalContextCardData;

export class ContextCardComponent {
	private expanded = false;

	constructor(private readonly data: ContextCardData) {}

	toggle(): void {
		this.expanded = !this.expanded;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	render(width: number): string[] {
		const boxWidth = Math.max(32, Math.min(width, 100));
		const innerWidth = Math.max(1, boxWidth - 6);
		const border = this.data.kind === "external" ? C.cyan : C.suggestion;
		const title = this.data.kind === "external" ? "◇ 外部注入" : "◆ 提示词变更";
		const state = this.data.kind === "external" ? this.externalTitle() : `第 ${this.data.turnNumber} 回合`;
		const tag = ` ${title} · ${state} `;
		const top = `  ${border}╭─${C.bold}${tag}${C.reset}${border}${"─".repeat(Math.max(2, boxWidth - visibleWidth(tag) - 5))}╮${C.reset}`;
		const rows = this.data.kind === "external" ? this.externalRows(innerWidth) : this.promptRows(innerWidth);
		const body = rows.map((row) => {
			const clipped = truncateToWidth(stripAnsi(row), innerWidth, "…");
			return `  ${border}│${C.reset} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${border}│${C.reset}`;
		});
		const bottom = `  ${border}╰${"─".repeat(Math.max(2, boxWidth - 4))}╯${C.reset}`;
		return [top, ...body, bottom];
	}

	private externalTitle(): string {
		const data = this.data as ExternalContextCardData;
		return `${data.source.type}${data.source.ref ? ` · ${data.source.ref}` : ""}`;
	}

	private promptRows(width: number): string[] {
		const data = this.data as PromptContextCardData;
		const rows = [
			`${C.text}${data.systemPrompt.length}${C.reset} 字符 · ${data.injections.length} 个来源 · ${this.changeSummary()} ` +
				`${C.dim}${this.expanded ? "收起" : "展开查看"}${C.reset}`,
		];
		if (data.injections.length === 0) rows.push(`  ${C.inactive}└─ 无额外来源${C.reset}`);
		else {
			data.injections.forEach((item, index) => {
				const branch = index === data.injections.length - 1 ? "└─" : "├─";
				rows.push(`  ${C.suggestion}${branch}${C.reset} ${item.extension} · ${injectionLabel(item)}`);
			});
		}
		if (this.expanded) {
			rows.push(`${C.dim}最终 system prompt${C.reset}`);
			for (const line of wrapTextWithAnsi(sanitizeRenderText(data.systemPrompt), Math.max(1, width - 2)))
				rows.push(`  ${C.dim}${line}${C.reset}`);
		}
		return rows;
	}

	private externalRows(width: number): string[] {
		const data = this.data as ExternalContextCardData;
		const rows = [
			`${C.text}来源${C.reset} ${data.source.kind}/${data.source.type}${data.source.ref ? ` · ${data.source.ref}` : ""}`,
			`${C.dim}${data.receivedAt}${C.reset} · ${C.dim}${this.expanded ? "收起" : "展开查看"}${C.reset}`,
		];
		const text = sanitizeRenderText(data.text + imageNotice(data.images));
		const lines = wrapTextWithAnsi(text, Math.max(1, width - 2));
		if (this.expanded || lines.length <= 3) rows.push(...lines.map((line) => `  ${C.text}${line}${C.reset}`));
		else rows.push(`  ${C.text}${lines.slice(0, 3).join(" ")}…${C.reset}`);
		return rows;
	}

	private changeSummary(): string {
		const data = this.data as PromptContextCardData;
		if (data.previousSystemPrompt === undefined) return "首次建立";
		const delta = data.systemPrompt.length - data.previousSystemPrompt.length;
		return `正文${delta === 0 ? "有变化" : `${delta > 0 ? "+" : ""}${delta} 字符`}`;
	}
}

function injectionLabel(item: InjectionProvenance): string {
	switch (item.kind) {
		case "messages":
			return `${item.messageCount ?? 0} 条消息 · ${item.chars} 字符`;
		case "systemPrompt":
			return `系统提示词 · ${item.chars} 字符`;
		case "projection":
			return `投影${item.preview ? ` · ${item.preview}` : ""}`;
		default:
			return item.preview || item.kind;
	}
}
