/**
 * 思考链流式展示与格式化组件（全面对齐 dsh-TUI 规范，支持 ✦ 图标与零边距左对齐）。
 * 特性：
 * 1. 深度思考流式输出归属于消息对话流，绝不脱离上下文附着在输入框上；
 * 2. 默认收起态：嵌入对话流中，占单行，带璀璨四角星 `✦ 思考 · 1s (ctrl+o 展开 · alt+o 全量)`；
 * 3. 展开态：原地舒展出带暗色细线竖标 `│` 的完整结构化推理正文；
 * 4. 思考流式进行中支持动态展开与收起；
 * 5. 支持鼠标悬停高亮与单击展开/收起。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth, wrapTextWithAnsi } from "../../core/utils.js";

/** 格式化对话流内部的思考链块（永久行） */
export function formatThinkingLines(
	thinkingText: string,
	collapsed = true,
	width = 80,
	isHovered = false,
): string[] {
	if (!thinkingText || !thinkingText.trim()) {
		return [];
	}

	const lines: string[] = [];
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
		lines.push(truncateToWidth(line, width, ""));
	} else {
		const hint = isHovered
			? `${C.suggestion}(点击 / ctrl+o 收起)${C.reset}`
			: `${C.subtle}(ctrl+o 收起 · alt+o 全量)${C.reset}`;
		const title = `${icon} ${titleText} ${hint}:`;
		lines.push(truncateToWidth(title, width, ""));

		const wrapped = wrapTextWithAnsi(thinkingText.trim(), Math.max(20, width - 4));
		for (const line of wrapped) {
			lines.push(`${C.subtle}│${C.reset} ${C.inactive}${C.italic}${line}${C.reset}`);
		}
	}
	lines.push(""); // 与后续助手正文保持一空行的垂直节奏
	return lines;
}

export class ThinkingViewComponent implements Component {
	private thinkingText = "";
	private active = false;
	private collapsed = true;
	private isHovered = false;

	appendThinking(text: string): void {
		this.thinkingText += text;
		this.active = true;
	}

	isActive(): boolean {
		return this.active;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
	}

	setHovered(hovered: boolean): void {
		this.isHovered = hovered;
	}

	clear(): void {
		this.thinkingText = "";
		this.active = false;
		this.collapsed = true;
		this.isHovered = false;
	}

	render(width: number): string[] {
		if (!this.active || !this.thinkingText.trim()) return [];
		return formatThinkingLines(this.thinkingText, this.collapsed, width, this.isHovered);
	}

	invalidate(): void {}
}
