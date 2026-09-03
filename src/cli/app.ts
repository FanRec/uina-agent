import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, activeProvider } from "../ai/config.js";
import { createProvider, ModelRegistry } from "../ai/providers.js";
import { execCommandDirect } from "../extensions/runtime-tools/exec-command/index.js";
import { ToolBroker } from "../tools/broker.js";
import { Subject } from "../agent/loop.js";
import { openJsonlSession } from "../session/jsonl-store.js";
import { projectModelHistory } from "../session/recovery.js";
import { createInteractiveUI, type InteractiveTUI, type OutMsg } from "../ui/tui.js";
import { sanitizeTerminalText, toolStartLine, toolResultLines } from "../ui/format.js";
import { JobRegistry } from "../extensions/jobs/registry.js";
import { DefaultAgentFactory } from "../agent/runtime.js";
import { SubagentRegistry } from "../extensions/subagents/registry.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { CommandRouter } from "../extensions/commands.js";
import { activateBuiltinCommands } from "../extensions/builtin.js";
import { activateRuntimeTools, createChildTools } from "../extensions/runtime-tools/index.js";
import { createJobAdapter } from "../ui/adapters/jobs.js";
import { createSubagentAdapter } from "../ui/adapters/subagents.js";

const DATA_DIR = join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "session.jsonl");
const CLEAR_LINE = "\r\x1b[2K";
const ERR = "\x1b[31m";
const RESET = "\x1b[0m";

export async function runApp(): Promise<void> {
	mkdirSync(DATA_DIR, { recursive: true });
	const cfg = loadConfig();
	const active = activeProvider(cfg);
	const provider = createProvider(active.name, active);
	const tools = new ToolBroker();
	const jobs = new JobRegistry();
	const modelRegistry = new ModelRegistry(cfg);
	modelRegistry.register(provider.name, provider);
	void modelRegistry.refreshModels().catch((error: unknown) => {
		process.stderr.write(`[模型目录刷新失败] ${error instanceof Error ? error.message : String(error)}\n`);
	});

	const { store, snapshot } = await openJsonlSession(SESSION_FILE);
	let tui: InteractiveTUI | null = null;
	let nonTTY: ReturnType<typeof createInterface> | null = null;
	let shuttingDown = false;
	const toolStartedAt = new Map<string, number>();
	let execTail = Promise.resolve();
	let execRunning = false;
	let execAbort: AbortController | null = null;
	const oneshot = process.env.UINA_ONESHOT_MSG;

	const renderStdio = (message: OutMsg): void => {
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
				const elapsed = message.ts ? Date.now() - message.ts : 0;
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
			case "error":
				process.stdout.write(`[错误] ${message.text}\n`);
				break;
			case "queue":
				break;
		}
	};

	const render = (message: OutMsg): void => {
		if (tui) tui.render(message);
		else renderStdio(message);
	};

	let subject: Subject;
	const extensionHost = new ExtensionRunner({
		cwd: process.cwd(),
		tools,
		onError: (text) => render({ type: "error", text }),
		onProvider: (name, registered) => modelRegistry.register(name, registered),
		onCustomMessage: async (message) => { await subject.appendCustomMessage(message); tui?.host.transcript.addCustomMessage(message); tui?.host.requestRender(); },
		onCustomEntry: async (entry) => { await subject.appendCustomEntry(entry); tui?.host.transcript.addCustomEntry(entry); tui?.host.requestRender(); },
	});

	subject = new Subject(
		provider,
		tools,
		{
			onToken: (text) => render({ type: "text", text }),
			onThinking: (text) => { if (tui || process.env.UINA_SHOW_THINKING === "1") render({ type: "thinking", text }); },
			onTurnStart: (n, text) => render({ type: "turn_start", n, text }),
			onTurnEnd: (n, usage) => render({ type: "turn_end", n, usage }),
			onToolStart: (name, args, callId) => {
				if (callId) toolStartedAt.set(callId, Date.now());
				render({ type: "tool_start", name, args, callId });
			},
			onToolDone: (name, result, status, callId) => {
				const ts = callId ? toolStartedAt.get(callId) : undefined;
				if (callId) toolStartedAt.delete(callId);
				render({ type: "tool_done", name, result, status, callId, ts });
			},
			onError: (text) => render({ type: "error", text }),
			onNotice: (text) => render({ type: "notice", text }),
			onQueueChanged: (items) => render({ type: "queue", items }),
		},
		{ store, thinkingLevel: cfg.thinkingLevel, runtimeHooks: extensionHost.runtimeHooks() },
	);
	const commands = new CommandRouter(extensionHost.registry, (text) => render({ type: "error", text }));

	extensionHost.on("session_compact", (e) => {
		if (tui) {
			tui.host.addCompaction({
				summary: e.summary,
				turnsCount: e.retainedTailCount,
				tokensSaved: e.tokensBefore,
				collapsed: true,
			});
		} else {
			process.stdout.write(`\n[会话压缩] ${e.summary}\n`);
		}
	});
	const subagents = new SubagentRegistry({
		factory: new DefaultAgentFactory(),
		provider,
		thinkingLevel: cfg.thinkingLevel,
		createTools: createChildTools,
		notify: async (text, data) => {
			if (shuttingDown) return;
			await subject.accept({
				id: `subagent-notice-${String(data.id)}`,
				mode: "followUp",
				source: { kind: "runtime", type: "subagent-notice", ref: String(data.id) },
				text,
				data,
			});
		},
	});

	const restoredHistory = projectModelHistory(snapshot.entries);
	subject.addHistory(restoredHistory);
	subject.seedQueue(snapshot.queued);
	if (restoredHistory.length > 0) {
		process.stdout.write(`（已恢复 JSONL 会话：${restoredHistory.length} 条消息）\n\n`);
	}

	const restoreQueueToEditor = async (): Promise<void> => {
		if (!tui) return;
		const queued = await subject.takeQueuedForEditor();
		if (queued.length > 0) tui.replaceInput(queued.map((item) => item.text).join("\n\n"));
	};

	const shutdown = async (cancelCurrent = true): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (cancelCurrent && subject.isBusy()) subject.interrupt();
		if (execRunning) execAbort?.abort();
		await subject.waitForIdle();
		await extensionHost.dispose();
		await execTail;
		await subject.waitForIdle();
		tui?.close();
		nonTTY?.close();
		await store.close();
		process.exitCode = 0;
	};

	const handleInterrupt = (): void => {
		if (subject.isBusy() || (tui && tui.host.isBusy())) {
			subject.interrupt();
			void subject.waitForIdle().then(restoreQueueToEditor).catch((error) => process.stderr.write(`[队列恢复失败] ${String(error)}\n`));
			return;
		}
		if (execRunning) {
			execAbort?.abort();
			return;
		}
		void shutdown(false);
	};

	const runDirectCommand = async (input: string): Promise<void> => {
		const command = input.slice(1).trim();
		if (!command || shuttingDown) return;
		if (subject.isBusy()) {
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

	const onUserLine = (raw: string, mode: "steer" | "followUp" = "followUp"): void => {
		const text = raw.trim();
		if (!text || shuttingDown) return;
		if (text === "/stop") {
			handleInterrupt();
			return;
		}
		if (text.startsWith("/")) { void commands.dispatch(text); return; }
		if (text.startsWith("!")) {
			if (subject.isBusy()) {
				process.stdout.write("[!] 模型正在处理中，请等待本轮结束后再执行\n");
				return;
			}
			execTail = execTail.then(() => runDirectCommand(text)).catch((error) => {
				process.stdout.write(`${ERR}[命令错误]${RESET} ${String(error)}\n`);
			});
			return;
		}
		subject.pushInput(text, { mode: subject.isBusy() ? mode : "direct" });
	};

	const isTTY = process.stdout.isTTY && process.stdin.isTTY;
	if (!isTTY) {
		process.stdout.write(`Uina 就绪（模型：${provider.name}）— /quit 退出\n\n`);
	}
	process.on("SIGINT", handleInterrupt);

	if (isTTY) {
		tui = createInteractiveUI({
			modelName: provider.name,
			thinkingLevels: provider.thinkingLevels,
			thinkingLevel: subject.getThinkingLevel(),
			cwd: process.cwd(),
			registry: extensionHost.registry,
			jobPort: createJobAdapter(jobs),
			subagentPort: createSubagentAdapter(subagents),
		});
		extensionHost.attachUI(tui.ctxUI);
		tui.onLine(onUserLine);
		tui.onSIGINT(handleInterrupt);
		tui.onThinkingLevelCycle(() => {
			if (!subject.getModel().thinkingLevels?.length) {
				tui?.host.transcript.addNotice("当前 Provider 未提供 thinking 能力元数据；无法循环档位。");
				tui?.host.requestRender();
				return;
			}
			const level = subject.cycleThinkingLevel();
			tui?.host.setReasoningEffort(level);
			tui?.host.transcript.addNotice(`思考等级已设置为: ${level}`);
			tui?.host.requestRender();
		});
		tui.host.setUsage(subject.getUsedTokens(), subject.getContextWindow(), false, {
			segments: subject.getContextSegments(),
		});
		if (snapshot.entries.length > 0) {
			tui.loadSession(snapshot.entries);
		}
	} else {
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			void shutdown(false);
		});
	}

	await extensionHost.activateBuiltin("runtime-tools", activateRuntimeTools({
		jobs,
		subagents,
		onJobResolved: (job) => {
			if (shuttingDown) return;
			void subject.accept({
				id: `job-notice-${job.id}`,
				mode: "followUp",
				source: { kind: "runtime", type: "job-notice", ref: job.id },
				text: `后台任务 ${job.id} 已${job.status === "completed" ? "完成" : job.status === "killed" ? "被取消" : "结束"}。任务：${job.label}。来源：${job.source.extension}${job.source.operation ? `/${job.source.operation}` : ""}。请使用 job_output 读取结果。`,
				data: { status: job.status, label: job.label, source: job.source },
			}).catch((error) => render({ type: "error", text: `后台任务通知失败：${String(error)}` }));
		},
	}));
	const builtinUI = tui ? {
		openHelpMenu: () => tui!.host.openHelpMenu(),
		toggleThinking: () => {
			tui!.host.transcript.toggleThinking();
			tui!.host.requestRender();
		},
		clear: () => {
			tui!.host.transcript.clear();
			tui!.host.requestRender();
		},
		openModelPicker: (current: string, groups: any, onPick: any) => {
			tui!.host.openModelPicker(current, groups, onPick);
		},
		openEffortSlider: (current: any, tiers: any, onChange: any) => {
			tui!.host.openEffortSlider(current, tiers, onChange);
		},
		openTasks: () => tui!.host.openTasks(),
		openSubagents: () => tui!.host.openSubagents(),
		openTrajectory: () => tui!.host.openTrajectory(),
		setModel: (name: string) => tui!.host.setModel(name),
		setThinkingLevels: (levels?: readonly any[]) => tui!.host.setThinkingLevels(levels),
		setReasoningEffort: (level?: any) => tui!.host.setReasoningEffort(level),
		setUsage: (used: number, window?: number) => tui!.host.setUsage(used, window),
	} : undefined;

	await extensionHost.activateBuiltin("commands", activateBuiltinCommands({
		subject,
		models: modelRegistry,
		jobs,
		subagents,
		ui: builtinUI,
		reload: async () => {
			await subject.waitForIdle();
			await extensionHost.reload();
			render({ type: "notice", text: "项目扩展已重新加载。" });
		},
		shutdown: async () => shutdown(),
	}));
	await extensionHost.load();
	if (oneshot !== undefined) {
		subject.pushInput(oneshot, { mode: "direct" });
		await subject.waitForIdle();
		await shutdown(false);
	}

}
