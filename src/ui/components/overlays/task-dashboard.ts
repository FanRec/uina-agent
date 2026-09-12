/**
 * 终端后台任务看板组件（TaskDashboard）。
 * 遵循无状态 View 规范：状态唯一归属内核 JobRegistry，
 * 本组件只管理视图光标、分屏焦点与滚动位置，彻底杜绝数据复制与模拟假数据。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import type { JobSnapshot, JobStatus, JobRead } from "../../../extensions/jobs/registry.js";
import { formatDuration } from "../../format.js";

export interface JobPort {
	list(): JobSnapshot[];
	read(id: string, fromCursor?: number): JobRead;
	cancel(id: string, reason?: string): boolean;
}

export class TaskDashboard implements Component, Focusable {
	focused = true;
	private selectedIndex = 0;
	private logScrollOffset = 0;
	private isMaximizedLog = false;
	private focusTarget: "list" | "logs" = "list";

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(private readonly jobPort: JobPort) {}

	handleInput(data: string): void {
		const tasks = this.jobPort.list();

		if (matchesKey(data, Key.escape)) {
			if (this.isMaximizedLog) {
				this.isMaximizedLog = false;
			} else {
				this.onClose?.();
			}
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.focusTarget = this.focusTarget === "list" ? "logs" : "list";
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.isMaximizedLog = !this.isMaximizedLog;
			this.onRequestRender?.();
			return;
		}

		if (this.focusTarget === "list" && !this.isMaximizedLog) {
			if (matchesKey(data, Key.up)) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.logScrollOffset = 0;
				this.onRequestRender?.();
			} else if (matchesKey(data, Key.down)) {
				this.selectedIndex = Math.min(Math.max(0, tasks.length - 1), this.selectedIndex + 1);
				this.logScrollOffset = 0;
				this.onRequestRender?.();
			} else if (data === "k" || data === "K") {
				const current = tasks[this.selectedIndex];
				if (current && (current.status === "running" || current.status === "stopping")) {
					this.jobPort.cancel(current.id, "用户手动终止");
					this.onRequestRender?.();
				}
			}
		} else {
			// 日志滚动模式
			if (matchesKey(data, Key.up)) {
				this.logScrollOffset++;
				this.onRequestRender?.();
			} else if (matchesKey(data, Key.down)) {
				this.logScrollOffset = Math.max(0, this.logScrollOffset - 1);
				this.onRequestRender?.();
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
		const tasks = this.jobPort.list();

		// 1. 顶栏：运行指标统计
		const runningCount = tasks.filter((t) => t.status === "running").length;
		const completedCount = tasks.filter((t) => t.status === "completed").length;
		const failedCount = tasks.filter((t) => t.status === "failed" || t.status === "killed").length;

		const titleTag = `─ 后台任务与进程看板 (${runningCount} 运行 · ${completedCount} 完成 · ${failedCount} 退出) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		const output: string[] = [topLine];

		if (tasks.length === 0) {
			const emptyText = `${C.dim}暂无正在运行或历史后台作业 (按 Esc 关闭)${C.reset}`;
			const padLen = Math.max(0, innerW - visibleWidth(emptyText));
			output.push(`  ${borderCol}│${C.reset} ${emptyText}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`);
			return output;
		}

		if (this.selectedIndex >= tasks.length) {
			this.selectedIndex = Math.max(0, tasks.length - 1);
		}

		const currentTask = tasks[this.selectedIndex]!;
		// 直接向 JobPort 读取当前任务的实时日志
		const readResult = this.jobPort.read(currentTask.id, 0);
		const rawLogLines = readResult.text ? readResult.text.split("\n") : [];

		if (this.isMaximizedLog) {
			// 全屏单栏日志透视
			const maxLogRows = Math.max(6, terminalHeight - 8);
			const logHeader = `${C.bold}${C.cyan}▸ ${currentTask.label} 日志透视 (按 Enter 还原双屏)${C.reset}`;
			output.push(`  ${borderCol}│${C.reset} ${truncateToWidth(logHeader, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(logHeader)))} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

			const visibleLogLines = this.sliceLogs(rawLogLines, maxLogRows, innerW);
			for (const line of visibleLogLines) {
				output.push(`  ${borderCol}│${C.reset} ${line}${" ".repeat(Math.max(0, innerW - visibleWidth(line)))} ${borderCol}│${C.reset}`);
			}
		} else {
			// 上下双分屏模式
			// 上部：任务列表（带动态滑动视口，上限 4 行）
			const maxListRows = 4;
			const windowStart = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxListRows / 2), Math.max(0, tasks.length - maxListRows)),
			);
			const windowEnd = Math.min(tasks.length, windowStart + maxListRows);

			for (let i = windowStart; i < windowEnd; i++) {
				const t = tasks[i]!;
				const isSelected = i === this.selectedIndex;
				const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const statusIcon = this.formatStatus(t.status);
				const duration = formatDuration((t.finishedAt ?? Date.now()) - t.startedAt);
				const label = truncateToWidth(t.label, 24);
				const src = `${t.source.extension}${t.source.operation ? `/${t.source.operation}` : ""}`;

				const content = `${pointer} ${statusIcon} ${C.bold}${label}${C.reset}  ${C.dim}[${src}] · ${duration}${C.reset}`;
				output.push(`  ${borderCol}│${C.reset} ${content}${" ".repeat(Math.max(0, innerW - visibleWidth(content)))} ${borderCol}│${C.reset}`);
			}

			// 分割线
			const scrollHint = tasks.length > maxListRows ? ` (${this.selectedIndex + 1}/${tasks.length}) ` : "";
			const splitTag = `─ 实时输出 (Tail)${scrollHint}─`;
			const splitFill = Math.max(1, boxWidth - 2 - visibleWidth(splitTag));
			output.push(`  ${borderCol}├${splitTag}${"─".repeat(splitFill)}┤${C.reset}`);

			// 下部：日志窗口（固定 5 行）
			const visibleLogs = this.sliceLogs(rawLogLines, 5, innerW);
			for (const line of visibleLogs) {
				output.push(`  ${borderCol}│${C.reset} ${line}${" ".repeat(Math.max(0, innerW - visibleWidth(line)))} ${borderCol}│${C.reset}`);
			}
		}

		// 底边框
		const hint = `↑↓ 导航 · K 终止 · Tab 切换 · Enter 放大 · Esc 关闭`;
		const botFill = Math.max(1, boxWidth - 2 - visibleWidth(hint) - 2);
		output.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);

		return output;
	}

	private sliceLogs(logs: string[], maxRows: number, innerW: number): string[] {
		if (logs.length === 0) {
			return [`${C.dim}(暂无输出日志)${C.reset}`];
		}
		const end = Math.max(0, logs.length - this.logScrollOffset);
		const start = Math.max(0, end - maxRows);
		const sliced = logs.slice(start, end);
		while (sliced.length < maxRows) {
			sliced.push("");
		}
		return sliced.map((l) => truncateToWidth(l, innerW));
	}

	private formatStatus(status: JobStatus): string {
		switch (status) {
			case "running":
				return `${C.green}●${C.reset}`;
			case "stopping":
				return `${C.yellow}◐${C.reset}`;
			case "completed":
				return `${C.cyan}✓${C.reset}`;
			case "killed":
				return `${C.gray}○${C.reset}`;
			case "failed":
				return `${C.red}✗${C.reset}`;
			default:
				return `${C.dim}?${C.reset}`;
		}
	}
}
