/**
 * 简易 TUI：终端对话界面。
 *
 * 布局：对话流式打印在屏幕上，输入行固定在下（readline 管理）。
 * 输入走 readline——保留中文 IME 输入能力（rawMode 手写会毁掉 IME）。
 * 流式输出期间暂停读行（rl.pause），输出结束恢复（rl.resume + prompt 重绘）。
 *
 * 颜色约定：用户=青、Uina=绿、工具=灰（进行中）/绿色✓（完成）、错误=红。
 */
import { createInterface } from "node:readline/promises";

/** 渲染层消息（主体 hooks → UI 的消息形状） */
export type OutMsg =
	| { type: "text"; text: string }
	| { type: "turn_start"; n: number; text: string }
	| { type: "turn_end"; n: number }
	| { type: "error"; text: string }
	| { type: "tool_start"; name: string; args: unknown }
	| { type: "tool_done"; name: string; result: string };

const C = {
	line: "\x1b[2K", // 清整行
	user: "\x1b[36m",
	me: "\x1b[32m",
	tool: "\x1b[90m",
	ok: "\x1b[32m",
	err: "\x1b[31m",
	reset: "\x1b[0m",
};

export interface TUIOptions {
	prompt?: string;
}

export class SimpleTUI {
	private readonly rl: ReturnType<typeof createInterface>;
	private closed = false;

	constructor(opts: TUIOptions = {}) {
		this.rl = createInterface({ input: process.stdin, output: process.stdout });
		this.rl.setPrompt(opts.prompt ?? "\x1b[36m你 > \x1b[0m");
		this.rl.prompt();
		this.rl.on("close", () => {
			this.closed = true;
		});
	}

	onLine(cb: (line: string) => void): void {
		this.rl.on("line", (line: string) => cb(line));
	}

	close(): void {
		this.closed = true;
		this.rl.close();
	}

	render(m: OutMsg): void {
		switch (m.type) {
			case "text":
				// 流式片段原样输出（错误走 error 类型有色渲染，不再用文本嗅探）
				process.stdout.write(m.text);
				break;
			case "turn_start": {
				// 清掉输入行，输出用户消息并起头 Uina 的回复
				if (!this.closed) this.rl.pause();
				process.stdout.write(`\r${C.line}`);
				if (m.text) process.stdout.write(`${C.user}你 > ${m.text}${C.reset}\n`);
				process.stdout.write(`${C.me}Uina > ${C.reset}`);
				break;
			}
			case "turn_end":
				process.stdout.write("\n");
				if (!this.closed) {
					this.rl.resume();
					this.rl.prompt();
				}
				break;
			case "tool_start":
				process.stdout.write(`\n${C.tool}  ⏳ [工具] ${m.name}${C.reset}`);
				break;
			case "tool_done":
				process.stdout.write(` ${C.ok}✓${C.reset}`);
				break;
			case "error":
				process.stdout.write(`${C.err}${m.text}${C.reset}\n`);
				break;
			default:
				break; // 未知消息类型：忽略
		}
	}
}
