import type { ProcessTerminal } from "../../../src/ui/core/terminal.js";

export interface SilentTerminalResult {
	readonly terminal: ProcessTerminal;
	readonly frames: string[];
	getVisibleText(): string;
	getLastFrame(): string | undefined;
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
 * 捕获所有渲染帧，绝不向真实 process.stdout 刷屏输出，杜绝测试控制台污染。
 */
export function createSilentTerminal(
	optionsOrColumns: SilentTerminalOptions | number = 120,
	rowsArg = 30,
): SilentTerminalResult {
	const options: SilentTerminalOptions =
		typeof optionsOrColumns === "number"
			? { columns: optionsOrColumns, rows: rowsArg }
			: optionsOrColumns;

	const columns = options.columns ?? 120;
	const rows = options.rows ?? 30;
	const isTTY = options.isTTY ?? true;
	const frames: string[] = [];

	const terminal = {
		columns,
		rows,
		isTTY,
		syncWrite: (data: string) => {
			frames.push(data);
		},
		write: (data: string) => {
			frames.push(data);
		},
		start: () => {},
		stop: () => {},
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
		getVisibleText: () => stripAnsiColors(frames.join("\n")),
		getLastFrame: () => frames.at(-1),
		clear: () => {
			frames.length = 0;
		},
	};
}
