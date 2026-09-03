/**
 * 思考强度滑块组件（完整复刻 dsh-TUI EffortSlider 拟态滑块规范与 5 档推理等级）。
 *
 * 对齐 dsh-TUI 特性：
 * 1. 5 档推理强度全覆盖：Off ── Low ── Medium ── High ── Max；
 * 2. 拟态变阻器 (Rheostat row)：聚焦项反色高亮 (inverse)，当前生效项携带 cyan 勾选标记 (✓)，以 " ── " 联结；
 * 3. 实时生效哲学 (The slider IS the control)：← / → 滑移时立即原地 live-apply 生效，Enter / Esc 关闭；
 * 4. 环形循环包裹导航 (Wrap-around navigation)；
 * 5. 详细语义释义行与键盘快捷提示行。
 */

import { C, visibleWidth } from "../core/utils.js";

export type EffortTierId = "off" | "low" | "medium" | "high" | "max" | "none";

export interface EffortTier {
	id: "off" | "low" | "medium" | "high" | "max";
	name: string;
	description: string;
}

export const DEFAULT_EFFORT_TIERS: EffortTier[] = [
	{ id: "off", name: "Off", description: "关闭额外思考，快速直出回复 (No extra thinking)" },
	{ id: "low", name: "Low", description: "轻量快速推理，适合简单任务与日常问答 (Faster responses)" },
	{ id: "medium", name: "Medium", description: "兼顾推理深度与响应速度，推荐日常使用 (Balanced speed & depth)" },
	{ id: "high", name: "High", description: "深度系统分析，全面权衡边界与代码严谨性 (Deep thinking)" },
	{ id: "max", name: "Max", description: "极限推演，探索最复杂架构与疑难难题 (Maximum reasoning effort)" },
];

export function normalizeEffortId(id: string): "off" | "low" | "medium" | "high" | "max" {
	const lower = id.toLowerCase().trim();
	if (lower === "none" || lower === "off" || lower === "0") return "off";
	if (lower === "low" || lower === "1") return "low";
	if (lower === "medium" || lower === "med" || lower === "2") return "medium";
	if (lower === "high" || lower === "3") return "high";
	if (lower === "max" || lower === "maximum" || lower === "4") return "max";
	return "medium";
}

export class EffortSlider {
	private tiers: EffortTier[];
	private activeTierId: "off" | "low" | "medium" | "high" | "max";
	private focusIndex = 2; // 默认 Medium

	constructor(activeTierId: string = "medium", tiers = DEFAULT_EFFORT_TIERS) {
		this.tiers = tiers;
		this.activeTierId = normalizeEffortId(activeTierId);
		const found = this.tiers.findIndex((t) => t.id === this.activeTierId);
		if (found >= 0) {
			this.focusIndex = found;
		}
	}

	/** 环形向左滑动，同时实时同步当前激活档位（The slider IS the control） */
	navigateLeft(): EffortTier {
		this.focusIndex = (this.focusIndex - 1 + this.tiers.length) % this.tiers.length;
		this.activeTierId = this.tiers[this.focusIndex]!.id;
		return this.getCurrentTier();
	}

	/** 环形向右滑动，同时实时同步当前激活档位（The slider IS the control） */
	navigateRight(): EffortTier {
		this.focusIndex = (this.focusIndex + 1) % this.tiers.length;
		this.activeTierId = this.tiers[this.focusIndex]!.id;
		return this.getCurrentTier();
	}

	/** 直接跳转到指定索引（支持鼠标点击触发） */
	setFocusIndex(index: number): EffortTier {
		if (index >= 0 && index < this.tiers.length) {
			this.focusIndex = index;
			this.activeTierId = this.tiers[this.focusIndex]!.id;
		}
		return this.getCurrentTier();
	}

	getCurrentTier(): EffortTier {
		return this.tiers[this.focusIndex]!;
	}

	getActiveTierId(): "off" | "low" | "medium" | "high" | "max" {
		return this.activeTierId;
	}

	formatLines(terminalWidth = 80): string[] {
		// 保证盒宽自适应且有充裕空间展示 5 档拟态滑动轨
		const boxWidth = Math.max(56, Math.min(terminalWidth - 6, 76));
		const innerW = boxWidth - 4; // 减去两端 "│ " 与 " │"
		const borderCol = C.gray;

		// 1. 顶边框（复刻 dsh-TUI Pane 视觉规范）
		const titleTag = `─ 推理强度 (Reasoning effort) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		// 2. 拟态滑动变阻器行 (Rheostat Row)：
		//    Off ── Low ── Medium ── High✓ ── [Max]
		const segments: string[] = [];
		for (let i = 0; i < this.tiers.length; i++) {
			const tier = this.tiers[i]!;
			const isFocused = i === this.focusIndex;
			const isCurrent = tier.id === this.activeTierId;
			const checkmark = isCurrent ? `${C.cyan}✓${C.reset}` : "";

			if (isFocused) {
				// 聚焦项反色高亮 (inverse + bold)
				const label = ` ${tier.name}${isCurrent ? "✓" : ""} `;
				segments.push(`\x1b[7m\x1b[1m${label}\x1b[0m`);
			} else {
				// 未聚焦项常态文本
				segments.push(`${C.dim}${tier.name}${checkmark}${C.reset}`);
			}
		}

		const sliderBar = segments.join(` ${borderCol}──${C.reset} `);
		const sliderPad = Math.max(0, innerW - visibleWidth(sliderBar));
		const sliderLine = `  ${borderCol}│${C.reset} ${sliderBar}${" ".repeat(sliderPad)} ${borderCol}│${C.reset}`;

		// 3. 当前聚焦档位详细释义
		const current = this.getCurrentTier();
		const descText = `${C.dim}${current.description}${C.reset}`;
		const descPad = Math.max(0, innerW - visibleWidth(descText));
		const descLine = `  ${borderCol}│${C.reset} ${descText}${" ".repeat(descPad)} ${borderCol}│${C.reset}`;

		// 4. 底部操作提示行（复刻 dsh-TUI HintLine）
		const hintText = `${C.dim}\x1b[3m${C.bold}←/→${C.reset}${C.dim}\x1b[3m 调整 · ${C.bold}Enter/Esc${C.reset}${C.dim}\x1b[3m 完成${C.reset}`;
		const hintPad = Math.max(0, innerW - visibleWidth(hintText));
		const hintLine = `  ${borderCol}│${C.reset} ${hintText}${" ".repeat(hintPad)} ${borderCol}│${C.reset}`;

		// 5. 底边框
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
