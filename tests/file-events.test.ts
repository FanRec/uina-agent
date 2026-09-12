import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import type { Model, ModelRequest, ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { mockModel } from "./helpers/mock-provider.js";

// The shell tool uses the platform shell, so the fixture commands must too.
const IS_WINDOWS = process.platform === "win32";
const SHORT_JOB = IS_WINDOWS ? "Start-Sleep -Seconds 2; Write-Output JOB_DONE" : "sleep 2; echo JOB_DONE";
const LONG_JOB = IS_WINDOWS ? "Start-Sleep -Seconds 60" : "sleep 60";

it("ordinary file extension handles real jobs, silence, user input, failure and teardown", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-file-event-"));
	const file = join(root, "observed.txt"); const session = join(root, "session.jsonl");
	await writeFile(file, "initial"); await mkdir(join(root, ".uina/extensions"), { recursive: true });
	await writeFile(join(root, ".uina/extensions/watch.mjs"), `export { default } from ${JSON.stringify(new URL("../examples/file-events.mts", import.meta.url).href)};`);
	const previous = process.env.UINA_WATCH_FILE; process.env.UINA_WATCH_FILE = file;
	const { store } = await openJsonlSession(session);
	const broker = new ToolBroker(); const errors: string[] = []; const text: string[] = [];
	let subject!: Subject; let requests = 0; let call = 0;
	const runner = new ExtensionRunner({ cwd: root, tools: broker, onInput: input => subject.accept(input), onError: error => errors.push(error) });
	const model = mockModel({ id: "deterministic-fixture", name: "deterministic-fixture" });
	const stream: ModelStreamFn = async (_m: Model, req: ModelRequest, emit: (d: StreamDelta) => void) => {
		requests++; const last = req.messages.at(-1); const content = last?.content ?? "";
		if (last?.role !== "tool" && content.includes("[运行时事件 file-changed") && /RUN|LONG|FAIL/.test(content)) {
			const command = content.includes("LONG") ? LONG_JOB : content.includes("FAIL") ? "exit 7" : SHORT_JOB;
			emit({ kind: "tool_call", call: { id: `call-${++call}`, name: "watch_exec", args: JSON.stringify({ command, run_in_background: true }) } });
			emit({ kind: "finish", reason: "tool_calls" });
		} else if (last?.role !== "tool" && content.includes("[运行时事件 watch-job")) {
			const id = content.match(/job-[\da-f-]+/)?.[0];
			emit({ kind: "tool_call", call: { id: `call-${++call}`, name: "watch_job_output", args: JSON.stringify({ job_id: id }) } });
			emit({ kind: "finish", reason: "tool_calls" });
		} else if (last?.role !== "tool" && content.includes("IGNORE")) {
			emit({ kind: "tool_call", call: { id: `call-${++call}`, name: "watch_silence", args: "{}" } }); emit({ kind: "finish", reason: "tool_calls" });
		} else { if (content === "hello") emit({ kind: "text", text: "here" }); emit({ kind: "finish", reason: "stop" }); }
	};
	subject = new Subject(model, stream, broker, { onToken: (value: string) => text.push(value), onError: (error: string) => errors.push(error) }, { store, runtimeHooks: runner.runtimeHooks() });
	const jobs = async () => JSON.parse(await broker.run("watch_job_list", {})) as Array<{ status: string }>;
	try {
		await runner.load(); expect(errors).toEqual([]); expect(broker.has("watch_exec")).toBe(true);
		await writeFile(file, "RUN");
		await vi.waitFor(async () => expect(await jobs()).toHaveLength(1), { timeout: 5000 });
		await subject.waitForIdle();
		await subject.pushInput("hello"); await subject.waitForIdle();
		expect(text).toEqual(["here"]); expect((await jobs())[0]?.status).toBe("running");
		await vi.waitFor(() => expect(subject.historySnapshot().some(m => m.role === "tool" && m.content.includes("JOB_DONE"))).toBe(true), { timeout: 8000 });
		await subject.waitForIdle();
		const beforeSilent = requests; await writeFile(file, "IGNORE");
		await vi.waitFor(() => expect(requests).toBeGreaterThan(beforeSilent)); await subject.waitForIdle(); expect(text).toEqual(["here"]);
		await writeFile(file, "FAIL"); await vi.waitFor(async () => expect((await jobs()).some(j => j.status === "failed")).toBe(true), { timeout: 5000 });
		await subject.waitForIdle();
		await writeFile(file, "LONG"); await vi.waitFor(async () => expect(await jobs()).toHaveLength(3), { timeout: 5000 });
		await subject.waitForIdle(); await runner.registry.getCommand("watch-stop")!.handler!("");
		expect((await jobs())[2]?.status).toBe("killed");
		const afterStop = requests; await runner.disposeProjects(); await writeFile(file, "RUN again");
		await new Promise(resolve => setTimeout(resolve, 100)); expect(requests).toBe(afterStop);
		expect(broker.has("watch_exec")).toBe(false); expect(errors).toEqual([]);
		await store.close();
		const reopened = await openJsonlSession(session); await reopened.store.close();
		expect(reopened.snapshot.entries.some(e => e.kind === "input" && e.input.source?.type === "file-changed")).toBe(true);
		expect((await readFile(session, "utf8")).includes("watch-job")).toBe(true);
	} finally {
		await runner.dispose(); subject.interrupt(); await subject.waitForIdle(); await store.close();
		if (previous === undefined) delete process.env.UINA_WATCH_FILE; else process.env.UINA_WATCH_FILE = previous;
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
