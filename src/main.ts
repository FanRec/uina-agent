/**
 * 入口：组装主体 + 终端 UI。
 * 启动：pnpm start [--continue]    退出：/quit（或 Ctrl+C）
 *  --continue 恢复上次会话的对话历史（data/session.json）
 * 工具从 tools/ 目录自动发现加载（见 src/tools/loader.ts，pi 同款机制）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, activeProvider } from "./ai/config.js";
import { createOpenAIProvider } from "./ai/gateway.js";
import { execCommandDirect } from "../tools/exec-command/index.js";
import { ToolBroker } from "./tools/broker.js";
import { loadTools } from "./tools/loader.js";
import { Subject, findOrphanToolCalls } from "./mind/loop.js";
import { SimpleTUI, type OutMsg } from "./ui/tui.js";
import { toolStartLine, toolResultLines } from "./ui/format.js";

const DATA_DIR = join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "session.json");
const TOOLS_DIR = join(process.cwd(), "tools");
mkdirSync(DATA_DIR, { recursive: true });

// ! 命令渲染用的本地样式（对齐 tui.ts 的 C 颜色约定：line 清行 / err 红 / reset）
const CLEAR_LINE = "\r\x1b[2K";
const ERR = "\x1b[31m";
const RESET = "\x1b[0m";

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
				process.stdout.write(`\n  ⏳ ${toolStartLine(m.name, m.args)}`);
				break;
			case "tool_done": {
				const elapsed = m.ts ? Date.now() - m.ts : 0;
				process.stdout.write(`\n  ✓ ${m.name}`);
				const plain = {
					ok: (s: string) => s,
					err: (s: string) => s,
					warn: (s: string) => s,
					dim: (s: string) => s,
				};
				for (const line of toolResultLines(m.result, elapsed, plain)) {
					process.stdout.write(`\n    ${line}`);
				}
				break;
			}
			case "notice":
				process.stdout.write(`\n⚠ ${m.text}\n`);
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
	let lastToolTs = 0;
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
		onToolStart: (name, args) => {
			lastToolTs = Date.now();
			render({ type: "tool_start", name, args, ts: lastToolTs });
		},
		onToolDone: (name, result) =>
			render({ type: "tool_done", name, result, ts: lastToolTs }),
		onError: (msg) => render({ type: "error", text: msg }),
		onNotice: (msg) => render({ type: "notice", text: msg }),
	});

	// 会话续聊：--continue 恢复上次对话历史
	if (process.argv.includes("--continue")) {
		try {
			const saved = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as {
				messages: unknown[];
			};
			if (Array.isArray(saved.messages) && saved.messages.length > 0) {
				// 历史校验（暴露而非兜底）：发现配对破损不自动补占位，显式报错并拒绝恢复
				const orphans = findOrphanToolCalls(saved.messages as never);
				if (orphans.length > 0) {
					process.stderr.write(
						`[会话校验] 历史损坏：${orphans.length} 个工具调用没有对应结果` +
							"（可能来自旧版本中断 bug）。已跳过恢复，从新会话开始。\n" +
							"如需检查现场，查看 data/session.json。\n",
					);
					process.stdout.write("（检测到历史损坏，未恢复，从空开始）\n\n");
				} else {
					subject.addHistory(saved.messages as never);
					process.stdout.write(
						`（已恢复上次会话：${saved.messages.length} 条历史消息）\n\n`,
					);
				}
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

	// 前台 ! 命令的执行状态：执行中按 Ctrl+C 杀命令而不是退出进程
	let execAbort: AbortController | null = null;
	let execRunning = false;

	//
	// Ctrl+C 统一处理（幂等）：有轮在跑 → 中断；有 ! 命令在跑 → 杀命令；空闲 → 保存会话退出
	//
	const handleInterrupt = (): void => {
		if (subject.isBusy()) {
			subject.interrupt();
			return;
		}
		if (execRunning) {
			execAbort?.abort();
			return;
		}
		saveSession(subject);
		process.exit(0);
	};

	//
	// ! 命令：强制终端工具执行——直接跑 shell，不经模型（对齐 pi 的 ! 命令）。
	// 执行期间暂停读行（防输入与输出交错），结束恢复；结果不进 LLM 上下文。
	//
	const execCommand = async (input: string): Promise<void> => {
		const command = input.slice(1).trim();
		if (!command) return;
		if (subject.isBusy()) {
			// 模型轮进行中执行 ! 命令：输出会与流式回复交错（且 Ctrl+C 语义混乱）——拒绝并提示
			process.stdout.write(
				`[!] 模型正在处理中，请等本轮结束后再执行（输出会与回复交错）\n`,
			);
			return;
		}
		execRunning = true;
		execAbort = new AbortController();
		tui?.pauseInput();
		try {
			process.stdout.write(`${CLEAR_LINE}`); // 清掉输入行（对齐 turn_start 渲染）
			const r = await execCommandDirect(command, execAbort.signal);
			if (r.cancelled) {
				process.stdout.write(`${ERR}[命令已中断]${RESET}\n`);
				return;
			}
			if (r.stdout) {
				process.stdout.write(
					r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`,
				);
			}
			if (r.stderr && (!r.stdout || r.code !== 0)) {
				process.stdout.write(`${ERR}[stderr]${RESET}\n${r.stderr}\n`);
			}
			if (r.code !== 0 && !r.cancelled) {
				process.stdout.write(`${ERR}[退出码 ${r.code}]${RESET}\n`);
			}
		} finally {
			execRunning = false;
			execAbort = null;
			tui?.resumeInput();
		}
	};

	process.stdout.write(
		`Uina 就绪（模型：${provider.name}，工具：${loaded.loaded} 个）— /quit 退出\n\n`,
	);

	// 命令行输入统一处理（TTY 与管道共用）：/quit 退出、/stop 中断、! 强制终端、其余进主体
	const onUserLine = (raw: string): void => {
		const text = raw.trim();
		if (!text) return;
		if (text === "/quit") {
			saveSession(subject);
			tui?.close();
			process.exit(0);
		}
		if (text === "/stop") {
			subject.interrupt();
			return;
		}
		if (text.startsWith("!")) {
			void execCommand(text);
			return;
		}
		subject.pushInput(text);
	};

	const isTTY = process.stdout.isTTY && process.stdin.isTTY;
	if (isTTY) {
		tui = new SimpleTUI();
		tui.onLine(onUserLine);
		// TTY：readline 终端模式拦截 Ctrl+C（发射到 rl 的 SIGINT 事件），只走这一条路径。
		// 不再注册进程级 SIGINT——双注册会双触发 handleInterrupt（历史冗余）。
		tui.onSIGINT(() => handleInterrupt());
	} else {
		// 管道输入（echo "..." | pnpm start）：无界面 readline，行到位即喂主体，不再静默吞输入。
		// EOF 后剩余轮跑完、事件循环排空，beforeExit 落盘退出。
		const rl = createInterface({ input: process.stdin });
		rl.on("line", onUserLine);
		// 非 TTY：无 readline 拦截，进程级 SIGINT 兜底（中断/杀命令/退出）
		process.on("SIGINT", handleInterrupt);
	}

	if (oneshot !== undefined) {
		setTimeout(() => subject.pushInput(oneshot), 300);
	}
}

void main();
