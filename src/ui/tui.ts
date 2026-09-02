/**
 * 简易 TUI：终端对话界面。
 *
 * 布局：对话流式打印在屏幕上，输入行固定在下（readline 管理）。
 * 输入走 readline——保留中文 IME 输入能力（rawMode 手写会毁掉 IME）。
 * 流式输出期间暂停读行（rl.pause），输出结束恢复（rl.resume + prompt 重绘）。
 *
 * 颜色约定：用户=青、Uina=绿、工具=灰、内部事件/错误=黄/红。
 */
import { createInterface } from "node:readline/promises";
import type { OutputBroker, OutMsg } from "../core/output.js";

const C = {
  line: "\x1b[2K", // 清整行
  user: "\x1b[36m",
  me: "\x1b[32m",
  tool: "\x1b[90m",
  inner: "\x1b[33m",
  err: "\x1b[31m",
  reset: "\x1b[0m",
};

export interface TUIOptions {
  prompt?: string;
}

export class SimpleTUI {
  private readonly rl: ReturnType<typeof createInterface>;
  private closed = false;

  constructor(
    private readonly broker: OutputBroker,
    opts: TUIOptions = {},
  ) {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt(opts.prompt ?? "\x1b[36m你 > \x1b[0m");
    this.rl.prompt();
    this.rl.on("close", () => {
      this.closed = true;
    });
    this.broker.add((m) => this.render(m));
  }

  onLine(cb: (line: string) => void): void {
    this.rl.on("line", (line: string) => cb(line));
  }

  close(): void {
    this.closed = true;
    this.rl.close();
  }

  private render(m: OutMsg): void {
    switch (m.type) {
      case "text":
        // 流式片段：检测工具/错误/前缀着色
        process.stdout.write(this.colorize(m.text));
        break;
      case "turn_start": {
        // 清掉输入行，输出用户消息并起头 Uina 的回复
        if (!this.closed) this.rl.pause();
        process.stdout.write(`\r${C.line}`);
        if (m.text) process.stdout.write(`${C.user}你 > ${m.text}${C.reset}\n`);
        process.stdout.write(`${m.viaInternal ? `${C.inner}（内部）` : ""}${C.me}Uina > ${C.reset}`);
        break;
      }
      case "turn_end":
        process.stdout.write("\n");
        if (!this.closed) {
          this.rl.resume();
          this.rl.prompt();
        }
        break;
      case "error":
        process.stdout.write(`${C.err}${m.text}${C.reset}\n`);
        break;
      default:
        break; // 未知消息类型：忽略
    }
  }

  /** 工具行/错误行着色；其余原样（保证流式不被破坏） */
  private colorize(text: string): string {
    if (text.includes("[tool:")) return `${C.tool}${text}${C.reset}`;
    if (text.includes("[内部错误]")) return `${C.err}${text}${C.reset}`;
    return text;
  }
}