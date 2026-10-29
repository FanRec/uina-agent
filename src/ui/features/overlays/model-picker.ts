/**
 * 模型快速选择器组件（对齐 Pi Component 规范，保留两级下钻选择视觉）。
 */

import type { ModelPickerGroup } from "../../../extensions/ui-contract.js";
import { Key } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C } from "../../core/utils.js";
import { hintsFor, type Keymap, resolve } from "../../keys/keymap.js";
import { fitLine } from "../../layout/fit.js";
import { panelRow, panelTopBorder, renderPanel } from "../../layout/panel.js";

export type ModelGroup = ModelPickerGroup;
type ModelItem = ModelPickerGroup["models"][number];

export class ModelPicker implements Component, Focusable {
	focused = true;
	private groups: ModelGroup[];
	private currentModelId?: string;
	private level: "groups" | "models" = "groups";
	private selectedGroupIndex = 0;
	private selectedModelIndex = 0;
	/** 空分组的显式反馈（C24）：Enter 不再无响应，提示留在面板内直到下一次操作。 */
	private notice?: string;

	onPick?: (modelId: string) => void;
	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(currentModelId?: string, groups: ModelGroup[] = []) {
		this.groups = groups;
		this.currentModelId = currentModelId;

		const grpIdx = this.groups.findIndex((g) => g.models.some((m) => this.isCurrent(m)));
		if (grpIdx >= 0) {
			this.selectedGroupIndex = grpIdx;
			const mIdx = this.groups[grpIdx]!.models.findIndex((m) => this.isCurrent(m));
			if (mIdx >= 0) this.selectedModelIndex = mIdx;
		}
	}

	// 调用方传入并回传的都是 providerId/modelId 复合键（groups() 统一产出），精确比较即可
	private isCurrent(m: ModelItem): boolean {
		return m.id === this.currentModelId;
	}

	keymap(): Keymap {
		const browsing = this.level === "groups" ? (this.groups[this.selectedGroupIndex]?.models.length ?? 0) > 0 : true;
		return {
			capturing: true,
			bindings: [
				{ keys: [Key.up], action: "overlay.up", label: "↑↓ 移动" },
				{ keys: [Key.down], action: "overlay.down", label: "↑↓ 移动" },
				{
					keys: [Key.enter],
					action: "overlay.confirm",
					label: browsing ? (this.level === "groups" ? "Enter 展开" : "Enter 确认切换") : "Enter（空分组）",
				},
				{ keys: [Key.escape], action: "overlay.esc", label: this.level === "groups" ? "Esc 关闭" : "Esc 返回" },
			],
		};
	}

	navigateUp(): void {
		this.notice = undefined;
		if (this.groups.length === 0) return;
		if (this.level === "groups") {
			this.selectedGroupIndex = Math.max(0, this.selectedGroupIndex - 1);
		} else {
			this.selectedModelIndex = Math.max(0, this.selectedModelIndex - 1);
		}
	}

	navigateDown(): void {
		this.notice = undefined;
		if (this.groups.length === 0) return;
		if (this.level === "groups") {
			this.selectedGroupIndex = Math.min(this.groups.length - 1, this.selectedGroupIndex + 1);
		} else {
			const group = this.groups[this.selectedGroupIndex];
			if (group) {
				this.selectedModelIndex = Math.min(group.models.length - 1, this.selectedModelIndex + 1);
			}
		}
	}

	confirm(): { action: "drilled" } | { action: "picked"; modelId: string } | null {
		if (this.level === "groups") {
			const group = this.groups[this.selectedGroupIndex];
			if (!group || group.models.length === 0) {
				this.notice = group ? `分组「${group.name}」暂无可用模型` : "暂无可用模型分组";
				return null;
			}
			this.notice = undefined;
			this.level = "models";
			const mIdx = group.models.findIndex((m) => this.isCurrent(m));
			this.selectedModelIndex = mIdx >= 0 ? mIdx : 0;
			return { action: "drilled" };
		}

		const group = this.groups[this.selectedGroupIndex];
		const model = group?.models[this.selectedModelIndex];
		if (model) {
			this.currentModelId = model.id;
			return { action: "picked", modelId: model.id };
		}
		return null;
	}

	back(): { action: "back" } | { action: "close" } {
		if (this.level === "models") {
			this.level = "groups";
			this.notice = undefined;
			return { action: "back" };
		}
		return { action: "close" };
	}

	handleInput(data: string): void {
		const action = resolve(this.keymap(), data);
		switch (action) {
			case "overlay.up":
				this.navigateUp();
				this.onRequestRender?.();
				return;
			case "overlay.down":
				this.navigateDown();
				this.onRequestRender?.();
				return;
			case "overlay.confirm": {
				const res = this.confirm();
				if (res?.action === "picked") {
					this.onPick?.(res.modelId);
				} else {
					this.onRequestRender?.();
				}
				return;
			}
			case "overlay.esc": {
				const res = this.back();
				if (res.action === "close") {
					this.onClose?.();
				} else {
					this.onRequestRender?.();
				}
				return;
			}
			default:
				return;
		}
	}

	render(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		return this.formatLines(terminalWidth, availableHeight);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		if (terminalWidth <= 0 || availableHeight <= 0) return [];
		if (terminalWidth < 5) return [fitLine("模型", terminalWidth, "clip")];
		const leftPad = terminalWidth >= 48 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(terminalWidth - leftPad, 78));
		const currentGroup = this.groups[this.selectedGroupIndex] ?? this.groups[0];
		const title = this.level === "groups" ? "切换模型服务商 (Providers)" : `选择模型 (${currentGroup?.name ?? "未知"})`;
		const items = this.level === "groups" ? this.groups : (currentGroup?.models ?? []);
		const selectedIndex =
			items.length === 0
				? 0
				: Math.min(
						Math.max(0, this.level === "groups" ? this.selectedGroupIndex : this.selectedModelIndex),
						items.length - 1,
					);
		const height = Number.isFinite(availableHeight)
			? Math.max(1, Math.floor(availableHeight))
			: Number.MAX_SAFE_INTEGER;
		if (height === 1) return [panelTopBorder(boxWidth, { title, borderColor: C.gray, leftPad })];
		if (height === 2) {
			const selectedItem = items[selectedIndex];
			const label =
				this.level === "groups" ? this.groups[selectedIndex]?.name : (selectedItem as ModelItem | undefined)?.name;
			const remaining = Math.max(0, items.length - selectedIndex - 1);
			return [
				panelTopBorder(boxWidth, { title, borderColor: C.gray, leftPad }),
				panelRow(`❯ ${label ?? "暂无可用模型"} · ↑${selectedIndex} ↓${remaining}`, boxWidth, {
					borderColor: C.gray,
					leftPad,
				}),
			];
		}
		const rowBudget = Number.isFinite(availableHeight)
			? Math.max(1, Math.floor(availableHeight) - 2)
			: Math.max(1, items.length);
		const visibleCount = Math.min(Math.max(1, items.length), rowBudget);
		const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), items.length - visibleCount));
		const endIndex = startIndex + visibleCount;
		const body: string[] = [];
		if (this.notice !== undefined) body.push(`${C.warning}⚠ ${this.notice}${C.reset}`);

		if (items.length === 0) {
			body.push(`${C.dim}没有来自配置、Provider 或可信目录的可选模型${C.reset}`);
		} else if (this.level === "groups") {
			for (let i = startIndex; i < endIndex; i++) {
				const group = this.groups[i]!;
				const selected = i === selectedIndex;
				const hasCurrent = group.models.some((model) => this.isCurrent(model));
				const pointer = selected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const name = selected ? `${C.bold}${C.white}[${group.name}]${C.reset}` : `${C.gray}[${group.name}]${C.reset}`;
				const check = hasCurrent ? ` ${C.green}✓${C.reset}` : "";
				const description = `${C.dim}${group.description} (${group.models.length} 个模型)${C.reset}`;
				body.push(`${pointer} ${name}${check}  ${description}`);
			}
		} else {
			for (let i = startIndex; i < endIndex; i++) {
				const model = currentGroup!.models[i]!;
				const selected = i === selectedIndex;
				const pointer = selected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const name = selected ? `${C.bold}${C.white}${model.name}${C.reset}` : `${C.gray}${model.name}${C.reset}`;
				const check = this.isCurrent(model) ? ` ${C.green}✓${C.reset}` : "";
				body.push(`${pointer} ${name}${check}  ${C.dim}${model.description}${C.reset}`);
			}
		}

		const above = startIndex;
		const below = Math.max(0, items.length - endIndex);
		const scrollHint = above > 0 || below > 0 ? `↑${above} ↓${below} · ` : "";
		// 底边提示由键位表生成（W5）：提示与绑定不再可能漂移
		const actionHint = hintsFor(this.keymap(), Number.MAX_SAFE_INTEGER);
		return renderPanel({
			title,
			body,
			bottomTag: `${scrollHint}${actionHint}`,
			boxWidth,
			leftPad,
			borderColor: C.gray,
		});
	}
}
