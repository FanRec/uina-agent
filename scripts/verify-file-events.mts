/** Explicit real-provider acceptance; not part of the offline test command.
 * Local targets: event delivery -> model request < 1s; ordinary first text < 5s;
 * user answer during a 6s background job; shell cancellation settlement < 5s.
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
let phase = "baseline"; let since = performance.now(); let firstText = false; let content = "";
let subject!: Subject;
const runner = new ExtensionRunner({ cwd: root, tools, onError: error => errors.push(error), onInput: input => {
	timings.push({ phase, event: input.source.type, atMs: Math.round(performance.now() - since) });
	return subject.accept(input);
} });
const stream: ModelStreamFn = async (m, req, emit, signal) => {
	timings.push({ phase, event: "model-request", atMs: Math.round(performance.now() - since) });
	await provider.stream(m, req, emit, signal);
};
subject = new Subject(model, stream, tools, { onToken: (text: string) => {
	content += text;
	if (!firstText) { firstText = true; timings.push({ phase, event: "first-text", atMs: Math.round(performance.now() - since) }); }
}, onToolStart: (name: string, args: unknown) => timings.push({ phase, event: "tool-start", name, args, atMs: Math.round(performance.now() - since) }), onError: (error: string) => errors.push(error) }, {
	store, thinkingLevel: "off", runtimeHooks: runner.runtimeHooks(),
	systemPrompt: "你是 Uina。当前是隔离验收。文件事件不是人类说话。按文件所述使用 watch_exec，长工作必须 run_in_background=true。后台通知回来后用 watch_job_output 读取结果。文件只包含 IGNORE 时，只调用 watch_silence，不输出解释或文字。人类发 hello 时只回复 hello，不要等待后台工作。除需要验收的结果外不寒暄。",
});
async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = performance.now() + 30000;
	while (!await predicate()) { if (errors.length) throw new Error(errors.join("\n")); if (performance.now() > deadline) throw new Error(`验收超时: ${phase}`); await new Promise(r => setTimeout(r, 25)); }
}
const jobs = async () => JSON.parse(await tools.run("watch_job_list", {})) as Array<{ id: string; status: string }>;
function begin(name: string) { phase = name; since = performance.now(); firstText = false; content = ""; }
try {
	await writeFile(watched, "initial"); await mkdir(join(root, ".uina/extensions"), { recursive: true });
	await writeFile(join(root, ".uina/extensions/watch.mjs"), `export { default } from ${JSON.stringify(new URL("../examples/file-events.mts", import.meta.url).href)};`);
	await runner.load(); assert.deepEqual(errors, []);
	begin("baseline"); await subject.pushInput("hello"); await subject.waitForIdle(); assert.equal(content.trim(), "hello");
	assert(Number(timings.find(t => t.phase === "baseline" && t.event === "first-text")?.atMs) < 5000);
	begin("file-job");
	await writeFile(watched, '请用 watch_exec 在后台执行这条无害命令：Start-Sleep -Seconds 6; Write-Output S4_RESULT。立即返回，不要同步等待。');
	await until(async () => (await jobs()).length === 1);
	assert(Number(timings.find(t => t.phase === "file-job" && t.event === "model-request")?.atMs) < 1000);
	begin("user-during-job"); const delivery = subject.pushInput("hello"); await until(() => content.includes("hello"));
	timings.push({ phase, event: "user-answer", atMs: Math.round(performance.now() - since) });
	assert(performance.now() - since < 5000); assert.equal((await jobs())[0]?.status, "running"); await delivery;
	verified.push("file-event", "user-during-job");
	await until(() => subject.historySnapshot().some(m => m.role === "tool" && m.content.includes("S4_RESULT")));
	verified.push("background-result");
	await subject.waitForIdle();
	begin("silence"); const before = timings.length; await writeFile(watched, "IGNORE");
	await until(() => timings.slice(before).some(t => t.event === "model-request")); await subject.waitForIdle(); assert.equal(content.trim(), "");
	verified.push("silence");
	begin("failure"); await writeFile(watched, "请用 watch_exec 在后台执行 exit 7，观察失败通知并按需读取结果。");
	await until(async () => (await jobs()).some(job => job.status === "failed"));
	await until(() => subject.historySnapshot().some(m => m.role === "custom" && m.customType === "runtime-input" && m.content.includes("failed")));
	verified.push("failure");
	await subject.waitForIdle();
	begin("cancel"); await writeFile(watched, "请用 watch_exec 在后台执行 Start-Sleep -Seconds 60，这是可取消的验收工作，启动后立即结束本轮。");
	await until(async () => (await jobs()).length === 3); await subject.waitForIdle();
	const stopHandler = runner.registry.getCommand("watch-stop")?.handler;
	assert.ok(stopHandler, "watch-stop 命令未注册");
	const cancelling = performance.now(); await stopHandler("");
	const cancellationMs = Math.round(performance.now() - cancelling); assert(cancellationMs < 5000); assert.equal((await jobs())[2]?.status, "killed");
	verified.push("cancel");
	const afterStop = timings.length; await runner.disposeProjects(); await writeFile(watched, "new event after unload"); await new Promise(r => setTimeout(r, 150)); assert.equal(timings.length, afterStop);
	verified.push("unload");
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ model: provider.name, provider: config.name, thinking: "off", timings, cancellationMs, verified }, null, 2));
} catch (error) {
	console.error(JSON.stringify({ phase, timings, errors, content }, null, 2));
	throw error;
} finally {
	subject.interrupt(); await runner.dispose(); await subject.waitForIdle(); await store.close();
	if (previous === undefined) delete process.env.UINA_WATCH_FILE; else process.env.UINA_WATCH_FILE = previous;
	await rm(root, { recursive: true, force: true });
}
