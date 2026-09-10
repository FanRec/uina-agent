/**
 * 终端底层输入输出封装（支持 RawMode、DEC CSI 2026 同步写入、光标定位）。
 */

import { initConsoleMode } from "./native-modifiers.js";

export class ProcessTerminal {
	private running = false;
	private rawModeActive = false;
	private onInputHandler?: (data: string) => void;
	private onResizeHandler?: () => void;

	constructor() {}

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	get isTTY(): boolean {
		return Boolean(process.stdout.isTTY && process.stdin.isTTY);
	}

	/** 启动终端交互：接管原始输入，启用括号粘贴 */
	start(onInput: (data: string) => void, onResize?: () => void): void {
		if (this.running) return;
		this.running = true;
		this.onInputHandler = onInput;
		this.onResizeHandler = onResize;

		initConsoleMode();

		if (this.isTTY) {
			try {
				process.stdin.setRawMode(true);
				this.rawModeActive = true;
			} catch {
				this.rawModeActive = false;
			}
			process.stdin.resume();
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", this.handleStdinData);

			if (this.onResizeHandler) {
				process.stdout.on("resize", this.onResizeHandler);
			}

			// 开启备用屏（DEC 1049）、清屏、括号粘贴模式、键盘扩展、SGR 鼠标跟踪（滚轮、选区与 Hover 悬停）
			process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h\x1b[>1u\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
		}
	}

	/** 恢复终端：关闭原始模式、光标显示、退出备用屏与鼠标跟踪 */
	stop(): void {
		if (!this.running) return;
		this.running = false;

		if (this.isTTY) {
			// 退出鼠标跟踪、退出备用屏（DEC 1049 恢复主屏历史）、关闭括号粘贴模式
			process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?2004l\x1b[<u\x1b[?25h");
			this.showCursor();

			process.stdin.removeListener("data", this.handleStdinData);
			if (this.onResizeHandler) {
				process.stdout.removeListener("resize", this.onResizeHandler);
			}

			if (this.rawModeActive) {
				try {
					process.stdin.setRawMode(false);
				} catch {
					// 忽略退出异常
				}
				this.rawModeActive = false;
			}
			process.stdin.pause();
		}
	}

	private handleStdinData = (chunk: string | Buffer): void => {
		const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.onInputHandler?.(str);
	};

	/** 直接写入标准输出 */
	write(data: string): void {
		process.stdout.write(data);
	}

	/**
	 * DEC CSI 2026 原子同步写入：
	 * 告诉终端把这批字符作为单一渲染事务（Frame）瞬间提交，彻底消灭逐字符刷屏撕裂。
	 */
	syncWrite(data: string): void {
		process.stdout.write(`\x1b[?2026h${data}\x1b[?2026l`);
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	cursorUp(lines = 1): void {
		if (lines > 0) process.stdout.write(`\x1b[${lines}A`);
	}

	cursorDown(lines = 1): void {
		if (lines > 0) process.stdout.write(`\x1b[${lines}B`);
	}

	clearLine(): void {
		process.stdout.write("\r\x1b[2K");
	}

	clearDown(): void {
		process.stdout.write("\x1b[J");
	}

	moveTo(row: number, col: number): void {
		process.stdout.write(`\x1b[${row};${col}H`);
	}
}

function restoreTerminal(): void {
	try {
		process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?2004l\x1b[<u\x1b[?25h");
		if (process.stdin.isTTY) {
			try {
				process.stdin.setRawMode(false);
			} catch {}
		}
	} catch {}
}

/** Restore the terminal device. Safe to call when no TUI ever started.
 * Process signals are owned by the host (see cli/app.ts), not by this module:
 * importing terminal.ts must not install process-global handlers. */
export function installTerminalGuards(): () => void {
	const onExit = (): void => restoreTerminal();
	const onCrash = (): void => restoreTerminal();
	process.on("exit", onExit);
	process.on("uncaughtExceptionMonitor", onCrash);
	return () => {
		process.off("exit", onExit);
		process.off("uncaughtExceptionMonitor", onCrash);
	};
}

