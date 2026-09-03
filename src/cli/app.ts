import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadConfig, activeProvider } from "../ai/config.js";
import { createProvider, ModelRegistry } from "../ai/providers.js";
import { execCommandDirect } from "../../tools/exec-command/index.js";
import { ToolBroker } from "../tools/broker.js";
import { loadTools, loadToolsFromPaths } from "../tools/loader.js";
import { Subject } from "../agent/loop.js";
import { openJsonlSession } from "../session/jsonl-store.js";
import { createInteractiveUI, type InteractiveTUI, type OutMsg } from "../ui/tui.js";
import { sanitizeTerminalText, toolStartLine, toolResultLines } from "../ui/format.js";
import { JobRegistry } from "../extensions/jobs/registry.js";
import { createJobTools } from "../extensions/jobs/tools.js";
import { createExecCommandTool } from "../../tools/exec-command/index.js";
import { DefaultAgentFactory } from "../agent/runtime.js";
import { SubagentRegistry } from "../extensions/subagents/registry.js";
import { createSubagentTools } from "../extensions/subagents/tools.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { CommandRouter } from "../extensions/commands.js";
import { activateBuiltinCommands } from "../extensions/builtin.js";

const DATA_DIR = join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "session.jsonl");
const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tools");
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
	void modelRegistry.refreshModels();

	const loaded = await loadTools(TOOLS_DIR, tools);
	tools.remove("exec_command");
	const ordinaryTools = new ToolBroker();
	tools.copyTo(ordinaryTools);
	tools.register(createExecCommandTool(jobs, "root"));
	for (const tool of createJobTools(jobs, "root")) tools.register(tool);
	for (const failure of loaded.failed) {
		process.stderr.write(`[工具加载失败] ${failure.file}: ${failure.error}\n`);
	}

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
		{ store, thinkingLevel: cfg.thinkingLevel, extensionHost },
	);
	const commands = new CommandRouter(extensionHost.registry, (text) => render({ type: "error", text }));

	extensionHost.on("session_compact", (e) => {
		if (tui) {
			tui.host.addCompaction({
				id: Date.now(),
				summary: e.summary,
				turnsCount: e.retainedTailCount,
				tokensSaved: e.tokensBefore,
				collapsed: true,
				timestamp: Date.now(),
			});
		} else {
			process.stdout.write(`\n[会话压缩] ${e.summary}\n`);
		}
	});
	const subagents = new SubagentRegistry({
		factory: new DefaultAgentFactory(),
		provider,
		thinkingLevel: cfg.thinkingLevel,
		createTools: () => {
			const childTools = new ToolBroker();
			ordinaryTools.copyTo(childTools);
			return childTools;
		},
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
	for (const tool of createSubagentTools(subagents, "root")) tools.register(tool);
	jobs.onResolved((job) => {
		if (shuttingDown) return;
		void subject.accept({
			id: `job-notice-${job.id}`,
			mode: "followUp",
			source: { kind: "runtime", type: "job-notice", ref: job.id },
			text: `后台任务 ${job.id} 已${job.status === "completed" ? "完成" : job.status === "killed" ? "被取消" : "结束"}。任务：${job.label}。来源：${job.source.extension}${job.source.operation ? `/${job.source.operation}` : ""}。请使用 job_output 读取结果。`,
			data: { status: job.status, label: job.label, source: job.source },
		}).catch((error) => render({ type: "error", text: `后台任务通知失败：${String(error)}` }));
	});

	subject.addHistory(snapshot.messages);
	for (const message of snapshot.customMessages) subject.restoreCustomMessage(message);
	subject.seedQueue(snapshot.queued);
	if (snapshot.messages.length > 0) {
		process.stdout.write(`（已恢复 JSONL 会话：${snapshot.messages.length} 条消息）\n\n`);
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
		await subagents.close();
		await jobs.close();
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
		process.stdout.write(`Uina 就绪（模型：${provider.name}，工具：${loaded.loaded} 个）— /quit 退出\n\n`);
	}
	process.on("SIGINT", handleInterrupt);

	if (isTTY) {
		tui = createInteractiveUI({
			modelName: provider.name,
			thinkingLevels: provider.thinkingLevels,
			toolCount: loaded.loaded,
			cwd: process.cwd(),
			registry: extensionHost.registry,
		});
		extensionHost.attachUI(tui.ctxUI);
		tui.onLine(onUserLine);
		tui.onSIGINT(handleInterrupt);
		tui.host.setUsage(subject.getUsedTokens(), subject.getContextWindow());
		if (snapshot.messages.length > 0) {
			tui.loadHistory(snapshot.messages);
			let sys = 0, pr = 0, ast = 0, th = 0, tl = 0;
			for (const m of snapshot.messages) {
				const len = Math.ceil(m.content.length / 3);
				if (m.role === "system") sys += len;
				else if (m.role === "user") pr += len;
				else if (m.role === "assistant") {
					ast += len;
					if (m.thinking) th += Math.ceil(m.thinking.length / 3);
					if (m.tool_calls) tl += Math.ceil(JSON.stringify(m.tool_calls).length / 3);
				} else if (m.role === "tool") tl += len;
			}
			tui.host.setDetailedSegments({
				sys: Math.max(sys, 9000),
				pr: Math.max(pr, 5),
				ast: Math.max(ast, 79),
				th: Math.max(th, 358),
				tl: Math.max(tl, 0),
			});
		}
		for (const message of snapshot.customMessages) tui.host.transcript.addCustomMessage(message);
		for (const entry of snapshot.customEntries) tui.host.transcript.addCustomEntry(entry);
	} else {
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			void shutdown(false);
		});
	}

	await extensionHost.activateBuiltin("commands", activateBuiltinCommands({ subject, models: modelRegistry, jobs, subagents, host: tui?.host, reload: async () => { await subject.waitForIdle(); await extensionHost.reload(); render({ type: "notice", text: "项目扩展已重新加载。" }); }, shutdown: async () => shutdown() }));
	await extensionHost.load();
	const discovered = await extensionHost.emitResourcesDiscover(process.cwd(), "startup");
	if (discovered.toolPaths?.length) {
		await loadToolsFromPaths(discovered.toolPaths, ordinaryTools);
		await loadToolsFromPaths(discovered.toolPaths, tools);
	}
	if (oneshot !== undefined) {
		subject.pushInput(oneshot, { mode: "direct" });
		await subject.waitForIdle();
		await shutdown(false);
	}

}
