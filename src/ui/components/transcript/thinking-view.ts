/**
 * 思考链流式展示与格式化组件（复刻 dsh-TUI ThinkingToggle.tsx 与 ReasoningBlock 规范）。
 * 特性：
 * 1. 深度思考流式输出归属于消息对话流，绝不脱离上下文附着在输入框上；
 * 2. 默认收起态：嵌入对话流中，占单行，带圆润折叠标记 `▶ 思考过程: 摘要... [Ctrl+O 展开]`；
 * 3. 展开态：原地舒展出带暗色细线竖标 `│` 的完整结构化推理正文；
 * 4. 思考流式进行中支持动态展开（实时滚屏 + 闪烁光标）与收起；
 * 5. 支持全局快捷键 Ctrl+O / 鼠标点击在对话历史中自由展开/收起任意轮次。
 */

import type { Component } from "../../core/types.js";
import { C, truncateToWidth, wrapTextWithAnsi } from "../../core/utils.js";

/** 格式化对话流内部的思考链块（永久行） */
export function formatThinkingLines(
	thinkingText: string,
	collapsed = true,
	width = 80,
): string[] {
	if (!thinkingText || !thinkingText.trim()) {
		return [];
	}

	const lines: string[] = [];

	if (collapsed) {
		const clean = thinkingText.replace(/[\r\n]+/g, " ").trim();
		const maxSnippetLen = Math.max(15, width - 42);
		const snippet = clean.length > maxSnippetLen ? `${clean.slice(0, maxSnippetLen)}…` : clean;
		const line = `  ${C.cyan}⚓ ${C.bold}思考${C.reset} ${C.dim}${snippet} (ctrl+o 展开 · alt+o 全量)${C.reset}`;
		lines.push(truncateToWidth(line, width));
	} else {
		const title = `  ${C.cyan}⚓ ${C.bold}思考${C.reset} ${C.dim}(ctrl+o 收起 · alt+o 全量):${C.reset}`;
		lines.push(truncateToWidth(title, width));

		const wrapped = wrapTextWithAnsi(thinkingText.trim(), Math.max(20, width - 6));
		for (const line of wrapped) {
			lines.push(`  ${C.gray}│${C.reset} ${C.dim}${line}${C.reset}`);
		}
	}
	lines.push(""); // 与后续助手正文保持一空行的优雅垂直节奏
	return lines;
}

export class ThinkingViewComponent implements Component {
	private thinkingText = "";
	private active = false;
	private collapsed = true;

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

	setCollapsed(c: boolean): void {
		this.collapsed = c;
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
	}

	reset(): void {
		this.thinkingText = "";
		this.active = false;
		this.collapsed = true;
	}

	finish(): void {
		this.active = false;
	}

	render(width: number): string[] {
		if (!this.active || !this.thinkingText) {
			return [];
		}

		if (this.collapsed) {
			// 收起态：单行动态思考指示器 + 实时截断摘要
			const clean = this.thinkingText.replace(/[\r\n]+/g, " ").trim();
			const maxLen = Math.max(15, width - 42);
			const snippet = clean.length > maxLen ? `${clean.slice(-maxLen)}...` : clean;
			const title = `${C.iceBlue}⠋${C.reset} ${C.dim}思考中: ${snippet} ${C.gray}[Ctrl+O 展开实时思考]${C.reset}`;
			return [truncateToWidth(`  ${title}`, width), ""];
		}

		// 展开态：显示实时流式思考框（多行带有动态光标 █）
		const title = `${C.iceBlue}▼${C.reset} ${C.dim}正在深度推理 (DeepSeek-R1) ${C.gray}[Ctrl+O 收起]:${C.reset}`;
		const lines: string[] = [truncateToWidth(`  ${title}`, width)];
		const wrapped = wrapTextWithAnsi(this.thinkingText.trim(), Math.max(20, width - 6));

		const maxVisibleLines = 10;
		const displayLines = wrapped.slice(-maxVisibleLines);
		if (wrapped.length > maxVisibleLines) {
			lines.push(`  ${C.gray}│${C.reset} ${C.dim}... (前略 ${wrapped.length - maxVisibleLines} 行) ...${C.reset}`);
		}
		for (let i = 0; i < displayLines.length; i++) {
			const isLast = i === displayLines.length - 1;
			const cursor = isLast ? `${C.iceBlue}█${C.reset}` : "";
			lines.push(`  ${C.gray}│${C.reset} ${C.dim}${displayLines[i]}${cursor}${C.reset}`);
		}
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}
