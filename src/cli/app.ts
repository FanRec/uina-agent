import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execCommandDirect } from "../extensions/runtime-tools/exec-command/index.js";
import type { BuiltinUI } from "../extensions/builtin.js";
import { UinaHost } from "../host/host.js";
import type { HostEvent } from "../host/events.js";
import { createInteractiveUI, type InteractiveTUI } from "../ui/tui.js";
import { installTerminalGuards } from "../ui/core/terminal.js";
import { combineQueuedDraft } from "./draft.js";
import { sanitizeTerminalText, toolStartLine, toolResultLines } from "../ui/format.js";
import { createJobAdapter } from "../ui/adapters/jobs.js";
import { createSubagentAdapter } from "../ui/adapters/subagents.js";

const DATA_DIR = join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "session.jsonl");
const CLEAR_LINE = "\r\x1b[2K";
const ERR = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * 组合根：只做四件事——建宿主、挂一个消费者、装进程级守卫、退出。
 *
 * 主体（UinaHost）不再由 UI 拥有：TUI 只是 subscribe 到宿主事件流的一个消费者。
 * 因此 TUI 关闭、换成 stdio、或接入第二个观察者，都不影响主体是否继续存活。
 */
export async function runApp(): Promise<void> {
	mkdirSync(DATA_DIR, { recursive: true });

	const oneshot = process.env.UINA_ONESHOT_MSG;
	const isTTY = process.stdout.isTTY && process.stdin.isTTY;

	let tui: InteractiveTUI | null = null;
	let nonTTY: ReturnType<typeof createInterface> | null = null;
	let shuttingDown = false;
	let hadError = false;
	let unsubscribe: () => void = () => {};

	// `!shell` 直通路径是消费者自己的交互能力，不属于主体。
	let execTail = Promise.resolve();
	let execRunning = false;
	let execAbort: AbortController | null = null;

	const renderStdio = (message: HostEvent): void => {
		switch (message.type) {
			case "thinking":
				break;
			case "text":
				process.stdout.write(sanitizeTerminalText(message.text));
				break;
			case "turn_start":
				process.stdout.write(`\n${message.text ? `你 > ${message.text}\n` : ""}Uina > `);
				break;
			case "turn_end":
				process.stdout.write("\n");
				break;
			case "tool_start":
				process.stdout.write(`\n  ⏳ ${toolStartLine(message.name, message.args)}`);
				break;
			case "tool_done": {
				const elapsed = message.elapsedMs ?? 0;
				const style = {
					ok: (value: string) => value,
					err: (value: string) => value,
					warn: (value: string) => value,
					dim: (value: string) => value,
				};
				process.stdout.write(`\n  ${message.status === "succeeded" ? "✓" : "!"} ${message.name}`);
				for (const line of toolResultLines(message.result, elapsed, style)) {
					process.stdout.write(`\n    ${line}`);
				}
				break;
			}
			case "notice":
				process.stdout.write(`\n⚠ ${message.text}\n`);
				break;
			case "turn_aborted":
				process.stdout.write("\n[已打断]\n");
				break;
			case "error":
				process.stdout.write(`[错误] ${message.text}\n`);
				break;
			case "queue":
				break;
			default:
				break;
		}
	};

	const render = (message: HostEvent): void => {
		if (message.type === "error") hadError = true;
		if (tui) tui.render(message);
		else renderStdio(message);
	};

	// —— 宿主：唯一的主体所有者。它不认识 TUI。 ——
	let host: UinaHost;
	try {
		host = await UinaHost.create({
			cwd: process.cwd(),
			sessionPath: SESSION_FILE,
			onError: (text) => render({ type: "error", text }),
		});
	} catch (error) {
		process.stderr.write(`[启动失败] ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
		return;
	}
	unsubscribe = host.subscribe(render);

	if (!isTTY) {
		process.stdout.write(`Uina 就绪（模型：${host.snapshot().modelName}）— /quit 退出\n\n`);
	}
	if (host.historyCount() > 0) {
		process.stdout.write(`（已恢复 JSONL 会话：${host.historyCount()} 条消息）\n\n`);
	}

	// —— 进程级守卫：信号与 stdout/stderr 归属进程，不属于任何 UI。 ——
	const hostGuardCleanups: Array<() => void> = [];
	const uninstallHostGuards = (): void => {
		for (const cleanup of hostGuardCleanups.splice(0)) cleanup();
	};

	let interruptSeq = 0;

	const shutdown = async (cancelCurrent = true, force = false): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (force) {
			uninstallHostGuards();
			tui?.close();
			nonTTY?.close();
			process.exit(0);
			return;
		}
		unsubscribe();
		if (cancelCurrent && host.isBusy()) host.interrupt();
		if (execRunning) execAbort?.abort();
		// 主体自己负责等待活动结束、释放扩展、杀掉工具留下的分离子进程、关闭会话。
		await host.dispose();
		await execTail;
		tui?.close();
		nonTTY?.close();
		uninstallHostGuards();
		process.exitCode = oneshot !== undefined && hadError ? 1 : 0;
	};

	const restoreQueueToEditor = async (): Promise<number> => {
		if (!tui) return 0;
		const items = await host.takeQueuedForEditor();
		if (items.length === 0) return 0;
		tui.replaceInput(combineQueuedDraft(items, tui.host.inputLine.getText()));
		tui.host.transcript.addNotice(`已打断当前轮次，已将 ${items.length} 条排队消息退回输入栏`);
		tui.host.requestRender();
		return items.length;
	};

	const handleCancel = (source: "escape" | "ctrl+c" = "escape"): void => {
		if (host.isBusy()) {
			const queued = host.snapshot().queue;
			if (source === "escape" && queued.length > 0) {
				deliverQueuedNow();
				return;
			}
			if (source === "ctrl+c") {
				void restoreQueueToEditor().catch((error) => {
					process.stderr.write(`[队列恢复失败] ${String(error)}\n`);
				});
				host.interrupt();
				return;
			}
			host.interrupt();
		}
		if (execRunning) execAbort?.abort();
	};

	const handleExit = (force = false): void => {
		void shutdown(false, force);
	};

	const handleInterrupt = (force = false): void => {
		if (force) {
			handleExit(true);
			return;
		}
		if (host.isBusy() || (tui && tui.host.isBusy())) {
			handleCancel("ctrl+c");
			return;
		}
		handleExit(false);
	};

	/**
	 * Process-level ownership lives here, not in ui/core/terminal.ts:
	 * - SIGINT keeps the ordinary interrupt/exit semantics. Node passes the
	 *   signal name as the first listener argument, so it must never be forwarded
	 *   into the `force` parameter.
	 * - SIGTERM/SIGHUP run the graceful shutdown first, then exit with the
	 *   conventional 143/129 codes (Pi: modes/print-mode.ts, modes/rpc/rpc-mode.ts).
	 */
	const installHostGuards = (tty: boolean): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");
		for (const signal of signals) {
			const handler = (): void => {
				void shutdown(true).finally(() => process.exit(signal === "SIGHUP" ? 129 : 143));
			};
			process.prependListener(signal, handler);
			hostGuardCleanups.push(() => process.off(signal, handler));
		}
		const sigint = (): void => handleInterrupt(false);
		process.on("SIGINT", sigint);
		hostGuardCleanups.push(() => process.off("SIGINT", sigint));
		const onStreamError = (error: NodeJS.ErrnoException): void => {
			if (error.code === "EPIPE") return;
			throw error;
		};
		process.stdout.on("error", onStreamError);
		process.stderr.on("error", onStreamError);
		hostGuardCleanups.push(() => {
			process.stdout.off("error", onStreamError);
			process.stderr.off("error", onStreamError);
		});
		if (tty) hostGuardCleanups.push(installTerminalGuards());
	};

	const deliverQueuedNow = (extraText?: string): void => {
		const token = ++interruptSeq;
		if (host.isBusy() || (tui && tui.host.isBusy())) host.interrupt();
		if (execRunning) execAbort?.abort();
		void host.waitForIdle().then(async () => {
			if (interruptSeq !== token) return;
			const items = await host.takeQueuedForEditor();
			const allTexts = [...items.map((it) => it.text), ...(extraText ? [extraText] : [])].filter((t) => t.trim());
			if (allTexts.length === 0) return;
			// Queued text was already accepted as user input: re-deliver it as
			// plain input, never re-parse it as a slash command or shell line.
			void host.pushInput(allTexts[0]!, "direct").catch((error: unknown) => {
				process.stderr.write(`[投递失败] ${String(error)}\n`);
			});
			for (let i = 1; i < allTexts.length; i++) {
				void host.pushInput(allTexts[i]!, "followUp").catch((error: unknown) => {
					process.stderr.write(`[投递失败] ${String(error)}\n`);
				});
			}
			tui?.host.transcript.addNotice(`已打断当前回合，${allTexts.length} 条消息立即处理`);
			tui?.host.requestRender();
		}).catch((error) => {
			process.stderr.write(`[打断投递失败] ${String(error)}\n`);
		});
	};

	const handleInterruptAndDeliver = (text: string): void => {
		const trimmed = text.trim();
		if (!trimmed) return;
		deliverQueuedNow(trimmed);
	};

	const handlePullBackQueue = async (): Promise<void> => {
		if (!tui) return;
		const last = await host.takeLastQueuedForEditor();
		if (!last) {
			tui.host.notify("排队队列为空，无待办可撤回", "warning", 2000);
			return;
		}
		tui.replaceInput(combineQueuedDraft([last], tui.host.inputLine.getText()));
		const remaining = host.snapshot().queue.length;
		tui.host.notify(`已从队列撤回 1 条消息至输入栏${remaining > 0 ? `（剩余排队：${remaining} 条）` : ""}`, "info", 2000);
	};

	const runDirectCommand = async (input: string): Promise<void> => {
		const command = input.slice(1).trim();
		if (!command || shuttingDown) return;
		if (host.isBusy()) {
			process.stdout.write("[!] 模型正在处理中，请等待本轮结束后再执行\n");
			return;
		}
		process.stdout.write(CLEAR_LINE);
		execRunning = true;
		execAbort = new AbortController();
		try {
			const result = await execCommandDirect(command, execAbort.signal);
			if (result.cancelled) {
				process.stdout.write(`${ERR}[命令已中断]${RESET}\n`);
				return;
			}
			if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
			if (result.stderr) process.stdout.write(`${ERR}[stderr]${RESET}\n${result.stderr}\n`);
			if (result.code !== 0) process.stdout.write(`${ERR}[退出码 ${result.code}]${RESET}\n`);
		} finally {
			execRunning = false;
			execAbort = null;
		}
	};

	const onUserLine = (raw: string, mode: "steer" | "followUp" | "direct" = "followUp"): void => {
		const text = raw.trim();
		if (!text || shuttingDown) return;
		if (text === "/stop") {
			handleInterrupt();
			return;
		}
		if (text.startsWith("/")) { void host.commands.dispatch(text); return; }
		if (text.startsWith("!")) {
			if (host.isBusy()) {
				process.stdout.write("[!] 模型正在处理中，请等待本轮结束后再执行\n");
				return;
			}
			execTail = execTail.then(() => runDirectCommand(text)).catch((error) => {
				process.stdout.write(`${ERR}[命令错误]${RESET} ${String(error)}\n`);
			});
			return;
		}
		void host.submitText(text, mode).catch((error: unknown) => {
			process.stderr.write(`[输入提交失败] ${String(error)}\n`);
		});
	};

	// —— 消费者接入 ——
	if (isTTY) {
		const snapshot = host.snapshot();
		tui = createInteractiveUI({
			modelName: snapshot.modelName,
			thinkingLevels: snapshot.thinkingLevels,
			thinkingLevel: snapshot.thinkingLevel,
			cwd: process.cwd(),
			registry: host.extensionRegistry,
			jobPort: createJobAdapter(host.jobs),
			subagentPort: createSubagentAdapter(host.subagents),
		});
		host.attachExtensionUI(tui.ctxUI);
		tui.onLine(onUserLine);
		tui.onCancel(handleCancel);
		tui.onExit(handleExit);
		tui.onSIGINT(() => handleInterrupt(false));
		tui.onForceExit(() => handleInterrupt(true));
		tui.onInterruptAndDeliver(handleInterruptAndDeliver);
		tui.onPullBackQueue(() => {
			void handlePullBackQueue();
		});
		tui.onThinkingLevelCycle(() => {
			if (!host.snapshot().thinkingLevels?.length) {
				tui?.host.notify("当前 Provider 未提供 thinking 能力元数据；无法循环档位。", "warning", 2500);
				return;
			}
			host.cycleThinkingLevel();
		});
		tui.host.setUsage(snapshot.usedTokens, snapshot.contextWindow, false, {
			segments: snapshot.segments,
		});
		if (host.restoredEntries.length > 0) tui.loadSession(host.restoredEntries);
		tui.setPendingQueue(snapshot.queue);
	} else if (oneshot === undefined) {
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			void shutdown(false);
		});
	}

	installHostGuards(isTTY);

	const builtinUI: BuiltinUI | undefined = tui ? {
		openHelpMenu: () => tui!.host.openHelpMenu(),
		toggleThinking: () => {
			tui!.host.transcript.toggleThinking();
			tui!.host.requestRender();
		},
		clear: () => {
			tui!.host.transcript.clear();
			tui!.host.requestRender();
		},
		openModelPicker: (current, groups, onPick) => { tui!.host.openModelPicker(current, groups as never, onPick as never); },
		openEffortSlider: (current, declaredLevels, onChange) => { tui!.host.openEffortSlider(current, declaredLevels, onChange); },
		openTasks: () => tui!.host.openTasks(),
		openSubagents: () => tui!.host.openSubagents(),
		openTrajectory: () => tui!.host.openTrajectory(),
		setModel: (name) => tui!.host.setModel(name),
		setThinkingLevels: (levels) => tui!.host.setThinkingLevels(levels),
		setReasoningEffort: (level) => tui!.host.setReasoningEffort(level),
		setUsage: (used, window) => tui!.host.setUsage(used, window),
		getGutterMode: () => tui!.host.getGutterMode(),
		setGutterMode: (mode) => tui!.host.setGutterMode(mode),
		getScrollbarThumbStyle: () => tui!.host.getScrollbarThumbStyle(),
		setScrollbarThumbStyle: (style) => tui!.host.setScrollbarThumbStyle(style),
		addCompaction: (record) => tui!.host.addCompaction(record),
	} : undefined;

	await host.start({
		ui: builtinUI,
		requestShutdown: () => shutdown(),
	});

	if (oneshot !== undefined) {
		await host.submitText(oneshot, "direct").catch((error: unknown) => {
			process.stderr.write(`[oneshot 提交失败] ${String(error)}\n`);
			hadError = true;
		});
		await host.waitForIdle();
		await shutdown(false);
	}
}
