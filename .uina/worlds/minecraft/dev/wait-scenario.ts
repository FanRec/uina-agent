import assert from "node:assert/strict";
import type { ToolResultEvent } from "../../../../src/runtime/events.js";

interface Scenario {
	direct(action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	ask(action: string, params: Record<string, unknown>): Promise<ToolResultEvent>;
	finish(reply: ToolResultEvent): Promise<{ snapshot: { run: string; outcome?: string } }>;
	step(name: string, work: () => Promise<void>): Promise<void>;
}
export async function waitScenario(s: Scenario): Promise<void> {
	const completed = async (reply: ToolResultEvent) => {
		const r = await s.finish(reply);
		assert.equal(r.snapshot.outcome, "succeeded", JSON.stringify(r));
		return r.snapshot.run;
	};
	const value = async (run: string) =>
		(await s.direct("runs", { op: "record", ref: run })).record as { value: { value: Record<string, unknown> } };
	let eventRun = "";
	await s.step("events baseline -> chat -> committed incremental wait", async () => {
		eventRun = await completed(
			await s.ask("run", {
				code: `async function main(mc,input){
   const baseline=await mc.read('events@1',{kinds:['chat'],limit:200});
   await mc.call('chat@1',{text:input.text});
   return mc.waitUntil({messages:{ref:'events@1',input:{after:baseline.value.after,limit:200}}},
    s=>s.messages.events.some(e=>typeof e.payload.text==='string'&&e.payload.text.includes(input.text)),{timeoutMs:10000});
  }`,
				input: { text: "uina-wait-source-echo" },
			}),
		);
		assert.equal((await value(eventRun)).value.value.kind, "met");
	});
	await s.step("inventory waiter allows real collection and crafting in a second Run", async () => {
		const waiting = await s.ask("run", {
			code: "async function main(mc){return mc.waitUntil({inv:{ref:'inventory@1'}},s=>(s.inv?.counts.oak_planks??0)>=4,{timeoutMs:30000});}",
		});
		assert.equal((waiting.details as { kind: string }).kind, "accepted");
		const status = await s.direct("runs", {
			op: "status",
			run: (waiting.details as { snapshot: { run: string } }).snapshot.run,
		});
		assert.equal(status.phase, "waiting");
		assert.equal((status.waiting as { kind: string }).kind, "world_change");
		await completed(
			await s.ask("run", {
				code: "async function main(mc){await mc.call('collect@1',{item:'oak_log',count:1,radius:8});return mc.call('craft@1',{item:'oak_planks',count:4});}",
			}),
		);
		const run = await completed(waiting);
		assert.equal((await value(run)).value.value.kind, "met");
	});
	await s.step("body-held waiting queues the next owner; explicit stop releases it", async () => {
		const held = await s.ask("run", {
			code: "async function main(mc){return mc.withBody(()=>mc.waitUntil({inv:{ref:'inventory@1'}},s=>(s.inv?.counts.diamond??0)>=64));}",
		});
		assert.equal((held.details as { kind: string }).kind, "accepted");
		const run = (held.details as { snapshot: { run: string } }).snapshot.run;
		const status = await s.direct("runs", { op: "status", run });
		assert.equal(status.control, "active");
		assert.equal(status.phase, "waiting");
		const next = await s.ask("run", {
			code: "async function main(mc){return mc.withBody(b=>b.lookAt({x:16002,y:201,z:16000}));}",
		});
		assert.equal((next.details as { kind: string }).kind, "accepted");
		await s.direct("runs", { op: "stop", run });
		const result = await s.finish(held);
		assert.equal(result.snapshot.outcome, "cancelled");
		await completed(next);
	});
	await s.step("save the exact waiting program and execute its named material", async () => {
		const calls = await s.direct("runs", { op: "calls", run: eventRun });
		const root = (calls.items as { run: string; segment: string; call: string; parent: string | null }[]).find(
			(c) => c.parent === null,
		)!;
		await s.direct("library", {
			op: "save",
			name: "wait_echo",
			summary: "Wait for an observed chat echo",
			from: { run: root.run, segment: root.segment, call: root.call },
		});
		const run = await completed(await s.ask("run", { selector: "wait_echo", input: { text: "uina-wait-named-echo" } }));
		assert.equal((await value(run)).value.value.kind, "met");
	});
	await s.step("zero deadline returns the final real inventory observation", async () => {
		const run = await completed(
			await s.ask("run", {
				code: "async function main(mc){return mc.waitUntil({inv:{ref:'inventory@1'}},s=>(s.inv?.counts.diamond??0)>=64,{timeoutMs:0});}",
			}),
		);
		assert.equal((await value(run)).value.value.kind, "timeout");
	});
}
