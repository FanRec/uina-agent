/**
 * 快捷键与命令帮助抽屉组件（复刻 dsh-TUI 与 Claude Code HelpMenu 视觉规范）。
 * 特性：
 * 1. 空输入框按 ? 或敲 /help 弹出，按 Esc 或键入文本即时收起；
 * 2. 双栏排版：左栏“全局快捷键”、右栏“可用斜杠指令”；
 * 3. 细线圆角全封闭几何盒子，像素级对齐。
 */

import { C, visibleWidth } from "../core/utils.js";

export interface HelpCommandInfo {
	name: string;
	description: string;
}

export class HelpMenu {
	private commands: HelpCommandInfo[];

	constructor(commands: HelpCommandInfo[] = []) {
		this.commands = commands;
	}

	setCommands(commands: HelpCommandInfo[]): void {
		this.commands = commands;
	}

	formatLines(terminalWidth = 80): string[] {
		const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 88));
		const innerW = boxWidth - 4; // 减去两端 "│ " 与 " │"
		const borderCol = C.gray;

		// 1. 顶边框
		const titleTag = `─ 快捷键与指令总览 (Help Menu) `;
		const topFillLen = Math.max(1, boxWidth - 2 - visibleWidth(titleTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(topFillLen)}╮${C.reset}`;

		// 2. 双栏数据
		const leftShortcuts: Array<[string, string]> = [
			["Alt+A", "子智能体看板 (Subagents)"],
			["Alt+J", "后台任务看板 (TaskDashboard)"],
			["Alt+T", "全屏审计轨迹 (Trajectory)"],
			["Shift+Tab", "循环切换思考强度"],
			["Ctrl+O", "展开/收起思考或卡片"],
			["Alt+O", "全展开/全折叠思考链"],
			["Shift+Enter", "多行换行输入"],
			["Tab / ↑↓", "联想选择与补全"],
			["Esc", "取消浮层 / 中断运行"],
			["?", "在空行快速唤起此帮助"],
		];

		// 过滤并合并别名指令（如 /agents, /jobs, /traj, /exit），保持双栏对称整洁
		const commandMap = new Map<string, string>();
		for (const c of this.commands) {
			if (c.name === "agents" || c.name === "jobs" || c.name === "traj" || c.name === "exit") {
				continue;
			}
			let nameDisplay = `/${c.name}`;
			if (c.name === "subagents") nameDisplay = "/subagents, /agents";
			else if (c.name === "tasks") nameDisplay = "/tasks, /jobs";
			else if (c.name === "trajectory") nameDisplay = "/trajectory, /traj";
			else if (c.name === "quit") nameDisplay = "/quit, /exit";
			commandMap.set(nameDisplay, c.description);
		}

		const rightCommands: Array<[string, string]> = commandMap.size > 0
			? Array.from(commandMap.entries())
			: [
					["/model", "快速切模型浮层"],
					["/effort", "思考强度调节滑块"],
					["/subagents, /agents", "多子智能体看板与详情审查"],
					["/tasks, /jobs", "后台作业与进程管理看板"],
					["/trajectory, /traj", "全屏事件时序与性能热点剖析"],
					["/compact", "会话压缩与释放上下文"],
					["/diff", "展开/折叠差异对比"],
					["/clear", "清屏并重置当前历史"],
					["/quit, /exit", "退出终端助手"],
				];

		const maxRows = Math.max(leftShortcuts.length, rightCommands.length);
		const col1W = Math.floor((innerW - 3) * 0.48);
		const col2W = innerW - 3 - col1W;

		const output: string[] = [topLine];

		// 分栏标题
		const col1Title = `${C.bold}${C.iceBlue}▸ 常用快捷键${C.reset}`;
		const col2Title = `${C.bold}${C.iceBlue}▸ 常用斜杠指令${C.reset}`;
		const headerLine = `  ${borderCol}│${C.reset} ${col1Title}${" ".repeat(Math.max(0, col1W - visibleWidth(col1Title)))} ${borderCol}│${C.reset} ${col2Title}${" ".repeat(Math.max(0, col2W - visibleWidth(col2Title)))} ${borderCol}│${C.reset}`;
		output.push(headerLine);
		output.push(`  ${borderCol}├${"─".repeat(col1W + 1)}┼${"─".repeat(col2W + 2)}┤${C.reset}`);

		// 数据行
		for (let r = 0; r < maxRows; r++) {
			const left = leftShortcuts[r];
			const right = rightCommands[r];

			let leftContent = "";
			if (left) {
				const key = `${C.cyan}${left[0]}${C.reset}`;
				const desc = `${C.dim}${left[1]}${C.reset}`;
				leftContent = `${key} ${desc}`;
			}
			const leftPad = Math.max(0, col1W - visibleWidth(leftContent));

			let rightContent = "";
			if (right) {
				const cmd = `${C.cyan}${right[0]}${C.reset}`;
				const desc = `${C.dim}${right[1]}${C.reset}`;
				rightContent = `${cmd} ${desc}`;
			}
			const rightPad = Math.max(0, col2W - visibleWidth(rightContent));

			const rowLine = `  ${borderCol}│${C.reset} ${leftContent}${" ".repeat(leftPad)} ${borderCol}│${C.reset} ${rightContent}${" ".repeat(rightPad)} ${borderCol}│${C.reset}`;
			output.push(rowLine);
		}

		// 底部提示行
		output.push(`  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`);
		const hintText = `${C.dim}按 Esc 或键入任意字符即刻收起抽屉${C.reset}`;
		const hintPad = Math.max(0, innerW - visibleWidth(hintText));
		output.push(`  ${borderCol}│${C.reset} ${hintText}${" ".repeat(hintPad)} ${borderCol}│${C.reset}`);

		// 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;
		output.push(botLine);

		return output;
	}
}
