/**
 * 思考强度滑块组件（对齐 Pi Component 契约，保留 5 档拟态滑动变阻器视觉）。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth } from "../../core/utils.js";
import type { ThinkingLevel } from "../../../core/types.js";

export type EffortTierId = ThinkingLevel | "none";

export interface EffortTier {
	id: ThinkingLevel;
	name: string;
	description: string;
}

export const DEFAULT_EFFORT_TIERS: EffortTier[] = [
	{ id: "off", name: "Off", description: "关闭额外思考，快速直出回复 (No extra thinking)" },
	{ id: "minimal", name: "Minimal", description: "最小思考预算" },
	{ id: "low", name: "Low", description: "轻量快速推理，适合简单任务与日常问答 (Faster responses)" },
	{ id: "medium", name: "Medium", description: "兼顾推理深度与响应速度，推荐日常使用 (Balanced speed & depth)" },
	{ id: "high", name: "High", description: "深度系统分析，全面权衡边界与代码严谨性 (Deep thinking)" },
	{ id: "xhigh", name: "XHigh", description: "更高的思考预算" },
	{ id: "max", name: "Max", description: "极限推演，探索最复杂架构与疑难难题 (Maximum reasoning effort)" },
];

export function normalizeEffortId(id: string): ThinkingLevel {
	const lower = id.toLowerCase().trim();
	if (lower === "none" || lower === "off" || lower === "0") return "off";
	if (lower === "minimal") return "minimal";
	if (lower === "low" || lower === "1") return "low";
	if (lower === "medium" || lower === "med" || lower === "2") return "medium";
	if (lower === "high" || lower === "3") return "high";
	if (lower === "xhigh") return "xhigh";
	if (lower === "max" || lower === "maximum" || lower === "4") return "max";
	return "medium";
}

export class EffortSlider implements Component, Focusable {
	focused = true;
	private tiers: EffortTier[];
	private activeTierId: ThinkingLevel;
	private focusIndex = 2; // 默认 Medium

	onChange?: (tierId: ThinkingLevel) => void;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(activeTierId = "medium", tiers = DEFAULT_EFFORT_TIERS) {
		this.tiers = tiers;
		this.activeTierId = normalizeEffortId(activeTierId);
		const found = this.tiers.findIndex((t) => t.id === this.activeTierId);
		if (found >= 0) {
			this.focusIndex = found;
		}
	}

	navigateLeft(): EffortTier {
		this.focusIndex = (this.focusIndex - 1 + this.tiers.length) % this.tiers.length;
		this.activeTierId = this.tiers[this.focusIndex]!.id;
		this.onChange?.(this.activeTierId);
		return this.getCurrentTier();
	}

	navigateRight(): EffortTier {
		this.focusIndex = (this.focusIndex + 1) % this.tiers.length;
		this.activeTierId = this.tiers[this.focusIndex]!.id;
		this.onChange?.(this.activeTierId);
		return this.getCurrentTier();
	}

	setFocusIndex(index: number): EffortTier {
		if (index >= 0 && index < this.tiers.length) {
			this.focusIndex = index;
			this.activeTierId = this.tiers[this.focusIndex]!.id;
			this.onChange?.(this.activeTierId);
		}
		return this.getCurrentTier();
	}

	getCurrentTier(): EffortTier {
		return this.tiers[this.focusIndex]!;
	}

	getActiveTierId(): ThinkingLevel {
		return this.activeTierId;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.left)) {
			this.navigateLeft();
			this.onRequestRender?.();
		} else if (matchesKey(data, Key.right)) {
			this.navigateRight();
			this.onRequestRender?.();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
			this.onClose?.();
		}
	}

	render(width = 80): string[] {
		return this.formatLines(width);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80): string[] {
		const boxWidth = Math.max(56, Math.min(terminalWidth - 6, 76));
		const innerW = boxWidth - 4;
		const borderCol = C.gray;

		const titleTag = `─ 推理强度 (Reasoning effort) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		const segments: string[] = [];
		for (let i = 0; i < this.tiers.length; i++) {
			const tier = this.tiers[i]!;
			const isFocused = i === this.focusIndex;
			const isCurrent = tier.id === this.activeTierId;
			const checkmark = isCurrent ? `${C.cyan}✓${C.reset}` : "";

			if (isFocused) {
				const label = ` ${tier.name}${isCurrent ? "✓" : ""} `;
				segments.push(`\x1b[7m\x1b[1m${label}\x1b[0m`);
			} else {
				segments.push(`${C.dim}${tier.name}${checkmark}${C.reset}`);
			}
		}

		const sliderBar = segments.join(` ${borderCol}──${C.reset} `);
		const sliderPad = Math.max(0, innerW - visibleWidth(sliderBar));
		const sliderLine = `  ${borderCol}│${C.reset} ${sliderBar}${" ".repeat(sliderPad)} ${borderCol}│${C.reset}`;

		const current = this.getCurrentTier();
		const descText = `${C.dim}${current.description}${C.reset}`;
		const descPad = Math.max(0, innerW - visibleWidth(descText));
		const descLine = `  ${borderCol}│${C.reset} ${descText}${" ".repeat(descPad)} ${borderCol}│${C.reset}`;

		const hintText = `${C.dim}\x1b[3m${C.bold}←/→${C.reset}${C.dim}\x1b[3m 调整 · ${C.bold}Enter/Esc${C.reset}${C.dim}\x1b[3m 完成${C.reset}`;
		const hintPad = Math.max(0, innerW - visibleWidth(hintText));
		const hintLine = `  ${borderCol}│${C.reset} ${hintText}${" ".repeat(hintPad)} ${borderCol}│${C.reset}`;

		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;

		return [
			topLine,
			`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
			sliderLine,
			`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
			descLine,
			hintLine,
			botLine,
		];
	}
}
