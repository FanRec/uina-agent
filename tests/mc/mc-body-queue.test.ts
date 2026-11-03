import { describe, expect, test } from "vitest";
import type { BodySession, ControlOwner, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { CallContext, NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { CallFailure, ExactRef, JsonValue, Ref } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { BodyLeaseQueue } from "../../.uina/worlds/minecraft/runtime/body-queue.js";
import { RuntimeEngine } from "../../.uina/worlds/minecraft/runtime/engine.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { RuntimeRefs } from "../../.uina/worlds/minecraft/runtime/refs.js";

/**
 * Body 单槽 FIFO 队列回归（runtime.md §3.3.1/§3.3.2）。
 *
 * 三个历史缺陷：
 * 1. 同 tick 双申请都看到"槽空" → 并发 acquire → 双持有（本该排队）。
 * 2. 排队/在途期间 Run 被停止，仍照常授予并执行 work。
 * 3. 谱系内独立申请在 acquire 在途窗口漏判 → 从 CONTROL_CONFLICT 退化成排队。
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function owner(run: string): ControlOwner {
	return { kind: "run", run, segment: `seg:${run}`, callId: `call:${run}` };
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

interface PortStats {
	/** 每次 acquire 的 owner，按调用序。 */
	acquires: ControlOwner[];
	/** acquire 在途峰值；>1 即双持有。 */
	maxInFlight: number;
	closes: number;
	heldNow: number;
}

function makePort(options: { delayMs?: number } = {}): { port: PlayerPort; stats: PortStats } {
	const stats: PortStats = { acquires: [], maxInFlight: 0, closes: 0, heldNow: 0 };
	let inFlight = 0;
	const port = {
		async acquire(acquireOwner: ControlOwner): Promise<BodySession> {
			stats.acquires.push(acquireOwner);
			inFlight++;
			stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
			await delay(options.delayMs ?? 0);
			inFlight--;
			stats.heldNow++;
			return {
				runScoped: async (_scope: unknown, work: () => Promise<unknown>) => work(),
				close: async (): Promise<void> => {
					stats.closes++;
					stats.heldNow--;
				},
			} as unknown as BodySession;
		},
		chat: async (): Promise<never> => {
			throw new Error("chat is not part of the body queue");
		},
	} as PlayerPort;
	return { port, stats };
}

async function captureFailure(promise: Promise<unknown>): Promise<CallFailure> {
	try {
		await promise;
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the promise to reject");
}

describe("BodyLeaseQueue：单槽 + 同步占槽", () => {
	test("同 tick 双申请：只有一个 acquire 在途，第二项等 release 后才授予", async () => {
		const { port, stats } = makePort({ delayMs: 10 });
		const queue = new BodyLeaseQueue({
			port,
			onGrant: () => {},
			onRelease: () => {},
			isOwnerLive: () => true,
		});
		const first = queue.request(owner("run:1"), "call:1", signal());
		const second = queue.request(owner("run:2"), "call:2", signal());
		const grant = await first;
		// 第二项必须仍在排队：并发 acquire 会让 Driver 侧判成 CONTROL_CONFLICT 或双持有
		expect(stats.maxInFlight).toBe(1);
		expect(stats.acquires).toHaveLength(1);
		await grant.session.close();
		// close 屏障完成后才算释放；此前不得授予下一项
		expect(stats.acquires).toHaveLength(1);
		grant.release();
		const next = await second;
		expect(stats.acquires).toHaveLength(2);
		expect(stats.maxInFlight).toBe(1);
		next.release();
	});

	test("FIFO：三项按申请序授予，且每次只有一个持有者", async () => {
		const { port, stats } = makePort();
		const queue = new BodyLeaseQueue({ port, onGrant: () => {}, onRelease: () => {}, isOwnerLive: () => true });
		const order: string[] = [];
		for (const run of ["run:a", "run:b", "run:c"]) {
			const grant = await queue.request(owner(run), `call:${run}`, signal());
			order.push(run);
			expect(stats.heldNow).toBe(1);
			await grant.session.close();
			grant.release();
		}
		expect(order).toEqual(["run:a", "run:b", "run:c"]);
		expect(stats.acquires.map((o) => (o.kind === "run" ? o.run : "safety"))).toEqual(["run:a", "run:b", "run:c"]);
	});

	test("排队期中断：该项拒绝 INTERRUPTED 且不进入 acquire，后续项照常授予", async () => {
		const { port, stats } = makePort({ delayMs: 5 });
		const queue = new BodyLeaseQueue({ port, onGrant: () => {}, onRelease: () => {}, isOwnerLive: () => true });
		const first = queue.request(owner("run:1"), "call:1", signal());
		const controller = new AbortController();
		const second = queue.request(owner("run:2"), "call:2", controller.signal);
		const third = queue.request(owner("run:3"), "call:3", signal());
		controller.abort();
		const err = await captureFailure(second);
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("INTERRUPTED");
		const grant = await first;
		grant.release();
		const next = await third;
		expect(stats.acquires).toHaveLength(2); // run:1 与 run:3，run:2 从未 acquire
		next.release();
	});
});

describe("BodyLeaseQueue：授予前复验与停止覆盖", () => {
	test("acquire 在途时 owner 失效：关闭会话并拒绝，不进入 work", async () => {
		const { port, stats } = makePort({ delayMs: 10 });
		let live = true;
		let granted = 0;
		const queue = new BodyLeaseQueue({
			port,
			onGrant: () => {
				granted++;
			},
			onRelease: () => {},
			isOwnerLive: () => live,
		});
		const pending = queue.request(owner("run:1"), "call:1", signal());
		live = false; // 与 acquire 在途重叠的停止
		const err = await captureFailure(pending);
		expect(err.code).toBe("INTERRUPTED");
		expect(granted).toBe(0); // 归属槽未登记
		expect(stats.closes).toBe(1); // 已授予的会话被关闭，不留悬空资格
		expect(stats.heldNow).toBe(0);
	});

	test("cancelRun 同时清排队项与在途项", async () => {
		const { port, stats } = makePort({ delayMs: 15 });
		const stopped = new Set<string>();
		const queue = new BodyLeaseQueue({
			port,
			onGrant: () => {},
			onRelease: () => {},
			isOwnerLive: (o) => o.kind !== "run" || !stopped.has(o.run),
		});
		const inFlight = queue.request(owner("run:1"), "call:1", signal());
		const queued = queue.request(owner("run:1"), "call:2", signal());
		const other = queue.request(owner("run:2"), "call:3", signal());
		// 立即挂上捕获器：在途项的拒绝先于下面的 await 发生
		const inFlightFailure = captureFailure(inFlight);
		const otherGrant = other.then((grant) => grant);
		stopped.add("run:1");
		queue.cancelRun("run:1");
		const queuedErr = await captureFailure(queued);
		expect(queuedErr.code).toBe("INTERRUPTED");
		expect(queuedErr.message).toContain("run stopped");
		const inFlightErr = await inFlightFailure;
		expect(inFlightErr.code).toBe("INTERRUPTED");
		expect(inFlightErr.message).toContain("expired before grant");
		expect(stats.closes).toBe(1);
		// 无关 Run 的申请不受影响
		const grant = await otherGrant;
		expect(stats.acquires).toHaveLength(2);
		grant.release();
	});
});

describe("BodyLeaseQueue：显式优先级一档（G9）", () => {
	test("priority 申请插队到已排队的 FIFO 等待者之前，safety 仍最前", async () => {
		const { port, stats } = makePort({ delayMs: 5 });
		const queue = new BodyLeaseQueue({ port, onGrant: () => {}, onRelease: () => {}, isOwnerLive: () => true });
		const grant = await queue.request(owner("run:hold"), "call:hold", signal());
		const fifo = queue.request(owner("run:fifo"), "call:fifo", signal());
		// priority run：引擎在申请前设一次性旗标 → unshift 到 fifo 之前
		queue.prioritize("run:priority");
		const priority = queue.request(owner("run:priority"), "call:priority", signal());
		// safety 到得最晚，仍按 enqueue 语义 unshift 到最前
		const safety = queue.request(
			{ kind: "safety", intervention: "int:1", interruptedRun: "run:hold" } as ControlOwner,
			"call:safety",
			signal(),
		);
		await grant.session.close();
		grant.release();
		const safetyGrant = await safety;
		safetyGrant.release();
		const priorityGrant = await priority;
		priorityGrant.release();
		const fifoGrant = await fifo;
		fifoGrant.release();
		expect(stats.acquires.map((o) => (o.kind === "run" ? o.run : "safety"))).toEqual([
			"run:hold",
			"safety",
			"run:priority",
			"run:fifo",
		]);
	});

	test("一次性旗标：匹配申请消费后，同 run 未重设旗标的下一次申请回到 FIFO", async () => {
		const { port, stats } = makePort({ delayMs: 5 });
		const queue = new BodyLeaseQueue({ port, onGrant: () => {}, onRelease: () => {}, isOwnerLive: () => true });
		const grant = await queue.request(owner("run:hold"), "call:hold", signal());
		const other = queue.request(owner("run:other"), "call:other", signal());
		queue.prioritize("run:priority");
		const first = queue.request(owner("run:priority"), "call:priority-1", signal());
		await grant.session.close();
		grant.release();
		const firstGrant = await first;
		firstGrant.release();
		// 旗标已被消费；同 run 再次申请（引擎未重设）排在 other 之后
		const second = queue.request(owner("run:priority"), "call:priority-2", signal());
		const otherGrant = await other;
		otherGrant.release();
		const secondGrant = await second;
		secondGrant.release();
		expect(stats.acquires.map((o) => (o.kind === "run" ? o.run : "safety"))).toEqual([
			"run:hold",
			"run:priority",
			"run:other",
			"run:priority",
		]);
	});
});

// ---- 引擎级：谱系冲突与独立申请的排队 ----

function makeCallable(
	ref: ExactRef,
	invoke: (ctx: CallContext, input: JsonValue) => Promise<JsonValue>,
): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: {
			ref,
			summary: `test callable ${ref}`,
			input: {},
			output: {},
			access: "act",
			completion: { scope: "execution", description: "returns when the test work is done" },
			errors: [],
			requires: [],
			examples: [],
			implementation: "native",
		},
		invoke,
	};
}

function makeEngine(port: PlayerPort, callables: NativeCallable<JsonValue, JsonValue>[]): { engine: RuntimeEngine } {
	const refs = new RuntimeRefs("t");
	const instance = refs.writerInstance();
	const queue: RecordQueue = new RecordQueue({
		instance,
		mintRecord: () => refs.record(),
		recoveredWatermarks: {},
		// 测试无 worker：落盘即回报 durable，让 run 结算的 flushThrough 可完成
		apply: (items) => {
			const last = items[items.length - 1];
			if (last != null) queue.onDurable(instance, last.ticket.sequence);
		},
	});
	const engine = new RuntimeEngine({
		refs,
		queue,
		world: {} as WorldPort,
		playerPort: port,
		callables,
		worldOwner: "world:t:1",
	});
	return { engine };
}

async function runToEnd(
	engine: RuntimeEngine,
	rootRef: ExactRef,
): Promise<{ run: Ref; outcome: string; error: { code: string } | null }> {
	const owner = await engine.owner.attach({ worldOwner: "world:t:1", activation: "act:t:1" });
	await engine.owner.setGate({
		requestId: "enable",
		attachment: owner.attachment,
		gate: "disabled",
		closed: false,
		expectedRevision: owner.gateRevision,
	});
	const acceptance = await engine.submit(
		{ worldOwner: "world:t:1", activation: "act:t:1" },
		{
			requestId: `req:${rootRef}`,
			entry: { kind: "call", selector: rootRef, input: {} },
			schedule: { kind: "enqueue" },
		},
	);
	if (acceptance.kind !== "accepted") throw new Error(`submission rejected: ${JSON.stringify(acceptance)}`);
	const run = acceptance.snapshot.run;
	await engine.wait(run, { timeoutMs: 2000 }, undefined);
	const summary = engine.read(run);
	return {
		run,
		outcome: summary.phase === "finished" ? (summary.outcome ?? "") : summary.phase,
		error: summary.phase === "finished" ? (summary.error ?? null) : null,
	};
}

describe("RuntimeEngine：身体所有权的谱系语义", () => {
	test("delegation suspends parent writes, rejects concurrent delegation and restores the same body", async () => {
		let writes = 0,
			release!: () => void,
			entered!: () => void;
		const inside = new Promise<void>((r) => {
			entered = r;
		});
		const wait = new Promise<void>((r) => {
			release = r;
		});
		const { port, stats } = makePort();
		const acquire = port.acquire.bind(port);
		port.acquire = async (owner, signal) =>
			Object.assign(await acquire(owner, signal), {
				lookAt: async () => {
					writes++;
					return null;
				},
			});
		const child = makeCallable("t.delegated@1", async (ctx) =>
			ctx.withBody(async (scope) => {
				await scope.player.lookAt({ x: 0, y: 0, z: 0 });
				entered();
				await wait;
				return null;
			}),
		);
		const root = makeCallable("t.owner@1", async (ctx) =>
			ctx.withBody(async (scope) => {
				const pending = scope.call("t.delegated@1", {});
				await inside;
				await expect(scope.player.lookAt({ x: 1, y: 1, z: 1 })).rejects.toMatchObject({ code: "BODY_SUSPENDED" });
				await expect(scope.call("t.delegated@1", {})).rejects.toMatchObject({ code: "BODY_BUSY" });
				await expect(ctx.withBody(async () => null)).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
				release();
				await pending;
				await scope.player.lookAt({ x: 2, y: 2, z: 2 });
				return null;
			}),
		);
		const { engine } = makeEngine(port, [root, child]);
		const done = await runToEnd(engine, "t.owner@1");
		expect(done.outcome, JSON.stringify(done.error)).toBe("succeeded");
		expect(writes).toBe(2);
		expect(stats.acquires).toHaveLength(1);
		expect(stats.closes).toBe(1);
	});
	test("根部 Promise.all 两个兄弟调用各自 withBody：排队而非双持有", async () => {
		const { port, stats } = makePort({ delayMs: 5 });
		const worker = makeCallable("t.worker@1", async (ctx) => {
			await ctx.withBody(async () => {
				await delay(10);
				return null;
			});
			return null;
		});
		const root = makeCallable("t.parallel@1", async (ctx) => {
			await Promise.all([ctx.call("t.worker@1", {}), ctx.call("t.worker@1", {})]);
			return "ok";
		});
		const { engine } = makeEngine(port, [worker, root]);
		const done = await runToEnd(engine, "t.parallel@1");
		expect(done.outcome, JSON.stringify(done.error)).toBe("succeeded");
		expect(stats.maxInFlight).toBe(1);
		expect(stats.acquires).toHaveLength(2);
	});

	test("后代正在 acquire 时本调用独立申请：仍 CONTROL_CONFLICT", async () => {
		const { port, stats } = makePort({ delayMs: 20 });
		const child = makeCallable("t.child@1", async (ctx) => {
			await ctx.withBody(async () => {
				await delay(10);
				return null;
			});
			return null;
		});
		const seen: { parentError: CallFailure | null } = { parentError: null };
		const root = makeCallable("t.parent@1", async (ctx) => {
			// 子调用同步进入 acquire 在途窗口（body 队列同步占槽）
			const pending = ctx.call("t.child@1", {});
			try {
				await ctx.withBody(async () => null);
			} catch (err) {
				seen.parentError = err as CallFailure;
			}
			await pending;
			return null;
		});
		const { engine } = makeEngine(port, [child, root]);
		const done = await runToEnd(engine, "t.parent@1");
		expect(done.outcome).toBe("succeeded");
		expect(seen.parentError?.code).toBe("CONTROL_CONFLICT");
		// 冲突在派发申请前拒绝：只有子调用真正 acquire 过一次
		expect(stats.acquires).toHaveLength(1);
	});
});
