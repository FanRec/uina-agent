import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { SubjectHarness, Scenario, mockTool } from "./harness/index.js";

const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const input = (id = "a") => ({
	id,
	mode: "followUp" as const,
	text: "report",
	source: { kind: "runtime" as const, type: "completion", origin: "internal" as const, channel: "world" },
	receipt: { key: "k", attempt: id },
});
const owner = { namespace: "test", isActive: () => true };

describe("Subject delivery ownership", () => {
	it("returns a tool commit that arrives while durable input withdrawal is pending", async () => {
		const store = new MemorySessionStore();
		const write = store.appendEvent.bind(store),
			entered = gate(),
			finish = gate(),
			busy = gate();
		vi.spyOn(store, "appendEvent").mockImplementation(async (name, data) => {
			if (name === "queue_restored") {
				entered.resolve();
				await finish.promise;
			}
			await write(name, data);
		});
		const h = SubjectHarness.create({ store });
		const activity = h.subject.runActivity(() => busy.promise);
		await h.subject.accept(input(), owner);
		const retired = h.subject.delivery("test").retire("k", "a");
		await entered.promise;
		await store.appendMessage({
			role: "assistant",
			content: "",
			tool_calls: [{ id: "race", name: "probe", args: {} }],
		});
		await store.appendEvent("tool_started", { callId: "race" });
		await store.appendEvent("tool_finished", { callId: "race", status: "succeeded" });
		await store.appendMessage({
			role: "tool",
			tool_call_id: "race",
			content: "report",
			receipt: { key: "k", attempt: "tool" },
			receiptNamespace: "test",
		});
		finish.resolve();
		expect(await retired).toMatchObject({ kind: "committed", receipt: { channel: "tool", attempt: "tool" } });
		busy.resolve();
		await activity;
	});
	it("retires a failed admission after storage recovers and accepts the next attempt", async () => {
		const store = new MemorySessionStore();
		vi.spyOn(store, "appendEvent").mockRejectedValueOnce(new Error("admission failed"));
		const h = SubjectHarness.create({ store });
		await expect(h.subject.accept(input(), owner)).rejects.toThrow("admission failed");
		expect(await h.subject.delivery("test").retire("k", "a")).toEqual({ kind: "retired" });
		await h.subject.accept(input("b"), owner);
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({
			kind: "committed",
			receipt: { attempt: "b" },
		});
	});

	it("does not let a retired render rejection requeue or poison a replacement with the same input id", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		const entered = gate(),
			render = gate();
		const old = h.subject.accept(
			{
				...input(),
				render: async () => {
					entered.resolve();
					await render.promise;
					throw new Error("old render failed");
				},
			},
			owner,
		);
		await entered.promise;
		expect(await h.subject.delivery("test").retire("k", "a")).toEqual({ kind: "retired" });
		await h.subject.accept({ ...input(), receipt: { key: "k", attempt: "b" } }, owner);
		render.resolve();
		await old;
		expect(h.subject.queuedSnapshot().map((item) => item.receipt?.attempt)).toEqual(["b"]);
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({ kind: "pending", attempt: "b" });
		await h.subject.resumePending();
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({
			kind: "committed",
			receipt: { attempt: "b" },
		});
	});
	it("shares a durable withdrawal between empty render and retire", async () => {
		const store = new MemorySessionStore();
		const write = store.appendEvent.bind(store),
			entered = gate(),
			finish = gate();
		vi.spyOn(store, "appendEvent").mockImplementation(async (name, data) => {
			if (name === "queue_restored") {
				entered.resolve();
				await finish.promise;
			}
			await write(name, data);
		});
		const h = SubjectHarness.create({ store });
		const run = h.subject.accept({ ...input(), render: () => null }, owner);
		await entered.promise;
		const retired = h.subject.delivery("test").retire("k", "a");
		finish.resolve();
		await run;
		expect(await retired).toEqual({ kind: "retired" });
		expect(await h.subject.delivery("test").inspect("k")).toEqual({ kind: "absent" });
	});

	it("does not overwrite another material's ownership when its input id is reused", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		const hold = gate();
		const busy = h.subject.runActivity(() => hold.promise);
		await h.subject.accept(input(), owner);
		await expect(h.subject.accept({ ...input(), receipt: { key: "other", attempt: "b" } }, owner)).rejects.toThrow(
			/id/,
		);
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({ kind: "pending", attempt: "a" });
		hold.resolve();
		await busy;
		await h.subject.delivery("test").retire("k", "a");
	});

	it("retries explicit withdrawal after its storage recovers without re-rendering", async () => {
		const store = new MemorySessionStore();
		const write = store.appendEvent.bind(store);
		let fail = true;
		vi.spyOn(store, "appendEvent").mockImplementation(async (name, data) => {
			if (name === "queue_restored" && fail) throw new Error("withdrawal failed");
			await write(name, data);
		});
		const h = SubjectHarness.create({ store }),
			hold = gate();
		const busy = h.subject.runActivity(() => hold.promise);
		await h.subject.accept(input(), owner);
		expect(await h.subject.delivery("test").retire("k", "a")).toMatchObject({ kind: "unavailable" });
		expect(h.subject.queuedSnapshot()).toHaveLength(1);
		fail = false;
		expect(await h.subject.delivery("test").retire("k", "a")).toEqual({ kind: "retired" });
		hold.resolve();
		await busy;
	});
	it("does not commit a retired member of a claimed batch after another member finishes rendering", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		const busy = gate(),
			entered = gate(),
			render = gate();
		const activity = h.subject.runActivity(() => busy.promise);
		await h.subject.accept(
			{
				...input("first"),
				render: async () => {
					entered.resolve();
					await render.promise;
					return "first";
				},
			},
			owner,
		);
		await h.subject.accept({ ...input("second"), receipt: { key: "second", attempt: "second" } }, owner);
		busy.resolve();
		await activity;
		const run = h.subject.resumePending();
		await entered.promise;
		expect(await h.subject.delivery("test").retire("second", "second")).toEqual({ kind: "retired" });
		render.resolve();
		await run;
		expect(await h.subject.delivery("test").inspect("second")).toEqual({ kind: "absent" });
		expect(h.store!.state.queued.size).toBe(0);
		expect(h.store!.readRecords().some((r) => r.kind === "input" && r.input.id === "second")).toBe(false);
	});

	it("withdraws a queue item if the same material was committed by a tool during render", async () => {
		const store = new MemorySessionStore();
		const h = SubjectHarness.create({ store });
		await h.subject.accept(
			{
				...input(),
				render: async () => {
					await store.appendMessage({
						role: "assistant",
						content: "",
						tool_calls: [{ id: "race", name: "probe", args: {} }],
					});
					await store.appendEvent("tool_started", { callId: "race" });
					await store.appendEvent("tool_finished", { callId: "race", status: "succeeded" });
					await store.appendMessage({
						role: "tool",
						tool_call_id: "race",
						content: "report",
						receipt: { key: "k", attempt: "tool" },
						receiptNamespace: "test",
					});
					return "duplicate";
				},
			},
			owner,
		);
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({
			kind: "committed",
			receipt: { attempt: "tool" },
		});
		expect(store.state.queued.size).toBe(0);
	});

	it("can explicitly retire after a failed input append without retrying its render or material", async () => {
		const store = new MemorySessionStore();
		vi.spyOn(store, "appendInput").mockRejectedValue(new Error("write failed"));
		const h = SubjectHarness.create({ store });
		await h.subject.accept(input(), owner);
		expect(await h.subject.delivery("test").retire("k", "a")).toEqual({ kind: "retired" });
		expect(store.state.queued.size).toBe(0);
		expect(await h.subject.delivery("test").inspect("k")).toEqual({ kind: "absent" });
	});

	it("does not grant restored receipt input the old activation's commit authority", async () => {
		const store = new MemorySessionStore();
		const queued = { ...input(), order: 1, receiptNamespace: "test" };
		await store.appendEvent("queue_enqueued", queued);
		const h = SubjectHarness.create({ store });
		h.subject.seedQueue([queued]);
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({ kind: "pending" });
		await h.subject.resumePending();
		expect(await h.subject.delivery("test").inspect("k")).toEqual({ kind: "absent" });
		expect(store.state.queued.size).toBe(0);
	});
	it("reserves one input synchronously while busy and deduplicates after commit", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		const port = h.subject.delivery("test");
		const hold = gate();
		const busy = h.subject.runActivity(() => hold.promise);
		await Promise.all(Array.from({ length: 20 }, (_, n) => h.subject.accept(input(`a${n}`), owner)));
		expect(h.subject.queuedSnapshot()).toHaveLength(1);
		expect(await port.inspect("k")).toMatchObject({
			kind: "pending",
			attempt: "a0",
			channel: "input",
			activity: "queued",
		});
		hold.resolve();
		await busy;
		await h.subject.resumePending();
		await h.subject.waitForIdle();
		expect(await port.inspect("k")).toMatchObject({
			kind: "committed",
			receipt: { key: "k", attempt: "a0", channel: "input" },
		});
		await h.subject.accept(input("later"), owner);
		expect(h.subject.queuedSnapshot()).toHaveLength(0);
	});

	it("retires an unresolved render and prevents its late result from committing over a new attempt", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		const port = h.subject.delivery("test");
		const entered = gate(),
			render = gate();
		const old = h.subject.accept(
			{
				...input(),
				render: async () => {
					entered.resolve();
					await render.promise;
					return "old";
				},
			},
			owner,
		);
		await entered.promise;
		expect(await port.retire("k", "wrong")).toMatchObject({ kind: "changed" });
		expect(await port.retire("k", "a")).toEqual({ kind: "retired" });
		await h.subject.accept(input("b"), owner);
		expect(await port.retire("k", "a")).toMatchObject({ kind: "changed", state: { attempt: "b" } });
		render.resolve();
		await old;
		await h.subject.waitForIdle();
		await h.subject.resumePending();
		await h.subject.waitForIdle();
		expect(await port.inspect("k")).toMatchObject({ kind: "committed", receipt: { attempt: "b" } });
		expect(h.store!.readRecords().some((r) => r.kind === "input" && r.input.text === "old")).toBe(false);
	});

	it("waits for an append already in progress and returns its real receipt", async () => {
		const store = new MemorySessionStore();
		const entered = gate(),
			finish = gate();
		const append = store.appendInput.bind(store);
		vi.spyOn(store, "appendInput").mockImplementation(async (item) => {
			entered.resolve();
			await finish.promise;
			await append(item);
		});
		const h = SubjectHarness.create({ store });
		const port = h.subject.delivery("test");
		const run = h.subject.accept(input(), owner);
		await entered.promise;
		let settled = false;
		const retirement = port.retire("k", "a").then((r) => {
			settled = true;
			return r;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finish.resolve();
		expect(await retirement).toMatchObject({ kind: "committed" });
		await run;
	});

	it("does not commit after the source retires during render", async () => {
		const h = SubjectHarness.create({ store: new MemorySessionStore() });
		let active = true;
		await h.subject.accept(
			{
				...input(),
				render: () => {
					active = false;
					return "late";
				},
			},
			{ namespace: "test", isActive: () => active },
		);
		expect(await h.subject.delivery("test").inspect("k")).toEqual({ kind: "absent" });
	});

	it("reports storage failure as unavailable without inventing a commit", async () => {
		const store = new MemorySessionStore();
		vi.spyOn(store, "appendInput").mockRejectedValue(new Error("disk down"));
		const h = SubjectHarness.create({ store });
		await h.subject.accept(input(), owner);
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({
			kind: "unavailable",
			reason: expect.stringContaining("disk down"),
		});
	});

	it("registers tool pending before hooks and retains it while another tool runs", async () => {
		const store = new MemorySessionStore();
		const seen = gate(),
			slow = gate();
		const scenario = new Scenario()
			.custom((b) => b.toolCall("fast", {}, "c1").toolCall("slow", {}, "c2").finish("tool_calls"))
			.reply("done");
		const h = SubjectHarness.create({
			store,
			scenario,
			runtimeHooks: {
				...NO_RUNTIME_HOOKS,
				tools: {
					...NO_RUNTIME_HOOKS.tools,
					transformResult: async (info) => {
						if (info.name === "fast") {
							expect(await h.subject.delivery("producer").inspect("k")).toMatchObject({
								kind: "pending",
								channel: "tool",
							});
							seen.resolve();
						}
						return { result: "projection", receipt: { key: "forged", attempt: "forged" } } as never;
					},
				},
			},
		});
		h.broker.register(
			mockTool("fast", () => ({ result: "original", status: "succeeded", receipt: { key: "k", attempt: "a" } })),
			{ deliveryNamespace: "producer" },
		);
		h.broker.register(
			mockTool("slow", async () => {
				await slow.promise;
				return "slow";
			}),
		);
		const run = h.run("go");
		await seen.promise;
		expect(await h.subject.delivery("producer").inspect("k")).toMatchObject({ kind: "pending" });
		slow.resolve();
		await run;
		expect(await h.subject.delivery("producer").inspect("k")).toMatchObject({
			kind: "committed",
			receipt: { channel: "tool", attempt: "a" },
		});
		expect(await h.subject.delivery("producer").inspect("forged")).toEqual({ kind: "absent" });
		expect(JSON.stringify(scenario.calls)).not.toContain("receiptNamespace");
		expect(JSON.stringify(scenario.calls)).not.toContain('"receipt":');
	});

	it("retiring a tool attempt does not suppress its late canonical result", async () => {
		const hold = gate(),
			entered = gate();
		const h = SubjectHarness.create({
			store: new MemorySessionStore(),
			scenario: new Scenario().callTool("probe", {}).reply("done"),
			runtimeHooks: {
				...NO_RUNTIME_HOOKS,
				tools: {
					...NO_RUNTIME_HOOKS.tools,
					transformResult: async () => {
						entered.resolve();
						await hold.promise;
						return {};
					},
				},
			},
		});
		h.broker.register(
			mockTool("probe", () => ({ result: "ok", status: "succeeded", receipt: { key: "k", attempt: "a" } })),
			{ deliveryNamespace: "test" },
		);
		const run = h.run("go");
		await entered.promise;
		expect(await h.subject.delivery("test").retire("k", "a")).toEqual({ kind: "retired" });
		hold.resolve();
		await run;
		expect(await h.subject.delivery("test").inspect("k")).toMatchObject({ kind: "committed" });
	});
});
