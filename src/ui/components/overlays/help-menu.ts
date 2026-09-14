/**
 * 快捷键与命令帮助抽屉组件（对齐 Pi Component 规范，保留双栏排版视觉）。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../../core/utils.js";

export interface HelpCommandInfo {
	name: string;
	description: string;
}

export class HelpMenu implements Component, Focusable {
	focused = true;
	private commands: HelpCommandInfo[];
	onClose?: () => void;
	onConvertToInput?: (text: string) => void;

	constructor(commands: HelpCommandInfo[] = []) {
		this.commands = commands;
	}

	setCommands(commands: HelpCommandInfo[]): void {
		this.commands = commands;
	}

	handleInput(data: string): void {
		// 忽略终端鼠标移动报告序列 (SGR 模式 \x1b[<... 或 X10 \x1b[M...)
		if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) {
			return;
		}
		if (data === "?") {
			if (this.onConvertToInput) {
				this.onConvertToInput("?");
			} else {
				this.onClose?.();
			}
			return;
		}
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			data === "q" ||
			data === "Q" ||
			data === " " ||
			(!data.startsWith("\x1b") && data.length > 0)
		) {
			this.onClose?.();
		}
	}

	render(terminalWidth = 80): string[] {
		return this.formatLines(terminalWidth);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80): string[] {
		const boxWidth = Math.max(54, Math.min(terminalWidth - 4, 92));
		const borderCol = C.subtle;

		// 1. 双栏数据
		const leftShortcuts: Array<[string, string]> = [
			["Alt+A", "子智能体看板 (Subagents)"],
			["Alt+J", "后台任务看板 (TaskDashboard)"],
			["Alt+T", "全屏审计轨迹时序 (Trajectory)"],
			["Alt+H", "会话历史分支检视 (History)"],
			["Alt+↑ / Alt+Q", "待办队列撤回至草稿"],
			["Ctrl+Enter", "紧急打断并立即插队发送"],
			["Shift+Tab", "循环切换思考强度 (off/high/max)"],
			["Ctrl+O", "展开/收起思考或会话卡片"],
			["Alt+O", "全展开/全折叠思考链"],
			["Shift+Enter", "多行换行编辑"],
			["Esc", "取消浮层 / 打断并递送待办"],
			["?", "在空行快速唤起/收起此帮助"],
		];

		// 帮助面板展示的命令必须与 CommandRouter 的实际分发表一致：
		// 没有别名机制，凡是 registry 里不存在的名字一律不展示，避免「幽灵命令」。
		const commandMap = new Map<string, string>();
		for (const c of this.commands) {
			commandMap.set(`/${c.name}`, c.description);
		}

		const defaultRightCommands: Array<[string, string]> = [
			["/help", "查看所有可用命令与快捷键"],
			["/model", "切换模型或打开模型选择面板"],
			["/effort", "设置或调整模型思考强度 (滑块/参数)"],
			["/compact", "会话压缩与释放上下文空间"],
			["/subagents", "多智能体并行看板 (Alt+A)"],
			["/tasks", "后台任务与进程看板 (Alt+J)"],
			["/trajectory", "全屏审计轨迹时序看板 (Alt+T)"],
			["/gutter", "切换右侧导航轨 (scrollbar/timeline)"],
			["/clear", "清空当前屏幕转录流"],
			["/reload", "重载项目与本地扩展"],
			["/quit", "退出控制台"],
		];

		const rightCommands: Array<[string, string]> =
			commandMap.size > 0 ? Array.from(commandMap.entries()) : defaultRightCommands;

		const maxRows = Math.max(leftShortcuts.length, rightCommands.length);
		const col1W = Math.floor((boxWidth - 7) * 0.46);
		const col2W = boxWidth - 7 - col1W;
		const innerContentW = col1W + col2W + 5; // 刚好等于 boxWidth - 2

		// 1. 顶边框
		const titleTag = `─ 快捷键与指令总览 (Help Menu) `;
		const topFillLen = Math.max(1, innerContentW - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${C.inactive}${titleTag}${borderCol}${"─".repeat(topFillLen)}╮${C.reset}`;

		const output: string[] = [topLine];

		// 2. 分栏标题
		const col1Title = `${C.bold}${C.suggestion}▸ 常用快捷键${C.reset}`;
		const col2Title = `${C.bold}${C.suggestion}▸ 常用斜杠指令${C.reset}`;
		const col1Pad = Math.max(0, col1W - visibleWidth(col1Title));
		const col2Pad = Math.max(0, col2W - visibleWidth(col2Title));
		const headerLine = `  ${borderCol}│${C.reset} ${col1Title}${" ".repeat(col1Pad)} ${borderCol}│${C.reset} ${col2Title}${" ".repeat(col2Pad)} ${borderCol}│${C.reset}`;
		output.push(headerLine);

		// 3. 分栏分割线 (col1W + 2 对应左栏内部宽度，中线 ┼ 精确对齐中间竖线 │)
		output.push(`  ${borderCol}├${"─".repeat(col1W + 2)}┼${"─".repeat(col2W + 2)}┤${C.reset}`);

		// 4. 数据行循环（全防御截断，防止超长文本撑破边框）
		for (let r = 0; r < maxRows; r++) {
			const left = leftShortcuts[r];
			const right = rightCommands[r];

			let leftFormatted = "";
			if (left) {
				const key = `${C.suggestion}${left[0]}${C.reset}`;
				const desc = `${C.text}${left[1]}${C.reset}`;
				const raw = `${key} ${desc}`;
				leftFormatted = visibleWidth(raw) > col1W ? truncateToWidth(raw, col1W, "…") : raw;
			}
			const leftPad = Math.max(0, col1W - visibleWidth(leftFormatted));

			let rightFormatted = "";
			if (right) {
				const cmd = `${C.suggestion}${right[0]}${C.reset}`;
				const desc = `${C.text}${right[1]}${C.reset}`;
				const raw = `${cmd} ${desc}`;
				rightFormatted = visibleWidth(raw) > col2W ? truncateToWidth(raw, col2W, "…") : raw;
			}
			const rightPad = Math.max(0, col2W - visibleWidth(rightFormatted));

			const rowLine = `  ${borderCol}│${C.reset} ${leftFormatted}${" ".repeat(leftPad)} ${borderCol}│${C.reset} ${rightFormatted}${" ".repeat(rightPad)} ${borderCol}│${C.reset}`;
			output.push(rowLine);
		}

		// 5. 底部提示区分割线
		output.push(`  ${borderCol}├${"─".repeat(innerContentW)}┤${C.reset}`);

		// 6. 底部操作指引行
		const hint = `${C.inactive}按 ${C.suggestion}Esc${C.inactive}、${C.suggestion}q${C.inactive} 收起 · 再按 ${C.suggestion}?${C.inactive} 转为普通输入${C.reset}`;
		const hintEffective = visibleWidth(hint) > innerContentW - 2 ? truncateToWidth(hint, innerContentW - 2, "…") : hint;
		const hintPad = Math.max(0, innerContentW - 2 - visibleWidth(hintEffective));
		output.push(`  ${borderCol}│${C.reset} ${hintEffective}${" ".repeat(hintPad)} ${borderCol}│${C.reset}`);

		// 7. 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(innerContentW)}╯${C.reset}`;
		output.push(botLine);

		return output;
	}
}
