import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultAgentFactory } from "../src/agent/runtime.js";
import { JobRegistry, type JobOutcome } from "../src/extensions/jobs/registry.js";
import { SubagentRegistry } from "../src/extensions/subagents/registry.js";
import { ToolBroker } from "../src/tools/broker.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

it("manual compaction owns activity until cancellation and disposal have finished", async () => {
	const directory = await mkdtemp(join(tmpdir(), "uina-activity-"));
	const path = join(directory, "session.jsonl");
	const { store } = await openJsonlSession(path);
	const entered = deferred<void>(); const finish = deferred<void>();
	let signal: AbortSignal | undefined;
	const handle = new DefaultAgentFactory().create({ store, tools: new ToolBroker(), provider: { name: "fixture", async stream(_req, emit, cancellation) { signal = cancellation; entered.resolve(); await finish.promise; emit({ kind: "text", text: "summary" }); emit({ kind: "finish", reason: "stop" }); } } });
	const history = [{ role: "user" as const, content: "first" }, { role: "assistant" as const, content: "answer" }, { role: "user" as const, content: "next" }];
	for (const message of history) await store.appendMessage(message);
	handle.subject.addHistory(history);
	const compact = handle.subject.compact(); const caught = compact.catch(error => error);
	await entered.promise;
	expect(handle.snapshot()).toMatchObject({ busy: true, status: "running" });
	await expect(handle.subject.appendCustomMessage({ customType: "race", content: "new" })).rejects.toThrow("压缩期间");
	let released = false; const disposal = handle.dispose().then(() => { released = true; });
	await Promise.resolve(); expect(signal?.aborted).toBe(true); expect(released).toBe(false);
	finish.resolve(); await caught; await disposal;
	expect(handle.history()).toEqual(history);
	const reopened = await openJsonlSession(path); await reopened.store.close();
	expect(reopened.snapshot.entries).toHaveLength(3);
	await rm(directory, { recursive: true, force: true });
});

it.each(["completed", "failed"] as const)("cancel control failure does not discard later producer %s", async status => {
	const jobs = new JobRegistry(); const done = deferred<JobOutcome>();
	const id = jobs.start({ ownerId: "root", label: "fixture", source: { extension: "test" }, start: () => ({ cancel() { throw new Error("cancel broke"); }, done: done.promise }) });
	let closed = false; const closing = jobs.close().then(() => { closed = true; });
	await Promise.resolve();
	expect(jobs.get(id, "root")).toMatchObject({ status: "stopping", detail: "取消请求失败：cancel broke" });
	expect(closed).toBe(false);
	done.resolve({ status, output: { result: "actual result" } }); await closing;
	expect(jobs.read(id, "root")).toMatchObject({ job: { status }, result: "actual result" });
});

it("default jobs accept more than ten producers", async () => {
	const jobs = new JobRegistry(); const done = deferred<JobOutcome>();
	for (let n = 0; n < 12; n++) jobs.start({ ownerId: "root", label: String(n), source: { extension: "test" }, start: () => ({ cancel() {}, done: done.promise }) });
	expect(jobs.list("root")).toHaveLength(12); done.resolve({ status: "completed" }); await jobs.close();
});

it("sending to a busy child cannot publish waiting while its handle is busy", async () => {
	const entered = deferred<void>(); const finish = deferred<void>();
	const registry = new SubagentRegistry({ factory: new DefaultAgentFactory(), createTools: () => new ToolBroker(), provider: () => ({ name: "fixture", async stream(_req, emit) { entered.resolve(); await finish.promise; emit({ kind: "text", text: "done" }); emit({ kind: "finish", reason: "stop" }); } }) });
	const child = registry.start({ ownerId: "root", label: "child", prompt: "first" }); await entered.promise;
	await registry.send(child.id, "root", "second");
	expect(registry.get(child.id, "root")).toMatchObject({ busy: true, status: "running" });
	finish.resolve(); await registry.close();
	expect(registry.get(child.id, "root")).toMatchObject({ busy: false, status: "settled" });
});
