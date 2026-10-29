import { createInterface } from "node:readline/promises";
import { errorMessage } from "../core/errors.js";
import { compactionDecorations } from "../extensions/compaction/index.js";
import type { HostEventRecord } from "../host/events.js";
import { UinaHost } from "../host/host.js";
import { releaseProfileLock, resolveProfile } from "../host/profile.js";
import { listPromptSnapshots } from "../session/prompt-snapshots.js";
import { installTerminalGuards } from "../ui/core/terminal.js";
import { toolResultLines } from "../ui/format.js";
import { createInteractiveUI, type InteractiveTUI } from "../ui/tui.js";
import { formatHelp, parseArgs, readPipedStdin, UINA_VERSION } from "./args.js";
import { executeCancelActions, resolveCancelActions } from "./cancel-decision.js";
import { canEditQueuedDraft, combineQueuedDraft } from "./draft.js";
import { routePresentationIntent } from "./presentation-intents.js";
import { formatStartupBanner, resolveExitCode, resolveRunMode } from "./run-mode.js";
import { resolveSessionPath } from "./session-path.js";
import { formatStdioEventLine, formatToolCallLine, formatToolResultBlock } from "./stdio-render.js";

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

	/** 工具耗时的两端时刻都取自 HostEventRecord.at；缺任一端保持未知。 */
	const toolStartedAt = new Map<string, number>();
	const elapsedFor = (callId: string, endedAt: number): number | undefined => {
		const startedAt = toolStartedAt.get(callId);
		toolStartedAt.delete(callId);
		return startedAt === undefined ? undefined : Math.max(0, endedAt - startedAt);
	};
	const renderStdio = (record: HostEventRecord): void => {
		const message = record.event;
		switch (message.type) {
			case "tool_call":
				toolStartedAt.set(message.callId, record.at);
				process.stdout.write(formatToolCallLine(message));
				return;
			case "tool_result":
				process.stdout.write(formatToolResultBlock(message, elapsedFor(message.callId, record.at)));
				return;
			default: {
				const line = formatStdioEventLine(message);
				if (line !== null) process.stdout.write(line);
			}
		}
	};

	const writeCommandOutput = (text: string): void => {
		if (tui) {
			tui.addNotice(text);
			return;
		}
		process.stdout.write(`${text}\n`);
	};

	const earlyEvents: HostEventRecord[] = [];

	// session_rewind 的压缩装饰在此派生：事件按 1:1 透传纪律不带派生数据，
	// 装饰取自宿主当前 auxiliary（restoredAuxiliary 是启动快照，覆盖不了恢复后新发生的压缩）。
	const renderToTui = (record: HostEventRecord): void => {
		const message = record.event;
		if (message.type === "session_rewind") {
			const auxiliary = host.auxiliaryEntries();
			tui!.consume(
				record,
				compactionDecorations(auxiliary, message.entries),
				listPromptSnapshots(auxiliary),
				auxiliary,
			);
			return;
		}
		tui!.consume(record);
	};

	const render = (record: HostEventRecord): void => {
		const message = record.event;
		if (message.type === "error") hadError = true;
		if (message.type === "turn_end" || message.type === "turn_aborted") cancellationPending = false;
		if (tui) {
			if (message.type === "model_select") {
				tui.updateSnapshot(host.snapshot());
			}
			renderToTui(record);
		} else if (shouldRunTUI) {
			// 在 TUI 实例化与会话加载前到达的事件（如早期模型目录刷新、启动告警）暂存，避免被 stdio 污染后又被 alternate screen 抹除
			earlyEvents.push(record);
		} else {
			renderStdio(record);
		}
	};

	// —— 宿主：唯一的主体所有者。它不认识 TUI。 ——
	// 主体 profile：--profile 提供时解析身份与资源绑定并取得独占锁；
	// 不传时保持原有启动与数据位置。profile 存在时 sessionPath 从 profile 取。
	let profile: ReturnType<typeof resolveProfile>;
	try {
		profile = resolveProfile({ profileArg: args.profile, cwd: process.cwd() });
	} catch (error) {
		process.stderr.write(`[启动失败] ${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	}
	const sessionPath =
		profile?.sessions.journalPath ?? resolveSessionPath({ noSession: args.noSession, cwd: process.cwd() });
	let host: UinaHost;
	try {
		host = await UinaHost.create({
			cwd: process.cwd(),
			sessionPath,
			profile,
			modelName: args.model,
			extensionPaths: args.extensions,
			// 组合根本地诊断（非主体事实）：没有宿主派发记录，时刻取本地观察时刻。
			onError: (text) => render({ at: Date.now(), event: { type: "error", text } }),
		});
	} catch (error) {
		process.stderr.write(`[启动失败] ${errorMessage(error)}\n`);
		process.exitCode = 1;
		return;
	}
	unsubscribe = host.onEventRecord(render);

	process.stdout.write(formatStartupBanner(host.snapshot().modelName, host.historyCount(), shouldRunTUI, isPrintMode));

	// —— 进程级守卫：信号与 stdout/stderr 归属进程，不属于任何 UI。 ——
	const hostGuardCleanups: Array<() => void> = [];
	const uninstallHostGuards = (): void => {
		for (const cleanup of hostGuardCleanups.splice(0)) cleanup();
	};

	let interruptSeq = 0;
	let cancellationPending = false;

	/** 释放所有宿主资源（存储刷新、扩展销毁、锁释放、信号守护注销） */
	const cleanupResources = async (): Promise<void> => {
		unsubscribe();
		if (host.isBusy()) host.interrupt();
		if (execRunning) execAbort?.abort();
		await host.dispose();
		await execTail;
		if (profile) await releaseProfileLock(profile).catch(() => {});
		uninstallHostGuards();
	};

	/**
	 * 统一交互退出协调器（第一性原则与奥卡姆剃刀）：
	 * 1. 0ms 终端复原：进入退出即刻释放 TUI / Raw Mode，绝不让用户对着假死界面；
	 * 2. 连击强退：退出中再次触发任何退出操作，立即 process.exit(0)；
	 * 3. 异步解耦：通过 setImmediate 脱离微任务调用栈，彻底根除自等待死锁；
	 * 4. 熔断竞争：给予底层资源清理 600ms 窗口，配合 800ms 不可取消硬熔断，保证必能退出。
	 */
	const executeExit = (force = false): void => {
		uninstallHostGuards();
		try {
			tui?.close();
		} catch {}
		try {
			nonTTY?.close();
		} catch {}

		if (shuttingDown || force) {
			process.exit(0);
		}
		shuttingDown = true;

		// 异步脱离当前事件处理栈（破除 ExtensionRunner.dispose 正在等待当前命令返回的死锁）
		setImmediate(async () => {
			const exitCode = resolveExitCode(isPrintMode, oneshot !== undefined, hadError);

			// 800ms 强制超时熔断（不可 unref，硬保证进程绝不卡死挂起）
			const hardDeadline = setTimeout(() => {
				process.exit(exitCode);
			}, 800);

			try {
				await Promise.race([cleanupResources(), new Promise((resolve) => setTimeout(resolve, 600))]);
			} catch {
				hadError = true;
			} finally {
				clearTimeout(hardDeadline);
				process.exit(resolveExitCode(isPrintMode, oneshot !== undefined, hadError));
			}
		});
	};

	const restoreQueueToEditor = async (): Promise<number> => {
		if (!tui) return 0;
		if (!canEditQueuedDraft(host.snapshot().queue)) {
			tui.notify("队列包含图片或扩展事件，已保留；可按 Esc 继续处理", "info");
			return 0;
		}
		const result = await host.claimAllQueued();
		if (result.kind === "partial") {
			tui.notify(
				`队列恢复中断：条目持久化失败（${errorMessage(result.error)}），其余排队消息已保留在队列中`,
				"warning",
			);
		}
		const items = result.claimed;
		if (items.length === 0) return 0;
		tui.setDraft(combineQueuedDraft(items, tui.getDraft()));
		tui.addNotice(`已打断当前轮次，已将 ${items.length} 条排队消息退回输入栏`);
		return items.length;
	};

	const handleCancel = (source: "escape" | "ctrl+c" = "escape"): void => {
		// 决策与执行序在 cancel-decision.ts（纯函数，可穷举测试）；这里只装配效果回调。
		executeCancelActions(
			resolveCancelActions(source, {
				busy: host.isBusy(),
				execRunning,
				cancellationPending,
				queuedCount: host.snapshot().queue.length,
			}),
			{
				forceExit: () => executeExit(true),
				gracefulExit: () => executeExit(false),
				abortExec: () => execAbort?.abort(),
				interrupt: () => host.interrupt(),
				deliverQueued: () => deliverQueuedNow(),
				restoreQueue: () => {
					void restoreQueueToEditor().catch((error) => {
						process.stderr.write(`[队列恢复失败] ${String(error)}\n`);
					});
				},
				armPending: (debounceMs) => {
					cancellationPending = true;
					setTimeout(() => {
						cancellationPending = false;
					}, debounceMs).unref?.();
				},
				notify: (text) => tui?.notify(text, "info", 2000),
			},
		);
	};

	const handleInterrupt = (force = false): void => {
		if (force) {
			executeExit(true);
			return;
		}
		if (host.isBusy()) {
			handleCancel("ctrl+c");
			return;
		}
		executeExit(false);
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
		// SIGHUP 在 win32 同样会到达：关闭终端窗口时 Node 收到 SIGHUP。没有监听器时
		// 进程被直接终止、process.on("exit") 钩子不运行，world spawn 的子进程（如 mpv）
		// 会变孤儿继续出声。executeExit(true) 立即退出，由子进程兜底表完成击杀。
		const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
		for (const signal of signals) {
			const handler = (): void => {
				executeExit(true);
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
		const wasBusy = host.isBusy();
		if (wasBusy) host.interrupt();
		if (execRunning) execAbort?.abort();
		void host
			.waitForIdle()
			.then(async () => {
				if (interruptSeq !== token) return;
				if (extraText?.trim()) await host.pushInput(extraText, "followUp");
				const count = host.snapshot().queue.length;
				if (!count) return;
				void host.resumePending().catch((error: unknown) => {
					process.stderr.write("[投递失败] " + String(error) + "\n");
				});
				tui?.addNotice((wasBusy ? "已打断当前回合，" : "") + count + " 条消息立即处理");
			})
			.catch((error) => {
				process.stderr.write(`[打断投递失败] ${String(error)}\n`);
			});
	};

	const handleInterruptAndDeliver = (text: string): void => {
		// 空文本同样生效：投递持有队列（Ctrl+Enter 空输入"插队"），无队列时 deliverQueuedNow 天然 no-op。
		deliverQueuedNow(text.trim() || undefined);
	};

	const handlePullBackQueue = async (): Promise<void> => {
		if (!tui) return;
		// UI 组合：peek（快照）选目标，claim（mailbox 原语）领取。Subject 不懂"编辑器"语义。
		const candidate = host.snapshot().queue.at(-1);
		if (!candidate) {
			tui.notify("排队队列为空，无待办可撤回", "warning", 2000);
			return;
		}
		if (!canEditQueuedDraft([candidate])) {
			tui.notify("该输入包含图片或扩展来源，已保留在队列中", "info");
			return;
		}
		const last = await host.claimQueued(candidate.id);
		if (!last) {
			tui.notify("排队队列为空，无待办可撤回", "warning", 2000);
			return;
		}
		tui.setDraft(combineQueuedDraft([last], tui.getDraft()));
		const remaining = host.snapshot().queue.length;
		tui.notify(`已从队列撤回 1 条消息至输入栏${remaining > 0 ? `（剩余排队：${remaining} 条）` : ""}`, "info", 2000);
	};

	const runDirectCommand = async (input: string): Promise<void> => {
		const command = input.slice(1).trim();
		if (!command || shuttingDown) return;
		if (host.isBusy()) {
			writeCommandOutput("[!] 模型正在处理中，请等待本轮结束后再执行");
			return;
		}
		execRunning = true;
		execAbort = new AbortController();
		try {
			const started = Date.now();
			const outcome = await host.runToolDirect("exec_command", { command }, execAbort.signal);
			const plain = (value: string): string => value;
			const lines = toolResultLines(outcome.result, Date.now() - started, {
				ok: plain,
				err: plain,
				warn: plain,
				dim: plain,
			});
			if (outcome.status !== "succeeded") lines.push(`[${outcome.status}]`);
			if (lines.length > 0) writeCommandOutput(lines.join("\n"));
		} finally {
			execRunning = false;
			execAbort = null;
		}
	};

	const onUserLine = (raw: string, mode: "steer" | "followUp" | "direct" = "followUp"): void => {
		const text = raw.trim();
		if (!text || shuttingDown) return;
		cancellationPending = false;
		if (text === "/stop") {
			handleInterrupt();
			return;
		}
		if (text.startsWith("/")) {
			void host.commands.dispatch(text);
			return;
		}
		if (text.startsWith("!")) {
			if (host.isBusy()) {
				writeCommandOutput("[!] 模型正在处理中，请等待本轮结束后再执行");
				return;
			}
			execTail = execTail
				.then(() => runDirectCommand(text))
				.catch((error) => {
					writeCommandOutput(`[命令错误] ${String(error)}`);
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
				cwd: process.cwd(),
				registry: host.extensionRegistry,
				features: {
					sessionPort: host.session,
				},
			});
			tui.initialize(snapshot);
			if (host.restoredEntries.length > 0) {
				const decorations = compactionDecorations(host.restoredAuxiliary, host.restoredEntries);
				tui.restoreSession(
					host.restoredEntries,
					decorations,
					listPromptSnapshots(host.restoredAuxiliary),
					host.restoredAuxiliary,
				);
			}
			host.attachExtensionUI(tui.extensionUI);
			tui.onIntent((intent) =>
				routePresentationIntent(intent, {
					submit: onUserLine,
					interaction: () => {
						cancellationPending = false;
					},
					cancel: handleCancel,
					interruptAndDeliver: handleInterruptAndDeliver,
					pullBackQueue: () => {
						void handlePullBackQueue();
					},
					cycleThinkingLevel: () => {
						if (!host.snapshot().thinkingLevels?.length) {
							tui?.notify("当前 Provider 未提供 thinking 能力元数据；无法循环档位。", "warning", 2500);
							return;
						}
						host.cycleThinkingLevel();
					},
				}),
			);
			tui.start();
			for (const event of earlyEvents.splice(0)) {
				render(event);
			}
			return;
		}
		if (isPrintMode) return;
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			executeExit(false);
		});
	};
	attachConsumer();

	installHostGuards(shouldRunTUI);

	// 官方命令已并入 pi 面：TUI 的富 UI 能力经 ctxUI（attachExtensionUI）到达 pi.ui，
	// 不再需要 BuiltinUI 桥接对象。
	await host.start({
		requestShutdown: () => {
			executeExit(false);
			return Promise.resolve();
		},
	});

	const runPrintPhase = async (): Promise<void> => {
		if (initialPrompt !== undefined) {
			await host.submitText(initialPrompt, "direct").catch((error: unknown) => {
				process.stderr.write(`[执行失败] ${String(error)}\n`);
				hadError = true;
			});
			await host.waitForIdle();
		}
		await cleanupResources();
		process.exitCode = resolveExitCode(isPrintMode, oneshot !== undefined, hadError);
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
