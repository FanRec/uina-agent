/**
 * 全屏审计轨迹看板（TrajectoryScene）。
 * 遵循无状态 View 规范：数据来源于运行时事件投影（TrajectoryProjection），
 * 彻底消除模拟假数据，无事件时如实呈现空状态。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import { highlightCode } from "../../components/primitives/syntax-text.js";
import type { TrajectoryEventSource, TrajectoryNode, TrajectoryNodeStatus } from "../../../presentation/trajectory.js";

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

/** 五态图标与中文标签；running 是进行态，单独表达。 */
function statusGlyph(status: TrajectoryNodeStatus): { icon: string; label: string } {
	switch (status) {
		case "completed":
			return { icon: `${C.green}✓${C.reset}`, label: "完成" };
		case "failed":
			return { icon: `${C.red}✗${C.reset}`, label: "失败" };
		case "cancelled":
			return { icon: `${C.warning}⊘${C.reset}`, label: "已取消" };
		case "unknown":
			return { icon: `${C.warning}?${C.reset}`, label: "结果未知" };
		case "not_started":
			return { icon: `${C.dim}○${C.reset}`, label: "未执行" };
		case "running":
			return { icon: `${C.warning}●${C.reset}`, label: "进行中" };
	}
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
	// 时间未知的节点不参与波形：波形是时间轴投影，没有时刻就没有位置。
	const timed = nodes
		.map((node, index) => ({ node, index }))
		.filter(
			(entry): entry is { node: TrajectoryNode & { startedAt: number }; index: number } =>
				entry.node.startedAt !== undefined,
		);
	if (timed.length === 0) {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
	const minTime = Math.min(...timed.map((entry) => entry.node.startedAt));
	const maxTime = Math.max(...timed.map((entry) => entry.node.endedAt ?? entry.node.startedAt), minTime + 1);
	const totalSpan = Math.max(1, maxTime - minTime);

	// 将全会话切分为 width 根时间柱
	const colNodes: TrajectoryNode[][] = Array.from({ length: width }, () => []);
	let cursorCol = 0;

	for (const { node, index } of timed) {
		const midTime = (node.startedAt + (node.endedAt ?? node.startedAt)) / 2;
		const col = Math.min(width - 1, Math.max(0, Math.floor(((midTime - minTime) / totalSpan) * width)));
		colNodes[col]!.push(node);
		if (index === cursorIndex) cursorCol = col;
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

export class TrajectoryScene implements Component, Focusable {
	focused = true;
	private viewMode: "timeline" | "hotspot" = "timeline";
	private cursorIndex = 0;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(private readonly source: TrajectoryEventSource) {}

	handleInput(data: string): void {
		const nodes = this.source.list();

		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.viewMode = this.viewMode === "timeline" ? "hotspot" : "timeline";
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

	render(terminalWidth = 80, availableHeight = 24): string[] {
		return this.formatLines(terminalWidth, availableHeight);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, terminalHeight = 24): string[] {
		if (terminalWidth <= 0 || terminalHeight <= 0) return [];
		if (terminalWidth < 64 || terminalHeight < 12) return this.formatCompactLines(terminalWidth, terminalHeight);
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
		const tab1 =
			this.viewMode === "timeline" ? `\x1b[7m 时间线 (Timeline) \x1b[0m` : `${C.dim} 时间线 (Timeline) ${C.reset}`;
		const tab2 =
			this.viewMode === "hotspot" ? `\x1b[7m 性能热点 (Hotspots) \x1b[0m` : `${C.dim} 性能热点 (Hotspots) ${C.reset}`;
		const tabRow = `  ${borderCol}│${C.reset} [Tab] ${tab1}  ${tab2}${" ".repeat(Math.max(0, innerW - visibleWidth(tab1) - visibleWidth(tab2) - 8))} ${borderCol}│${C.reset}`;
		output.push(tabRow);
		output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

		if (this.viewMode === "timeline") {
			// 3. 波形带
			const waveWidth = Math.max(10, innerW - 2);
			const [wave1, wave2] = projectWaveBand(nodes as TrajectoryNode[], waveWidth, this.cursorIndex);
			const pad1 = Math.max(0, innerW - 2 - visibleWidth(wave1));
			const pad2 = Math.max(0, innerW - 2 - visibleWidth(wave2));
			output.push(`  ${borderCol}│${C.reset} ${wave1}${" ".repeat(pad1)} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}│${C.reset} ${wave2}${" ".repeat(pad2)} ${borderCol}│${C.reset}`);
			output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

			// 4. 当前选中节点的检查器
			const current = nodes[this.cursorIndex]!;
			const glyph = statusGlyph(current.status);
			const timeStr = current.startedAt === undefined ? "时间未知" : formatTime(current.startedAt);
			const durStr = current.durationMs === undefined ? "耗时未知" : formatDuration(current.durationMs);

			const detailHeader = `节点 [${this.cursorIndex + 1}/${nodes.length}] ${glyph.icon} ${C.dim}[${glyph.label}]${C.reset} ${C.bold}${current.label}${C.reset}  ${C.dim}${timeStr} ${durStr}${C.reset}`;
			output.push(
				`  ${borderCol}│${C.reset} ${truncateToWidth(detailHeader, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(detailHeader)))} ${borderCol}│${C.reset}`,
			);

			// 详情顺序统一为 参数 → 结果 → 错误，宽屏与紧凑共用。
			const detailLines: string[] = [];
			if (current.argsJson) {
				detailLines.push(`${C.dim}参数:${C.reset} ${highlightCode(current.argsJson, "json")}`);
			}
			if (current.resultPreview) {
				detailLines.push(`${C.dim}结果:${C.reset} ${current.resultPreview}`);
			}
			if (current.error) {
				detailLines.push(`${C.red}错误: ${current.error}${C.reset}`);
			}
			for (const detailLine of detailLines) {
				output.push(
					`  ${borderCol}│${C.reset} ${truncateToWidth(detailLine, innerW)}${" ".repeat(Math.max(0, innerW - visibleWidth(detailLine)))} ${borderCol}│${C.reset}`,
				);
			}
		} else {
			// 热点视图
			const hotspots = this.source.aggregate("duration");
			// 数值列固定宽度：次数 4 / 总耗时 8 / 平均耗时 8 / 错误 4 / Token 7，间隔 2。
			const NUM_COLS = 39;
			const nameWidth = Math.max(6, innerW - NUM_COLS);
			output.push(
				`  ${borderCol}│${C.reset} ${C.bold}类别/操作${" ".repeat(Math.max(1, nameWidth - 9))}次数  总耗时  平均耗时  错误    Token${C.reset} ${borderCol}│${C.reset}`,
			);
			output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);

			const maxRows = Math.min(6, hotspots.length);
			for (let i = 0; i < maxRows; i++) {
				const h = hotspots[i]!;
				const name = truncateToWidth(h.name, nameWidth, "…");
				const cells = [
					String(h.count).padStart(4),
					formatDuration(h.totalDurationMs).padStart(8),
					formatDuration(h.avgDurationMs).padStart(8),
					String(h.errors).padStart(4),
					String(h.totalTokens).padStart(7),
				].join("  ");
				const row = `${C.cyan}${name}${C.reset}${" ".repeat(Math.max(1, nameWidth - visibleWidth(name)))}${cells}`;
				output.push(
					`  ${borderCol}│${C.reset} ${row}${" ".repeat(Math.max(0, innerW - visibleWidth(row)))} ${borderCol}│${C.reset}`,
				);
			}
		}

		// 底边框
		const hint = `←→ 移动时序 · Tab 切换热点 · Enter 展开 · Esc 关闭`;
		const botFill = Math.max(1, boxWidth - 2 - visibleWidth(hint) - 2);
		output.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);

		return output;
	}

	private formatCompactLines(terminalWidth: number, terminalHeight: number): string[] {
		const nodes = this.source.list();
		if (this.cursorIndex >= nodes.length) this.cursorIndex = Math.max(0, nodes.length - 1);
		const leftPad = terminalWidth >= 64 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(terminalWidth - leftPad, 96));
		const innerW = Math.max(1, boxWidth - 4);
		const border = C.gray;
		const pad = " ".repeat(leftPad);
		const title = truncateToWidth(`事件轨迹 · ${nodes.length} 节点`, Math.max(1, boxWidth - 6), "…");
		const tag = `─ ${title} `;
		const frame = (content: string): string => {
			const safe = truncateToWidth(content, innerW, "…");
			return `${pad}${border}│${C.reset} ${safe}${" ".repeat(Math.max(0, innerW - visibleWidth(safe)))} ${border}│${C.reset}`;
		};
		const output = [
			`${pad}${border}╭${tag}${border}${"─".repeat(Math.max(0, boxWidth - 2 - visibleWidth(tag)))}╮${C.reset}`,
		];
		if (nodes.length === 0) {
			output.push(frame("当前会话暂无运行生命周期事件记录"));
		} else {
			const node = nodes[this.cursorIndex]!;
			const glyph = statusGlyph(node.status);
			output.push(frame(`[${this.cursorIndex + 1}/${nodes.length}] ${glyph.icon} ${node.label} · ${glyph.label}`));
			if (node.argsJson) output.push(frame(`参数: ${node.argsJson}`));
			if (node.resultPreview) output.push(frame(`结果: ${node.resultPreview}`));
			if (node.error) output.push(frame(`错误: ${node.error}`));
		}
		if (terminalHeight >= 3) output.push(frame("←/→ 移动 · Tab 热点 · Esc 关闭"));
		output.push(`${pad}${border}╰${"─".repeat(Math.max(0, boxWidth - 2))}╯${C.reset}`);
		return output.slice(0, Math.max(1, Math.floor(terminalHeight)));
	}
}
