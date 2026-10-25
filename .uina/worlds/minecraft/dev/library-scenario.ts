import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResultEvent } from "../../../../src/runtime/events.js";

interface Scenario {
	dataRoot: string;
	direct(action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	ask(action: string, params: Record<string, unknown>): Promise<ToolResultEvent>;
	finish(reply: ToolResultEvent): Promise<{ snapshot: { run: string; outcome?: string } }>;
	step(name: string, work: () => Promise<void>): Promise<void>;
}
export async function libraryScenario(s: Scenario): Promise<void> {
	const run = async (params: Record<string, unknown>) => {
		const result = await s.finish(await s.ask("run", params));
		assert.equal(result.snapshot.outcome, "succeeded", JSON.stringify(result));
		return result.snapshot.run;
	};
	let origin!: { run: string; segment: string; call: string },
		originalDigest = "";
	await s.step("real production and exact save from committed Call", async () => {
		const ref = await run({
			code: `async function main(mc,input){
      let missing=null;try{await mc.call('craft@1',{item:'iron_pickaxe',count:1});}catch(e){missing=e.code;}
      await mc.call('collect@1',{item:'oak_log',count:input.logs,radius:8});
      await mc.call('craft@1',{item:'oak_planks',count:input.logs*4});
      return {missing,inventory:(await mc.read('inventory@1')).value.counts};
    }`,
			input: { logs: 1 },
		});
		const calls = await s.direct("runs", { op: "calls", run: ref });
		const call = (
			calls.items as { run: string; segment: string; call: string; parent: string | null; implementation: string }[]
		).find((c) => c.parent === null && c.implementation === "program")!;
		origin = { run: call.run, segment: call.segment, call: call.call };
		const saved = await s.direct("library", {
			op: "save",
			name: "plank_batch",
			summary: "Collect nearby logs and craft planks; assumes reachable logs",
			from: origin,
			tags: ["wood", "production"],
		});
		originalDigest = saved.digest as string;
		const material = await s.direct("library", { op: "get", name: "plank_batch" });
		assert.equal((material.savedFrom as { call: string }).call, origin.call);
		const record = await s.direct("runs", { op: "record", ref });
		assert.equal((record.record as { value: { value: { missing: string } } }).value.value.missing, "MISSING_MATERIAL");
	});
	await s.step("unified discovery, source replacement and new real production", async () => {
		const found = await s.direct("describe", { query: "plank_batch" });
		assert.ok(
			(found.items as { kind: string; name: string }[]).some((e) => e.kind === "program" && e.name === "plank_batch"),
		);
		const description = await s.direct("describe", { selector: "plank_batch" });
		assert.equal((description.program as { source?: string }).source, undefined);
		const current = await s.direct("library", { op: "get", name: "plank_batch" });
		await s.direct("library", {
			op: "update",
			name: "plank_batch",
			expectedDigest: current.digest,
			source: (current.source as string).replace(
				"return {missing,inventory:",
				"return {revision:'v2',missing,inventory:",
			),
		});
		const ref = await run({ selector: "plank_batch", input: { logs: 1 } });
		const record = await s.direct("runs", { op: "record", ref });
		assert.equal((record.record as { value: { value: { revision: string } } }).value.value.revision, "v2");
		const inventory = await s.direct("observe", { selector: "inventory@1" });
		assert.ok((inventory.value as { counts: Record<string, number> }).counts.oak_planks >= 8);
		assert.notEqual((await s.direct("library", { op: "get", name: "plank_batch" })).digest, originalDigest);
	});
	await s.step("a running segment keeps its named material while the working file changes", async () => {
		await s.direct("library", {
			op: "save",
			name: "echo_fixed",
			summary: "old",
			source: "async function main(){return 'old';}",
		});
		const reply = await s.ask("run", {
			code: "async function main(mc){const a=await mc.call('echo_fixed');mc.progress({summary:'material fixed'});await mc.sleep(6500);return [a,await mc.call('echo_fixed')];}",
		});
		assert.equal((reply.details as { kind: string }).kind, "accepted", reply.result);
		await s.direct("library", { op: "update", name: "echo_fixed", source: "async function main(){return 'new';}" });
		const completed = await s.finish(reply);
		const record = await s.direct("runs", { op: "record", ref: completed.snapshot.run });
		assert.deepEqual((record.record as { value: { value: string[] } }).value.value, ["old", "old"]);
		const next = await run({ selector: "echo_fixed" });
		const nextRecord = await s.direct("runs", { op: "record", ref: next });
		assert.equal((nextRecord.record as { value: { value: string } }).value.value, "new");
	});
	await s.step("experience and raw blueprint use the same formal Library", async () => {
		await s.direct("library", {
			op: "save",
			kind: "experience",
			name: "plank_batch",
			text: '<!-- uina {"summary":"Nearby logs enabled this production task","tags":["wood"]} -->\nThis is a conditional observation, not a universal guarantee.',
		});
		const directory = join(s.dataRoot, "blueprints", "plank_batch");
		await mkdir(directory, { recursive: true });
		const raw = Buffer.from([0, 10, 255, 2]);
		await writeFile(join(directory, "design.schem"), raw);
		await s.direct("library", {
			op: "save",
			kind: "blueprint",
			name: "plank_batch",
			summary: "Raw fixture; format validity is unverified",
		});
		const blue = await s.direct("library", { op: "get", kind: "blueprint", name: "plank_batch" });
		assert.equal(blue.size, raw.length);
		assert.deepEqual(await readFile(join(directory, "design.schem")), raw);
		const found = await s.direct("describe", { query: "plank_batch" });
		assert.deepEqual(
			(found.items as { kind: string }[]).map((e) => e.kind),
			["blueprint", "experience", "program"],
		);
		await s.direct("library", { op: "delete", kind: "blueprint", name: "plank_batch" });
		await s.direct("library", { op: "delete", name: "plank_batch" });
		await s.direct("library", {
			op: "save",
			name: "plank_restored",
			summary: "Restored from original execution after deletion",
			from: origin,
		});
		assert.ok((await s.direct("library", { op: "get", name: "plank_restored" })).source);
	});
}
