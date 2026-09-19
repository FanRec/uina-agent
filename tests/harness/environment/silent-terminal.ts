import type { ProcessTerminal } from "../../../src/ui/core/terminal.js";
import { VtScreen } from "./vt-screen.js";

export interface SilentTerminalResult {
	readonly terminal: ProcessTerminal;
	readonly frames: string[];
	readonly screen: VtScreen;
	getVisibleText(): string;
	getLastFrame(): string | undefined;
	feedInput(data: string): void;
	resize(cols: number, rows: number): void;
	clear(): void;
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 从 ANSI 转义序列中剥离控制符，还原纯可见文本。 */
export function stripAnsiColors(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

export interface SilentTerminalOptions {
	columns?: number;
	rows?: number;
	isTTY?: boolean;
}

/**
 * 创建静音的虚拟终端实例：
 * 捕获所有渲染帧，由 VtScreen 逐格仿真当前真实可见屏幕，绝不向真实 process.stdout 刷屏。
 */
export function createSilentTerminal(
	optionsOrColumns: SilentTerminalOptions | number = 120,
	rowsArg = 30,
): SilentTerminalResult {
	const options: SilentTerminalOptions =
		typeof optionsOrColumns === "number"
			? { columns: optionsOrColumns, rows: rowsArg }
			: optionsOrColumns;

	let columns = options.columns ?? 120;
	let rows = options.rows ?? 30;
	const isTTY = options.isTTY ?? true;
	const frames: string[] = [];
	let screen = new VtScreen(columns, rows);
	let inputHandler: ((data: string) => void) | undefined;
	let resizeHandler: (() => void) | undefined;

	const terminal = {
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
		isTTY,
		syncWrite: (data: string) => {
			frames.push(data);
			screen.feed(data);
		},
		write: (data: string) => {
			frames.push(data);
			screen.feed(data);
		},
		start: (onInput?: (data: string) => void, onResize?: () => void) => {
			inputHandler = onInput;
			resizeHandler = onResize;
		},
		stop: () => {
			inputHandler = undefined;
			resizeHandler = undefined;
		},
		hideCursor: () => {},
		showCursor: () => {},
		cursorUp: () => {},
		cursorDown: () => {},
		clearLine: () => {},
		clearDown: () => {},
		moveTo: () => {},
	} as unknown as ProcessTerminal;

	return {
		terminal,
		frames,
		get screen() {
			return screen;
		},
		getVisibleText: () => screen.getVisibleText(),
		getLastFrame: () => frames.at(-1),
		feedInput: (data: string) => {
			inputHandler?.(data);
		},
		resize: (cols: number, newRows: number) => {
			columns = cols;
			rows = newRows;
			screen = new VtScreen(columns, rows);
			resizeHandler?.();
		},
		clear: () => {
			frames.length = 0;
			screen = new VtScreen(columns, rows);
		},
	};
}
