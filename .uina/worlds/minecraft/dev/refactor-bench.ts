import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../contracts/runtime.js";
import { openHarness, sleep } from "./harness.js";
import { makeScenario } from "./scenario.js";

const argument = process.argv[2] ?? "10";
const disconnectMode =
	argument === "--disconnect-native" ? "native" : argument === "--disconnect-program" ? "program" : null;
const faults = argument === "--faults";
const rounds = faults || disconnectMode ? 0 : Number(argument);
assert(
	Number.isInteger(rounds) && (rounds >= 1 || faults || disconnectMode),
	"pass a positive round count or a fault scenario",
);
const fence = String.fromCharCode(96).repeat(3);
async function example(name: string): Promise<string> {
	const guide = await readFile(new URL(`../companion/guides/${name}.md`, import.meta.url), "utf8");
	const script = guide
		.replace(/\r\n/g, "\n")
		.split(fence + "js\n")
		.at(-1)
		?.split("\n" + fence)[0];
	assert(script && script.startsWith("async function main"), "missing runnable guide example");
	return script;
}

const [collect, build] = await Promise.all([example("mining_playbook"), example("building_playbook")]);
const dataRoot = await mkdtemp(join(tmpdir(), "uina-mc-refactor-bench-"));
const h = await openHarness("refactor-bench", { dataRoot });
const s = makeScenario(h, "refactor-bench");
const user = h.bot.username;
const owner = { worldOwner: h.worldOwner, activation: h.activation };
let seq = 0;
async function run(entry: Entry) {
	const requestId = `bench:${++seq}`;
	const started = performance.now();
	const accepted = await h.runtime.submit(owner, { requestId, entry, schedule: { kind: "enqueue" } });
	assert(accepted.kind === "accepted", JSON.stringify(accepted));
	const { run } = accepted.snapshot;
	const reply = await h.runtime.wait(run, { timeoutMs: 90000 });
	if (reply.kind !== "result") await h.runtime.stop({ requestId: `stop:${requestId}`, target: { run } });
	assert(reply.kind === "result", JSON.stringify(reply));
	const elapsedMs = Math.round(performance.now() - started);
	const record = await h.runtime.readRecord(reply.snapshot.record);
	const detail = record.kind === "inline" ? record.record.value : null;
	return { snapshot: reply.snapshot, elapsedMs, detail };
}

const program = (code: string, input: Entry["input"]): Entry => ({ kind: "program", source: { code }, input });
const gathering = (mode: "program" | "native", input: Entry["input"]): Entry =>
	mode === "program" ? program(collect, input) : { kind: "call", selector: "collect@1", input };
async function reset(tools: string | null) {
	await s.command(`/gamemode creative ${user}`);
	await s.command(`/tp ${user} 8.5 100 8.5`);
	await s.command(`/clear ${user}`);
	await s.command("/kill @e[type=minecraft:item,distance=..32]");
	if (tools) await s.command(`/give ${user} ${tools}`);
	await s.command(`/gamemode survival ${user}`);
}

try {
	await s.command(`/gamemode creative ${user}`);
	await s.command(`/tp ${user} 8.5 103 8.5`);
	await sleep(1000);
	await s.command("/fill 4 99 4 29 99 13 stone");
	await s.command("/time set day");

	if (disconnectMode) {
		await reset("diamond_axe 1");
		await s.command("/fill 12 100 8 13 100 8 oak_log");
		const client = h.bot._client;
		const write = client.write.bind(client);
		let dispatched = 0;
		client.write = (name, payload) => {
			write(name, payload);
			if (name === "block_dig" && payload.status === 2) {
				dispatched++;
				h.bot.end("refactor probe: disconnected immediately after dig dispatch");
			}
		};
		const result = await run(gathering(disconnectMode, { item: "oak_log", count: 2, radius: 8 }));
		assert.equal(dispatched, 1);
		assert(result.snapshot.phase === "finished" && result.snapshot.outcome !== "succeeded", JSON.stringify(result));
		assert(result.snapshot.unknownEffectCount > 0, JSON.stringify(result));
		console.log("BENCH disconnect " + JSON.stringify({ mode: disconnectMode, dispatched, snapshot: result.snapshot }));
	} else if (faults) {
		for (const mode of ["native", "program"] as const) {
			for (const fault of ["full", "missing-tool", "existing-drop", "unreachable"] as const) {
				await reset(fault === "full" ? "cobblestone 2304" : fault === "missing-tool" ? null : "diamond_axe 1");
				await s.command("/fill 12 100 8 27 100 8 air");
				await s.command("/setblock 12 100 8 air");
				await s.command("/setblock 12 120 8 air");
				const item = fault === "missing-tool" ? "raw_iron" : "oak_log";
				const y = fault === "unreachable" ? 120 : 100;
				const block = fault === "missing-tool" ? "iron_ore" : "oak_log";
				await s.command("/setblock 12 " + y + " 8 " + block);
				if (fault === "existing-drop")
					await s.command('/summon item 10.5 100 8.5 {Item:{id:"minecraft:oak_log",count:1}}');
				const result = await run(gathering(mode, { item, radius: 8, count: 1 }));
				const unchanged = await s.serverBlock({ x: 12, y, z: 8 }, block);
				assert(result.snapshot.phase === "finished" || result.snapshot.phase === "awaiting_decision");
				if (fault !== "existing-drop") {
					assert(unchanged, JSON.stringify(result));
					assert(
						result.snapshot.phase !== "finished" || result.snapshot.outcome !== "succeeded",
						JSON.stringify(result),
					);
				} else {
					const inventory = await s.serverInventory();
					assert.equal(inventory.source, "server");
					assert((inventory.counts.oak_log ?? 0) >= 1, JSON.stringify(inventory));
				}
				console.log(
					"BENCH fault " + JSON.stringify({ mode, fault, unchanged, snapshot: result.snapshot, detail: result.detail }),
				);
			}
		}
	} else {
		await reset("oak_log 1");
		await s.command("/setblock 10 100 8 air");
		await s.command("/setblock 10 100 9 air");
		await s.command("/setblock 9 100 8 diamond_block");
		const structure = [
			{ at: { x: 10, y: 100, z: 8 }, block: { name: "oak_log", properties: { axis: "y" } } },
			{ at: { x: 10, y: 100, z: 9 }, block: { name: "oak_log", properties: { axis: "y" } } },
		];
		const partial = await run(program(build, { cells: structure }));
		assert.equal(partial.snapshot.phase, "awaiting_decision", JSON.stringify(partial));
		assert(await s.serverBlock({ x: 10, y: 100, z: 8 }, "oak_log[axis=y]"));
		assert(await s.serverBlock({ x: 10, y: 100, z: 9 }, "air"));
		assert(await s.serverBlock({ x: 9, y: 100, z: 8 }, "diamond_block"));
		await s.command(`/give ${user} oak_log 1`);
		const built = await run(program(build, { cells: structure }));
		assert(built.snapshot.phase === "finished" && built.snapshot.outcome === "succeeded", JSON.stringify(built));
		assert(await s.serverBlock({ x: 10, y: 100, z: 9 }, "oak_log[axis=y]"));
		assert(await s.serverBlock({ x: 9, y: 100, z: 8 }, "diamond_block"));
		await s.command("/setblock 10 100 8 air");
		await s.command("/setblock 10 100 9 air");
		await s.command("/setblock 9 100 8 air");
		console.log("BENCH build: partial, oriented completion and preservation confirmed by Paper");

		await reset("diamond_axe 1");
		await s.command("/setblock 15 100 10 oak_log");
		const short = await run(program(collect, { count: 1, radius: 4 }));
		assert.equal(short.snapshot.phase, "awaiting_decision", JSON.stringify(short));
		assert(await s.serverBlock({ x: 15, y: 100, z: 10 }, "oak_log"));
		const edited = collect.replace("input.radius ?? 16", "input.radius ?? 8");
		assert.notEqual(edited, collect);
		const wider = await run(program(edited, { count: 1 }));
		assert(wider.snapshot.phase === "finished" && wider.snapshot.outcome === "succeeded", JSON.stringify(wider));
		const widened = await s.serverInventory();
		assert.equal(widened.source, "server");
		assert.equal(widened.counts.oak_log, 1);
		console.log("BENCH copied Program: edited radius changed the server outcome");

		const samples = { program: [] as number[], native: [] as number[] };
		for (let index = 0; index < rounds; index++) {
			const modes = index % 2 === 0 ? (["native", "program"] as const) : (["program", "native"] as const);
			for (const mode of modes) {
				await reset("diamond_axe 1");
				await s.command("/fill 12 100 8 27 100 8 oak_log");
				const before = await s.serverInventory();
				assert.equal(before.source, "server");
				assert.equal(before.counts.oak_log ?? 0, 0);
				const input = { item: "oak_log", radius: 32, count: 16 };
				const result = await run(gathering(mode, input));
				const after = await s.serverInventory();
				console.log(
					"BENCH " +
						JSON.stringify({ index: index + 1, mode, elapsedMs: result.elapsedMs, after, detail: result.detail }),
				);
				assert(result.snapshot.phase === "finished" && result.snapshot.outcome === "succeeded", JSON.stringify(result));
				assert.equal(after.source, "server");
				assert.equal(after.counts.oak_log, 16);
				samples[mode].push(result.elapsedMs);
			}
		}
		const stats = (values: number[]) => {
			const sorted = [...values].sort((a, b) => a - b);
			return {
				median: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
				p90: sorted[Math.ceil(sorted.length * 0.9) - 1]!,
			};
		};
		const native = stats(samples.native);
		const guest = stats(samples.program);
		console.log(
			"BENCH summary " +
				JSON.stringify({
					rounds,
					native,
					program: guest,
					withinBudget: guest.median <= native.median * 1.15 && guest.p90 <= native.p90 * 1.25,
				}),
		);
	}
} finally {
	await h.close();
}
