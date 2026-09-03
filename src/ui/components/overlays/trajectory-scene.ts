/**
 * 全屏审计轨迹看板（TrajectoryScene）。
 * 遵循无状态 View 规范：数据来源于运行时事件投影（TrajectoryProjection），
 * 彻底消除模拟假数据，无事件时如实呈现空状态。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import { highlightCode } from "../primitives/syntax-text.js";

export type TrajectoryNodeKind =
	| "turn_start"
	| "thinking"
	| "tool_call"
	| "model_stream"
	| "compaction"
	| "error"
	| "system";

export type TrajectoryNodeStatus = "running" | "completed" | "failed";

export interface TrajectoryNode {
	id: string;
	turn?: number;
	kind: TrajectoryNodeKind;
	label: string;
	status: TrajectoryNodeStatus;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	tokens?: {
		input?: number;
		output?: number;
		total?: number;
	};
	argsJson?: string;
	resultPreview?: string;
	error?: string;
}

export interface HotspotRow {
	kind: TrajectoryNodeKind;
	name: string;
	count: number;
	totalDurationMs: number;
	avgDurationMs: number;
	totalTokens: number;
	errors: number;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const min = Math.floor(ms / 60000);
	const sec = Math.floor((ms % 60000) / 1000);
	return `${min}m${sec}s`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

/**
 * 余弦/密度能量波形带投影器 (WaveBand)
 */
export function projectWaveBand(nodes: TrajectoryNode[], width: number, cursorIndex: number): string[] {
	if (width <= 0) return ["", ""];
	if (nodes.length === 0) {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}

	const GLYPHS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const minTime = nodes[0]!.startedAt;
	const maxTime = Math.max(...nodes.map((n) => n.endedAt ?? n.startedAt), minTime + 1);
	const totalSpan = Math.max(1, maxTime - minTime);

	// 将全会话切分为 width 根时间柱
	const colNodes: TrajectoryNode[][] = Array.from({ length: width }, () => []);
	let cursorCol = 0;

	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]!;
		const midTime = (n.startedAt + (n.endedAt ?? n.startedAt)) / 2;
		const col = Math.min(width - 1, Math.max(0, Math.floor(((midTime - minTime) / totalSpan) * width)));
		colNodes[col]!.push(n);
		if (i === cursorIndex) {
			cursorCol = col;
		}
	}

	const line1Chars: string[] = [];
	const line2Chars: string[] = [];

	for (let col = 0; col < width; col++) {
		const list = colNodes[col]!;
		const count = list.length;
		const hasError = list.some((n) => n.status === "failed");
		const hasTool = list.some((n) => n.kind === "tool_call");
		const isCursor = col === cursorCol;

		let charColor = C.cyan;
		if (hasError) {
			charColor = C.red;
		} else if (hasTool) {
			charColor = C.yellow;
		}

		if (count === 0) {
			if (isCursor) {
				line1Chars.push(`${C.glowWhite}│${C.reset}`);
				line2Chars.push(`${C.glowWhite}▲${C.reset}`);
			} else {
				line1Chars.push(`${C.gray}·${C.reset}`);
				line2Chars.push(" ");
			}
			continue;
		}

		const heightVal = Math.min(8, Math.max(1, count * 2));
		const glyph = GLYPHS[heightVal]!;

		if (isCursor) {
			line1Chars.push(`\x1b[7m\x1b[1m${glyph}\x1b[0m`);
			line2Chars.push(`${C.glowWhite}▲${C.reset}`);
		} else {
			line1Chars.push(`${charColor}${glyph}${C.reset}`);
			line2Chars.push(`${C.dim}▂${C.reset}`);
		}
	}

	return [line1Chars.join(""), line2Chars.join("")];
}

/**
 * 轨迹事件投影接口（只读）
 */
export interface TrajectoryEventSource {
	list(): readonly TrajectoryNode[];
	aggregate(sortBy?: "duration" | "tokens" | "errors"): HotspotRow[];
}

export class TrajectoryScene implements Component, Focusable {
	focused = true;
	private viewMode: "timeline" | "hotspot" = "timeline";
	private cursorIndex = 0;
	private isMaximized = false;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(private readonly source: TrajectoryEventSource) {}

	handleInput(data: string): void {
		const nodes = this.source.list();

		if (matchesKey(data, Key.escape)) {
			if (this.isMaximized) {
				this.isMaximized = false;
				this.onRequestRender?.();
			} else {
				this.onClose?.();
			}
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.viewMode = this.viewMode === "timeline" ? "hotspot" : "timeline";
			this.onRequestRender?.();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.isMaximized = !this.isMaximized;
			this.onRequestRender?.();
			return;
		}

		if (this.viewMode === "timeline") {
			if (matchesKey(data, Key.left)) {
				this.cursorIndex = Math.max(0, this.cursorIndex - 1);
				this.onRequestRender?.();
			} else if (matchesKey(data, Key.right)) {
				this.cursorIndex = Math.min(Math.max(0, nodes.length - 1), this.cursorIndex + 1);
				this.onRequestRender?.();
			} else if (data === "e" || data === "E") {
				// 跳转到下一个报错节点
				const nextErr = nodes.findIndex((n, idx) => idx > this.cursorIndex && n.status === "failed");
				if (nextErr >= 0) {
					this.cursorIndex = nextErr;
					this.onRequestRender?.();
				}
			}
		}
	}

	render(terminalWidth = 80): string[] {
		return this.formatLines(terminalWidth, 24);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, _terminalHeight = 24): string[] {
		const boxWidth = Math.max(56, Math.min(terminalWidth - 6, 96));
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const nodes = this.source.list();

		const titleTag = `─ 全屏事件时序与审计轨迹 (${nodes.length} 节点) `;
		const topFill = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFill)}╮${C.reset}`;
		const output: string[] = [topLine];

		if (nodes.length === 0) {
			const emptyText = `${C.dim}当前会话暂无运行生命周期事件记录 (按 Esc 关闭)${C.reset}`;
			const padLen = Math.max(0, innerW - visibleWidth(emptyText));
			output.push(`  ${borderCol}│${C.reset} ${emptyText}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`);
			return output;
		}

		if (this.cursorIndex >= nodes.length) {
			this.cursorIndex = Math.max(0, nodes.length - 1);
		}

		// 2. Tab 栏
		const tab1 = this.viewMode === "timeline" ? `\x1b[7m 时间线 (Timeline) \x1b[0m` : `${C.dim} 时间线 (Timeline) ${C.reset}`;
		const tab2 = this.viewMode === "hotspot" ? `\x1b[7m 性能热点 (Hotspots) \x1b[0m` : `${C.dim} 性能热点 (Hotspots) ${C.reset}`;
		const tabRow = `  ${borderCol}│${C.reset} [Tab] ${tab1}  ${tab2}${" ".repeat(Math.max(0, innerW - visibleWidth(tab1) - visibleWidth(tab2) - 8))} ${borderCol}│${C.reset}`;
		output.push(tabRow);
		output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

		if (this.viewMode === "timeline") {
			// 3. 波形带
			const [wave1, wave2] = projectWaveBand(nodes as TrajectoryNode[], innerW, this.cursorIndex);
			output.push(`  ${borderCol}│${C.reset} ${wave1} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}│${C.reset} ${wave2} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

			// 4. 当前选中节点的检查器
			const current = nodes[this.cursorIndex]!;
			const statusIcon = current.status === "completed" ? `${C.green}✓${C.reset}` : current.status === "failed" ? `${C.red}✗${C.reset}` : `${C.yellow}●${C.reset}`;
			const timeStr = formatTime(current.startedAt);
			const durStr = current.durationMs ? formatDuration(current.durationMs) : "";

			const detailHeader = `节点 [${this.cursorIndex + 1}/${nodes.length}] ${statusIcon} ${C.bold}${current.label}${C.reset}  ${C.dim}${timeStr} ${durStr}${C.reset}`;
			output.push(`  ${borderCol}│${C.reset} ${truncateToWidth(detailHeader, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(detailHeader)))} ${borderCol}│${C.reset}`);

			if (current.error) {
				const errLine = `${C.red}错误: ${current.error}${C.reset}`;
				output.push(`  ${borderCol}│${C.reset} ${truncateToWidth(errLine, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(errLine)))} ${borderCol}│${C.reset}`);
			} else if (current.argsJson) {
				const argsHighlight = highlightCode(current.argsJson, "json");
				const argsLine = `${C.dim}参数:${C.reset} ${argsHighlight}`;
				output.push(`  ${borderCol}│${C.reset} ${truncateToWidth(argsLine, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(argsLine)))} ${borderCol}│${C.reset}`);
			} else if (current.resultPreview) {
				const preview = `${C.dim}结果:${C.reset} ${current.resultPreview}`;
				output.push(`  ${borderCol}│${C.reset} ${truncateToWidth(preview, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(preview)))} ${borderCol}│${C.reset}`);
			}
		} else {
			// 热点视图
			const hotspots = this.source.aggregate("duration");
			output.push(`  ${borderCol}│${C.reset} ${C.bold}类别/操作${" ".repeat(Math.max(1, innerW - 40))}次数    总耗时     平均耗时${C.reset} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

			const maxRows = Math.min(6, hotspots.length);
			for (let i = 0; i < maxRows; i++) {
				const h = hotspots[i]!;
				const name = truncateToWidth(h.name, innerW - 32);
				const countStr = String(h.count).padStart(4);
				const totalDur = formatDuration(h.totalDurationMs).padStart(8);
				const avgDur = formatDuration(h.avgDurationMs).padStart(8);
				const row = `${C.cyan}${name}${C.reset}${" ".repeat(Math.max(1, innerW - visibleWidth(name) - 22))}${countStr}  ${totalDur}  ${avgDur}`;
				output.push(`  ${borderCol}│${C.reset} ${row}${" ".repeat(Math.max(0, innerW - visibleWidth(row)))} ${borderCol}│${C.reset}`);
			}
		}

		// 底边框
		const hint = `←→ 移动时序 · Tab 切换热点 · Enter 展开 · Esc 关闭`;
		const botFill = Math.max(1, boxWidth - 2 - visibleWidth(hint) - 2);
		output.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);

		return output;
	}
}
