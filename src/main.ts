/**
 * 入口：组装主体 + 终端 UI。
 * 启动：pnpm start [--continue]    退出：/quit（或 Ctrl+C）
 *  --continue 恢复上次会话的对话历史（data/session.json）
 * 工具从 tools/ 目录自动发现加载（见 src/tools/loader.ts，pi 同款机制）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, activeProvider } from "./ai/config.js";
import { createOpenAIProvider } from "./ai/gateway.js";
import { ToolBroker } from "./tools/broker.js";
import { loadTools } from "./tools/loader.js";
import { Subject } from "./mind/loop.js";
import { SimpleTUI, type OutMsg } from "./ui/tui.js";

const DATA_DIR = join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "session.json");
const TOOLS_DIR = join(process.cwd(), "tools");
mkdirSync(DATA_DIR, { recursive: true });

async function main(): Promise<void> {
	const cfg = loadConfig();
	const provider = createOpenAIProvider(activeProvider(cfg));

	// 工具自动发现：扫描 tools/ 目录，注册每个默认导出（pi 同款）
	const tools = new ToolBroker();
	const loaded = await loadTools(TOOLS_DIR, tools);
	for (const f of loaded.failed) {
		process.stdout.write(`[工具加载失败] ${f.file}: ${f.error}\n`);
	}

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
			case "tool_start":
				process.stdout.write(`\n  [工具] ${m.name}`);
				break;
			case "tool_done":
				process.stdout.write(" ✓");
				break;
			case "error":
				process.stdout.write(`[错误] ${m.text}\n`);
				break;
			default:
				break;
		}
	};

	let tui: SimpleTUI | null = null;
	const render = (m: OutMsg): void => {
		if (tui) tui.render(m);
		else renderStdio(m);
	};

	// 一次性模式：设 UINA_ONESHOT_MSG 后自动发一条消息并在她回复结束后退出（真实模型冒烟/回归用）
	const oneshot = process.env.UINA_ONESHOT_MSG;
	let oneshotDone = false;

	// 主体 → 渲染层：hooks 直连（单一输出端，不需要广播中间层）
	const subject = new Subject(provider, tools, {
		onToken: (text) => render({ type: "text", text }),
		onTurnStart: (n, text) => render({ type: "turn_start", n, text }),
		onTurnEnd: (n) => {
			render({ type: "turn_end", n });
			if (oneshot !== undefined && !oneshotDone) {
				oneshotDone = true;
				setTimeout(() => {
					saveSession(subject);
					process.exit(0);
				}, 1500);
			}
		},
		onToolStart: (name, args) => render({ type: "tool_start", name, args }),
		onToolDone: (name, result) => render({ type: "tool_done", name, result }),
		onError: (msg) => render({ type: "error", text: msg }),
	});

	// 会话续聊：--continue 恢复上次对话历史
	if (process.argv.includes("--continue")) {
		try {
			const saved = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as {
				messages: unknown[];
			};
			if (Array.isArray(saved.messages) && saved.messages.length > 0) {
				subject.addHistory(saved.messages as never);
				process.stdout.write(
					`（已恢复上次会话：${saved.messages.length} 条历史消息）\n\n`,
				);
			} else {
				process.stdout.write("（没有可恢复的会话，从空开始）\n\n");
			}
		} catch {
			process.stdout.write("（没有可恢复的会话，从空开始）\n\n");
		}
	}

	// 退出前落盘会话
	const saveSession = (s: Subject): void => {
		try {
			writeFileSync(
				SESSION_FILE,
				JSON.stringify(
					{
						savedAt: new Date().toISOString(),
						messages: s.historySnapshot(),
					},
					null,
					2,
				),
				"utf8",
			);
		} catch {
			// 落盘失败不阻塞退出
		}
	};
	process.on("beforeExit", () => saveSession(subject));

	process.stdout.write(
		`Uina 就绪（模型：${provider.name}，工具：${loaded.loaded} 个）— /quit 退出\n\n`,
	);

	if (process.stdout.isTTY && process.stdin.isTTY) {
		tui = new SimpleTUI();
		tui.onLine((line) => {
			const text = line.trim();
			if (text === "/quit") {
				saveSession(subject);
				tui?.close();
				process.exit(0);
			}
			subject.pushInput(text);
		});
	}

	if (oneshot !== undefined) {
		setTimeout(() => subject.pushInput(oneshot), 300);
	}
}

void main();
