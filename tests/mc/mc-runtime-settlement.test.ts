import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import type { BodySession, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { CallContext, NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { DriverExecutionFact, RunSummary } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { callFailure, type ExactRef, type JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { RuntimeEngine } from "../../.uina/worlds/minecraft/runtime/engine.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { RuntimeRefs } from "../../.uina/worlds/minecraft/runtime/refs.js";
import { callFromRow, snapshotFromRow } from "../../.uina/worlds/minecraft/runtime/rows.js";
import type { CallRow, RunRow } from "../../.uina/worlds/minecraft/runtime/runtime-db-worker.js";
import { nativeCallable } from "./mc-native-fixture.js";

/** settlement 回归的固定 descriptor 口径（capability scope 的 completion）。 */
const callable = (
	ref: ExactRef,
	invoke: NativeCallable<JsonValue, JsonValue>["invoke"],
): NativeCallable<JsonValue, JsonValue> =>
	nativeCallable(ref, invoke, {
		summary: "settlement regression",
		completion: { scope: "capability", description: "observed result" },
	});

function receipt(completion: DriverExecutionFact["completion"] = "unknown"): DriverExecutionFact {
	return {
		effect: "eff:settlement",
		operation: "op:settlement",
		contract: "body.window.click@1",
		observedAt: "2026-10-25T00:00:00.000Z",
		kind: "receipt",
		dispatch: "sent",
		completion,
		evidence: [],
	};
}

function harness(build: (queue: RecordQueue) => NativeCallable<JsonValue, JsonValue>[]) {
	const refs = new RuntimeRefs("settlement");
	const instance = refs.writerInstance();
	const callRows = new Map<string, CallRow>();
	const runRows = new Map<string, RunRow>();
	const queue = new RecordQueue({
		instance,
		mintRecord: () => refs.record(),
		recoveredWatermarks: {},
		apply: (items) => {
			for (const item of items) {
				if (item.mutation.kind === "run") runRows.set(item.mutation.row.run, item.mutation.row);
				if (item.mutation.kind === "call") callRows.set(item.mutation.row.call, item.mutation.row);
			}
			queue.onDurable(instance, items[items.length - 1]!.ticket.sequence);
		},
	});
	const engine = new RuntimeEngine({
		refs,
		queue,
		world: {} as WorldPort,
		playerPort: {
			acquire: async () => ({ close: async () => {} }) as BodySession,
			chat: async () => {
				throw new Error("chat is outside this settlement fixture");
			},
		} satisfies PlayerPort,
		callables: build(queue),
		worldOwner: "owner:settlement",
	});
	const submit = async (selector: ExactRef) => {
		const state = await engine.owner.attach({ worldOwner: "owner:settlement", activation: "act:settlement" });
		await engine.owner.setGate({
			requestId: "enable",
			attachment: state.attachment,
			gate: "disabled",
			closed: false,
			expectedRevision: state.gateRevision,
		});
		const reply = await engine.submit(
			{ worldOwner: "owner:settlement", activation: "act:settlement" },
			{ requestId: `req:${selector}`, entry: { kind: "call", selector, input: {} }, schedule: { kind: "enqueue" } },
		);
		if (reply.kind !== "accepted") throw new Error(JSON.stringify(reply));
		return reply.snapshot.run;
	};
	const finish = async (run: string): Promise<Extract<RunSummary, { phase: "finished" }>> => {
		const reply = await engine.wait(run, { timeoutMs: 2000 }, undefined);
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") throw new Error(JSON.stringify(reply));
		return reply.snapshot;
	};
	return { engine, queue, submit, finish, calls: () => [...callRows.values()], runs: () => [...runRows.values()] };
}

function failure(): Error {
	return callFailure({
		code: "TARGET_NOT_MET",
		source: "capability",
		message: "goal not met",
		dispatch: "sent",
		effects: ["eff:settlement"],
		recoverable: true,
	});
}

function fact(
	partial: Partial<DriverExecutionFact> & { kind: DriverExecutionFact["kind"]; effect?: string },
): DriverExecutionFact {
	return {
		effect: "eff:settlement",
		operation: "op:settlement",
		contract: "body.window.click@1",
		observedAt: "2026-10-25T00:00:00.000Z",
		dispatch: "sent",
		completion: "unknown",
		evidence: [],
		...partial,
	};
}

describe("Effect current assessment matrix", () => {
	test("E02: a trusted intent closed before dispatch is not an unresolved write", async () => {
		const h = harness((queue) => [
			callable("closed@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(fact({ kind: "intent", dispatch: "unknown", completion: "unknown" }));
					queue.record(fact({ kind: "cleanup", dispatch: "not_sent", completion: "not_met" }));
					return "closed";
				}),
			),
		]);
		expect(await h.finish(await h.submit("closed@1"))).toMatchObject({ outcome: "succeeded", unknownEffects: [] });
	});

	test("E03: a conclusive not_met receipt is a confirmed business closure, not an unknown write", async () => {
		const h = harness((queue) => [
			callable("notmet@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(fact({ kind: "receipt", completion: "not_met" }));
					return "reported";
				}),
			),
		]);
		expect(await h.finish(await h.submit("notmet@1"))).toMatchObject({ outcome: "succeeded", unknownEffects: [] });
	});

	test("E04: not_met with a still-uncertain cleanup consequence stays unresolved", async () => {
		const h = harness((queue) => [
			callable("partial@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(fact({ kind: "receipt", completion: "not_met" }));
					queue.record(fact({ kind: "cleanup", dispatch: "sent", completion: "unknown" }));
					return "reported";
				}),
			),
		]);
		expect(await h.finish(await h.submit("partial@1"))).toMatchObject({
			outcome: "unknown",
			unknownEffects: ["eff:settlement"],
		});
	});

	test("E06a: a met receipt does not mask an unsettled cleanup on the same effect", async () => {
		const h = harness((queue) => [
			callable("goto@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(fact({ kind: "receipt", completion: "met" }));
					queue.record(fact({ kind: "cleanup", dispatch: "sent", completion: "unknown", contract: "body.goto@1" }));
					return "arrived";
				}),
			),
		]);
		expect(await h.finish(await h.submit("goto@1"))).toMatchObject({
			outcome: "unknown",
			unknownEffects: ["eff:settlement"],
		});
	});

	test("E06b: a failed navigation with settled cleanup is conclusively not_met, not unknown", async () => {
		const h = harness((queue) => [
			callable("nopath@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(fact({ kind: "dispatch", dispatch: "sent", completion: "unknown", contract: "body.goto@1" }));
					queue.record(fact({ kind: "cleanup", dispatch: "sent", completion: "met", contract: "body.goto@1" }));
					throw failure();
				}),
			),
		]);
		// 业务确定未达成（无 met 回执 + 操作已收尾），写入已静止：失败但不列未决。
		expect(await h.finish(await h.submit("nopath@1"))).toMatchObject({
			outcome: "failed",
			unknownEffects: [],
			error: { code: "TARGET_NOT_MET" },
		});
	});

	test("E06c: a standalone window-close effect settles by its own cleanup completion", async () => {
		const h = harness((queue) => [
			callable("closeok@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(
						fact({
							effect: "eff:close-ok",
							kind: "cleanup",
							dispatch: "sent",
							completion: "met",
							contract: "body.window.close@1",
						}),
					);
					return null;
				}),
			),
			callable("closeunknown@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(
						fact({
							effect: "eff:close-unknown",
							kind: "cleanup",
							dispatch: "sent",
							completion: "unknown",
							contract: "body.window.close@1",
						}),
					);
					return null;
				}),
			),
		]);
		expect(await h.finish(await h.submit("closeok@1"))).toMatchObject({ outcome: "succeeded", unknownEffects: [] });
		expect(await h.finish(await h.submit("closeunknown@1"))).toMatchObject({
			outcome: "unknown",
			unknownEffects: ["eff:close-unknown"],
		});
	});
});

describe("Runtime effect settlement", () => {
	test("a returned value with an unknown direct effect stays unknown in Run and Call records", async () => {
		let call = "";
		const h = harness((queue) => [
			callable("direct@1", async (ctx) => {
				call = ctx.callId;
				return ctx.withBody(async () => {
					queue.record(receipt());
					return { removed: 2 };
				});
			}),
		]);
		const summary = await h.finish(await h.submit("direct@1"));
		expect(summary).toMatchObject({ outcome: "unknown", unknownEffects: ["eff:settlement"] });
		expect(snapshotFromRow(h.runs().find((r) => r.run === summary.run))).toMatchObject({
			value: { removed: 2 },
			outcome: "unknown",
		});
		const record = h.calls().find((item) => item.call === call);
		expect(record?.outcome).toBe("unknown");
		expect(callFromRow(record!)).toMatchObject({
			effects: ["eff:settlement"],
			value: { removed: 2 },
			outcome: "unknown",
		});
	});

	test("nested effects affect the parent result without acquiring a second effect owner", async () => {
		const h = harness((queue) => [
			callable("leaf@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					return "leaf value";
				}),
			),
			callable("middle@1", async (ctx) => ctx.call("leaf@1", {})),
			callable("root@1", async (ctx) => {
				await ctx.call("middle@1", {});
				return "root value";
			}),
		]);
		const summary = await h.finish(await h.submit("root@1"));
		// 子调用交付边界：leaf 的 unknown 业务值不再沿普通成功 Promise 交付，中层与
		// 根默认不隐式继续；leaf 的历史记录（unknown + value + owner）不倒写。
		expect(summary).toMatchObject({ outcome: "failed", unknownEffects: ["eff:settlement"] });
		expect(summary.error?.code).toBe("EFFECT_UNCONFIRMED");
		const root = h.calls().find((call) => call.parent === null)!;
		const middle = h.calls().find((call) => call.parent === root.call)!;
		const leaf = h.calls().find((call) => call.parent === middle.call)!;
		expect(leaf.outcome).toBe("unknown");
		expect(callFromRow(leaf)).toMatchObject({ effects: ["eff:settlement"], value: "leaf value" });
		expect(middle.outcome).toBe("failed");
		expect(JSON.parse(middle.error!).code).toBe("EFFECT_UNCONFIRMED");
		expect(root.outcome).toBe("failed");
		expect(JSON.parse(root.error!).code).toBe("EFFECT_UNCONFIRMED");
		expect(callFromRow(root)).toMatchObject({ effects: [] });
		expect(callFromRow(middle)).toMatchObject({ effects: [] });
		expect(callFromRow(leaf)).toMatchObject({ effects: ["eff:settlement"] });
		expect(h.queue.effectRecord("eff:settlement")?.owner).toMatchObject({ callId: leaf.call });
	});

	test("an unhandled child domain failure keeps its original code while its unknown effect still fails the parent", async () => {
		const h = harness((queue) => [
			callable("leaf@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					throw failure();
				}),
			),
			callable("root@1", async (ctx) => ctx.call("leaf@1", {})),
		]);
		const summary = await h.finish(await h.submit("root@1"));
		// 确定的业务失败按原错误透传，不被通用 unknown 包装覆盖；未决效果仍如实列出。
		expect(summary.outcome).toBe("failed");
		expect(summary.error?.code).toBe("TARGET_NOT_MET");
		expect(summary.unknownEffects).toEqual(["eff:settlement"]);
		const child = h.calls().find((call) => call.ref === "leaf@1")!;
		expect(child.outcome).toBe("failed");
	});

	test("handling a failed child does not erase its unknown effect", async () => {
		const h = harness((queue) => [
			callable("leaf@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					throw failure();
				}),
			),
			callable("root@1", async (ctx) => {
				await ctx.call("leaf@1", {}).catch(() => undefined);
				return "recovered";
			}),
		]);
		const summary = await h.finish(await h.submit("root@1"));
		expect(summary.outcome).toBe("unknown");
		const root = h.calls().find((call) => call.parent === null)!;
		const child = h.calls().find((call) => call.parent === root.call)!;
		expect(child.outcome).toBe("failed");
		expect(snapshotFromRow(h.runs().find((r) => r.run === summary.run))).toMatchObject({ value: "recovered" });
	});

	// 根调用失败不等于"什么都没做"：调用侧在错误里点的进度必须成为 Run 的终态进度，
	// 否则模型会把"采到 9/16 才放弃"读成"一个都没采"，按 0 重做。
	test("a failed root keeps the progress the call reported in its failure", async () => {
		const h = harness(() => [
			callable("collect@1", async (ctx) => {
				await ctx.progress({ acquired: 3 });
				await ctx.progress({ acquired: 7 });
				// 最后一次增量已确认但还没走 ctx.progress：失败里带的值才是真值。
				throw callFailure({
					code: "TARGET_NOT_MET",
					source: "capability",
					message: "gave up after block attempts with 9/16",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
					progress: { acquired: 9, remaining: 7 },
				});
			}),
		]);
		const summary = await h.finish(await h.submit("collect@1"));
		expect(summary).toMatchObject({ phase: "finished", outcome: "failed" });
		expect(summary.progress).toEqual({ acquired: 9, remaining: 7 });
		expect(snapshotFromRow(h.runs().find((row) => row.run === summary.run)!)).toMatchObject({
			progress: { acquired: 9, remaining: 7 },
			progressComplete: true,
		});
	});

	test("a closed child scope must finish descendant cleanup before the parent settles", async () => {
		let started: () => void = () => {};
		let closing: () => void = () => {};
		let release: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const childClosing = new Promise<void>((resolve) => {
			closing = resolve;
		});
		const cleanup = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness((queue) => [
			callable("leaf@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt("met"));
					started();
					await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
					await cleanup;
					queue.record({ ...receipt(), effect: "eff:cleanup", kind: "cleanup" });
					return null;
				}),
			),
			callable("middle@1", async (ctx) => {
				ctx.signal.addEventListener("abort", () => closing(), { once: true });
				void ctx.call("leaf@1", {}).catch(() => undefined);
				await ready;
				return null;
			}),
			callable("root@1", async (ctx) => {
				void ctx.call("middle@1", {}).catch(() => undefined);
				await childClosing;
				return "root";
			}),
		]);
		const run = await h.submit("root@1");
		await childClosing;
		await new Promise((resolve) => setTimeout(resolve, 0));
		const phaseDuringCleanup = h.engine.read(run).phase;
		release();
		const summary = await h.finish(run);
		expect(phaseDuringCleanup).not.toBe("finished");
		expect(summary).toMatchObject({ outcome: "unknown", unknownEffects: ["eff:cleanup"] });
	});

	test("handling a child failure without effects can still satisfy the parent goal", async () => {
		const h = harness(() => [
			callable("leaf@1", async () => {
				throw failure();
			}),
			callable("root@1", async (ctx) => {
				await ctx.call("leaf@1", {}).catch(() => undefined);
				return "recovered";
			}),
		]);
		expect(await h.finish(await h.submit("root@1"))).toMatchObject({ outcome: "succeeded", unknownEffects: [] });
	});

	test("a confirmed latest receipt permits success even if the first receipt was unknown", async () => {
		const h = harness((queue) => [
			callable("confirmed@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					queue.record(receipt("met"));
					return "confirmed";
				}),
			),
		]);
		expect(await h.finish(await h.submit("confirmed@1"))).toMatchObject({ outcome: "succeeded", unknownEffects: [] });
	});

	test("the parent catches EFFECT_UNCONFIRMED and a later confirmed receipt lets it settle on current facts", async () => {
		const h = harness((queue) => [
			callable("leaf@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					return "leaf";
				}),
			),
			callable("root@1", async (ctx) => {
				try {
					await ctx.call("leaf@1", {});
					throw new Error("leaf delivery must reject with EFFECT_UNCONFIRMED");
				} catch (error) {
					if ((error as { code?: string }).code !== "EFFECT_UNCONFIRMED") throw error;
				}
				// 显式查证（夹具以"更晚的已确认 receipt"承担权威证据）：父按当前事实结算。
				await ctx.withBody(async () => {
					queue.record(receipt("met"));
				});
				return "confirmed";
			}),
		]);
		const summary = await h.finish(await h.submit("root@1"));
		expect(summary).toMatchObject({ outcome: "succeeded", unknownEffects: [] });
		const child = h.calls().find((call) => call.ref === "leaf@1")!;
		// 子历史不倒写：leaf 仍是 unknown，owner 不变。
		expect(child.outcome).toBe("unknown");
		expect(h.queue.effectRecord("eff:settlement")?.owner).toMatchObject({ callId: child.call });
	});

	test("a failed goal retains both failure and unresolved effects", async () => {
		const h = harness((queue) => [
			callable("failed@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					throw failure();
				}),
			),
		]);
		expect(await h.finish(await h.submit("failed@1"))).toMatchObject({
			outcome: "failed",
			unknownEffects: ["eff:settlement"],
			error: { code: "TARGET_NOT_MET" },
		});
	});

	test("an explicit stop retains cancellation and unresolved effects", async () => {
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const h = harness((queue) => [
			callable("cancelled@1", async (ctx: CallContext) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					started();
					await new Promise<void>((_resolve, reject) =>
						ctx.signal.addEventListener("abort", () => reject(failure()), { once: true }),
					);
					return null;
				}),
			),
		]);
		const run = await h.submit("cancelled@1");
		await ready;
		await h.engine.stop({ requestId: "stop:settlement", target: { run } });
		expect(await h.finish(run)).toMatchObject({ outcome: "cancelled", unknownEffects: ["eff:settlement"] });
	});

	test("an explicit stop remains cancelled when a callable handles abort and returns", async () => {
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const h = harness((queue) => [
			callable("handled-stop@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(receipt());
					started();
					await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
					return "cleanup done";
				}),
			),
		]);
		const run = await h.submit("handled-stop@1");
		await ready;
		await h.engine.stop({ requestId: "stop:handled", target: { run } });
		expect(await h.finish(run)).toMatchObject({ outcome: "cancelled", unknownEffects: ["eff:settlement"] });
	});

	test("SQLite close/reopen preserves nested outcomes, return values and unique effect ownership", () => {
		const dir = mkdtempSync(join(tmpdir(), "uina-runtime-settlement-"));
		const runtimeUrl = pathToFileURL(resolve(".uina/worlds/minecraft/runtime/index.ts")).href;
		const script = join(dir, "verify.mjs");
		writeFileSync(
			script,
			`
import assert from "node:assert/strict";
import { MinecraftRuntime } from ${JSON.stringify(runtimeUrl)};
const descriptor = ref => ({ref,summary:"settlement",input:{},output:{},access:"act",implementation:"native",completion:{scope:"capability",description:"observed result"},errors:[],requires:[],examples:[]});
let runtime;
const callables = [
 {descriptor:descriptor("leaf@1"),invoke:ctx=>ctx.withBody(async()=>{runtime.sink.record(${JSON.stringify(receipt())});return {removed:2};})},
 {descriptor:descriptor("root@1"),invoke:ctx=>ctx.call("leaf@1",{})}
];
const options = {dbPath:${JSON.stringify(join(dir, "runtime.db"))},storageId:"settlement@1",namespace:"first",worldOwner:"owner:settlement",world:{},playerPort:{acquire:async()=>({close:async()=>{}})},callables};
runtime = (await MinecraftRuntime.open(options)).runtime;
const owner=await runtime.attach({worldOwner:"owner:settlement",activation:"act:settlement"});
await runtime.setOwnerGate({requestId:"enable",attachment:owner.attachment,gate:"disabled",closed:false,expectedRevision:owner.gateRevision});
let run, before, records, effect;
try {
	 const accepted=await runtime.submit({worldOwner:"owner:settlement",activation:"act:settlement"},{requestId:"req:sqlite",entry:{kind:"call",selector:"root@1",input:{}},schedule:{kind:"enqueue"}});
	 assert.equal(accepted.kind,"accepted");run=accepted.snapshot.run;
	 const reply=await runtime.wait(run,{timeoutMs:2000});assert.equal(reply.kind,"result");assert.equal(reply.snapshot.outcome,"failed");
	 before=(await runtime.read(run));records=(await runtime.readRecord(before.record)).record;
	 effect=(await runtime.readRecord("eff:settlement")).record;assert.equal(effect.value.latest.completion,"unknown");assert.ok(!("value" in records.value));
} finally { await runtime.close(); }
runtime=(await MinecraftRuntime.open({...options,namespace:"restart"})).runtime;
 try {
  assert.deepEqual((await runtime.read(run)),before);assert.deepEqual((await runtime.readRecord(before.record)).record,records);assert.deepEqual((await runtime.readRecord("eff:settlement")).record,effect);
  const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(options.dbPath);
  try {const calls=db.prepare("SELECT outcome,effects,value FROM calls ORDER BY parent IS NOT NULL").all();assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.outcome),["failed","unknown"]);assert.deepEqual(calls.map(c=>JSON.parse(c.effects)),[[],["eff:settlement"]]);assert.deepEqual(calls.map(c=>JSON.parse(c.value)),[null,{removed:2}]);} finally {db.close();}
 } finally {await runtime.close();}
console.log("runtime settlement SQLite integration passed");
`,
		);
		try {
			const output = execFileSync(process.execPath, ["--import", "tsx", script], {
				cwd: resolve("."),
				encoding: "utf8",
				timeout: 15_000,
				windowsHide: true,
			});
			expect(output).toContain("runtime settlement SQLite integration passed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
