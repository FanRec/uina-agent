/**
 * 持久挂起与唤醒（设计包 §5.9 / C14 / C21 / C23 的确定性部分）。
 *
 * 钉住四件事：
 * 1. 根原生能力抛挂起后，Run 停在 awaiting_decision 但**不是**等 Host 决策；
 * 2. 跨重启不丢：重启后仍是挂起态，扫描到点按原入口续段，检查点原样交回；
 * 3. 没有合法 Owner 绑定就不唤醒；stop 优先于唤醒；多次扫描只认领一次；
 * 4. 能力永远观察不到条件时，Runtime 自己的次数预算收口成 unknown，不是无限续段。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import type { PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { createSuspendError } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import type { RunSummary } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { MinecraftRuntime } from "../../.uina/worlds/minecraft/runtime/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

const playerPort = {
	acquire: async () => {
		throw Error("unexpected body");
	},
	chat: async () => {
		throw Error("unused");
	},
} satisfies PlayerPort;

async function setup(callables: NativeCallable<JsonValue, JsonValue>[]) {
	const root = await mkdtemp(join(tmpdir(), "uina-durable-wait-"));
	const options = {
		dbPath: join(root, "runtime.db"),
		storageId: "durable",
		namespace: "first",
		worldOwner: "owner",
		ownerLifetimeMs: 60000,
		world: {} as WorldPort,
		playerPort,
		callables,
		// 段记录里固化的环境：换环境之后"继承"必须被拒，才谈得上验拒绝路径。
		environment: { serverVersion: "1.21.11", protocol: 774 },
		// 定时器交给测试显式驱动，避免"等 1 秒"变成隐式时序依赖。
		durableWakeIntervalMs: 0,
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
		return state;
	}
	await enable();
	return {
		root,
		options,
		get runtime() {
			return runtime;
		},
		origin,
		enable,
		async reopen(overrides: Partial<typeof options> = {}) {
			await runtime.close();
			runtime = (
				await MinecraftRuntime.open({
					...options,
					...overrides,
					namespace: `reopened-${++reopened}`,
					oldControlRetired: true,
				})
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

/** 先交一次挂起、再在重入时返回检查点；`seen` 记录每轮看到的检查点。 */
function suspending(seen: (JsonValue | null)[], recheckAfterMs = 0, deadlineAfterMs = 60_000) {
	return native("wait@1", async (ctx) => {
		seen.push(ctx.checkpoint);
		if (ctx.checkpoint == null)
			throw createSuspendError({
				reason: "waiting for the furnace to finish",
				checkpoint: { step: "loaded", furnace: [1, 64, 2] },
				recheckAfterMs,
				deadlineAfterMs,
			});
		return { resumed: ctx.checkpoint };
	});
}

async function submitWait(f: Awaited<ReturnType<typeof setup>>, requestId = "waiter") {
	const accepted = await f.runtime.submit(f.origin, {
		requestId,
		entry: { kind: "call", selector: "wait@1", input: { furnace: [1, 64, 2] } },
		schedule: { kind: "enqueue" },
	});
	if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
	const parked = (await f.runtime.wait(accepted.snapshot.run, { timeoutMs: 4000 })).snapshot;
	return { run: accepted.snapshot.run as string, parked };
}

test("a root native suspend parks the Run and a due recheck resumes it with its checkpoint", async () => {
	const seen: (JsonValue | null)[] = [];
	const f = await setup([suspending(seen)]);
	const { run, parked } = await submitWait(f);
	expect(parked).toMatchObject({ phase: "awaiting_decision" });
	expect(seen).toEqual([null]);
	// 落库的形状：phase 是 awaiting_decision，但 decision 里带着 wait（不是等 Host 决策）。
	const record = await f.runtime.readRecord(parked.phase === "awaiting_decision" ? parked.completionRef : "");
	expect(JSON.stringify(record)).toContain("earliestCheckAt");
	expect(await f.runtime.recheckDurableWaits()).toBe(1);
	expect((await f.runtime.wait(run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "succeeded",
	});
	expect(seen).toEqual([null, { step: "loaded", furnace: [1, 64, 2] }]);
	expect(JSON.stringify(await f.runtime.readRecord(run))).toContain('"resumed"');
	// 已经续过段，再扫不会重复唤醒。
	expect(await f.runtime.recheckDurableWaits()).toBe(0);
});

test("a durable wait survives reopen and resumes through the recovered row", async () => {
	const seen: (JsonValue | null)[] = [];
	const f = await setup([suspending(seen)]);
	const { run, parked } = await submitWait(f);
	expect(parked.phase).toBe("awaiting_decision");
	await f.reopen();
	const afterReopen: RunSummary = await f.runtime.read(run);
	expect(afterReopen).toMatchObject({ phase: "awaiting_decision" });
	expect(await f.runtime.recheckDurableWaits()).toBe(1);
	expect((await f.runtime.wait(run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "succeeded",
	});
	expect(seen).toEqual([null, { step: "loaded", furnace: [1, 64, 2] }]);
});

test("a parked wait is not resumed while the owner has no open binding, and resumes once it does", async () => {
	const seen: (JsonValue | null)[] = [];
	const f = await setup([suspending(seen)]);
	const { run, parked } = await submitWait(f);
	expect(parked.phase).toBe("awaiting_decision");
	const owner = await f.enable();
	await f.runtime.setOwnerGate({
		requestId: "close-disabled",
		attachment: owner.attachment,
		gate: "disabled",
		closed: true,
	});
	expect(await f.runtime.recheckDurableWaits()).toBe(0);
	expect((await f.runtime.read(run)).phase).toBe("awaiting_decision");
	expect(seen).toHaveLength(1);
	await f.enable();
	expect(await f.runtime.recheckDurableWaits()).toBe(1);
	expect((await f.runtime.wait(run, { timeoutMs: 4000 })).snapshot).toMatchObject({
		phase: "finished",
		outcome: "succeeded",
	});
});

test("stop wins over a due wake: the parked Run is cancelled and never re-enters", async () => {
	const seen: (JsonValue | null)[] = [];
	const f = await setup([suspending(seen)]);
	const { run, parked } = await submitWait(f);
	expect(parked.phase).toBe("awaiting_decision");
	await f.runtime.stop({ requestId: "stop-parked", target: { run } });
	expect(await f.runtime.read(run)).toMatchObject({ phase: "finished", outcome: "cancelled" });
	expect(await f.runtime.recheckDurableWaits()).toBe(0);
	expect(seen).toHaveLength(1);
});

test("concurrent rechecks claim the same wait exactly once", async () => {
	const seen: (JsonValue | null)[] = [];
	const f = await setup([suspending(seen)]);
	const { run, parked } = await submitWait(f);
	expect(parked.phase).toBe("awaiting_decision");
	const claimed = await Promise.all([f.runtime.recheckDurableWaits(), f.runtime.recheckDurableWaits()]);
	expect(claimed.reduce((a, b) => a + b, 0)).toBe(1);
	expect((await f.runtime.wait(run, { timeoutMs: 4000 })).snapshot).toMatchObject({ phase: "finished" });
	expect(seen).toEqual([null, { step: "loaded", furnace: [1, 64, 2] }]);
});

test("a nested suspend is refused instead of resuming the wrong call stack", async () => {
	const seen: (JsonValue | null)[] = [];
	const f = await setup([suspending(seen), native("outer@1", (ctx, input) => ctx.call("wait@1", input))]);
	const accepted = await f.runtime.submit(f.origin, {
		requestId: "nested",
		entry: { kind: "call", selector: "outer@1", input: {} },
		schedule: { kind: "enqueue" },
	});
	if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
	const settled = (await f.runtime.wait(accepted.snapshot.run, { timeoutMs: 4000 })).snapshot;
	expect(settled).toMatchObject({ phase: "finished", outcome: "failed", error: { code: "SUSPEND_NOT_ROOT" } });
	expect(await f.runtime.recheckDurableWaits()).toBe(0);
});

test("a capability that never observes progress is bounded by the wake budget, not resumed forever", async () => {
	let attempts = 0;
	const f = await setup([
		native("wait@1", async () => {
			attempts++;
			throw createSuspendError({
				reason: "the furnace block never loads",
				checkpoint: { step: "loaded" },
				recheckAfterMs: 0,
				deadlineAfterMs: 60_000,
			});
		}),
	]);
	const { run, parked } = await submitWait(f);
	expect(parked.phase).toBe("awaiting_decision");
	let last = parked;
	for (let i = 0; i < 40 && last.phase === "awaiting_decision"; i++) {
		await f.runtime.recheckDurableWaits();
		last = (await f.runtime.wait(run, { timeoutMs: 4000 })).snapshot;
	}
	expect(last).toMatchObject({
		phase: "finished",
		outcome: "unknown",
		error: { code: "WAIT_BUDGET_EXHAUSTED" },
	});
	// 16 次挂起（attempts 1..16）+ 第 17 次被拒的那一轮：预算到顶后不再排唤醒。
	expect(attempts).toBe(17);
});

test("non-parked unfinished rows are still settled conservatively after restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-durable-wait-rows-"));
	const options = {
		dbPath: join(root, "runtime.db"),
		storageId: "durable-rows",
		namespace: "first",
		worldOwner: "owner",
		ownerLifetimeMs: 60000,
		world: {} as WorldPort,
		playerPort,
		callables: [suspending([])],
		durableWakeIntervalMs: 0,
	};
	const first = await MinecraftRuntime.open(options);
	await first.runtime.close();
	const db = new DatabaseSync(options.dbPath);
	try {
		const insert = db.prepare(
			`INSERT INTO runs (run, owner, request_id, revision, decision, segment_request_id, started, segment, phase,
				waiting, outcome, value, error, completion_ref, control, unknown_effects, record, progress,
				completion_scope, completion_description)
			 VALUES (?, 'owner', ?, 1, NULL, ?, 1, ?, ?, ?, NULL, NULL, NULL, NULL, 'none', '[]', ?, '{}',
				'execution', 'x')`,
		);
		insert.run("run:inflight", "inflight", "inflight", "segment:inflight", "running", null, "rec:1");
		insert.run(
			"run:waiting",
			"waiting",
			"waiting",
			"segment:waiting",
			"waiting",
			'{"kind":"idle","sinceMs":0}',
			"rec:2",
		);
	} finally {
		db.close();
	}
	const reopened = (await MinecraftRuntime.open({ ...options, namespace: "second", oldControlRetired: true })).runtime;
	cleanups.push(() => reopened.close());
	for (const run of ["run:inflight", "run:waiting"])
		expect(await reopened.read(run)).toMatchObject({
			phase: "finished",
			outcome: "unknown",
			error: { code: "runtime_restart" },
		});
});

/** 从任意记录里找出持久等待的形状（决策报告里嵌在 `request.wait`）。 */
function findWait(
	node: unknown,
): { earliestCheckAt: string; deadlineAt: string; lastProgressAt: string; attempts: number } | null {
	if (node == null || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;
	if (typeof record.earliestCheckAt === "string" && typeof record.deadlineAt === "string")
		return record as unknown as {
			earliestCheckAt: string;
			deadlineAt: string;
			lastProgressAt: string;
			attempts: number;
		};
	for (const value of Object.values(record)) {
		const hit = findWait(value);
		if (hit != null) return hit;
	}
	return null;
}

async function waitOf(f: Awaited<ReturnType<typeof setup>>, completionRef: string) {
	const record = await f.runtime.readRecord(completionRef);
	const wait = findWait(record);
	if (wait == null) throw Error(JSON.stringify(record));
	return wait;
}

test("the recheck time never runs past the declared silent budget", async () => {
	const f = await setup([
		native("wait@1", async () => {
			throw createSuspendError({
				reason: "the furnace needs a long time",
				checkpoint: { step: "loaded" },
				recheckAfterMs: 3_600_000,
				deadlineAfterMs: 1_000,
			});
		}),
	]);
	const { parked } = await submitWait(f);
	if (parked.phase !== "awaiting_decision") throw Error(JSON.stringify(parked));
	const wait = await waitOf(f, parked.completionRef);
	// 能力想等一小时，预算只剩一秒：复查时刻必须被夹到预算之内。
	expect(wait.earliestCheckAt <= wait.deadlineAt).toBe(true);
	expect(Date.parse(wait.earliestCheckAt) - Date.now()).toBeLessThan(5_000);
});

test("a recheck without progress keeps the silent budget anchored, progress resets it", async () => {
	const f = await setup([
		native("wait@1", async (ctx) => {
			const step = (ctx.checkpoint as { step?: number } | null)?.step ?? 0;
			throw createSuspendError({
				reason: `batch ${step}`,
				checkpoint: { step: step + 1 },
				recheckAfterMs: 0,
				deadlineAfterMs: 60_000,
				// 前两轮都不算推进，第三轮起才算（step 是上一版检查点里的值）。
				progressed: step >= 2,
			});
		}),
	]);
	const first = await submitWait(f);
	if (first.parked.phase !== "awaiting_decision") throw Error("not parked");
	const firstWait = await waitOf(f, first.parked.completionRef);
	await f.runtime.recheckDurableWaits();
	const second = (await f.runtime.wait(first.run, { timeoutMs: 4000 })).snapshot;
	if (second.phase !== "awaiting_decision") throw Error(JSON.stringify(second));
	const secondWait = await waitOf(f, second.completionRef);
	// 第二轮没推进：静默预算的起点不动，截止时刻也不动。
	expect(secondWait.lastProgressAt).toBe(firstWait.lastProgressAt);
	expect(secondWait.deadlineAt).toBe(firstWait.deadlineAt);
	expect(secondWait.attempts).toBe(2);
	await f.runtime.recheckDurableWaits();
	const third = (await f.runtime.wait(first.run, { timeoutMs: 4000 })).snapshot;
	if (third.phase !== "awaiting_decision") throw Error(JSON.stringify(third));
	const thirdWait = await waitOf(f, third.completionRef);
	// 第三轮声明推进了：起点前移，预算重新起算。
	expect(thirdWait.lastProgressAt > firstWait.lastProgressAt).toBe(true);
	expect(thirdWait.deadlineAt > firstWait.deadlineAt).toBe(true);
});

test("a wake refused by admission is reported once and not retried every scan", async () => {
	const logged: string[] = [];
	const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	});
	try {
		const f = await setup([
			native("wait@1", async () => {
				throw createSuspendError({
					reason: "waiting",
					checkpoint: { step: 1 },
					recheckAfterMs: 0,
					deadlineAfterMs: 60_000,
				});
			}),
		]);
		const { run, parked } = await submitWait(f);
		if (parked.phase !== "awaiting_decision") throw Error("not parked");
		// 换一个运行环境再打开：继承的环境已经不在了，续段会被 WRONG_STATE 拒掉。
		await f.reopen({ environment: { serverVersion: "1.20.1", protocol: 763 } });
		expect(await f.runtime.recheckDurableWaits()).toBe(0);
		expect(logged.filter((line) => line.includes("durable wake")).length).toBe(1);
		// 同一版挂起不再重试：不再调受理、也不再刷日志。
		expect(await f.runtime.recheckDurableWaits()).toBe(0);
		expect(await f.runtime.recheckDurableWaits()).toBe(0);
		expect(logged.filter((line) => line.includes("durable wake")).length).toBe(1);
		expect((await f.runtime.read(run)).phase).toBe("awaiting_decision");
	} finally {
		spy.mockRestore();
	}
});
