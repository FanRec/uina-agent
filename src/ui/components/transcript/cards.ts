/**
 * 会话转录区卡片组件簇（Transcript Cards）。
 * 集中管理思考链卡片、压缩摘要卡片、扩展自定义消息卡片与扩展自定义条目卡片。
 */

import { imageNotice } from "../../../core/content.js";
import { Container } from "../../core/container.js";
import { C, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import type { Component } from "../../core/types.js";
import type {
	CustomMessage,
	CustomEntry,
	MessageRenderer,
	EntryRenderer,
} from "../../../extensions/ui-contract.js";

/* ------------------------------------------------------------------ */
/* 1. 思考链展示卡片                                                    */
/* ------------------------------------------------------------------ */

/** 格式化对话流内部的思考链块（永久行） */
export function formatThinkingLines(
	thinkingText: string,
	collapsed = true,
	width = 80,
	isHovered = false,
): string[] {
	thinkingText = sanitizeRenderText(thinkingText);
	if (!thinkingText || !thinkingText.trim()) return [];

	const iconColor = isHovered ? `${C.bold}${C.text}` : C.claude;
	const icon = `${iconColor}✦${C.reset}`;
	const titleText = isHovered ? `${C.bold}${C.text}思考${C.reset}` : `${C.bold}${C.claude}思考${C.reset}`;

	if (collapsed) {
		const clean = thinkingText.replace(/[\r\n]+/g, " ").trim();
		const maxSnippetLen = Math.max(10, width - 36);
		const snippet = clean.length > maxSnippetLen ? `${clean.slice(0, maxSnippetLen)}…` : clean;
		const hint = isHovered
			? `${C.suggestion}(点击 / ctrl+o 展开)${C.reset}`
			: `${C.subtle}(ctrl+o 展开 · alt+o 全量)${C.reset}`;
		const line = `${icon} ${titleText} ${C.inactive}${snippet}${C.reset} ${hint}`;
		return [truncateToWidth(line, width, ""), ""];
	}

	const hint = isHovered
		? `${C.suggestion}(点击 / ctrl+o 收起)${C.reset}`
		: `${C.subtle}(ctrl+o 收起 · alt+o 全量)${C.reset}`;
	const title = `${icon} ${titleText} ${hint}:`;
	const lines = [truncateToWidth(title, width, "")];

	const wrapped = wrapTextWithAnsi(thinkingText.trim(), Math.max(20, width - 4));
	for (const line of wrapped) {
		lines.push(`${C.subtle}│${C.reset} ${C.inactive}${C.italic}${line}${C.reset}`);
	}
	lines.push(""); // 与后续助手正文保持一空行的垂直节奏
	return lines;
}

/* ------------------------------------------------------------------ */
/* 2. 会话压缩摘要卡片                                                 */
/* ------------------------------------------------------------------ */

export interface CompactionRecord {
	summary: string;
	turnsCount: number;
	tokensSaved: number;
	collapsed: boolean;
}

function applyCardBackground(line: string, bg: string, width: number): string {
	const curW = visibleWidth(line);
	const effLine = curW > width ? truncateToWidth(line, width, "…") : line;
	const effW = curW > width ? visibleWidth(effLine) : curW;
	const padding = " ".repeat(Math.max(0, width - effW));
	const patched = effLine.replace(/\x1b\[0?m/g, `\x1b[0m${bg}`).replace(/\x1b\[49m/g, bg);
	return `${bg}${patched}${padding}${C.reset}`;
}

/**
 * 格式化渲染会话压缩卡片行
 */
export function formatCompactionCardLines(
	record: CompactionRecord,
	width = 80,
	isHovered = false,
): string[] {
	const boxW = Math.max(20, width);
	const tokenSavedStr =
		record.tokensSaved >= 1000
			? `${(record.tokensSaved / 1000).toFixed(1)}k`
			: `${record.tokensSaved}`;

	const leftDashes = "───";
	const leftW = visibleWidth(leftDashes);

	if (record.collapsed) {
		const title = " 会话已压缩 ";
		const rightDashCount = Math.max(3, boxW - leftW - visibleWidth(title));
		const topLine = `${C.subtle}${leftDashes}${C.inactive}${title}${C.subtle}${"─".repeat(rightDashCount)}${C.reset}`;

		const symbol = `${isHovered ? C.suggestion : C.inactive}∴${C.reset}`;
		const label = `${C.inactive}摘要已折叠 · ${C.reset}`;
		const hint = isHovered
			? `${C.suggestion}(点击 / ctrl+o 展开)${C.reset}`
			: `${C.inactive}(ctrl+o / 点击展开)${C.reset}`;

		const flat = record.summary.replace(/\s+/g, " ").trim();
		const budget = Math.max(8, boxW - (4 + visibleWidth("摘要已折叠 · ")) - (visibleWidth(hint) + 1));
		const preview = truncateToWidth(flat, budget, "…");
		const previewCol = isHovered ? C.text : C.inactiveShimmer;
		const rawLine = `  ${symbol} ${label}${previewCol}${preview}${C.reset} ${hint}`;

		const middleLine = isHovered
			? applyCardBackground(rawLine, C.toolCardBackground, boxW)
			: `${rawLine}${" ".repeat(Math.max(0, boxW - visibleWidth(rawLine)))}`;
		const botLine = `${C.subtle}${"─".repeat(boxW)}${C.reset}`;

		return [topLine, middleLine, botLine];
	}

	// 展开态：自适应标题
	const candidates = [
		` 会话已压缩 · 完整摘要 (已归档 ${record.turnsCount} 轮) `,
		` 会话已压缩 · 完整摘要 `,
		` 会话已压缩 `,
		"",
	];
	const title = candidates.find((t) => leftW + visibleWidth(t) + 3 <= boxW) ?? "";
	const rightDashCount = Math.max(3, boxW - leftW - visibleWidth(title));
	const topLine = `${C.subtle}${leftDashes}${C.inactive}${title}${C.subtle}${"─".repeat(rightDashCount)}${C.reset}`;

	const output: string[] = [topLine];

	// 正文自动折行与缩进
	const innerW = Math.max(10, boxW - 4);
	for (const line of wrapTextWithAnsi(record.summary.trim(), innerW)) {
		const lineContent = `  ${line}`;
		const effContent = visibleWidth(lineContent) > boxW ? truncateToWidth(lineContent, boxW, "…") : lineContent;
		output.push(`${C.text}${effContent}${" ".repeat(Math.max(0, boxW - visibleWidth(effContent)))}${C.reset}`);
	}

	// 底部统计与提示
	const arrow = `${isHovered ? C.suggestion : C.claude}↳${C.reset}`;
	const stats = `${C.success}压缩前 ~${tokenSavedStr} tokens${C.reset} · ${C.inactive}保留最近 ${record.turnsCount} 轮对话${C.reset}`;
	const hint = isHovered ? `${C.suggestion}(点击 / ctrl+o 收起)${C.reset}` : `${C.inactive}(ctrl+o / 点击收起)${C.reset}`;
	const footerRaw = `  ${arrow} ${stats} · ${hint}`;
	const effFooter = visibleWidth(footerRaw) > boxW ? truncateToWidth(footerRaw, boxW, "…") : footerRaw;
	output.push(`${effFooter}${" ".repeat(Math.max(0, boxW - visibleWidth(effFooter)))}`);
	output.push(`${C.subtle}${"─".repeat(boxW)}${C.reset}`);

	return output;
}

/* ------------------------------------------------------------------ */
/* 3. 扩展自定义卡片组件基础类与实现                                     */
/* ------------------------------------------------------------------ */

abstract class BaseCustomComponent<
	T extends { customType: string },
	R extends ((item: T, opts: { expanded: boolean }) => Component | undefined) | undefined,
> extends Container {
	constructor(
		protected readonly item: T,
		protected readonly renderer?: R,
	) {
		super();
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	protected abstract renderFallback(w: number): string[];

	private rebuild(): void {
		this.clear();
		if (this.renderer) {
			try {
				const c = this.renderer(this.item, { expanded: false });
				if (c) {
					this.addChild(c);
					return;
				}
			} catch (err) {
				this.addChild({
					render: () => [`${C.red}✗ [${this.item.customType}] 渲染失败: ${String(err)}${C.reset}`],
					invalidate: () => {},
				});
				return;
			}
		}
		this.addChild({
			render: (w: number) => this.renderFallback(w),
			invalidate: () => {},
		});
	}
}

export class CustomMessageComponent extends BaseCustomComponent<CustomMessage, MessageRenderer> {
	/** Rewind card: one declared frame width, content rows measured in display columns. */
	private renderRewindCard(w: number): string[] {
		const boxW = Math.max(32, Math.min(w, 88));
		const innerW = boxW - 6;
		const borderCol = C.yellow;
		const tag = " ⟲ 会话回溯 · 主线反思 ";
		const topFill = Math.max(2, boxW - visibleWidth(tag) - 5);
		const header = `  ${borderCol}╭─${C.bold}${C.yellow}${tag}${C.reset}${borderCol}${"─".repeat(topFill)}╮${C.reset}`;

		const rows: string[] = [];
		const addLine = (label: string, value: string, valCol = C.reset) => {
			rows.push(`${C.bold}${label}:${C.reset} ${valCol}${sanitizeRenderText(value)}${C.reset}`);
		};

		const details = this.item.details as {
			record?: { fromId: string; targetId: string; source: string; reason: string; summary?: string };
			effects?: { modifiedFiles?: readonly string[]; executedCommands?: readonly string[]; dispatchedTasks?: readonly { id: string; type: string; label?: string }[] };
		} | undefined;

		const record = details?.record;
		const effects = details?.effects;

		if (record) {
			addLine("回溯路径", `${record.fromId.slice(0, 8)} ➔ ${record.targetId.slice(0, 8)} [${record.source}]`, C.cyan);
			addLine("决策原因", record.reason, C.white);
			if (record.summary) addLine("经验摘要", record.summary, C.green);
		} else {
			for (const rawLine of sanitizeRenderText(this.item.content).split("\n").slice(0, 4)) {
				rows.push(rawLine);
			}
		}

		if (effects) {
			if (effects.modifiedFiles && effects.modifiedFiles.length > 0) {
				addLine("涉及文件", effects.modifiedFiles.join(", "), C.yellow);
			}
			if (effects.executedCommands && effects.executedCommands.length > 0) {
				addLine("已跑命令", effects.executedCommands.join(", "), C.yellow);
			}
			if (effects.dispatchedTasks && effects.dispatchedTasks.length > 0) {
				addLine("派生任务", effects.dispatchedTasks.map((t) => `${t.type}:${t.id}`).join(", "), C.yellow);
			}
		}

		rows.push(`${C.gray}退出路径已转为只读历史，可用 /history 检视${C.reset}`);

		const body = rows.map((row) => {
			const text = truncateToWidth(stripAnsi(row), innerW, "");
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(Math.max(0, innerW - visibleWidth(text)))} ${borderCol}│${C.reset}`;
		});

		const footer = `  ${borderCol}╰${"─".repeat(boxW - 4)}╯${C.reset}`;
		return [header, ...body, footer];
	}

	protected renderFallback(w: number): string[] {
		if (this.item.customType === "session-rewind") {
			return this.renderRewindCard(w);
		}
		const boxW = Math.max(24, Math.min(w, 80));
		const innerW = boxW - 6;
		const tag = `[${this.item.customType}]`;
		const borderCol = C.blue;
		const header = `  ${borderCol}╭─ ${C.bold}${tag}${C.reset}${borderCol} ${"─".repeat(Math.max(2, boxW - visibleWidth(tag) - 7))}╮${C.reset}`;
		const rawLines = sanitizeRenderText(this.item.content + imageNotice(this.item.images)).replace(/\r\n/g, "\n").split("\n");
		const bodyLines = rawLines.map((line) => {
			const text = truncateToWidth(stripAnsi(line), innerW, "");
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(Math.max(0, innerW - visibleWidth(text)))} ${borderCol}│${C.reset}`;
		});
		const footer = `  ${borderCol}╰${"─".repeat(boxW - 4)}╯${C.reset}`;
		return [header, ...bodyLines, footer];
	}
}

export class CustomEntryComponent extends BaseCustomComponent<CustomEntry, EntryRenderer> {
	protected renderFallback(w: number): string[] {
		const tag = `[条目: ${this.item.customType}]`;
		let preview = "(无附带数据)";
		if (this.item.data !== undefined) {
			try {
				preview = sanitizeRenderText(JSON.stringify(this.item.data) ?? "null");
			} catch {
				preview = "[无法序列化的数据]";
			}
		}
		return [`  ${C.gray}◈ ${C.cyan}${tag}${C.reset} ${truncateToWidth(preview, Math.max(10, w - 20))}`];
	}
}
