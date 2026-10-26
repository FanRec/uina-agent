import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { MinecraftRuntime } from "../../.uina/worlds/minecraft/runtime/index.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { readProgram } from "../../.uina/worlds/minecraft/library/program-source.js";
import type { PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import type { NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(callables: NativeCallable<JsonValue, JsonValue>[] = [], playerPort?: PlayerPort) {
	const root = await mkdtemp(join(tmpdir(), "uina-decision-runtime-"));
	const program = await createProgram({
		dataRoot: root,
		loadProgram: (name) => readProgram(join(root, "programs"), name),
	});
	cleanups.push(() => program.close());
	const options = {
		dbPath: join(root, "runtime.db"),
		storageId: "decision",
		namespace: "first",
		worldOwner: "owner",
		ownerLifetimeMs: 60000,
		world: {} as WorldPort,
		playerPort:
			playerPort ??
			({
				acquire: async () => {
					throw Error("unexpected body");
				},
				chat: async () => {
					throw Error("unused");
				},
			} satisfies PlayerPort),
		callables,
		program,
	};
	let runtime = (await MinecraftRuntime.open(options)).runtime;
	let reopened = 0;
	cleanups.push(() => runtime.close());
	const origin = { worldOwner: "owner", activation: "test", caller: "test-caller" };
	async function enable() {
		let state = await runtime.attach(origin);
		for (const gate of state.gates)
			state = (
				await runtime.setOwnerGate({
					requestId: `enable:${gate}`,
					attachment: state.attachment,
					gate,
					closed: false,
					expectedRevision: state.gateRevision,
				})
			).state;
	}
	await enable();
	return {
		root,
		options,
		get runtime() {
			return runtime;
		},
		origin,
		async reopen() {
			await runtime.close();
			runtime = (
				await MinecraftRuntime.open({ ...options, namespace: `reopened-${++reopened}`, oldControlRetired: true })
			).runtime;
			await enable();
		},
	};
}
function native(
	ref: `${string}@${string}`,
	invoke: NativeCallable<JsonValue, JsonValue>["invoke"],
): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: {
			ref,
			summary: ref,
			input: {},
			output: {},
			access: "act",
			completion: { scope: "execution", description: ref },
			implementation: "native",
			errors: [],
			requires: [],
			examples: [],
		},
		invoke,
	};
}
test("replace_pending atomically replaces only a never-started same-caller run", async () => {
	const calls: string[] = [];
	const f = await setup([
		native("work@1", async (_ctx, input) => {
			calls.push(String(input));
			return input;
		}),
	]);
	const entry = (input: string) => ({ kind: "call" as const, selector: "work@1", input });
	const [first, second] = await Promise.all([
		f.runtime.submit(f.origin, { requestId: "queued", entry: entry("old"), schedule: { kind: "enqueue" } }),
		f.runtime.submit(f.origin, {
			requestId: "replacement",
			entry: entry("new"),
			schedule: { kind: "replace_pending" },
		}),
	]);
	expect(second.kind).toBe("accepted");
	if (first.kind !== "accepted" || second.kind !== "accepted") return;
	expect((await f.runtime.wait(first.snapshot.run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "not_started",
	});
	await f.runtime.wait(second.snapshot.run, { timeoutMs: 4000 });
	expect(calls).toEqual(["new"]);
	const bad = await f.runtime.submit(f.origin, {
		requestId: "replace-started",
		entry: entry("bad"),
		schedule: { kind: "replace_pending", targets: [second.snapshot.run] },
	});
	expect(bad).toMatchObject({ kind: "not_accepted" });
});
test("preempt_current rejects mismatched control, then closes old body before granting replacement", async () => {
	const events: string[] = [];
	let enter!: () => void;
	const entered = new Promise<void>((r) => (enter = r));
	const port = {
		acquire: async (owner: { kind: string; run?: string }) => {
			events.push(`grant:${owner.run}`);
			return {
				runScoped: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
				close: async () => {
					events.push("closed");
				},
			} as unknown as import("../../.uina/worlds/minecraft/contracts/body.js").BodySession;
		},
		chat: async () => {
			throw Error("unused");
		},
	} as PlayerPort;
	const f = await setup(
		[
			native("hold@1", (ctx) =>
				ctx.withBody(async () => {
					enter();
					await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
					return null;
				}),
			),
			native("next@1", (ctx) =>
				ctx.withBody(async () => {
					events.push("replacement");
					return null;
				}),
			),
		],
		port,
	);
	const first = await f.runtime.submit(f.origin, {
		requestId: "holder",
		entry: { kind: "call", selector: "hold@1", input: {} },
		schedule: { kind: "enqueue" },
	});
	if (first.kind !== "accepted") throw Error("not accepted");
	await entered;
	expect(
		await f.runtime.submit(f.origin, {
			requestId: "wrong",
			entry: { kind: "call", selector: "next@1", input: {} },
			schedule: { kind: "preempt_current", expectedRun: "wrong" },
		}),
	).toMatchObject({ kind: "not_accepted" });
	expect(events).toHaveLength(1);
	const next = await f.runtime.submit(f.origin, {
		requestId: "preempt",
		entry: { kind: "call", selector: "next@1", input: {} },
		schedule: { kind: "preempt_current", expectedRun: first.snapshot.run },
	});
	expect(next.kind).toBe("accepted");
	if (next.kind !== "accepted") return;
	expect((await f.runtime.wait(next.snapshot.run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "succeeded",
	});
	expect(events.indexOf("closed")).toBeLessThan(events.indexOf(`grant:${next.snapshot.run}`));
	expect((await f.runtime.wait(first.snapshot.run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "cancelled",
	});
});
async function decide(f: Awaited<ReturnType<typeof setup>>, id = "initial") {
	const accepted = await f.runtime.submit(f.origin, {
		requestId: id,
		schedule: { kind: "enqueue" },
		entry: {
			kind: "program",
			source: { code: "async function main(mc){mc.progress({done:2});mc.decide('need material',{done:2});}" },
			input: {},
		},
	});
	expect(accepted.kind).toBe("accepted");
	if (accepted.kind !== "accepted") throw Error("not accepted");
	const result = await f.runtime.wait(accepted.snapshot.run, { timeoutMs: 4000 });
	expect(result.snapshot, JSON.stringify(result)).toMatchObject({ phase: "awaiting_decision" });
	if (result.snapshot.phase !== "awaiting_decision") throw Error(JSON.stringify(result));
	return result.snapshot;
}
test("decision survives reopen, explicit continuation makes a new segment and preserves old report", async () => {
	const f = await setup(),
		before = await decide(f);
	const original = await f.runtime.readRecord(before.completionRef);
	await f.reopen();
	expect(await f.runtime.read(before.run)).toMatchObject({ phase: "awaiting_decision", decision: before.decision });
	const request = {
		run: before.run,
		decision: before.decision,
		requestId: "resume",
		entry: {
			kind: "program" as const,
			source: { code: "async function main(mc){return {checkpoint:mc.checkpoint};}" },
			input: {},
		},
	};
	const accepted = await f.runtime.continue(f.origin, request);
	expect(accepted.kind).toBe("accepted");
	if (accepted.kind !== "accepted") return;
	expect(accepted.segment).not.toBe(before.segment);
	expect(accepted.snapshot.rootRequestId).toBe("initial");
	expect((await f.runtime.wait(before.run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "succeeded",
	});
	expect(await f.runtime.readRecord(before.run)).toMatchObject({
		kind: "inline",
		record: { value: { value: { checkpoint: { done: 2 } } } },
	});
	expect(await f.runtime.readRecord(before.completionRef)).toEqual(original);
	expect(await f.runtime.lookup("initial")).toMatchObject({ kind: "found", completionRef: before.completionRef });
	expect(await f.runtime.readDelivery(before.completionRef)).toMatchObject({ eligible: false });
	expect(await f.runtime.lookup("resume")).toMatchObject({
		kind: "found",
		operation: "continue",
		segment: accepted.segment,
	});
	expect(await f.runtime.continue(f.origin, request)).toMatchObject({ kind: "accepted", segment: accepted.segment });
	expect(await f.runtime.continue(f.origin, { ...request, requestId: "stale" })).toMatchObject({
		kind: "not_accepted",
		code: "DECISION_STALE",
	});
});
test("concurrent continuations consume a decision once, request stop before admission does not consume", async () => {
	const f = await setup(),
		before = await decide(f);
	const request = {
		run: before.run,
		decision: before.decision,
		requestId: "stopped",
		entry: { kind: "program" as const, source: { code: "async function main(){return 1;}" }, input: {} },
	};
	await f.runtime.stop({ requestId: "stop:request", target: { request: "stopped" } });
	expect(await f.runtime.continue(f.origin, request)).toMatchObject({
		kind: "not_accepted",
		code: "REQUEST_CANCELLED",
	});
	expect(await f.runtime.read(before.run)).toMatchObject({ phase: "awaiting_decision", decision: before.decision });
	const results = await Promise.all(
		["one", "two"].map((requestId) => f.runtime.continue(f.origin, { ...request, requestId })),
	);
	expect(results.filter((r) => r.kind === "accepted")).toHaveLength(1);
	expect(results.find((r) => r.kind === "not_accepted")).toMatchObject({ code: "DECISION_STALE" });
});
test("stopping an awaiting decision creates terminal cancellation and invalidates delivery", async () => {
	const f = await setup(),
		before = await decide(f);
	await f.runtime.stop({ requestId: "stop", target: { run: before.run } });
	expect((await f.runtime.wait(before.run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "cancelled",
	});
	expect(await f.runtime.readDelivery(before.completionRef)).toMatchObject({ eligible: false });
});

test("rolled-back preemption leaves old body live and storage usable", async () => {
	let enter!: () => void;
	const entered = new Promise<void>((r) => (enter = r));
	let closed = 0;
	const port = {
		acquire: async () =>
			({
				runScoped: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
				close: async () => {
					closed++;
				},
			}) as unknown as import("../../.uina/worlds/minecraft/contracts/body.js").BodySession,
		chat: async () => {
			throw Error("unused");
		},
	} satisfies PlayerPort;
	const f = await setup(
		[
			native("hold@1", (ctx) =>
				ctx.withBody(async () => {
					enter();
					await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
					return null;
				}),
			),
			native("next@1", async () => 1),
		],
		port,
	);
	const first = await f.runtime.submit(f.origin, {
		requestId: "holder",
		entry: { kind: "call", selector: "hold@1", input: {} },
		schedule: { kind: "enqueue" },
	});
	if (first.kind !== "accepted") throw Error("not accepted");
	await entered;
	const db = new DatabaseSync(join(f.root, "runtime.db"));
	try {
		db.exec(
			"CREATE TRIGGER reject_preemption BEFORE INSERT ON submissions WHEN NEW.request_id='rollback' BEGIN SELECT RAISE(ABORT,'rollback preemption'); END",
		);
		const result = await f.runtime.submit(f.origin, {
			requestId: "rollback",
			entry: { kind: "call", selector: "next@1", input: {} },
			schedule: { kind: "preempt_current", expectedRun: first.snapshot.run },
		});
		expect(result).toMatchObject({ kind: "not_accepted" });
		expect(closed).toBe(0);
		expect((await f.runtime.read(first.snapshot.run)).control).toBe("active");
		f.runtime.assertActionAllowed();
		expect(f.runtime.availability()).toBe("ready");
		expect(db.prepare("SELECT COUNT(*) AS n FROM stop_intents").get()!.n).toBe(0);
	} finally {
		db.close();
	}
	await f.runtime.stop({ requestId: "cleanup", target: { run: first.snapshot.run } });
});

test("a continued Run is never a never-started replacement target", async () => {
	const f = await setup(),
		before = await decide(f);
	const [resumed, replaced] = await Promise.all([
		f.runtime.continue(f.origin, {
			run: before.run,
			decision: before.decision,
			requestId: "continue-before-replace",
			entry: { kind: "program", source: { code: "async function main(){return 7;}" }, input: {} },
		}),
		f.runtime.submit(f.origin, {
			requestId: "replace-continued",
			entry: { kind: "program", source: { code: "async function main(){return 8;}" }, input: {} },
			schedule: { kind: "replace_pending", targets: [before.run] },
		}),
	]);
	expect(resumed.kind).toBe("accepted");
	expect(replaced).toMatchObject({ kind: "not_accepted", code: "REPLACE_TARGET_INVALID" });
});
test("request stop resolves recovered awaiting Run and durably prevents fresh continuation", async () => {
	const f = await setup(),
		before = await decide(f);
	await f.reopen();
	const stopped = await f.runtime.stop({ requestId: "stop-recovered-request", target: { request: "initial" } });
	expect(stopped.snapshot).toMatchObject({ run: before.run, phase: "finished", outcome: "cancelled" });
	expect(
		await f.runtime.continue(f.origin, {
			run: before.run,
			decision: before.decision,
			requestId: "after-stop",
			entry: { kind: "program", source: { code: "async function main(){return 1;}" }, input: {} },
		}),
	).toMatchObject({ kind: "not_accepted", code: "DECISION_STALE" });
	await f.reopen();
	expect(await f.runtime.read(before.run)).toMatchObject({ phase: "finished", outcome: "cancelled" });
});
test("stop after recovered continuation commit but before acknowledgement prevents execution", async () => {
	const f = await setup(),
		before = await decide(f);
	await f.reopen();
	const originalPost = Worker.prototype.postMessage,
		originalEmit = Worker.prototype.emit;
	let target: Worker | undefined, id: number | undefined, ready!: () => void, release!: () => void;
	const committed = new Promise<void>((r) => (ready = r));
	const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, value, transfer) {
		if (value.type === "admit" && value.command.requestId === "ack-race") {
			target = this;
			id = value.id;
		}
		return originalPost.call(this, value, transfer);
	});
	const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (this: Worker, event, ...args) {
		const message = args[0] as { type?: string; id?: number };
		if (this === target && event === "message" && message?.type === "query_reply" && message.id === id) {
			release = () => originalEmit.call(this, event, ...args);
			ready();
			return true;
		}
		return originalEmit.call(this, event, ...args);
	});
	try {
		const pending = f.runtime.continue(f.origin, {
			run: before.run,
			decision: before.decision,
			requestId: "ack-race",
			entry: { kind: "program", source: { code: "async function main(){return 'must not run';}" }, input: {} },
		});
		await committed;
		await f.runtime.stop({ requestId: "stop-after-commit", target: { run: before.run } });
		release();
		const accepted = await pending;
		expect(accepted.kind).toBe("accepted");
		expect((await f.runtime.wait(before.run, { timeoutMs: 4000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "cancelled",
		});
		const record = await f.runtime.readRecord(before.run);
		expect(record).not.toMatchObject({ record: { value: { value: "must not run" } } });
	} finally {
		post.mockRestore();
		emit.mockRestore();
		release?.();
	}
});
test.each([
	{ operation: "submit", stop: false },
	{ operation: "submit", stop: true },
	{ operation: "continue", stop: false },
	{ operation: "continue", stop: true },
] as const)(
	"$operation with lost commit ACK (request stopped=$stop) is confirmed only after recovery",
	async ({ operation, stop }) => {
		let invoked = 0;
		const f = await setup([native("probe@1", async () => ++invoked)]),
			before = await decide(f);
		const closeFaulted = cleanups.pop()!;
		const originalPost = Worker.prototype.postMessage,
			originalEmit = Worker.prototype.emit;
		let target: Worker | undefined, id: number | undefined, ready!: () => void, loseAck!: () => void;
		const committed = new Promise<void>((resolve) => (ready = resolve));
		const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, value, transfer) {
			if (value.type === "admit" && value.command.requestId === "lost-ack") {
				target = this;
				id = value.id;
			}
			return originalPost.call(this, value, transfer);
		});
		const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (this: Worker, event, ...args) {
			const message = args[0] as { type?: string; id?: number };
			if (this === target && event === "message" && message?.type === "query_reply" && message.id === id) {
				loseAck = () => {
					void this.terminate();
					originalEmit.call(
						this,
						"error",
						Object.assign(new Error("admission acknowledgement lost after commit"), {
							code: "ERR_WORKER_OUT_OF_MEMORY",
						}),
					);
				};
				ready();
				return true;
			}
			return originalEmit.call(this, event, ...args);
		});
		try {
			const entry = { kind: "call" as const, selector: "probe@1", input: {} };
			const pending =
				operation === "continue"
					? f.runtime.continue(f.origin, { run: before.run, decision: before.decision, requestId: "lost-ack", entry })
					: f.runtime.submit(f.origin, { requestId: "lost-ack", entry, schedule: { kind: "enqueue" } });
			await committed;
			if (stop) await f.runtime.stop({ requestId: "stop-committed-request", target: { request: "lost-ack" } });
			loseAck();
			expect(await pending).toMatchObject({ kind: "unknown", requestId: "lost-ack" });
			expect(f.runtime.lookup("lost-ack")).toMatchObject({ kind: "unavailable" });
			expect(invoked).toBe(0);
		} finally {
			post.mockRestore();
			emit.mockRestore();
			loseAck?.();
			await expect(closeFaulted()).rejects.toThrow(/recorder|storage/i);
		}
		const recovered = (await MinecraftRuntime.open({ ...f.options, namespace: "confirmed", oldControlRetired: true }))
			.runtime;
		cleanups.push(() => recovered.close());
		expect(recovered.lookup("lost-ack")).toMatchObject({
			kind: "found",
			operation,
			snapshot: { phase: "finished", ...(stop && operation === "continue" ? { outcome: "cancelled" } : {}) },
		});
		expect(invoked).toBe(0);
	},
);

test.each(["native", "program", "native-child"] as const)(
	"preempted %s replacement gets the first body opportunity ahead of an existing waiter",
	async (kind) => {
		let enter!: () => void;
		const entered = new Promise<void>((r) => (enter = r));
		const order: string[] = [];
		const port = {
			acquire: async () =>
				({
					runScoped: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
					close: async () => {},
				}) as unknown as import("../../.uina/worlds/minecraft/contracts/body.js").BodySession,
			chat: async () => {
				throw Error("unused");
			},
		} satisfies PlayerPort;
		const f = await setup(
			[
				native("hold@1", (ctx) =>
					ctx.withBody(async () => {
						enter();
						await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
						return null;
					}),
				),
				native("wrapper@1", (ctx, input) => ctx.call("body@1", input)),
				native("body@1", (ctx, input) =>
					ctx.withBody(async () => {
						order.push(String(input));
						return null;
					}),
				),
			],
			port,
		);
		const holder = await f.runtime.submit(f.origin, {
			requestId: "A",
			entry: { kind: "call", selector: "hold@1", input: {} },
			schedule: { kind: "enqueue" },
		});
		if (holder.kind !== "accepted") throw Error("not accepted");
		await entered;
		const waiting = await f.runtime.submit(f.origin, {
			requestId: "B",
			entry: { kind: "call", selector: "body@1", input: "B" },
			schedule: { kind: "enqueue" },
		});
		if (waiting.kind !== "accepted") throw Error("not accepted");
		const replacement = await f.runtime.submit(f.origin, {
			requestId: "C",
			entry:
				kind === "program"
					? { kind: "program", source: { code: "async function main(mc){return mc.call('body@1','C');}" }, input: {} }
					: { kind: "call", selector: kind === "native-child" ? "wrapper@1" : "body@1", input: "C" },
			schedule: { kind: "preempt_current", expectedRun: holder.snapshot.run },
		});
		if (replacement.kind !== "accepted") throw Error(JSON.stringify(replacement));
		await f.runtime.wait(replacement.snapshot.run, { timeoutMs: 4000 });
		await f.runtime.wait(waiting.snapshot.run, { timeoutMs: 4000 });
		expect(order).toEqual(["C", "B"]);
	},
);

test("navigation and body acquisitions share the same FIFO and preemption barrier", async () => {
	let enter!: () => void;
	const entered = new Promise<void>((r) => (enter = r)),
		order: string[] = [];
	let f!: Awaited<ReturnType<typeof setup>>;
	const port = {
		acquire: async () =>
			({
				runScoped: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
				close: async () => {},
			}) as unknown as import("../../.uina/worlds/minecraft/contracts/body.js").BodySession,
		chat: async () => {
			throw Error("unused");
		},
	} satisfies PlayerPort;
	f = await setup(
		[
			native("hold-nav@1", (ctx) =>
				f.runtime.navigate({ kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId }, async () => {
					enter();
					await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
					return null;
				}),
			),
			native("body@1", (ctx) =>
				ctx.withBody(async () => {
					order.push("B");
					return null;
				}),
			),
			native("next-nav@1", (ctx) =>
				f.runtime.navigate({ kind: "run", run: ctx.run, segment: ctx.segment, callId: ctx.callId }, async () => {
					order.push("C");
					return null;
				}),
			),
		],
		port,
	);
	const first = await f.runtime.submit(f.origin, {
		requestId: "nav-A",
		entry: { kind: "call", selector: "hold-nav@1", input: {} },
		schedule: { kind: "enqueue" },
	});
	if (first.kind !== "accepted") throw Error("not accepted");
	await entered;
	const second = await f.runtime.submit(f.origin, {
		requestId: "body-B",
		entry: { kind: "call", selector: "body@1", input: {} },
		schedule: { kind: "enqueue" },
	});
	if (second.kind !== "accepted") throw Error("not accepted");
	const third = await f.runtime.submit(f.origin, {
		requestId: "nav-C",
		entry: { kind: "call", selector: "next-nav@1", input: {} },
		schedule: { kind: "preempt_current", expectedRun: first.snapshot.run },
	});
	if (third.kind !== "accepted") throw Error(JSON.stringify(third));
	await f.runtime.wait(third.snapshot.run, { timeoutMs: 4000 });
	await f.runtime.wait(second.snapshot.run, { timeoutMs: 4000 });
	expect(order).toEqual(["C", "B"]);
});
