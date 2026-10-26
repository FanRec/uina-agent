import assert from "node:assert/strict";
import type { CallRecord, RunSnapshot } from "../contracts/runtime.js";

export interface I2Scenario {
	direct(action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	step(name: string, work: () => Promise<void>): Promise<void>;
	reopen(): Promise<void>;
	until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs?: number): Promise<T>;
}
export async function i2Scenario(s: I2Scenario): Promise<void> {
	const status = (run: string) => s.direct("runs", { op: "status", run });
	const finish = async (reply: Record<string, unknown>) => {
		assert.ok(reply.kind === "accepted" || reply.kind === "result", JSON.stringify(reply));
		const run = (reply.snapshot as { run: string }).run;
		const result = await s.until(
			() => s.direct("runs", { op: "wait", run, timeoutMs: 1000 }),
			(r) => r.kind === "result",
			90000,
		);
		return result.snapshot as unknown as RunSnapshot;
	};
	const record = async (ref: string) =>
		(await s.direct("runs", { op: "record", ref, format: "inline" })).record as { value: RunSnapshot };
	const calls = async (run: string) => {
		const all: CallRecord[] = [];
		let cursor: string | undefined;
		do {
			const page = await s.direct("runs", { op: "calls", run, ...(cursor ? { cursor } : {}) });
			all.push(...(page.items as CallRecord[]));
			cursor = page.next as string | undefined;
		} while (cursor);
		return all;
	};
	const inventory = async () =>
		(await s.direct("observe", { selector: "inventory@1" })).value as { counts: Record<string, number> };
	const completed = async (reply: Record<string, unknown>) => {
		const snapshot = await finish(reply);
		assert.equal(snapshot.phase, "finished", JSON.stringify(snapshot));
		assert.equal((snapshot as { outcome?: string }).outcome, "succeeded", JSON.stringify(snapshot));
		return snapshot.run;
	};
	let waitingRun = "",
		oldDigest = "",
		sourceCall: CallRecord;
	const before = (await inventory()).counts.oak_planks ?? 0;
	await s.step("running inventory waiter yields to real collect/craft and requests a decision", async () => {
		const start = await s.direct("run", {
			input: { target: before + 4 },
			code: `async function main(mc,input){
  mc.progress({summary:'I2 waiting for real planks',target:input.target});
  const result=await mc.waitUntil({inv:{ref:'inventory@1'}},(s,{unknown})=>s.inv!==null&&!unknown.inv?.length&&(s.inv.counts.oak_planks??0)>=input.target,{timeoutMs:60000});
  if(result.kind!=='met') throw new Error('real plank wait did not complete');
  mc.decide('I2 continuation required',{tag:'i2',target:input.target});
}`,
		});
		assert.equal(start.kind, "accepted", JSON.stringify(start));
		waitingRun = (start.snapshot as { run: string }).run;
		await s.until(
			() => status(waitingRun),
			(r) => r.phase === "waiting" && (r.waiting as { kind: string }).kind === "world_change",
		);
		await completed(
			await s.direct("run", {
				code: `async function main(mc){
  await mc.call('collect@1',{item:'oak_log',count:1,radius:8});
  await mc.call('craft@1',{item:'oak_planks',count:4});
  return (await mc.read('inventory@1')).value.counts;
}`,
			}),
		);
		const end = await finish(start);
		assert.equal(end.phase, "awaiting_decision", JSON.stringify(end));
		assert.ok((await inventory()).counts.oak_planks >= before + 4);
		const fixed = (await record(waitingRun)).value;
		assert.equal(fixed.phase, "awaiting_decision");
		if (fixed.phase !== "awaiting_decision") throw new Error("decision record missing");
		assert.deepEqual(fixed.checkpoint?.value, { tag: "i2", target: before + 4 });
		sourceCall = (await calls(waitingRun)).find((c) => c.parent === null && c.implementation === "program")!;
		assert.ok(sourceCall, "exact root program Call missing");
	});
	await s.step("fixed Call save-from, material edit and same-Run named continuation", async () => {
		const from = { run: sourceCall.run, segment: sourceCall.segment, call: sourceCall.call };
		const saved = await s.direct("library", {
			op: "save",
			name: "i2_planks",
			summary: "Wait for observed planks, then hand over a checkpoint",
			from,
		});
		oldDigest = saved.digest as string;
		const material = await s.direct("library", { op: "get", name: "i2_planks" });
		assert.equal((material.savedFrom as { call: string }).call, sourceCall.call);
		await s.direct("library", {
			op: "update",
			name: "i2_planks",
			expectedDigest: material.digest,
			source: `async function main(mc){const checkpoint=mc.checkpoint;
  if(checkpoint?.tag!=='i2') throw new Error('missing original checkpoint');
  const inventory=(await mc.read('inventory@1')).value.counts;
  if((inventory.oak_planks??0)<checkpoint.target) throw new Error('world no longer meets checkpoint');
  return {revision:'v2',checkpoint,inventory};
}`,
		});
		const decision = await status(waitingRun);
		const resumed = await s.direct("runs", {
			op: "continue",
			run: waitingRun,
			decision: decision.decision,
			entry: { selector: "i2_planks" },
		});
		assert.equal(await completed(resumed), waitingRun);
		const fixed = (await record(waitingRun)).value;
		assert.equal(fixed.phase, "finished");
		const result = (fixed as { value?: { revision: string; checkpoint: unknown } }).value;
		assert.equal(result?.revision, "v2");
		assert.deepEqual(result?.checkpoint, { tag: "i2", target: before + 4 });
		const roots = (await calls(waitingRun)).filter((c) => c.parent === null);
		assert.equal(new Set(roots.map((c) => c.segment)).size, 2);
		const reused = roots.find((c) => c.ref === "i2_planks")!;
		assert.ok(reused, "named continuation Call missing");
		const current = await s.direct("library", { op: "get", name: "i2_planks" });
		const reusedRecord = (await s.direct("runs", { op: "record", ref: reused.call, format: "inline" })).record as {
			value: CallRecord;
		};
		assert.equal(reusedRecord.value.program?.digest, current.digest);
		assert.notEqual(current.digest, oldDigest);
	});
	const hold = `async function main(mc){return mc.withBody(async body=>{
  await body.lookAt({x:16002,y:201,z:16000}); mc.progress({summary:'I2 holds body while waiting'});
  return mc.waitUntil({inv:{ref:'inventory@1'}},()=>false);
});}`;
	let stoppedRun = "";
	await s.step("explicit preempt retires the current body holder before its replacement", async () => {
		const held = await s.direct("run", { code: hold });
		const run = (held.snapshot as { run: string }).run;
		await s.until(
			() => status(run),
			(r) => r.phase === "waiting" && r.control === "active",
		);
		await completed(
			await s.direct("run", {
				code: "async function main(mc){return mc.withBody(b=>b.lookAt({x:16001,y:201,z:16000}));}",
				schedule: { kind: "preempt_current", expectedRun: run },
			}),
		);
		const result = await finish(held);
		assert.equal((result as { outcome?: string }).outcome, "cancelled");
	});
	await s.step("explicit stop settles the guest and releases body ownership", async () => {
		const held = await s.direct("run", { code: hold });
		stoppedRun = (held.snapshot as { run: string }).run;
		await s.until(
			() => status(stoppedRun),
			(r) => r.phase === "waiting" && r.control === "active",
		);
		await s.direct("runs", { op: "stop", run: stoppedRun });
		assert.equal(((await finish(held)) as { outcome?: string }).outcome, "cancelled");
		await s.until(
			() => s.direct("runs", { op: "status" }),
			(r) => (r.side as { program?: { residentGuests: number } })?.program?.residentGuests === 0,
		);
	});
	await s.step("real navigation queues behind Body and completes after explicit preemption", async () => {
		const held = await s.direct("run", { code: hold });
		const run = (held.snapshot as { run: string }).run;
		await s.until(
			() => status(run),
			(r) => r.phase === "waiting" && r.control === "active",
		);
		const navigation = await s.direct("run", {
			selector: "goto@1",
			input: { at: { x: 16000, y: 200, z: 16003 }, tolerance: 1, maxTimeMs: 30000 },
		});
		assert.equal(navigation.kind, "accepted", JSON.stringify(navigation));
		assert.equal((await status((navigation.snapshot as { run: string }).run)).control, "none");
		await completed(
			await s.direct("run", {
				code: "async function main(mc){return mc.withBody(b=>b.lookAt({x:16001,y:201,z:16000}));}",
				schedule: { kind: "preempt_current", expectedRun: run },
			}),
		);
		await completed(navigation);
		assert.equal(((await finish(held)) as { outcome?: string }).outcome, "cancelled");
	});
	await s.step("full activation reopen preserves pending decision and fixed records without replay", async () => {
		const pending = await finish(
			await s.direct("run", { code: "async function main(mc){mc.decide('I2 reopen checkpoint',{tag:'reopen'});}" }),
		);
		assert.equal(pending.phase, "awaiting_decision");
		if (pending.phase !== "awaiting_decision") throw new Error("pending decision missing");
		const priorCalls = (await calls(waitingRun)).map((c) => c.call).sort();
		const priorInventory = (await inventory()).counts;
		await s.reopen();
		const restored = await status(pending.run);
		assert.equal(restored.phase, "awaiting_decision", JSON.stringify(restored));
		assert.equal(restored.decision, pending.decision);
		assert.deepEqual((await calls(waitingRun)).map((c) => c.call).sort(), priorCalls);
		assert.equal((await status(stoppedRun)).phase, "finished");
		assert.equal((await status(stoppedRun)).outcome, "cancelled");
		assert.deepEqual((await inventory()).counts, priorInventory);
		const platform = await s.direct("runs", { op: "status" });
		assert.equal((platform.side as { program: { residentGuests: number } }).program.residentGuests, 0);
		await completed(
			await s.direct("runs", {
				op: "continue",
				run: pending.run,
				decision: restored.decision,
				entry: { code: "async function main(mc){return {checkpoint:mc.checkpoint};}" },
			}),
		);
		const final = (await record(pending.run)).value;
		assert.deepEqual((final as { value?: { checkpoint: unknown } }).value?.checkpoint, { tag: "reopen" });
	});
}
