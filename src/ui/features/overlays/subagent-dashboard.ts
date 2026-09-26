/**
 * 多子智能体看板组件（SubagentDashboard）。
 * 遵循无状态 View 规范：状态唯一归属于内核 SubagentRegistry，
 * 本组件只负责卡片排版、光标聚焦与下钻指令派发，彻底消除假数据。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import type { SubagentSnapshot, SubagentStatus } from "../../../extensions/subagents/types.js";
import { formatDuration } from "../../format.js";
import {
	panelGeometry,
	panelTopLine,
	panelRow,
	panelDivider,
	panelEmpty,
	panelBottomLine,
	panelWindow,
} from "../../components/primitives/panel.js";

export interface SubagentPort {
	list(ownerId?: string): SubagentSnapshot[];
	read(id: string, ownerId: string, cursor?: number): SubagentRead;
	transcript(id: string, ownerId: string): SubagentTranscript;
	send(id: string, ownerId: string, text: string): Promise<void>;
	interrupt(id: string, ownerId: string): Promise<"interruption-requested" | "already-finished">;
	subscribe?(listener: () => void): () => void;
}

import type { SubagentRead, SubagentTranscript } from "../../../extensions/subagents/types.js";

export class SubagentDashboard implements Component, Focusable {
	focused = true;
	private selectedIndex = 0;

	onClose?: () => void;
	onDispose?: () => void;
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
		const geo = panelGeometry(terminalWidth);
		const agents = this.subagentPort.list(this.ownerId);

		// 1. 顶栏：统计
		const runningCount = agents.filter((a) => a.status === "running" || a.status === "accepted").length;
		const settledCount = agents.filter((a) => a.status === "settled").length;
		const failedCount = agents.filter((a) => a.status === "failed" || a.status === "interrupted").length;
		const titleTag = `─ 多子智能体看板 (${runningCount} 活跃 · ${settledCount} 结算 · ${failedCount} 中断/失败) `;

		if (agents.length === 0) {
			return panelEmpty(geo, titleTag, `${C.dim}当前暂无派生的子智能体 (按 Esc 关闭)${C.reset}`);
		}

		if (this.selectedIndex >= agents.length) {
			this.selectedIndex = Math.max(0, agents.length - 1);
		}

		const output: string[] = [panelTopLine(geo, titleTag)];

		// 2. 渲染各智能体卡片（带滑动视口，最多显示 4 个）
		const { start: windowStart, end: windowEnd } = panelWindow(agents.length, this.selectedIndex, 4);

		for (let i = windowStart; i < windowEnd; i++) {
			const a = agents[i]!;
			const isSelected = i === this.selectedIndex;
			const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
			const statusIcon = formatSubagentStatusIcon(a.status);
			const duration = formatDuration((a.finishedAt ?? Date.now()) - a.createdAt);
			const label = truncateToWidth(a.label, 32);

			// 读取末行实时日志
			const readRes = this.subagentPort.read(a.id, this.ownerId, Math.max(0, a.outputCursor - 1));
			const latestOut = readRes.output.at(-1)?.text.replace(/\r?\n/g, " ") ?? "";
			const liveLine = latestOut ? `${C.dim}末行: ${truncateToWidth(latestOut, 36)}${C.reset}` : "";

			output.push(panelRow(geo, `${pointer} ${statusIcon} ${C.bold}${label}${C.reset}  ${C.dim}[ID: ${a.id.slice(-8)}] · ${duration}${C.reset}`));

			if (liveLine) {
				output.push(panelRow(geo, `    ${liveLine}`));
			}

			if (i < windowEnd - 1) {
				output.push(panelDivider(geo));
			}
		}

		// 3. 底边框
		output.push(panelBottomLine(geo, `↑↓ 导航 · Enter 深入审查 · I 中断 · Esc 关闭`));

		return output;
	}
}

/** 子代理状态图标（列表与详情页共用一套语义）。 */
function formatSubagentStatusIcon(status: SubagentStatus): string {
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

export type DetailAction = "close" | "toggleTab" | "scrollUp" | "scrollDown" | "interrupt" | "none";

const DETAIL_NAV: ReadonlyArray<{ key: string; action: DetailAction }> = [
	{ key: Key.escape, action: "close" },
	{ key: Key.tab, action: "toggleTab" },
	{ key: Key.up, action: "scrollUp" },
	{ key: Key.down, action: "scrollDown" },
];

/** 中断只对活跃子代理生效（列表页与详情页共用同一语义）。 */
export function isInterruptible(status: SubagentStatus): boolean {
	return status === "running" || status === "accepted";
}

/** 详情页 Tab 切换（纯函数）。 */
export function nextDetailTab(tab: "logs" | "transcript"): "logs" | "transcript" {
	return tab === "logs" ? "transcript" : "logs";
}

/** 详情页按键 → 动作（纯函数；I/i 仅在可中断状态下生效）。 */
export function detailKeyAction(data: string, status: SubagentStatus): DetailAction {
	for (const { key, action } of DETAIL_NAV) {
		if (matchesKey(data, key)) return action;
	}
	if ((data === "i" || data === "I") && isInterruptible(status)) return "interrupt";
	return "none";
}

/** 多行文本按前缀拍平成单行数组（\\r\\n 归一为 \\n）。 */
export function flattenLines(prefix: string, text: string): string[] {
	return text.replace(/\r\n/g, "\n").split("\n").map((line) => `${prefix}${line}`);
}

/** Tab 栏：激活项反显，按内宽补齐尾随空格（纯函数）。 */
export function formatDetailTabBar(activeTab: "logs" | "transcript", innerW: number): string {
	const tab1 = activeTab === "logs"
		? `\x1b[7m 输出流 (Logs) \x1b[0m`
		: `${C.dim} 输出流 (Logs) ${C.reset}`;
	const tab2 = activeTab === "transcript"
		? `\x1b[7m 对话历史 (Transcript) \x1b[0m`
		: `${C.dim} 对话历史 (Transcript) ${C.reset}`;
	const padTabs = Math.max(0, innerW - visibleWidth(tab1) - visibleWidth(tab2) - 8);
	return `[Tab] ${tab1}  ${tab2}${" ".repeat(padTabs)}`;
}

/** 滚动视口切片：scrollOffset 从尾部计，不足 maxRows 补空行（纯函数）。 */
export function sliceContentWindow(lines: string[], scrollOffset: number, maxRows: number): string[] {
	const end = Math.max(0, lines.length - scrollOffset);
	const start = Math.max(0, end - maxRows);
	const sliced = lines.slice(start, end);
	while (sliced.length < maxRows) {
		sliced.push("");
	}
	return sliced;
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
	onDispose?: () => void;
	onRequestRender?: () => void;

	constructor(
	private readonly subagentId: string,
		private readonly subagentPort: SubagentPort,
		private readonly ownerId = "root",
	) {}

	handleInput(data: string): void {
		const current = this.subagentPort.list(this.ownerId).find((item) => item.id === this.subagentId);
		const action = detailKeyAction(data, current?.status ?? "settled");
		switch (action) {
			case "close":
				this.onClose?.();
				return;
			case "toggleTab":
				this.activeTab = nextDetailTab(this.activeTab);
				this.scrollOffset = 0;
				this.onRequestRender?.();
				return;
			case "scrollUp":
				this.scrollOffset++;
				this.onRequestRender?.();
				return;
			case "scrollDown":
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.onRequestRender?.();
				return;
			case "interrupt":
				void this.subagentPort.interrupt(this.subagentId, this.ownerId).then(() => {
					this.onRequestRender?.();
				});
				return;
			case "none":
				return;
		}
	}

	render(terminalWidth = 80): string[] {
		return this.formatLines(terminalWidth, 24);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, terminalHeight = 24): string[] {
		const geo = panelGeometry(terminalWidth);
		const { innerW } = geo;
		const subagent = this.subagentPort.list(this.ownerId).find((item) => item.id === this.subagentId);
		if (!subagent) return panelEmpty(geo, "─ 子智能体审查 ", `${C.dim}子智能体已不可用 (按 Esc 返回)${C.reset}`);
		const duration = formatDuration((subagent.finishedAt ?? Date.now()) - subagent.createdAt);

		// 1. 顶边框
		const output: string[] = [panelTopLine(geo, `─ 子智能体审查: ${subagent.label} (${duration}) `)];

		// 2. Tab 栏
		output.push(panelRow(geo, formatDetailTabBar(this.activeTab, innerW)));
		output.push(panelDivider(geo));

		// 3. 内容区
		const maxRows = Math.max(6, terminalHeight - 8);
		let contentLines: string[] = [];

		if (this.activeTab === "logs") {
			const readRes = this.subagentPort.read(this.subagentId, this.ownerId, 0);
			contentLines = readRes.output.flatMap((o) => flattenLines(`[${o.kind}] `, o.text));
		} else {
			const trRes = this.subagentPort.transcript(this.subagentId, this.ownerId);
			contentLines = trRes.messages.flatMap((m) => {
				const role = m.role.toUpperCase();
				const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return flattenLines(`${C.bold}${role}:${C.reset} `, text);
			});
		}

		if (contentLines.length === 0) {
			contentLines = [`${C.dim}(暂无数据记录)${C.reset}`];
		}

		for (const line of sliceContentWindow(contentLines, this.scrollOffset, maxRows)) {
			output.push(panelRow(geo, truncateToWidth(line, innerW)));
		}

		// 4. 底边框
		output.push(panelBottomLine(geo, `Tab 切换标签 · ↑↓ 滚动 · I 中断 · Esc 返回`));

		return output;
	}
}
