/**
 * 模型快速选择器组件（对齐 Pi Component 规范，保留两级下钻选择视觉）。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";
import type { ModelPickerGroup } from "../../../extensions/ui-contract.js";

export type ModelGroup = ModelPickerGroup;
type ModelItem = ModelPickerGroup["models"][number];

export class ModelPicker implements Component, Focusable {
	focused = true;
	private groups: ModelGroup[];
	private currentModelId?: string;
	private level: "groups" | "models" = "groups";
	private selectedGroupIndex = 0;
	private selectedModelIndex = 0;

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

	navigateUp(): void {
		if (this.groups.length === 0) return;
		if (this.level === "groups") {
			this.selectedGroupIndex = Math.max(0, this.selectedGroupIndex - 1);
		} else {
			this.selectedModelIndex = Math.max(0, this.selectedModelIndex - 1);
		}
	}

	navigateDown(): void {
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
			if (!group || group.models.length === 0) return null;
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
			return { action: "back" };
		}
		return { action: "close" };
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.navigateUp();
			this.onRequestRender?.();
		} else if (matchesKey(data, Key.down)) {
			this.navigateDown();
			this.onRequestRender?.();
		} else if (matchesKey(data, Key.enter)) {
			const res = this.confirm();
			if (res?.action === "picked") {
				this.onPick?.(res.modelId);
			} else {
				this.onRequestRender?.();
			}
		} else if (matchesKey(data, Key.escape)) {
			const res = this.back();
			if (res.action === "close") {
				this.onClose?.();
			} else {
				this.onRequestRender?.();
			}
		}
	}

	render(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		return this.formatLines(terminalWidth, availableHeight);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		if (terminalWidth <= 0 || availableHeight <= 0) return [];
		if (terminalWidth < 5) return [truncateToWidth("模型", terminalWidth, "")];
		const leftPad = terminalWidth >= 48 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(terminalWidth - leftPad, 78));
		const innerW = Math.max(1, boxWidth - 4);
		const borderCol = C.gray;
		const currentGroup = this.groups[this.selectedGroupIndex] ?? this.groups[0];
		const title = this.level === "groups" ? "切换模型服务商 (Providers)" : `选择模型 (${currentGroup?.name ?? "未知"})`;
		const safeTitle = truncateToWidth(title, Math.max(1, boxWidth - 6), "…");
		const topTag = `─ ${safeTitle} `;
		const topFill = Math.max(0, boxWidth - 2 - visibleWidth(topTag));
		const pad = " ".repeat(leftPad);
		const topLine = `${pad}${borderCol}╭${topTag}${borderCol}${"─".repeat(topFill)}╮${C.reset}`;
		const frameLine = (content: string): string => {
			const safe = truncateToWidth(content, innerW, "…");
			return `${pad}${borderCol}│${C.reset} ${safe}${" ".repeat(Math.max(0, innerW - visibleWidth(safe)))} ${borderCol}│${C.reset}`;
		};
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
		if (height === 1) return [topLine];
		if (height === 2) {
			const selectedItem = items[selectedIndex];
			const label =
				this.level === "groups" ? this.groups[selectedIndex]?.name : (selectedItem as ModelItem | undefined)?.name;
			const remaining = Math.max(0, items.length - selectedIndex - 1);
			return [topLine, frameLine(`❯ ${label ?? "暂无可用模型"} · ↑${selectedIndex} ↓${remaining}`)];
		}
		const rowBudget = Number.isFinite(availableHeight)
			? Math.max(1, Math.floor(availableHeight) - 2)
			: Math.max(1, items.length);
		const visibleCount = Math.min(Math.max(1, items.length), rowBudget);
		const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), items.length - visibleCount));
		const endIndex = startIndex + visibleCount;
		const output = [topLine];

		if (items.length === 0) {
			output.push(frameLine("没有来自配置、Provider 或可信目录的可选模型"));
		} else if (this.level === "groups") {
			for (let i = startIndex; i < endIndex; i++) {
				const group = this.groups[i]!;
				const selected = i === selectedIndex;
				const hasCurrent = group.models.some((model) => this.isCurrent(model));
				const pointer = selected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const name = selected ? `${C.bold}${C.white}[${group.name}]${C.reset}` : `${C.gray}[${group.name}]${C.reset}`;
				const check = hasCurrent ? ` ${C.green}✓${C.reset}` : "";
				const description = `${C.dim}${group.description} (${group.models.length} 个模型)${C.reset}`;
				output.push(frameLine(`${pointer} ${name}${check}  ${description}`));
			}
		} else {
			for (let i = startIndex; i < endIndex; i++) {
				const model = currentGroup!.models[i]!;
				const selected = i === selectedIndex;
				const pointer = selected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const name = selected ? `${C.bold}${C.white}${model.name}${C.reset}` : `${C.gray}${model.name}${C.reset}`;
				const check = this.isCurrent(model) ? ` ${C.green}✓${C.reset}` : "";
				output.push(frameLine(`${pointer} ${name}${check}  ${C.dim}${model.description}${C.reset}`));
			}
		}

		const above = startIndex;
		const below = Math.max(0, items.length - endIndex);
		const scrollHint = above > 0 || below > 0 ? `↑${above} ↓${below} · ` : "";
		const actionHint =
			items.length === 0
				? "Esc 关闭"
				: this.level === "groups"
					? "↑↓ 移动 · Enter 展开 · Esc 关闭"
					: "↑↓ 移动 · Enter 确认切换 · Esc 返回";
		const bottomHint = truncateToWidth(`${scrollHint}${actionHint}`, Math.max(1, innerW), "…");
		const bottomTag = `─ ${bottomHint} `;
		const bottomFill = Math.max(0, boxWidth - 2 - visibleWidth(bottomTag));
		output.push(`${pad}${borderCol}╰${bottomTag}${borderCol}${"─".repeat(bottomFill)}╯${C.reset}`);
		return output;
	}
}
