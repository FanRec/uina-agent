/**
 * 思考强度滑块组件（对齐 Pi Component 契约）。
 *
 * 键位语义（W5/F4）：←/→ 只移动焦点做预览（✓ 标已提交值，高亮标焦点）；
 * Enter 提交焦点档位；Esc 回滚关闭。未声明档位时不预选任何项（A5），
 * 也不存在编造的默认档位表（A6：DEFAULT_EFFORT_TIERS 已删除）。
 */

import type { ThinkingLevel } from "../../../core/types.js";
import { Key } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C, visibleWidth } from "../../core/utils.js";
import { type Binding, hintsFor, type Keymap, resolve } from "../../keys/keymap.js";
import { panelInnerWidth, renderPanel } from "../../layout/panel.js";

export interface EffortTier {
	id: ThinkingLevel;
	name: string;
	description: string;
}

/** 字符串档位名的宽容归一（/effort <level> 参数用）；未知名返回 undefined，不编造档位（A5/A6）。 */
export function normalizeEffortId(id: string): ThinkingLevel | undefined {
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
		const id = normalizeEffortId(item) ?? (item as ThinkingLevel);
		const name = item.charAt(0).toUpperCase() + item.slice(1);
		return { id, name, description: "" };
	}
	return item;
}

export class EffortSlider implements Component, Focusable {
	focused = true;
	private tiers: EffortTier[];
	/** 已提交档位；未声明当前值时保持 undefined，不预选（A5）。 */
	private activeTierId: ThinkingLevel | undefined;
	private focusIndex = 0;

	onChange?: (tierId: ThinkingLevel) => void;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(
		activeTierId: ThinkingLevel | string | undefined,
		tiers: readonly (EffortTier | ThinkingLevel | string)[],
	) {
		this.tiers = tiers.map(toEffortTier);
		const normalized = typeof activeTierId === "string" ? normalizeEffortId(activeTierId) : activeTierId;
		const declared = normalized !== undefined ? this.tiers.findIndex((t) => t.id === normalized) : -1;
		this.focusIndex = declared >= 0 ? declared : 0;
		this.activeTierId = declared >= 0 ? this.tiers[declared]!.id : undefined;
	}

	keymap(): Keymap {
		const bindings: Binding[] = [
			{ keys: [Key.left], action: "overlay.previewPrev", label: "←/→ 预览" },
			{ keys: [Key.right], action: "overlay.previewNext", label: "←/→ 预览" },
			{ keys: [Key.enter], action: "overlay.commit", label: "Enter 提交" },
			{ keys: [Key.escape], action: "overlay.rollback", label: "Esc 回滚" },
		];
		// 单档位时 ←/→ 无处可去：不进提示也不响应
		if (this.tiers.length <= 1) return { capturing: true, bindings: bindings.slice(2) };
		return { capturing: true, bindings };
	}

	private preview(delta: number): void {
		if (this.tiers.length === 0) return;
		this.focusIndex = (this.focusIndex + delta + this.tiers.length) % this.tiers.length;
		this.onRequestRender?.();
	}

	private currentTier(): EffortTier | undefined {
		return this.tiers[this.focusIndex];
	}

	/** 测试与调试视图：当前预览焦点档位。 */
	getFocusedTier(): EffortTier | undefined {
		return this.currentTier();
	}

	/** 测试与调试视图：已提交档位（未声明时 undefined，不预选）。 */
	getActiveTierId(): ThinkingLevel | undefined {
		return this.activeTierId;
	}

	/** Enter：提交焦点档位（值变化时才回调）。 */
	commit(): void {
		const tier = this.currentTier();
		if (!tier || this.activeTierId === tier.id) return;
		this.activeTierId = tier.id;
		this.onChange?.(tier.id);
	}

	handleInput(data: string): void {
		const action = resolve(this.keymap(), data);
		switch (action) {
			case "overlay.previewPrev":
				this.preview(-1);
				return;
			case "overlay.previewNext":
				this.preview(1);
				return;
			case "overlay.commit":
				this.commit();
				this.onClose?.();
				return;
			case "overlay.rollback":
				this.onClose?.();
				return;
			default:
				return;
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
		const innerW = panelInnerWidth(boxWidth);

		const renderSliderWindow = (visibleTiers: readonly EffortTier[]): string => {
			const segments = visibleTiers.map((tier) => {
				// ✓ = 已提交值；反色高亮 = 预览焦点（F4：两者分离）
				const committed = this.activeTierId === tier.id ? `${C.suggestion}✓${C.reset}` : "";
				const label = `${tier.name}${committed}`;
				return tier === this.tiers[this.focusIndex]
					? `\x1b[7m\x1b[1m${label}\x1b[0m`
					: `${C.inactive}${label}${C.reset}`;
			});
			const leftHint = this.focusIndex > 0 ? `${C.inactive}←${this.focusIndex} ${C.reset}` : "";
			const shownThrough = this.focusIndex + visibleTiers.length;
			const remaining = Math.max(0, this.tiers.length - shownThrough);
			const rightHint = remaining > 0 ? ` ${C.inactive}→${remaining}${C.reset}` : "";
			return `${leftHint}${segments.join(` ${C.subtle}·${C.reset} `)}${rightHint}`;
		};
		const focusedTier = this.tiers[this.focusIndex];
		const availableTiers = focusedTier ? [focusedTier] : [];
		for (let index = this.focusIndex + 1; index < this.tiers.length; index++) {
			const candidate = [...availableTiers, this.tiers[index]!];
			if (visibleWidth(renderSliderWindow(candidate)) > innerW) break;
			availableTiers.push(this.tiers[index]!);
		}
		const sliderBar = focusedTier
			? renderSliderWindow(availableTiers)
			: `${C.inactive}当前模型未声明可用档位${C.reset}`;

		const current = this.currentTier();
		const descRaw = current
			? current.description
				? `${C.text}${current.description}${C.reset}`
				: `${C.inactive}当前档位: ${current.name}${C.reset}`
			: `${C.inactive}未声明思考档位${C.reset}`;

		return renderPanel({
			title: "推理强度 (Reasoning effort)",
			body: [sliderBar, descRaw, hintsFor(this.keymap(), innerW)],
			boxWidth,
			leftPad,
			borderColor: C.subtle,
		}).slice(0, Math.max(1, Math.floor(availableHeight)));
	}
}
