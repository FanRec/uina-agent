import { createInterface } from "node:readline/promises";
import type { BuiltinUI } from "../extensions/builtin.js";
import { UinaHost } from "../host/host.js";
import type { HostEvent } from "../host/events.js";
import { createInteractiveUI, type InteractiveTUI } from "../ui/tui.js";
import { installTerminalGuards } from "../ui/core/terminal.js";
import { combineQueuedDraft, canEditQueuedDraft } from "./draft.js";
import { sanitizeTerminalText, toolStartLine, toolResultLines } from "../ui/format.js";
import { createJobAdapter } from "../ui/adapters/jobs.js";
import { createSubagentAdapter } from "../ui/adapters/subagents.js";
import { formatHelp, parseArgs, readPipedStdin, UINA_VERSION } from "./args.js";
import { resolveSessionPath } from "./session-path.js";

const CLEAR_LINE = "\r\x1b[2K";
const ERR = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * 组合根：只做四件事——建宿主、挂一个消费者、装进程级守卫、退出。
 *
 * 主体（UinaHost）不再由 UI 拥有：TUI 只是 subscribe 到宿主事件流的一个消费者。
 * 因此 TUI 关闭、换成 stdio、或接入第二个观察者，都不影响主体是否继续存活。
 */
export async function runApp(rawArgs: readonly string[] = process.argv.slice(2)): Promise<void> {
	const args = parseArgs(rawArgs);
	if (args.help) {
		process.stdout.write(formatHelp());
		return;
	}
	if (args.version) {
		process.stdout.write(`v${UINA_VERSION}\n`);
		return;
	}

	const piped = await readPipedStdin();
	let initialPrompt: string | undefined;
	if (piped && args.prompt) {
		initialPrompt = `${args.prompt}\n\n[标准输入内容]:\n${piped}`;
	} else if (piped) {
		initialPrompt = piped;
	} else if (args.prompt) {
		initialPrompt = args.prompt;
	}
	const oneshot = process.env.UINA_ONESHOT_MSG;
	if (oneshot !== undefined) {
		initialPrompt = oneshot;
	}

	const isPrintMode = args.print || oneshot !== undefined || (!process.stdout.isTTY && initialPrompt !== undefined);
	const isTTY = process.stdout.isTTY && process.stdin.isTTY;
	const shouldRunTUI = isTTY && !isPrintMode;

	let tui: InteractiveTUI | null = null;
	let nonTTY: ReturnType<typeof createInterface> | null = null;
	let shuttingDown = false;
	let hadError = false;
	let unsubscribe: () => void = () => {};

	// The UI owns command queueing; the host owns capability execution.
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
    if (message.images?.length) process.stdout.write("\n  [图片: " + message.images.map(image => image.alt ?? image.mimeType).join(", ") + "]");
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
			case "session_rewind":
				process.stdout.write(`\n[会话回溯] ${message.fromId} → ${message.targetId}；退出路径只读，外部状态未撤销。\n`);
				break;
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
	const sessionPath = resolveSessionPath({ noSession: args.noSession, cwd: process.cwd() });
	let host: UinaHost;
	try {
		host = await UinaHost.create({
			cwd: process.cwd(),
			sessionPath,
			modelName: args.model,
   extensionPaths: args.extensions,
			onError: (text) => render({ type: "error", text }),
		});
	} catch (error) {
		process.stderr.write(`[启动失败] ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
		return;
	}
	unsubscribe = host.subscribe(render);

	if (!shouldRunTUI && !isPrintMode) {
		process.stdout.write(`Uina 就绪（模型：${host.snapshot().modelName}）— /quit 退出\n\n`);
	}
	if (host.historyCount() > 0 && !isPrintMode) {
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
		process.exitCode = (isPrintMode || oneshot !== undefined) && hadError ? 1 : 0;
	};

	const restoreQueueToEditor = async (): Promise<number> => {
		if (!tui) return 0;
  if (!canEditQueuedDraft(host.snapshot().queue)) { tui.host.notify('队列包含图片或扩展事件，已保留；可按 Esc 继续处理', 'info'); return 0; }
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
   if (extraText?.trim()) await host.pushInput(extraText, 'followUp');
   const count = host.snapshot().queue.length;
   if (!count) return;
   void host.resumePending().catch((error: unknown) => { process.stderr.write('[投递失败] ' + String(error) + '\n'); });
   tui?.host.transcript.addNotice('已打断当前回合，' + count + ' 条消息立即处理');
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
		const candidate = host.snapshot().queue.at(-1);
  if (candidate && !canEditQueuedDraft([candidate])) { tui.host.notify('该输入包含图片或扩展来源，已保留在队列中', 'info'); return; }
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
			const started = Date.now();
			const outcome = await host.runToolDirect("exec_command", { command }, execAbort.signal);
			const plain = (value: string): string => value;
			for (const line of toolResultLines(outcome.result, Date.now() - started, { ok: plain, err: plain, warn: plain, dim: plain })) {
				process.stdout.write(line + "\n");
			}
			if (outcome.status !== "succeeded") process.stdout.write("[" + outcome.status + "]\n");
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
	if (shouldRunTUI) {
		const snapshot = host.snapshot();
		tui = createInteractiveUI({
			modelName: snapshot.modelName,
			thinkingLevels: snapshot.thinkingLevels,
			thinkingLevel: snapshot.thinkingLevel,
			cwd: process.cwd(),
			registry: host.extensionRegistry,
			jobPort: createJobAdapter(host.jobs),
			subagentPort: createSubagentAdapter(host.subagents),
			sessionPort: host.session,
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
	} else if (!isPrintMode) {
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			void shutdown(false);
		});
	}

	installHostGuards(shouldRunTUI);

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
		openHistory: () => tui!.host.openHistory(),
		setModel: (name) => tui!.host.setModel(name),
		setThinkingLevels: (levels) => tui!.host.setThinkingLevels(levels),
		setReasoningEffort: (level) => tui!.host.setReasoningEffort(level),
		setUsage: (used, window, segments) => tui!.host.setUsage(used, window, false, { segments }),
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

	if (isPrintMode) {
		if (initialPrompt !== undefined) {
			await host.submitText(initialPrompt, "direct").catch((error: unknown) => {
				process.stderr.write(`[执行失败] ${String(error)}\n`);
				hadError = true;
			});
			await host.waitForIdle();
		}
		await shutdown(false);
	} else if (initialPrompt !== undefined) {
		// 交互模式下带有初始 prompt：自动提交首条任务，执行后停留在 TUI
		void host.submitText(initialPrompt, "direct").catch((error: unknown) => {
			process.stderr.write(`[初始任务提交失败] ${String(error)}\n`);
		});
	}
}
