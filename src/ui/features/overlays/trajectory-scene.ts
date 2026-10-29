/**
 * 全屏审计轨迹看板（TrajectoryScene）。
 * 遵循无状态 View 规范：数据来源于运行时事件投影（TrajectoryProjection），
 * 彻底消除模拟假数据，无事件时如实呈现空状态。
 */

import { formatDuration } from "../../../presentation/copy.js";
import { TOOL_STATUS_SPEC } from "../../../presentation/tool-status.js";
import type { TrajectoryEventSource, TrajectoryNode, TrajectoryNodeStatus } from "../../../presentation/trajectory.js";
import { highlightCode } from "../../components/primitives/syntax-text.js";
import { TOOL_TONE_COLORS } from "../../components/transcript/tool-view.js";
import { Key, matchesKey } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C, visibleWidth } from "../../core/utils.js";
import { type Keymap, resolve } from "../../keys/keymap.js";
import { fitLine } from "../../layout/fit.js";
import {
	panelBottomBorder,
	panelDivider,
	panelInnerWidth,
	panelRow,
	panelTopBorder,
	renderPanel,
} from "../../layout/panel.js";

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

/** 终态图标/文案来自单一状态矩阵；running 是进行态，单独表达。 */
function statusGlyph(status: TrajectoryNodeStatus): { icon: string; label: string } {
	if (status === "running") return { icon: `${C.warning}●${C.reset}`, label: "进行中" };
	const spec = TOOL_STATUS_SPEC[status === "completed" ? "succeeded" : status];
	return { icon: `${TOOL_TONE_COLORS[spec.tone]}${spec.icon}${C.reset}`, label: spec.label };
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

	keymap(): Keymap {
		return {
			capturing: true,
			bindings: [
				{ keys: [Key.left], action: "overlay.prev", label: "←→ 移动时序" },
				{ keys: [Key.right], action: "overlay.next", label: "←→ 移动时序" },
				{ keys: ["e"], action: "overlay.nextError", label: "e 下一错误" },
				{ keys: [Key.tab], action: "overlay.tab", label: "Tab 切换热点" },
				{ keys: [Key.escape], action: "overlay.close", label: "Esc 关闭" },
			],
		};
	}

	handleInput(data: string): void {
		const nodes = this.source.list();

		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}

		const action = resolve(this.keymap(), data);

		if (action === "overlay.tab") {
			this.viewMode = this.viewMode === "timeline" ? "hotspot" : "timeline";
			this.onRequestRender?.();
			return;
		}

		if (this.viewMode === "timeline") {
			if (action === "overlay.prev") {
				this.cursorIndex = Math.max(0, this.cursorIndex - 1);
				this.onRequestRender?.();
			} else if (action === "overlay.next") {
				this.cursorIndex = Math.min(Math.max(0, nodes.length - 1), this.cursorIndex + 1);
				this.onRequestRender?.();
			} else if (action === "overlay.nextError") {
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
		const leftPad = 2;
		const boxWidth = Math.max(56, Math.min(terminalWidth - leftPad, 96));
		const innerW = panelInnerWidth(boxWidth);
		const border = { leftPad, borderColor: C.gray };
		const nodes = this.source.list();

		if (nodes.length === 0) {
			return renderPanel({
				title: `全屏事件时序与审计轨迹 (0 节点)`,
				body: [`${C.dim}当前会话暂无运行生命周期事件记录 (按 Esc 关闭)${C.reset}`],
				boxWidth,
				...border,
			});
		}

		if (this.cursorIndex >= nodes.length) {
			this.cursorIndex = Math.max(0, nodes.length - 1);
		}

		// 1. Tab 栏
		const tab1 = this.viewMode === "timeline" ? `\x1b[7m 时间线 \x1b[0m` : `${C.dim} 时间线 ${C.reset}`;
		const tab2 = this.viewMode === "hotspot" ? `\x1b[7m 性能热点 \x1b[0m` : `${C.dim} 性能热点 ${C.reset}`;
		const output: string[] = [
			panelTopBorder(boxWidth, { title: `全屏事件时序与审计轨迹 (${nodes.length} 节点)`, ...border }),
			panelRow(`${C.dim}[Tab]${C.reset} ${tab1}  ${tab2}`, boxWidth, border),
			panelDivider(boxWidth, border),
		];

		if (this.viewMode === "timeline") {
			// 2. 波形带
			const waveWidth = Math.max(10, innerW - 2);
			const [wave1, wave2] = projectWaveBand(nodes as TrajectoryNode[], waveWidth, this.cursorIndex);
			output.push(panelRow(wave1, boxWidth, border), panelRow(wave2, boxWidth, border), panelDivider(boxWidth, border));

			// 3. 当前选中节点的检查器
			const current = nodes[this.cursorIndex]!;
			const glyph = statusGlyph(current.status);
			const timeStr = current.startedAt === undefined ? "时间未知" : formatTime(current.startedAt);
			const durStr = current.durationMs === undefined ? "耗时未知" : formatDuration(current.durationMs, "precise");

			output.push(
				panelRow(
					`节点 [${this.cursorIndex + 1}/${nodes.length}] ${glyph.icon} ${C.dim}[${glyph.label}]${C.reset} ${C.bold}${current.label}${C.reset}  ${C.dim}${timeStr} ${durStr}${C.reset}`,
					boxWidth,
					border,
				),
			);

			// 详情顺序统一为 参数 → 结果 → 错误，宽屏与紧凑共用。
			if (current.argsJson)
				output.push(panelRow(`${C.dim}参数:${C.reset} ${highlightCode(current.argsJson, "json")}`, boxWidth, border));
			if (current.resultPreview)
				output.push(panelRow(`${C.dim}结果:${C.reset} ${current.resultPreview}`, boxWidth, border));
			if (current.error) output.push(panelRow(`${C.red}错误: ${current.error}${C.reset}`, boxWidth, border));
		} else {
			// 热点视图
			const hotspots = this.source.aggregate("duration");
			// 数值列固定宽度：次数 4 / 总耗时 8 / 平均耗时 8 / 错误 4 / Token 7，间隔 2。
			const NUM_COLS = 39;
			const nameWidth = Math.max(6, innerW - NUM_COLS);
			output.push(
				panelRow(
					`${C.bold}类别/操作${" ".repeat(Math.max(1, nameWidth - 9))}次数  总耗时  平均耗时  错误    Token${C.reset}`,
					boxWidth,
					border,
				),
				panelDivider(boxWidth, border),
			);

			const maxRows = Math.min(6, hotspots.length);
			for (let i = 0; i < maxRows; i++) {
				const h = hotspots[i]!;
				const name = fitLine(h.name, nameWidth);
				const cells = [
					String(h.count).padStart(4),
					formatDuration(h.totalDurationMs, "precise").padStart(8),
					formatDuration(h.avgDurationMs, "precise").padStart(8),
					String(h.errors).padStart(4),
					String(h.totalTokens).padStart(7),
				].join("  ");
				output.push(
					panelRow(
						`${C.cyan}${name}${C.reset}${" ".repeat(Math.max(1, nameWidth - visibleWidth(name)))}${cells}`,
						boxWidth,
						border,
					),
				);
			}
		}

		// F1：详情（参数/结果/错误）已内联展示，页脚不再承诺不存在的 “Enter 展开”；e 进提示
		output.push(
			panelBottomBorder(boxWidth, {
				tag: this.keymap()
					.bindings.map((b) => b.label)
					.join(" · "),
				...border,
			}),
		);
		return output;
	}

	private formatCompactLines(terminalWidth: number, terminalHeight: number): string[] {
		const nodes = this.source.list();
		if (this.cursorIndex >= nodes.length) this.cursorIndex = Math.max(0, nodes.length - 1);
		const leftPad = terminalWidth >= 64 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(terminalWidth - leftPad, 96));
		const body: string[] = [];
		if (nodes.length === 0) {
			body.push(`${C.dim}当前会话暂无运行生命周期事件记录${C.reset}`);
		} else {
			const node = nodes[this.cursorIndex]!;
			const glyph = statusGlyph(node.status);
			body.push(`[${this.cursorIndex + 1}/${nodes.length}] ${glyph.icon} ${node.label} · ${glyph.label}`);
			if (node.argsJson) body.push(`参数: ${node.argsJson}`);
			if (node.resultPreview) body.push(`结果: ${node.resultPreview}`);
			if (node.error) body.push(`错误: ${node.error}`);
		}
		return renderPanel({
			title: `事件轨迹 · ${nodes.length} 节点`,
			body,
			...(terminalHeight >= 3 ? { footer: `${C.dim}←/→ 移动 · Tab 热点 · Esc 关闭${C.reset}` } : {}),
			boxWidth,
			leftPad,
			borderColor: C.gray,
		}).slice(0, Math.max(1, Math.floor(terminalHeight)));
	}
}
