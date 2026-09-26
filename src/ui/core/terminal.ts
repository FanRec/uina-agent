/**
 * 终端底层输入输出封装（支持 RawMode、DEC CSI 2026 同步写入、光标定位）。
 */

import { initConsoleMode } from "./native-modifiers.js";
import { frameLogEnabled, logFrame, logNote } from "./frame-log.js";

/** 终端真实尺寸回执（CSI 18t → CSI 8 ; rows ; cols t） */
export function parseSizeReport(data: string): { cols: number; rows: number } | null {
	const m = data.match(/\x1b\[8;(\d+);(\d+)t/);
	if (!m) return null;
	return { rows: Number(m[1]), cols: Number(m[2]) };
}

/** 回执是否可信：拒绝畸形值，避免把错误的尺寸写进布局 */
export function isPlausibleSize(size: { cols: number; rows: number }): boolean {
	return size.cols >= 20 && size.cols <= 1000 && size.rows >= 5 && size.rows <= 500;
}

export class ProcessTerminal {
	private running = false;
	private rawModeActive = false;
	private onInputHandler?: (data: string) => void;
	private onResizeHandler?: () => void;
	/** 终端自报的真实窗口尺寸。帧高/行宽必须与窗口一致：偏大就会写进可视区之外，
	 *  终端每帧滚动、整屏行映射错位（真机表现为出现从未发送过的残留片段）。 */
	private reportedSize: { cols: number; rows: number } | null = null;

	constructor() {}

	get columns(): number {
		return this.reportedSize?.cols ?? (process.stdout.columns || 80);
	}

	get rows(): number {
		return this.reportedSize?.rows ?? (process.stdout.rows || 24);
	}

	/** 是否采用终端自报尺寸（默认只探测记录，需显式开启才改布局） */
	private get trustReportedSize(): boolean {
		return process.env["UINA_TUI_TRUST_SIZE"] === "1";
	}

	/** 接收回执：记录；开关打开且值可信时切换布局尺寸并通知重绘 */
	private acceptSize(raw: string): void {
		const size = parseSizeReport(raw);
		if (!size || !isPlausibleSize(size)) return;
		const changed = !this.reportedSize || this.reportedSize.cols !== size.cols || this.reportedSize.rows !== size.rows;
		if (frameLogEnabled()) {
			logNote("size-report", { cols: size.cols, rows: size.rows, adopted: this.trustReportedSize });
		}
		if (!this.trustReportedSize) return;
		this.reportedSize = size;
		if (changed) this.onResizeHandler?.();
	}

	/** 问一次终端真实窗口尺寸（不支持的终端不会回执，行为不变） */
	private querySize(): void {
		try { process.stdout.write("\x1b[18t"); } catch {}
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
				// 窗口尺寸变化后重新问一次真实尺寸（回执到达时会再触发一次重绘）
				process.stdout.on("resize", this.handleResizeEvent);
			}

			// 开启备用屏（DEC 1049）、清屏、括号粘贴模式、键盘扩展、SGR 鼠标跟踪（滚轮、选区与 Hover 悬停）
			process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h\x1b[>1u\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");

			// 诊断（默认关闭）：记录 Node 自报的终端尺寸，并问终端要一次真实尺寸。
			// 帧渲染完全依赖 process.stdout.columns/rows；两者不一致时整屏行映射会错位。
			if (frameLogEnabled()) {
				logNote("node-size", { cols: process.stdout.columns || 0, rows: process.stdout.rows || 0, isTTY: this.isTTY });
			}
			this.querySize();
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
				process.stdout.removeListener("resize", this.handleResizeEvent);
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

	private handleResizeEvent = (): void => {
		this.querySize();
		this.onResizeHandler?.();
	};

	private handleStdinData = (chunk: string | Buffer): void => {
		let str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (str.includes("\x1b[8;")) {
			this.acceptSize(str);
			// 回执不是用户输入：剥掉后再交给上层，避免被当成按键
			str = str.replace(/\x1b\[8;\d+;\d+t/g, "");
			if (!str) return;
		}
		this.onInputHandler?.(str);
	};

	/**
	 * DEC CSI 2026 原子同步写入：
	 * 告诉终端把这批字符作为单一渲染事务（Frame）瞬间提交，彻底消灭逐字符刷屏撕裂。
	 */
	syncWrite(data: string): void {
		// 诊断开关（默认关闭）：把真机原始帧落盘，供离线还原"终端到底收到了什么"。
		if (frameLogEnabled()) logFrame(data, this.columns, this.rows);
		process.stdout.write(`\x1b[?2026h${data}\x1b[?2026l`);
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
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

