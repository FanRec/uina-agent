/**
 * 模型快速选择器组件（对齐 Pi Component 规范，保留两级下钻选择视觉）。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth } from "../../core/utils.js";

export interface ModelItem {
	id: string;
	name: string;
	description: string;
	provider: string;
}

export interface ModelGroup {
	id: string;
	name: string;
	description: string;
	models: ModelItem[];
}

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

		const grpIdx = this.groups.findIndex((g) => g.models.some((m) => m.id === currentModelId));
		if (grpIdx >= 0) {
			this.selectedGroupIndex = grpIdx;
			const mIdx = this.groups[grpIdx]!.models.findIndex((m) => m.id === currentModelId);
			if (mIdx >= 0) this.selectedModelIndex = mIdx;
		}
	}

	setGroups(groups: ModelGroup[]): void {
		this.groups = groups;
		this.selectedGroupIndex = Math.min(this.selectedGroupIndex, Math.max(0, groups.length - 1));
	}

	navigateUp(): void {
		if (this.level === "groups") {
			this.selectedGroupIndex = Math.max(0, this.selectedGroupIndex - 1);
		} else {
			this.selectedModelIndex = Math.max(0, this.selectedModelIndex - 1);
		}
	}

	navigateDown(): void {
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
			if (!group) return null;
			this.level = "models";
			const mIdx = group.models.findIndex((m) => m.id === this.currentModelId);
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

	render(terminalWidth = 80): string[] {
		return this.formatLines(terminalWidth);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80): string[] {
		const boxWidth = Math.max(44, Math.min(terminalWidth - 6, 78));
		const innerW = boxWidth - 4;
		const borderCol = C.gray;

		const currentGroup = this.groups[this.selectedGroupIndex] ?? this.groups[0];

		const titleTag =
			this.level === "groups"
				? `─ 切换模型服务商 (Providers) `
				: `─ 选择模型 (${currentGroup?.name ?? "未知"}) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		const output: string[] = [topLine];

		if (this.groups.length === 0) {
			const empty = `${C.dim}没有来自配置、Provider 或可信目录的可选模型${C.reset}`;
			output.push(`  ${borderCol}│${C.reset} ${empty}${" ".repeat(Math.max(0, innerW - visibleWidth(empty)))} ${borderCol}│${C.reset}`);
		} else if (this.level === "groups") {
			for (let i = 0; i < this.groups.length; i++) {
				const grp = this.groups[i]!;
				const isSelected = i === this.selectedGroupIndex;
				const hasCurrent = grp.models.some((m) => m.id === this.currentModelId);
				const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const nameTag = isSelected
					? `${C.bold}${C.white}[${grp.name}]${C.reset}`
					: `${C.gray}[${grp.name}]${C.reset}`;
				const check = hasCurrent ? ` ${C.green}✓${C.reset}` : "";
				const desc = `${C.dim}${grp.description} (${grp.models.length} 个模型)${C.reset}`;

				const content = `${pointer} ${nameTag}${check}  ${desc}`;
				const padLen = Math.max(0, innerW - visibleWidth(content));
				output.push(`  ${borderCol}│${C.reset} ${content}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
			}
		} else {
			for (let i = 0; i < (currentGroup?.models.length ?? 0); i++) {
				const model = currentGroup.models[i]!;
				const isSelected = i === this.selectedModelIndex;
				const isCurrent = model.id === this.currentModelId;
				const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const nameTag = isSelected
					? `${C.bold}${C.white}${model.name}${C.reset}`
					: `${C.gray}${model.name}${C.reset}`;
				const check = isCurrent ? ` ${C.green}✓${C.reset}` : "";
				const desc = `${C.dim}${model.description}${C.reset}`;

				const content = `${pointer} ${nameTag}${check}  ${desc}`;
				const padLen = Math.max(0, innerW - visibleWidth(content));
				output.push(`  ${borderCol}│${C.reset} ${content}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
			}
		}

		const bottomHint = this.groups.length === 0
			? `Esc 关闭`
			: this.level === "groups"
				? `↑↓ 移动 · Enter 展开 · Esc 关闭`
				: `↑↓ 移动 · Enter 确认切换 · Esc 返回`;
		const botFillLen = Math.max(1, boxWidth - 2 - visibleWidth(bottomHint) - 2);
		const botLine = `  ${borderCol}╰─ ${C.dim}${bottomHint}${C.reset} ${borderCol}${"─".repeat(botFillLen)}╯${C.reset}`;
		output.push(botLine);

		return output;
	}
}
