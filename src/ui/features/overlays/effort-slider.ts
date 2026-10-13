/**
 * 思考强度滑块组件（对齐 Pi Component 契约，保留 5 档拟态滑动变阻器视觉）。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import type { ThinkingLevel } from "../../../core/types.js";

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
	return knownEffortId(id) ?? "medium";
}

function knownEffortId(id: string): ThinkingLevel | undefined {
	const lower = id.toLowerCase().trim();
	if (lower === "none" || lower === "off" || lower === "0") return "off";
	if (lower === "minimal") return "minimal";
	if (lower === "low" || lower === "1") return "low";
	if (lower === "medium" || lower === "med" || lower === "2") return "medium";
	if (lower === "high" || lower === "3") return "high";
	if (lower === "xhigh") return "xhigh";
	if (lower === "max" || lower === "maximum" || lower === "4") return "max";
	return undefined;
}

export function toEffortTier(item: EffortTier | ThinkingLevel | string): EffortTier {
	if (typeof item === "string") {
		const norm = normalizeEffortId(item);
		const found = DEFAULT_EFFORT_TIERS.find((t) => t.id === norm || t.id === item);
		if (found) return found;
		const name = item.charAt(0).toUpperCase() + item.slice(1);
		return { id: norm, name, description: "" };
	}
	return item;
}

export class EffortSlider implements Component, Focusable {
	focused = true;
	private tiers: EffortTier[];
	private activeTierId: ThinkingLevel | undefined;
	private focusIndex = 0;

	onChange?: (tierId: ThinkingLevel) => void;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(
		activeTierId: ThinkingLevel | string = "medium",
		tiers: readonly (EffortTier | ThinkingLevel | string)[] = DEFAULT_EFFORT_TIERS,
	) {
		const resolvedTiers = (tiers.length > 0 ? tiers : DEFAULT_EFFORT_TIERS).map(toEffortTier);
		this.tiers = resolvedTiers.length > 0 ? resolvedTiers : DEFAULT_EFFORT_TIERS;
		const normalized = knownEffortId(activeTierId);
		const found = normalized ? this.tiers.findIndex((t) => t.id === normalized) : -1;
		this.focusIndex = Math.max(0, Math.min(found >= 0 ? found : 0, this.tiers.length - 1));
		this.activeTierId = normalized !== undefined && found >= 0 ? normalized : undefined;
	}

	navigateLeft(): EffortTier {
		if (this.tiers.length === 0) return { id: "off", name: "Off", description: "" };
		this.focusIndex = (this.focusIndex - 1 + this.tiers.length) % this.tiers.length;
		this.activeTierId = this.tiers[this.focusIndex]?.id ?? "off";
		this.onChange?.(this.activeTierId);
		return this.getCurrentTier();
	}

	navigateRight(): EffortTier {
		if (this.tiers.length === 0) return { id: "off", name: "Off", description: "" };
		this.focusIndex = (this.focusIndex + 1) % this.tiers.length;
		this.activeTierId = this.tiers[this.focusIndex]?.id ?? "off";
		this.onChange?.(this.activeTierId);
		return this.getCurrentTier();
	}

	getCurrentTier(): EffortTier {
		return this.tiers[this.focusIndex] ?? this.tiers[0] ?? { id: "off", name: "Off", description: "" };
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

	render(width = 80, height = Number.MAX_SAFE_INTEGER): string[] {
		return this.formatLines(width, height);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		if (terminalWidth <= 0 || availableHeight <= 0) return [];
		const leftPad = terminalWidth >= 64 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(terminalWidth - leftPad, 76));
		const innerW = Math.max(1, boxWidth - 4);
		const borderCol = C.subtle;

		const title = truncateToWidth("推理强度 (Reasoning effort)", Math.max(1, boxWidth - 6), "…");
		const titleTag = `─ ${title} `;
		const topFillLen = Math.max(0, boxWidth - 2 - visibleWidth(titleTag));
		const pad = " ".repeat(leftPad);
		const topLine = `${pad}${borderCol}╭${C.inactive}${titleTag}${borderCol}${"─".repeat(topFillLen)}╮${C.reset}`;
		const frameLine = (content: string): string => {
			const safe = truncateToWidth(content, innerW, "…");
			return `${pad}${borderCol}│${C.reset} ${safe}${" ".repeat(Math.max(0, innerW - visibleWidth(safe)))} ${borderCol}│${C.reset}`;
		};

		const renderSliderWindow = (visibleTiers: readonly EffortTier[]): string => {
			const segments = visibleTiers.map((tier) => {
				const index = this.tiers.indexOf(tier);
				const current = this.activeTierId === tier.id ? `${C.suggestion}✓${C.reset}` : "";
				const label = `${tier.name}${current}`;
				return index === this.focusIndex ? `\x1b[7m\x1b[1m${label}\x1b[0m` : `${C.inactive}${label}${C.reset}`;
			});
			const leftHint = this.focusIndex > 0 ? `${C.inactive}←${this.focusIndex} ${C.reset}` : "";
			const shownThrough = this.focusIndex + visibleTiers.length;
			const remaining = Math.max(0, this.tiers.length - shownThrough);
			const rightHint = remaining > 0 ? ` ${C.inactive}→${remaining}${C.reset}` : "";
			return `${leftHint}${segments.join(` ${borderCol}·${C.reset} `)}${rightHint}`;
		};
		const availableTiers = [this.tiers[this.focusIndex]!];
		for (let index = this.focusIndex + 1; index < this.tiers.length; index++) {
			const candidate = [...availableTiers, this.tiers[index]!];
			if (visibleWidth(renderSliderWindow(candidate)) > innerW) break;
			availableTiers.push(this.tiers[index]!);
		}
		const focusedTier = this.tiers[this.focusIndex];
		const sliderBar = focusedTier
			? renderSliderWindow(availableTiers)
			: `${C.inactive}当前模型未声明可用档位${C.reset}`;

		const current = this.getCurrentTier();
		const descRaw = current.description
			? `${C.text}${current.description}${C.reset}`
			: `${C.inactive}当前档位: ${current.name}${C.reset}`;
		const descEffective = truncateToWidth(descRaw, innerW, "…");

		const hintText = `${C.inactive}\x1b[3m${C.suggestion}←/→${C.inactive} 调整 · ${C.suggestion}Enter/Esc${C.inactive} 完成${C.reset}`;
		const hintEffective = truncateToWidth(hintText, innerW, "…");

		const botLine = `${pad}${borderCol}╰${"─".repeat(Math.max(0, boxWidth - 2))}╯${C.reset}`;
		const rows = [topLine, frameLine(sliderBar), frameLine(descEffective), frameLine(hintEffective), botLine];
		return rows.slice(0, Math.max(1, Math.floor(availableHeight)));
	}
}
