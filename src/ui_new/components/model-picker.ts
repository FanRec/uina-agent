/**
 * 模型快速选择器组件（复刻 dsh-TUI 与 Claude Code ModelPicker 两级下钻选择规范）。
 * 特性：
 * 1. 支持“服务商分组 (Providers) -> 细分模型 (Models)”两级平滑下钻与 Esc 返回；
 * 2. 键盘导航：↑ / ↓ 移动光标（❯），Enter 确认/进入，Esc 返回或退出；
 * 3. 当前激活模型带 ✓ 标识，聚焦行带说明描述；
 * 4. 4 面细线全封闭圆角盒子，像素级对齐。
 */

import { C, visibleWidth, truncateToWidth } from "../core/utils.js";

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

export const DEFAULT_MODEL_GROUPS: ModelGroup[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		description: "DeepSeek 官方 API 平台",
		models: [
			{ id: "deepseek-chat", name: "deepseek-chat", description: "通用极速模型 (DeepSeek-V3)", provider: "deepseek" },
			{ id: "deepseek-reasoner", name: "deepseek-reasoner", description: "长推理思考模型 (DeepSeek-R1)", provider: "deepseek" },
		],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		description: "Claude 尖端编程与推理模型",
		models: [
			{ id: "claude-3-7-sonnet", name: "claude-3-7-sonnet", description: "混合推理与编码旗舰", provider: "anthropic" },
			{ id: "claude-3-5-haiku", name: "claude-3-5-haiku", description: "轻量极速端到端响应", provider: "anthropic" },
		],
	},
	{
		id: "openai",
		name: "OpenAI",
		description: "GPT 与 O 系列推理模型",
		models: [
			{ id: "gpt-4o", name: "gpt-4o", description: "多模态全能旗舰模型", provider: "openai" },
			{ id: "o3-mini", name: "o3-mini", description: "高性价比 STEM 深度思考模型", provider: "openai" },
		],
	},
	{
		id: "ollama",
		name: "Ollama",
		description: "本地私有化离线部署模型",
		models: [
			{ id: "qwen2.5-coder:32b", name: "qwen2.5-coder:32b", description: "通义千问本地代码特化版", provider: "ollama" },
			{ id: "deepseek-r1:14b", name: "deepseek-r1:14b", description: "本地蒸馏深度思考模型", provider: "ollama" },
		],
	},
];

export class ModelPicker {
	private groups: ModelGroup[];
	private currentModelId: string;
	private level: "groups" | "models" = "groups";
	private selectedGroupIndex = 0;
	private selectedModelIndex = 0;

	constructor(currentModelId = "deepseek-chat", groups = DEFAULT_MODEL_GROUPS) {
		this.groups = groups;
		this.currentModelId = currentModelId;

		// 自动定位当前模型所在组
		const grpIdx = this.groups.findIndex((g) => g.models.some((m) => m.id === currentModelId));
		if (grpIdx >= 0) {
			this.selectedGroupIndex = grpIdx;
			const mIdx = this.groups[grpIdx]!.models.findIndex((m) => m.id === currentModelId);
			if (mIdx >= 0) this.selectedModelIndex = mIdx;
		}
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

	/**
	 * 按 Enter：
	 * 在 groups 层级时进入 models 层；
	 * 在 models 层级时选中模型并返回 modelId。
	 */
	confirm(): { action: "drilled" } | { action: "picked"; modelId: string } | null {
		if (this.level === "groups") {
			this.level = "models";
			const group = this.groups[this.selectedGroupIndex];
			if (group) {
				const mIdx = group.models.findIndex((m) => m.id === this.currentModelId);
				this.selectedModelIndex = mIdx >= 0 ? mIdx : 0;
			}
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

	/**
	 * 按 Esc：
	 * 在 models 层级时回退到 groups 层；
	 * 在 groups 层级时退出浮层。
	 */
	back(): { action: "back" } | { action: "close" } {
		if (this.level === "models") {
			this.level = "groups";
			return { action: "back" };
		}
		return { action: "close" };
	}

	/**
	 * 渲染浮层行
	 */
	formatLines(terminalWidth = 80): string[] {
		const boxWidth = Math.max(44, Math.min(terminalWidth - 6, 78));
		const innerW = boxWidth - 4; // 减去两端 "│ " 与 " │"
		const borderCol = C.gray;

		const currentGroup = this.groups[this.selectedGroupIndex]!;

		// 1. 顶边框
		const titleTag =
			this.level === "groups"
				? `─ 切换模型服务商 (Providers) `
				: `─ 选择模型 (${currentGroup.name}) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		const output: string[] = [topLine];

		if (this.level === "groups") {
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
			for (let i = 0; i < currentGroup.models.length; i++) {
				const model = currentGroup.models[i]!;
				const isSelected = i === this.selectedModelIndex;
				const isCurrent = model.id === this.currentModelId;
				const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
				const nameTag = isSelected
					? `${C.bold}${C.cyan}${model.name}${C.reset}`
					: `${C.white}${model.name}${C.reset}`;
				const check = isCurrent ? ` ${C.green}✓${C.reset}` : "";
				const desc = `${C.dim}· ${model.description}${C.reset}`;

				const content = `${pointer} ${nameTag}${check}  ${desc}`;
				const padLen = Math.max(0, innerW - visibleWidth(content));
				output.push(`  ${borderCol}│${C.reset} ${content}${" ".repeat(padLen)} ${borderCol}│${C.reset}`);
			}
		}

		// 底部提示行
		output.push(`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`);
		const hintText =
			this.level === "groups"
				? `${C.dim}↑↓ 移动 · Enter 进入 · Esc 取消${C.reset}`
				: `${C.dim}↑↓ 移动 · Enter 确认切换 · Esc 返回上级${C.reset}`;
		const hintPad = Math.max(0, innerW - visibleWidth(hintText));
		output.push(`  ${borderCol}│${C.reset} ${hintText}${" ".repeat(hintPad)} ${borderCol}│${C.reset}`);

		// 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;
		output.push(botLine);

		return output;
	}
}
