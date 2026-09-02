import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, activeProvider } from "../ai/config.js";
import { createOpenAIProvider } from "../ai/gateway.js";
import { execCommandDirect } from "../../tools/exec-command/index.js";
import { ToolBroker } from "../tools/broker.js";
import { loadTools } from "../tools/loader.js";
import { Subject } from "../agent/loop.js";
import { openJsonlSession } from "../session/jsonl-store.js";
import { SimpleTUI, type OutMsg } from "../ui/tui.js";
import { toolStartLine, toolResultLines } from "../ui/format.js";

const DATA_DIR = join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "session.jsonl");
const TOOLS_DIR = join(process.cwd(), "tools");
const CLEAR_LINE = "\r\x1b[2K";
const ERR = "\x1b[31m";
const RESET = "\x1b[0m";

export async function runApp(): Promise<void> {
	mkdirSync(DATA_DIR, { recursive: true });
	const cfg = loadConfig();
	const provider = createOpenAIProvider(activeProvider(cfg));
	const tools = new ToolBroker();
	const loaded = await loadTools(TOOLS_DIR, tools);
	for (const failure of loaded.failed) {
		process.stderr.write(`[工具加载失败] ${failure.file}: ${failure.error}\n`);
	}

	const { store, snapshot } = await openJsonlSession(SESSION_FILE);
	let tui: SimpleTUI | null = null;
	let nonTTY: ReturnType<typeof createInterface> | null = null;
	let shuttingDown = false;
	const toolStartedAt = new Map<string, number>();
	let execTail = Promise.resolve();
	let execRunning = false;
	let execAbort: AbortController | null = null;
	const oneshot = process.env.UINA_ONESHOT_MSG;

	const renderStdio = (message: OutMsg): void => {
		switch (message.type) {
			case "text":
				process.stdout.write(message.text);
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

	const subject = new Subject(
		provider,
		tools,
		{
			onToken: (text) => render({ type: "text", text }),
			onTurnStart: (n, text) => render({ type: "turn_start", n, text }),
			onTurnEnd: (n) => render({ type: "turn_end", n }),
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
		{ store },
	);

	subject.addHistory(snapshot.messages);
	subject.seedQueue(snapshot.queued);
	if (snapshot.messages.length > 0) {
		process.stdout.write(`（已恢复 JSONL 会话：${snapshot.messages.length} 条消息）\n\n`);
	}

	const restoreQueueToEditor = (): void => {
		if (!tui) return;
		const queued = subject.takeQueuedForEditor();
		if (queued.length > 0) tui.replaceInput(queued.map((item) => item.text).join("\n\n"));
	};

	const shutdown = async (cancelCurrent = true): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		if (cancelCurrent && subject.isBusy()) subject.interrupt();
		if (execRunning) execAbort?.abort();
		await subject.waitForIdle();
		await execTail;
		tui?.close();
		nonTTY?.close();
		await store.close();
		process.exitCode = 0;
	};

	const handleInterrupt = (): void => {
		if (subject.isBusy()) {
			subject.interrupt();
			void subject.waitForIdle().then(restoreQueueToEditor);
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
		if (text === "/quit") {
			void shutdown();
			return;
		}
		if (text === "/stop") {
			handleInterrupt();
			return;
		}
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

	process.stdout.write(`Uina 就绪（模型：${provider.name}，工具：${loaded.loaded} 个）— /quit 退出\n\n`);
	const isTTY = process.stdout.isTTY && process.stdin.isTTY;
	if (oneshot !== undefined) {
		// One-shot mode has no input stream to own.
		subject.pushInput(oneshot, { mode: "direct" });
		await subject.waitForIdle();
		await shutdown(false);
		return;
	}
	if (isTTY) {
		tui = new SimpleTUI();
		tui.onLine(onUserLine);
		tui.onSIGINT(handleInterrupt);
	} else {
		nonTTY = createInterface({ input: process.stdin });
		nonTTY.on("line", (line) => onUserLine(line, "followUp"));
		nonTTY.on("close", () => {
			void shutdown(false);
		});
		process.on("SIGINT", handleInterrupt);
	}

}
