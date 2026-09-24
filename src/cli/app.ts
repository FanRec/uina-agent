import { createInterface } from "node:readline/promises";
import { errorMessage } from "../core/errors.js";
import { UinaHost } from "../host/host.js";
import { compactionDecorations } from "../extensions/compaction/index.js";
import type { HostEvent } from "../host/events.js";
import { createInteractiveUI, type InteractiveTUI } from "../ui/tui.js";
import { installTerminalGuards } from "../ui/core/terminal.js";
import { combineQueuedDraft, canEditQueuedDraft } from "./draft.js";
import { toolResultLines } from "../ui/format.js";
import { createJobAdapter } from "../ui/adapters/jobs.js";
import { createSubagentAdapter } from "../ui/adapters/subagents.js";
import { formatHelp, parseArgs, readPipedStdin, UINA_VERSION } from "./args.js";
import { resolveSessionPath } from "./session-path.js";
import { resolveProfile, releaseProfileLock } from "../host/profile.js";
import { formatStartupBanner, resolveExitCode, resolveRunMode } from "./run-mode.js";
import { formatStdioEventLine, formatToolCallLine, formatToolResultBlock } from "./stdio-render.js";

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
	const oneshot = process.env.UINA_ONESHOT_MSG;
	const { initialPrompt, isPrintMode, shouldRunTUI } = resolveRunMode({
		print: args.print,
		piped,
		prompt: args.prompt,
		oneshot,
		stdoutTTY: process.stdout.isTTY,
		stdinTTY: process.stdin.isTTY,
	});

	let tui: InteractiveTUI | null = null;
	let nonTTY: ReturnType<typeof createInterface> | null = null;
	let shuttingDown = false;
	let hadError = false;
	let unsubscribe: () => void = () => {};

	// The UI owns command queueing; the host owns capability execution.
	let execTail = Promise.resolve();
	let execRunning = false;
	let execAbort: AbortController | null = null;

	const toolStartedAt = new Map<string, number>();
	/** tool_result 的耗时取值（顺带清账）；callId 缺失按 0 计。 */
	const elapsedFor = (callId: string | undefined): number => {
		if (callId === undefined) return 0;
		const startedAt = toolStartedAt.get(callId);
		toolStartedAt.delete(callId);
		return startedAt === undefined ? 0 : Date.now() - startedAt;
	};
	const renderStdio = (message: HostEvent): void => {
		switch (message.type) {
			case "tool_call":
				if (message.callId) toolStartedAt.set(message.callId, Date.now());
				process.stdout.write(formatToolCallLine(message));
				return;
			case "tool_result":
				process.stdout.write(formatToolResultBlock(message, elapsedFor(message.callId)));
				return;
			default: {
				const line = formatStdioEventLine(message);
				if (line !== null) process.stdout.write(line);
			}
		}
	};

	const render = (message: HostEvent): void => {
		if (message.type === "error") hadError = true;
		if (tui) tui.render(message);
		else renderStdio(message);
	};

	// —— 宿主：唯一的主体所有者。它不认识 TUI。 ——
	// 主体 profile（认知阶段 A）：--profile 提供时解析身份与资源绑定并取得独占锁；
	// 不传时保持原有启动与数据位置。profile 存在时 sessionPath 从 profile 取。
	let profile: ReturnType<typeof resolveProfile>;
	try {
		profile = resolveProfile({ profileArg: args.profile, cwd: process.cwd() });
	} catch (error) {
		process.stderr.write(`[启动失败] ${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	}
	const sessionPath = profile?.sessions.journalPath ?? resolveSessionPath({ noSession: args.noSession, cwd: process.cwd() });
	let host: UinaHost;
	try {
		host = await UinaHost.create({
			cwd: process.cwd(),
			sessionPath,
			profile,
			modelName: args.model,
   extensionPaths: args.extensions,
			onError: (text) => render({ type: "error", text }),
		});
	} catch (error) {
		process.stderr.write(`[启动失败] ${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	}
	unsubscribe = host.subscribe(render);

	process.stdout.write(formatStartupBanner(host.snapshot().modelName, host.historyCount(), shouldRunTUI, isPrintMode));

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
		// 主体 profile 锁在全部写入结算后释放（ownerToken 核对，不碰他人锁）。
		if (profile) await releaseProfileLock(profile).catch(() => {});
		tui?.close();
		nonTTY?.close();
		uninstallHostGuards();
		process.exitCode = resolveExitCode(isPrintMode, oneshot !== undefined, hadError);
	};

	const restoreQueueToEditor = async (): Promise<number> => {
		if (!tui) return 0;
  if (!canEditQueuedDraft(host.snapshot().queue)) { tui.host.notify('队列包含图片或扩展事件，已保留；可按 Esc 继续处理', 'info'); return 0; }
		const result = await host.claimAllQueued();
		if (result.kind === "partial") {
			// journal 无批事务：已持久化的条目 ownership 在 caller 手里，照常退回输入栏；
			// 未持久化的条目仍在队列中，持久化故障必须可见。
			tui.host.notify(`队列恢复中断：条目持久化失败（${errorMessage(result.error)}），其余排队消息已保留在队列中`, "warning");
		}
		const items = result.claimed;
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
		} else if (source === "ctrl+c" && !execRunning) {
			// Ctrl+C while Subject is idle is an exit intent; the process-level
			// shutdown path remains owned by the composition root.
			handleExit(false);
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
		// Host/Subject 是唯一活动事实源；UI busy 只服务动画与展示，不能决定退出。
		if (host.isBusy()) {
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
		// UI 组合：peek（快照）选目标，claim（mailbox 原语）领取。Subject 不懂"编辑器"语义。
		const candidate = host.snapshot().queue.at(-1);
		if (!candidate) {
			tui.host.notify("排队队列为空，无待办可撤回", "warning", 2000);
			return;
		}
  if (!canEditQueuedDraft([candidate])) { tui.host.notify('该输入包含图片或扩展来源，已保留在队列中', 'info'); return; }
  const last = await host.claimQueued(candidate.id);
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
	const attachConsumer = (): void => {
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
			if (snapshot.context) tui.host.setContext(snapshot.context);
			if (host.restoredEntries.length > 0) {
				const decorations = compactionDecorations(host.restoredAuxiliary, host.restoredEntries);
				tui.loadSession(host.restoredEntries, decorations);
			}
			tui.setPendingQueue(snapshot.queue);
			return;
		}
		if (isPrintMode) return;
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			void shutdown(false);
		});
	};
	attachConsumer();

	installHostGuards(shouldRunTUI);

	// 官方命令已并入 pi 面：TUI 的富 UI 能力经 ctxUI（attachExtensionUI）到达 pi.ui，
	// 不再需要 BuiltinUI 桥接对象。
	await host.start({
		requestShutdown: () => shutdown(),
	});

	const runPrintPhase = async (): Promise<void> => {
		if (initialPrompt !== undefined) {
			await host.submitText(initialPrompt, "direct").catch((error: unknown) => {
				process.stderr.write(`[执行失败] ${String(error)}\n`);
				hadError = true;
			});
			await host.waitForIdle();
		}
		await shutdown(false);
	};
	const submitInitialPromptInteractive = (prompt: string): void => {
		// 交互模式下带有初始 prompt：自动提交首条任务，执行后停留在 TUI
		void host.submitText(prompt, "direct").catch((error: unknown) => {
			process.stderr.write(`[初始任务提交失败] ${String(error)}\n`);
		});
	};

	if (isPrintMode) {
		await runPrintPhase();
	} else if (initialPrompt !== undefined) {
		submitInitialPromptInteractive(initialPrompt);
	}
}
