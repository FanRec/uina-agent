/** Explicit real-provider acceptance; not part of the offline test command.
 * Local targets: event delivery -> model request < 1s; ordinary first text < 5s;
 * foreground exec result lands in history; shell cancellation settlement < 5s.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, activeProvider } from "../src/ai/config.js";
import { createModel, createProvider } from "../src/ai/providers.js";
import { Subject } from "../src/agent/loop.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import type { ModelStreamFn } from "../src/core/types.js";

const root = await mkdtemp(join(tmpdir(), "uina-s4-real-"));
const watched = join(root, "observation.txt");
const previous = process.env.UINA_WATCH_FILE;
process.env.UINA_WATCH_FILE = watched;
const config = activeProvider(loadConfig());
const provider = createProvider(config.name, { ...config, maxRetries: 0 });
const model = createModel({ ...config, maxRetries: 0 }, config.name);
const tools = new ToolBroker();
const { store } = await openJsonlSession(join(root, "session.jsonl"));
const errors: string[] = [];
const timings: Array<Record<string, unknown>> = [];
/** Behaviors that actually reached their assertion in this run. */
const verified: string[] = [];
let phase = "baseline";
let since = performance.now();
let firstText = false;
let content = "";
let subject!: Subject;
const runner = new ExtensionRunner({
	cwd: root,
	tools,
	onError: (error) => errors.push(error),
	onInput: (input) => {
		timings.push({ phase, event: input.source.type, atMs: Math.round(performance.now() - since) });
		return subject.accept(input);
	},
});
const stream: ModelStreamFn = async (m, req, emit, signal) => {
	timings.push({ phase, event: "model-request", atMs: Math.round(performance.now() - since) });
	await provider.stream(m, req, emit, signal);
};
// 裸 Subject：不使用 Host 默认事件帧。这里验收工具行为，不证明帧投影下的模型表现。
subject = new Subject(model, stream, tools, {
	store,
	thinkingLevel: "off",
	runtimeHooks: runner.runtimeHooks(),
	systemPrompt:
		"你是 Uina。当前是隔离验收。文件事件不是人类说话。按文件所述使用 watch_exec 同步执行命令，合理设置 timeout。文件只包含 IGNORE 时，只调用 watch_silence，不输出解释或文字。人类发 hello 时只回复 hello。除需要验收的结果外不寒暄。",
});
subject.subscribe((e) => {
	if (e.type === "output_update" && e.channel === "content") {
		content += e.text;
		if (!firstText) {
			firstText = true;
			timings.push({ phase, event: "first-text", atMs: Math.round(performance.now() - since) });
		}
	} else if (e.type === "tool_call") {
		timings.push({
			phase,
			event: "tool-start",
			name: e.toolName,
			args: e.args,
			atMs: Math.round(performance.now() - since),
		});
	} else if (e.type === "error") {
		errors.push(e.text);
	}
});
async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = performance.now() + 30000;
	while (!(await predicate())) {
		if (errors.length) throw new Error(errors.join("\n"));
		if (performance.now() > deadline) throw new Error(`验收超时: ${phase}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
const historyHas = (needle: string) =>
	subject.historySnapshot().some((m) => m.role === "tool" && m.content.includes(needle));
function begin(name: string) {
	phase = name;
	since = performance.now();
	firstText = false;
	content = "";
}
try {
	await writeFile(watched, "initial");
	await mkdir(join(root, ".uina/extensions"), { recursive: true });
	await writeFile(
		join(root, ".uina/extensions/watch.mjs"),
		`export { default } from ${JSON.stringify(new URL("../examples/file-events.mts", import.meta.url).href)};`,
	);
	await runner.load();
	assert.deepEqual(errors, []);
	begin("baseline");
	await subject.pushInput("hello");
	await subject.waitForIdle();
	assert.equal(content.trim(), "hello");
	assert(Number(timings.find((t) => t.phase === "baseline" && t.event === "first-text")?.atMs) < 5000);
	begin("file-exec");
	await writeFile(
		watched,
		"请用 watch_exec 同步执行这条无害命令：Start-Sleep -Seconds 2; Write-Output S4_RESULT。合理设置 timeout，等待结果。",
	);
	await until(() => historyHas("S4_RESULT"));
	assert(Number(timings.find((t) => t.phase === "file-exec" && t.event === "model-request")?.atMs) < 1000);
	verified.push("file-event", "foreground-result");
	await subject.waitForIdle();
	begin("silence");
	const before = timings.length;
	await writeFile(watched, "IGNORE");
	await until(() => timings.slice(before).some((t) => t.event === "model-request"));
	await subject.waitForIdle();
	assert.equal(content.trim(), "");
	verified.push("silence");
	begin("failure");
	await writeFile(watched, "请用 watch_exec 同步执行 exit 7，观察失败结果。");
	await until(() => historyHas('"code":7'));
	verified.push("failure");
	await subject.waitForIdle();
	begin("cancel");
	await writeFile(
		watched,
		"请用 watch_exec 同步执行 Start-Sleep -Seconds 60，timeout 设为 120。这是可取消的验收工作。",
	);
	await until(() => timings.some((t) => t.phase === "cancel" && t.event === "tool-start" && t.name === "watch_exec"));
	await subject.waitForIdle();
	const stopHandler = runner.registry.getCommand("watch-stop")?.handler;
	assert.ok(stopHandler, "watch-stop 命令未注册");
	const cancelling = performance.now();
	await stopHandler("");
	const cancellationMs = Math.round(performance.now() - cancelling);
	assert(cancellationMs < 5000);
	await until(() => historyHas("cancelled") || historyHas('"cancelled":true'));
	verified.push("cancel");
	const afterStop = timings.length;
	await runner.disposeProjects();
	await writeFile(watched, "new event after unload");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(timings.length, afterStop);
	verified.push("unload");
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{ model: provider.name, provider: config.name, thinking: "off", timings, cancellationMs, verified },
			null,
			2,
		),
	);
} catch (error) {
	console.error(JSON.stringify({ phase, timings, errors, content }, null, 2));
	throw error;
} finally {
	subject.interrupt();
	await runner.dispose();
	await subject.waitForIdle();
	await store.close();
	if (previous === undefined) delete process.env.UINA_WATCH_FILE;
	else process.env.UINA_WATCH_FILE = previous;
	await rm(root, { recursive: true, force: true });
}
