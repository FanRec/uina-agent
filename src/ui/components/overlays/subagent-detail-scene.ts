/**
 * 子智能体二级审查详情页组件（SubagentDetailScene）。
 * 针对指定子代理提供全量输出流与完整历史会话审查。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import type { SubagentSnapshot } from "../../../extensions/subagents/types.js";
import type { SubagentPort } from "../../adapters/subagents.js";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSec = seconds % 60;
	return `${minutes}m${remSec}s`;
}

export class SubagentDetailScene implements Component, Focusable {
	focused = true;
	private activeTab: "logs" | "transcript" = "logs";
	private scrollOffset = 0;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(
		private subagent: SubagentSnapshot,
		private readonly subagentPort: SubagentPort,
		private readonly ownerId = "root",
	) {}

	setSubagent(subagent: SubagentSnapshot): void {
		this.subagent = subagent;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.activeTab = this.activeTab === "logs" ? "transcript" : "logs";
			this.scrollOffset = 0;
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.scrollOffset++;
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.onRequestRender?.();
			return;
		}

		if (data === "i" || data === "I") {
			if (this.subagent.status === "running" || this.subagent.status === "accepted") {
				void this.subagentPort.interrupt(this.subagent.id, this.ownerId).then(() => {
					this.onRequestRender?.();
				});
			}
		}
	}

	render(terminalWidth = 80): string[] {
		return this.formatLines(terminalWidth, 24);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, terminalHeight = 24): string[] {
		const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const duration = formatDuration((this.subagent.finishedAt ?? Date.now()) - this.subagent.createdAt);

		// 1. 顶边框
		const titleTag = `─ 子智能体审查: ${this.subagent.label} (${duration}) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;
		const output: string[] = [topLine];

		// 2. Tab 栏
		const tab1 = this.activeTab === "logs"
			? `\x1b[7m 输出流 (Logs) \x1b[0m`
			: `${C.dim} 输出流 (Logs) ${C.reset}`;
		const tab2 = this.activeTab === "transcript"
			? `\x1b[7m 对话历史 (Transcript) \x1b[0m`
			: `${C.dim} 对话历史 (Transcript) ${C.reset}`;
		const tabRow = `  ${borderCol}│${C.reset} [Tab] ${tab1}  ${tab2}${" ".repeat(Math.max(0, innerW - visibleWidth(tab1) - visibleWidth(tab2) - 8))} ${borderCol}│${C.reset}`;
		output.push(tabRow);
		output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

		// 3. 内容区
		const maxRows = Math.max(6, terminalHeight - 8);
		let contentLines: string[] = [];

		if (this.activeTab === "logs") {
			const readRes = this.subagentPort.read(this.subagent.id, this.ownerId, 0);
			contentLines = readRes.output.map((o) => `[${o.kind}] ${o.text}`);
		} else {
			const trRes = this.subagentPort.transcript(this.subagent.id, this.ownerId);
			contentLines = trRes.messages.map((m) => {
				const role = m.role.toUpperCase();
				const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return `${C.bold}${role}:${C.reset} ${text}`;
			});
		}

		if (contentLines.length === 0) {
			contentLines = [`${C.dim}(暂无数据记录)${C.reset}`];
		}

		const end = Math.max(0, contentLines.length - this.scrollOffset);
		const start = Math.max(0, end - maxRows);
		const sliced = contentLines.slice(start, end);
		while (sliced.length < maxRows) {
			sliced.push("");
		}

		for (const line of sliced) {
			const truncated = truncateToWidth(line, innerW);
			output.push(`  ${borderCol}│${C.reset} ${truncated}${" ".repeat(Math.max(0, innerW - visibleWidth(truncated)))} ${borderCol}│${C.reset}`);
		}

		// 4. 底边框
		const hint = `Tab 切换标签 · ↑↓ 滚动 · I 中断 · Esc 返回`;
		const botFill = Math.max(1, boxWidth - 2 - visibleWidth(hint) - 2);
		output.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);

		return output;
	}
}
