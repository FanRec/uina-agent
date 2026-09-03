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

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSec = seconds % 60;
	return `${minutes}m${remSec}s`;
}

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

		// 2. 渲染各智能体卡片
		for (let i = 0; i < agents.length; i++) {
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

			if (i < agents.length - 1) {
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
