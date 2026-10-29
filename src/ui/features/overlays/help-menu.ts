/**
 * 快捷键与命令帮助抽屉组件（对齐 Pi Component 规范，保留双栏排版视觉）。
 */

import { Key, matchesKey } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C } from "../../core/utils.js";
import {
	panelBottomBorder,
	panelCrossDivider,
	panelDivider,
	panelRow,
	panelSplitRow,
	panelTopBorder,
	renderPanel,
} from "../../layout/panel.js";

export interface HelpCommandInfo {
	name: string;
	description: string;
}

type HelpRow = readonly [label: string, description: string];

const SHORTCUTS: readonly HelpRow[] = [
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

const DEFAULT_COMMANDS: readonly HelpRow[] = [
	["/help", "查看所有可用命令与快捷键"],
	["/model", "切换模型或打开模型选择面板"],
	["/effort", "设置或调整模型思考强度 (滑块/参数)"],
	["/compact", "会话压缩与释放上下文空间"],
	["/trajectory", "全屏审计轨迹时序看板 (Alt+T)"],
	["/gutter", "切换右侧导航轨 (scrollbar/timeline)"],
	["/clear", "清空当前屏幕转录流"],
	["/reload", "重载项目与本地扩展"],
	["/quit", "退出控制台"],
];

function commandRows(commands: readonly HelpCommandInfo[]): HelpRow[] {
	const rows = new Map<string, string>();
	for (const command of commands) rows.set(`/${command.name}`, command.description);
	return rows.size > 0 ? Array.from(rows.entries()) : [...DEFAULT_COMMANDS];
}

export class HelpMenu implements Component, Focusable {
	focused = true;
	private commands: HelpCommandInfo[];
	private scrollOffset = 0;
	onClose?: () => void;
	onRequestRender?: () => void;
	onConvertToInput?: (text: string) => void;

	constructor(commands: readonly HelpCommandInfo[] = []) {
		this.commands = [...commands];
	}

	setCommands(commands: readonly HelpCommandInfo[]): void {
		this.commands = [...commands];
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
		const pageKey = matchesKey(data, Key.pageup) || matchesKey(data, Key.pagedown);
		const step = pageKey ? 6 : 1;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.pageup) || data === "k" || data === "K") {
			this.scrollOffset = Math.max(0, this.scrollOffset - step);
			this.onRequestRender?.();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.pagedown) || data === "j" || data === "J") {
			this.scrollOffset += step;
			this.onRequestRender?.();
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

	render(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		return this.formatLines(terminalWidth, availableHeight);
	}

	invalidate(): void {}

	formatLines(terminalWidth = 80, availableHeight = Number.MAX_SAFE_INTEGER): string[] {
		if (terminalWidth <= 0 || availableHeight <= 0) return [];
		if (terminalWidth < 64) return this.formatCompactLines(terminalWidth, availableHeight);
		const leftPad = 2;
		const boxWidth = Math.max(54, Math.min(terminalWidth - leftPad, 92));

		// 双栏预算：leftW + rightW = boxWidth - 7（panelSplitRow 行模型）
		const leftW = Math.floor((boxWidth - 7) * 0.46);
		const rightW = boxWidth - 7 - leftW;
		const midCol = leftW + 4;

		// 1. 双栏数据
		const rightCommands = commandRows(this.commands);
		const maxRows = Math.max(SHORTCUTS.length, rightCommands.length);

		const output: string[] = [
			panelTopBorder(boxWidth, { title: "快捷键与指令总览 (Help Menu)", leftPad, borderColor: C.subtle }),
			panelSplitRow(
				boxWidth,
				`${C.bold}${C.suggestion}▸ 常用快捷键${C.reset}`,
				`${C.bold}${C.suggestion}▸ 常用斜杠指令${C.reset}`,
				midCol,
				{ leftPad, borderColor: C.subtle },
			),
			panelCrossDivider(boxWidth, [midCol], { leftPad, borderColor: C.subtle }),
		];

		// 2. 数据行（左右两栏各自按栏宽截断，行宽由 panelSplitRow 保证精确）
		for (let r = 0; r < maxRows; r++) {
			const left = SHORTCUTS[r];
			const right = rightCommands[r];
			const leftCell = left ? `${C.suggestion}${left[0]}${C.reset} ${C.text}${left[1]}${C.reset}` : "";
			const rightCell = right ? `${C.suggestion}${right[0]}${C.reset} ${C.text}${right[1]}${C.reset}` : "";
			output.push(panelSplitRow(boxWidth, leftCell, rightCell, midCol, { leftPad, borderColor: C.subtle }));
		}

		// 3. 底部提示区
		output.push(panelDivider(boxWidth, { leftPad, borderColor: C.subtle }));
		output.push(
			panelRow(
				`${C.inactive}按 ${C.suggestion}Esc${C.inactive}、${C.suggestion}q${C.inactive} 收起 · 再按 ${C.suggestion}?${C.inactive} 转为普通输入${C.reset}`,
				boxWidth,
				{ leftPad, borderColor: C.subtle },
			),
		);
		output.push(panelBottomBorder(boxWidth, { leftPad, borderColor: C.subtle }));

		return output.length > availableHeight ? this.formatCompactLines(terminalWidth, availableHeight) : output;
	}

	private formatCompactLines(terminalWidth: number, availableHeight: number): string[] {
		const leftPad = terminalWidth >= 64 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(terminalWidth - leftPad, 92));
		const commands = commandRows(this.commands);
		const rows = [...SHORTCUTS, ...commands].map(([key, description]) => `${key}  ${description}`);
		const bodyRows = Math.max(1, Math.floor(availableHeight) - 3);
		const maxOffset = Math.max(0, rows.length - bodyRows);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visible = rows.slice(this.scrollOffset, this.scrollOffset + bodyRows);
		return renderPanel({
			title: "帮助 · 快捷键与指令",
			body: visible,
			footer: `↑↓/j/k 滚动 · ↑${this.scrollOffset} ↓${maxOffset - this.scrollOffset} · Esc 关闭`,
			boxWidth,
			leftPad,
			borderColor: C.subtle,
		}).slice(0, Math.max(1, Math.floor(availableHeight)));
	}
}
