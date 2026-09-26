/**
 * 终端后台任务看板组件（TaskDashboard）。
 * 遵循无状态 View 规范：状态唯一归属内核 JobRegistry，
 * 本组件只管理视图光标、分屏焦点与滚动位置，彻底杜绝数据复制与模拟假数据。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, truncateToWidth } from "../../core/utils.js";
import type { JobSnapshot, JobStatus, JobRead } from "../../../extensions/jobs/registry.js";
import { formatDuration } from "../../format.js";
import {
	panelGeometry,
	panelTopLine,
	panelRow,
	panelDivider,
	panelEmpty,
	panelBottomLine,
	panelWindow,
	panelTailSlice,
} from "../../components/primitives/panel.js";

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
		const geo = panelGeometry(terminalWidth);
		const { innerW } = geo;
		const tasks = this.jobPort.list();

		// 1. 顶栏：运行指标统计
		const runningCount = tasks.filter((t) => t.status === "running").length;
		const completedCount = tasks.filter((t) => t.status === "completed").length;
		const failedCount = tasks.filter((t) => t.status === "failed" || t.status === "killed").length;
		const titleTag = `─ 后台任务与进程看板 (${runningCount} 运行 · ${completedCount} 完成 · ${failedCount} 退出) `;

		if (tasks.length === 0) {
			return panelEmpty(geo, titleTag, `${C.dim}暂无正在运行或历史后台作业 (按 Esc 关闭)${C.reset}`);
		}

		const output: string[] = [panelTopLine(geo, titleTag)];

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
			output.push(panelRow(geo, truncateToWidth(logHeader, innerW)));
			output.push(panelDivider(geo));

			for (const line of panelTailSlice(rawLogLines, maxLogRows, this.logScrollOffset, innerW)) {
				output.push(panelRow(geo, line));
			}
		} else {
			// 上下双分屏模式
			// 上部：任务列表（带动态滑动视口，上限 4 行）
			const maxListRows = 4;
			const { start: windowStart, end: windowEnd } = panelWindow(tasks.length, this.selectedIndex, maxListRows);

			for (let i = windowStart; i < windowEnd; i++) {
				const t = tasks[i]!;
				const isSelected = i === this.selectedIndex;
				const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const statusIcon = formatJobStatusIcon(t.status);
				const duration = formatDuration((t.finishedAt ?? Date.now()) - t.startedAt);
				const label = truncateToWidth(t.label, 24);
				const src = `${t.source.extension}${t.source.operation ? `/${t.source.operation}` : ""}`;

				output.push(panelRow(geo, `${pointer} ${statusIcon} ${C.bold}${label}${C.reset}  ${C.dim}[${src}] · ${duration}${C.reset}`));
			}

			// 分割线
			const scrollHint = tasks.length > maxListRows ? ` (${this.selectedIndex + 1}/${tasks.length}) ` : "";
			output.push(panelDivider(geo, `─ 实时输出 (Tail)${scrollHint}─`));

			// 下部：日志窗口（固定 5 行）
			for (const line of panelTailSlice(rawLogLines, 5, this.logScrollOffset, innerW)) {
				output.push(panelRow(geo, line));
			}
		}

		// 底边框
		output.push(panelBottomLine(geo, `↑↓ 导航 · K 终止 · Tab 切换 · Enter 放大 · Esc 关闭`));

		return output;
	}
}

/** 任务状态图标（TaskDashboard 与外部消费者共用一套语义）。 */
function formatJobStatusIcon(status: JobStatus): string {
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
