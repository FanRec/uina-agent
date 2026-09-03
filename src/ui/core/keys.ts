/**
 * 终端按键解析与匹配模块（移植自 pi-tui keys.ts 精简版）。
 */

export const Key = {
	enter: "enter",
	shiftEnter: "shift+enter",
	backspace: "backspace",
	tab: "tab",
	shiftTab: "shift+tab",
	escape: "escape",
	space: "space",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	home: "home",
	end: "end",
	delete: "delete",
	pageup: "pageup",
	pagedown: "pagedown",
	ctrl: (c: string) => `ctrl+${c.toLowerCase()}`,
	alt: (c: string) => `alt+${c.toLowerCase()}`,
	shift: (c: string) => `shift+${c.toLowerCase()}`,
};

import { isShiftPressed } from "./native-modifiers.js";

/**
 * 检查输入的 raw 数据是否匹配目标键位定义
 */
export function matchesKey(data: string, keyId: string): boolean {
	switch (keyId) {
		case "shift+enter":
		case "shift+return":
			if (
				data === "\x1b[13;2u" ||
				data === "\x1b[13;2:1u" ||
				data === "\x1b[27;2;13~" ||
				data === "\x1b[13;2~" ||
				data === "\x1b\r" ||
				data === "\x1b\n"
			) {
				return true;
			}
			// Windows Terminal / ConPTY 底层修饰键补偿：如果收到回车字符且物理 Shift 处于按下状态
			if ((data === "\r" || data === "\n" || data === "\r\n") && isShiftPressed()) {
				return true;
			}
			return false;

		case "enter":
			// 如果物理 Shift 键正被按住，严禁作为普通 Enter 提交！
			if (isShiftPressed()) {
				return false;
			}
			return (
				data === "\r" ||
				data === "\n" ||
				data === "\r\n" ||
				data === "\x1b[13u" ||
				data === "\x1b[13:1u" ||
				data === "\x1bOM"
			);
		case "backspace":
			return data === "\x7f" || data === "\x08";
		case "shift+tab":
		case "backtab":
			if (
				data === "\x1b[Z" ||
				data === "\x1b[9;2u" ||
				data === "\x1b[9;2:1u" ||
				data === "\x1b[27;2;9~"
			) {
				return true;
			}
			if (data === "\t" && isShiftPressed()) {
				return true;
			}
			return false;
		case "tab":
			if (isShiftPressed()) {
				return false;
			}
			return data === "\t";
		case "escape":
			return data === "\x1b";
		case "up":
			return data === "\x1b[A" || data === "\x1bOA";
		case "down":
			return data === "\x1b[B" || data === "\x1bOB";
		case "right":
			return data === "\x1b[C" || data === "\x1bOC";
		case "left":
			return data === "\x1b[D" || data === "\x1bOD";
		case "home":
			return data === "\x1b[H" || data === "\x1b[1~";
		case "end":
			return data === "\x1b[F" || data === "\x1b[4~";
		case "delete":
			return data === "\x1b[3~";
		case "pageup":
			return data === "\x1b[5~";
		case "pagedown":
			return data === "\x1b[6~";
		// 常用快捷键组合
		case "ctrl+a":
			return data === "\x01";
		case "ctrl+b":
			return data === "\x02";
		case "ctrl+c":
			return data === "\x03";
		case "ctrl+d":
			return data === "\x04";
		case "ctrl+e":
			return data === "\x05";
		case "ctrl+k":
			return data === "\x0b";
		case "ctrl+l":
			return data === "\x0c";
		case "ctrl+n":
			return data === "\x0e";
		case "ctrl+o":
			return data === "\x0f";
		case "ctrl+p":
			return data === "\x10";
		case "ctrl+u":
			return data === "\x15";
		case "ctrl+v":
			return data === "\x16";
		case "ctrl+w":
			return data === "\x17";
		case "ctrl+z":
			return data === "\x1a";
		case "ctrl+left":
			return data === "\x1b[1;5D" || data === "\x1b\x1b[D";
		case "ctrl+right":
			return data === "\x1b[1;5C" || data === "\x1b\x1b[C";
		case "alt+backspace":
			return data === "\x1b\x7f" || data === "\x1b\x08";
		case "alt+o":
			return (
				data === "\x1bo" ||
				data === "\x1bO" ||
				data === "\x1b[111;3u" ||
				data === "\x1b[79;3u"
			);
		case "alt+a":
			return (
				data === "\x1ba" ||
				data === "\x1bA" ||
				data === "\x1b[97;3u" ||
				data === "\x1b[65;3u"
			);
		case "alt+j":
			return (
				data === "\x1bj" ||
				data === "\x1bJ" ||
				data === "\x1b[106;3u" ||
				data === "\x1b[74;3u"
			);
		case "alt+t":
			return (
				data === "\x1bt" ||
				data === "\x1bT" ||
				data === "\x1b[116;3u" ||
				data === "\x1b[84;3u"
			);
		default:
			return data === keyId;
	}
}

/** 判断是否为 Bracketed Paste 开始标记 */
export function isPasteStart(data: string): boolean {
	return data.startsWith("\x1b[200~");
}

/** 判断是否为 Bracketed Paste 结束标记 */
export function isPasteEnd(data: string): boolean {
	return data.includes("\x1b[201~");
}

export interface MouseClickEvent {
	button: number; // 0: left, 1: middle, 2: right
	col: number; // 1-based
	row: number; // 1-based
	isDown: boolean;
}

/**
 * 解析 ANSI SGR 鼠标点击事件（\x1b[<button;col;row(M|m)）
 */
export function parseMouseEvent(data: string): MouseClickEvent | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
	if (match) {
		return {
			button: parseInt(match[1]!, 10),
			col: parseInt(match[2]!, 10),
			row: parseInt(match[3]!, 10),
			isDown: match[4] === "M",
		};
	}
	return null;
}

