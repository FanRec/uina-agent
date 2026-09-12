/**
 * 多子智能体看板组件（SubagentDashboard）。
 * 遵循无状态 View 规范：状态唯一归属于内核 SubagentRegistry，
 * 本组件只负责卡片排版、光标聚焦与下钻指令派发，彻底消除假数据。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import type { SubagentSnapshot, SubagentStatus } from "../../../extensions/subagents/types.js";
import type { SubagentPort } from "../../adapters/subagents.js";
import { formatDuration } from "../../format.js";

export class SubagentDashboard implements Component, Focusable {
	focused = true;
	private selectedIndex = 0;

	onClose?: () => void;
	onDrilldown?: (subagent: SubagentSnapshot) => void;
	onRequestRender?: () => void;

	constructor(
		private readonly subagentPort: SubagentPort,
		private readonly ownerId = "root",
	) {}

	handleInput(data: string): void {
		const agents = this.subagentPort.list(this.ownerId);

		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(Math.max(0, agents.length - 1), this.selectedIndex + 1);
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const current = agents[this.selectedIndex];
			if (current) {
				this.onDrilldown?.(current);
			}
			return;
		}

		if (data === "i" || data === "I") {
			const current = agents[this.selectedIndex];
			if (current && (current.status === "running" || current.status === "accepted")) {
				void this.subagentPort.interrupt(current.id, this.ownerId).then(() => {
					this.onRequestRender?.();
				});
			}
		}
	}

	render(terminalWidth = 80): string[] {
		return this.formatLines(terminalWidth);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80): string[] {
		const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const agents = this.subagentPort.list(this.ownerId);

		// 1. 顶栏：统计
		const runningCount = agents.filter((a) => a.status === "running" || a.status === "accepted").length;
		const settledCount = agents.filter((a) => a.status === "settled").length;
		const failedCount = agents.filter((a) => a.status === "failed" || a.status === "interrupted").length;

		const titleTag = `─ 多子智能体看板 (${runningCount} 活跃 · ${settledCount} 结算 · ${failedCount} 中断/失败) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		const output: string[] = [topLine];

		if (agents.length === 0) {
			const emptyText = `${C.dim}当前暂无派生的子智能体 (按 Esc 关闭)${C.reset}`;
			const padLen = Math.max(0, innerW - visibleWidth(emptyText));
			output.push(`  ${borderCol}│${C.reset} ${emptyText}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`);
			return output;
		}

		if (this.selectedIndex >= agents.length) {
			this.selectedIndex = Math.max(0, agents.length - 1);
		}

		// 2. 渲染各智能体卡片（带滑动视口，最多显示 4 个）
		const maxVisible = 4;
		const windowStart = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), Math.max(0, agents.length - maxVisible)),
		);
		const windowEnd = Math.min(agents.length, windowStart + maxVisible);

		for (let i = windowStart; i < windowEnd; i++) {
			const a = agents[i]!;
			const isSelected = i === this.selectedIndex;
			const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
			const statusIcon = this.formatStatus(a.status);
			const duration = formatDuration((a.finishedAt ?? Date.now()) - a.createdAt);
			const label = truncateToWidth(a.label, 32);

			// 读取末行实时日志
			const readRes = this.subagentPort.read(a.id, this.ownerId, Math.max(0, a.outputCursor - 1));
			const latestOut = readRes.output.at(-1)?.text.replace(/\r?\n/g, " ") ?? "";
			const liveLine = latestOut ? `${C.dim}末行: ${truncateToWidth(latestOut, 36)}${C.reset}` : "";

			const line1 = `${pointer} ${statusIcon} ${C.bold}${label}${C.reset}  ${C.dim}[ID: ${a.id.slice(-8)}] · ${duration}${C.reset}`;
			output.push(`  ${borderCol}│${C.reset} ${line1}${" ".repeat(Math.max(0, innerW - visibleWidth(line1)))} ${borderCol}│${C.reset}`);

			if (liveLine) {
				const line2 = `    ${liveLine}`;
				output.push(`  ${borderCol}│${C.reset} ${line2}${" ".repeat(Math.max(0, innerW - visibleWidth(line2)))} ${borderCol}│${C.reset}`);
			}

			if (i < windowEnd - 1) {
				output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);
			}
		}

		// 3. 底边框
		const hint = `↑↓ 导航 · Enter 深入审查 · I 中断 · Esc 关闭`;
		const botFill = Math.max(1, boxWidth - 2 - visibleWidth(hint) - 2);
		output.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);

		return output;
	}

	private formatStatus(status: SubagentStatus): string {
		switch (status) {
			case "running":
			case "accepted":
				return `${C.yellow}●${C.reset}`;
			case "waiting":
				return `${C.blue}◐${C.reset}`;
			case "settled":
				return `${C.green}✓${C.reset}`;
			case "interrupted":
				return `${C.gray}○${C.reset}`;
			case "failed":
				return `${C.red}✗${C.reset}`;
			default:
				return `${C.dim}?${C.reset}`;
		}
	}
}

/**
 * 子智能体二级审查详情页组件（SubagentDetailScene）。
 * 针对指定子代理提供全量输出流与完整历史会话审查。
 */
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

		const flatten = (prefix: string, text: string): string[] =>
			text.replace(/\r\n/g, "\n").split("\n").map((line) => `${prefix}${line}`);
		if (this.activeTab === "logs") {
			const readRes = this.subagentPort.read(this.subagent.id, this.ownerId, 0);
			contentLines = readRes.output.flatMap((o) => flatten(`[${o.kind}] `, o.text));
		} else {
			const trRes = this.subagentPort.transcript(this.subagent.id, this.ownerId);
			contentLines = trRes.messages.flatMap((m) => {
				const role = m.role.toUpperCase();
				const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return flatten(`${C.bold}${role}:${C.reset} `, text);
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
