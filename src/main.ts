/**
 * 入口：组装主体 + 终端 TUI。
 * 启动：pnpm start    退出：/quit（或 Ctrl+C）
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "./core/bus.js";
import { RuntimeStore } from "./core/store.js";
import { OutputBroker, type OutMsg } from "./core/output.js";
import { loadConfig, activeProvider } from "./ai/config.js";
import { createOpenAIProvider } from "./ai/gateway.js";
import { createFileMemory } from "./memory/port.js";
import { ToolBroker } from "./tools/broker.js";
import { getTimeTool, rememberTool, recallTool, forgetTool, thinkForTool } from "./tools/builtin.js";
import { shellTool } from "./tools/shell.js";
import { Subject } from "./mind/loop.js";
import { SimpleTUI } from "./ui/tui.js";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const cfg = loadConfig();
const provider = createOpenAIProvider(activeProvider(cfg));

const bus = new Bus();
const store = new RuntimeStore();
const memory = createFileMemory(DATA_DIR);
memory.load();

const tools = new ToolBroker();
tools.register(getTimeTool());
tools.register(shellTool({ baseDir: process.cwd() }));
tools.register(rememberTool(memory));
tools.register(recallTool(memory));
tools.register(forgetTool(memory));
tools.register(thinkForTool((jobId, result) => bus.emit({ type: "job_done", jobId, result })));

// 主体 → 输出代理（TUI 订阅其消息流）
const output = new OutputBroker();
new Subject(bus, store, provider, memory, tools, {
  onToken(text) {
    output.emit({ type: "text", text });
  },
  onTurnStart(n, info) {
    output.emit({ type: "turn_start", n, ...info });
  },
  onTurnEnd(n) {
    output.emit({ type: "turn_end", n });
  },
});

process.stdout.write(`Uina 就绪（模型：${provider.name}）— /quit 退出\n\n`);

// 渲染层：真 TTY 用交互 TUI；非 TTY（管道/一次性模式）退化为纯 stdio 流式打印
const renderStdio = (m: OutMsg): void => {
  switch (m.type) {
    case "text":
      process.stdout.write(m.text);
      break;
    case "turn_start":
      process.stdout.write(`\n${m.text ? `你 > ${m.text}\n` : ""}Uina > `);
      break;
    case "turn_end":
      process.stdout.write("\n");
      break;
    case "error":
      process.stdout.write(`[错误] ${m.text}\n`);
      break;
    default:
      break;
  }
};

if (process.stdout.isTTY && process.stdin.isTTY) {
  const tui = new SimpleTUI(output);
  tui.onLine((line) => {
    const text = line.trim();
    if (text === "/quit") {
      tui.close();
      process.exit(0);
    }
    if (text) bus.emit({ type: "user_input", text, from: "terminal" });
  });
} else {
  output.add(renderStdio);
}

// 一次性模式：设 UINA_ONESHOT_MSG 后自动发一条消息并在她回复结束后退出（真实模型冒烟/回归用）
const oneshot = process.env.UINA_ONESHOT_MSG;
if (oneshot !== undefined) {
  let done = false;
  output.add((m) => {
    if (m.type === "turn_end" && !done) {
      done = true;
      setTimeout(() => process.exit(0), 1500);
    }
  });
  setTimeout(() => bus.emit({ type: "user_input", text: oneshot, from: "oneshot" }), 300);
}