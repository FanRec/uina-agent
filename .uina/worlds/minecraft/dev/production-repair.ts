/** Focused production repair acceptance on the existing Paper 1.21.11 test platform.
 * Preparation uses op commands; tested effects use the Runtime/Driver capability route.
 * This does not reset the server. Normal production-chain acceptance remains dev:mc:k3.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemValue } from "../contracts/body.js";
import type { RunSummary } from "../contracts/runtime.js";
import type { JsonValue } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario, type CallResult } from "./scenario.js";

interface Inventory {
	slots: ({ slot: number } & ItemValue)[];
	counts: Record<string, number>;
}
interface Container {
	slots: { region?: string; name: string; count: number }[];
}
function checked<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function until<T>(
	probe: () => Promise<T>,
	matches: (value: T) => boolean,
	label: string,
	timeoutMs = 5000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (matches(value)) return value;
		if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(value)}`);
		await sleep(100);
	}
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-production-repair-"));
	const h = await openHarness("production-repair", {
		dataRoot,
		binding: { world: "world:paper-dev", worldRevision: `revision:production-repair-${Date.now()}` },
	});
	const s = makeScenario(h, "production-repair");
	const user = h.bot.username;
	const pendingRuns = new Set<string>();
	const base = { x: 10000, y: 200, z: 10000 };
	const furnace = { x: base.x + 2, y: base.y, z: base.z };
	const inventory = async (): Promise<Inventory> =>
		(await h.world.read<Inventory>({ ref: "inventory@1", input: {} })).value;
	const count = async (name: string): Promise<number> => (await inventory()).counts[name] ?? 0;
	const resetItems = async () => {
		await s.command(`/clear ${user}`);
		await s.command(`/kill @e[type=minecraft:item,distance=..16]`);
	};
	const resetFurnace = async () => {
		await stopPending();
		await s.command(`/setblock ${furnace.x} ${furnace.y} ${furnace.z} minecraft:air`);
		await s.command(`/setblock ${furnace.x} ${furnace.y} ${furnace.z} minecraft:furnace`);
	};
	const itemAt = async (slot: number, item: string, amount: number) => {
		const location = slot < 27 ? `inventory.${slot}` : `hotbar.${slot - 27}`;
		await s.command(`/item replace entity ${user} ${location} with minecraft:${item} ${amount}`);
	};
	const fillInventory = async () => {
		await resetItems();
		for (let slot = 0; slot < 36; slot++) await itemAt(slot, "dirt", 64);
	};
	let sequence = 0;
	const submit = async (selector: string, input: JsonValue): Promise<string> => {
		const acceptance = await h.runtime.submit(
			{ worldOwner: h.worldOwner, activation: h.activation },
			{
				requestId: `req:${h.ns}:production-${++sequence}`,
				entry: { kind: "call", selector, input },
				schedule: { kind: "enqueue" },
			},
		);
		assert(acceptance.kind === "accepted", JSON.stringify(acceptance));
		pendingRuns.add(acceptance.snapshot.run);
		return acceptance.snapshot.run;
	};
	const finish = async (run: string, timeoutMs = 90000): Promise<Extract<RunSummary, { phase: "finished" }>> => {
		const reply = await h.runtime.wait(run, { timeoutMs });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
			await h.runtime.stop({ requestId: `stop:${run}`, target: { run } });
			throw new Error(`Run did not finish: ${JSON.stringify(reply)}`);
		}
		pendingRuns.delete(run);
		return reply.snapshot;
	};
	const stopPending = async () => {
		for (const run of pendingRuns) {
			await h.runtime.stop({ requestId: `cleanup:${run}`, target: { run } });
			await finish(run, 10000);
		}
	};
	// Count the actual outgoing packets only in this acceptance harness. Snapshot and
	// progress messages cannot accidentally stand in for proof of no late interaction.
	const client = h.bot._client;
	const originalWrite = client.write;
	const writes = { opens: 0, clicks: 0 };
	client.write = function (this: typeof client, name: string, ...args: unknown[]) {
		if (name === "block_place") writes.opens++;
		if (name === "window_click") writes.clicks++;
		return Reflect.apply(originalWrite, this, [name, ...args]);
	} as typeof originalWrite;
	let prepared = false;
	try {
		await s.step("prepare the existing dedicated Paper test platform", async () => {
			assert(h.bot.version === "1.21.11", `unexpected server version ${h.bot.version}`);
			await s.command(`/gamemode creative ${user}`);
			await s.command(`/tp ${user} 10000.5 205 10000.5`);
			await until(
				() => s.readBlock({ ...base, y: 199 }),
				(value) => value !== null,
				"test chunk unavailable",
				15000,
			);
			await s.command(`/fill 9996 199 9996 10004 199 10004 minecraft:stone`);
			await s.command(`/fill 9996 200 9996 10004 203 10004 minecraft:air`);
			await s.command(`/tp ${user} 10000.5 200 10000.5`);
			await waitForStill(h.bot, s.log);
			await s.command(`/gamemode survival ${user}`);
			assert((await s.readSelf()).onGround, "player did not settle on test platform");
			prepared = true;
			return `Paper=${h.bot.version} dataRoot=${dataRoot}`;
		});
		if (!prepared) return;

		await s.step("full inventory: consuming the final log frees its output slot", async () => {
			await fillInventory();
			await itemAt(0, "oak_log", 1);
			checked(await s.call("craft@1", { item: "oak_planks", count: 4 }));
			const after = await inventory();
			assert(after.counts.oak_planks === 4 && !after.counts.oak_log, JSON.stringify(after));
			assert(after.counts.dirt === 35 * 64, `dirt=${after.counts.dirt}`);
			assert(h.bot.currentWindow == null, "craft window remains open");
			return "oak_log=0 oak_planks=4 dirt=2240";
		});

		await s.step("craft output splits across two compatible partial stick stacks", async () => {
			await fillInventory();
			await itemAt(0, "stick", 62);
			await itemAt(1, "stick", 62);
			await itemAt(2, "oak_planks", 64);
			checked(await s.call("craft@1", { item: "stick", count: 4 }));
			const after = await inventory();
			assert(after.counts.stick === 128 && after.counts.oak_planks === 62, JSON.stringify(after));
			assert(
				after.slots.filter((slot) => slot.name === "stick").every((slot) => slot.count === 64),
				JSON.stringify(after),
			);
			return "stick stacks=64+64 oak_planks=62";
		});

		await s.step("plain output skips the earlier custom-named stick stack", async () => {
			await fillInventory();
			await itemAt(0, `stick[custom_name='{"text":"production-repair-named"}']`, 60);
			await itemAt(1, "stick", 60);
			await itemAt(2, "oak_planks", 64);
			const namedBefore = (await inventory()).slots.find((slot) => slot.name === "stick" && slot.components != null);
			assert(namedBefore != null, "named stick components were not observed");
			checked(await s.call("craft@1", { item: "stick", count: 4 }));
			const after = await inventory();
			const namedAfter = after.slots.find((slot) => slot.slot === namedBefore.slot);
			assert(
				namedAfter?.count === 60 && JSON.stringify(namedAfter.components) === JSON.stringify(namedBefore.components),
				JSON.stringify(after),
			);
			assert(
				after.slots.some((slot) => slot.name === "stick" && slot.count === 64),
				JSON.stringify(after),
			);
			assert(after.counts.oak_planks === 62, JSON.stringify(after));
			return "named stick=60 unchanged; plain stick=64";
		});

		await s.step("64 bamboo can load only 16 of 64 raw iron for wait:false", async () => {
			await resetFurnace();
			await resetItems();
			await s.command(`/give ${user} minecraft:raw_iron 64`);
			await s.command(`/give ${user} minecraft:bamboo 64`);
			const value = checked<{ loaded: { input: { count: number }; fuel: { count: number } }; remaining: number }>(
				await s.call("smelt@1", {
					item: "iron_ingot",
					count: 64,
					fuel: "bamboo",
					at: plain(furnace),
					wait: false,
				}),
			);
			assert(
				value.loaded.input.count === 16 && value.loaded.fuel.count === 64 && value.remaining === 48,
				JSON.stringify(value),
			);
			assert((await count("raw_iron")) === 48 && (await count("bamboo")) === 0, JSON.stringify(await inventory()));
			const view = checked<Container>(await s.call("container@1", { at: plain(furnace) }));
			const input = view.slots.filter((slot) => slot.region === "input").reduce((n, slot) => n + slot.count, 0);
			const output = view.slots.filter((slot) => slot.region === "result").reduce((n, slot) => n + slot.count, 0);
			assert(input + output === 16, JSON.stringify(view));
			return "inventory raw_iron=48; furnace input+output=16; bamboo transferred=64";
		});

		await s.step("three-iron waiting smelt releases body for another action", async () => {
			await resetFurnace();
			await resetItems();
			await s.command(`/give ${user} minecraft:raw_iron 3`);
			await s.command(`/give ${user} minecraft:coal 1`);
			const run = await submit("smelt@1", {
				item: "iron_ingot",
				count: 3,
				fuel: "coal",
				at: plain(furnace),
				maxTimeMs: 60000,
			});
			await until(inventory, (value) => !value.counts.raw_iron && !value.counts.coal, "smelt did not load");
			await until(
				async () => h.bot.currentWindow == null,
				(value) => value,
				"smelt window stayed open",
			);
			checked(await s.call("equip@1", { item: null, slot: "hand" }, 5000));
			assert(h.runtime.read(run).phase !== "finished", "body action did not finish before smelting");
			const result = await finish(run);
			assert(result.outcome === "succeeded", JSON.stringify(result));
			assert((await count("iron_ingot")) === 3, JSON.stringify(await inventory()));
			return "equip completed during wait; inventory iron_ingot=3";
		});

		await s.step("stopped wait never reopens or clicks; loaded iron still smelts and can be transferred", async () => {
			await resetFurnace();
			await resetItems();
			await s.command(`/give ${user} minecraft:raw_iron 3`);
			await s.command(`/give ${user} minecraft:coal 1`);
			const run = await submit("smelt@1", {
				item: "iron_ingot",
				count: 3,
				fuel: "coal",
				at: plain(furnace),
				maxTimeMs: 60000,
			});
			await until(inventory, (value) => !value.counts.raw_iron && !value.counts.coal, "smelt did not load");
			await until(
				async () => h.bot.currentWindow == null,
				(value) => value,
				"waiting window stayed open",
			);
			await h.runtime.stop({ requestId: `stop:${run}`, target: { run } });
			const result = await finish(run, 10000);
			assert(result.outcome === "cancelled", JSON.stringify(result));
			const stoppedWrites = { ...writes };
			// Exceed the 3-item estimated wait: catches a stale timer's late reopen.
			await sleep(33000);
			assert(
				writes.opens === stoppedWrites.opens && writes.clicks === stoppedWrites.clicks,
				`late packets ${JSON.stringify({ stoppedWrites, writes })}`,
			);
			assert((await count("iron_ingot")) === 0, "cancelled smelt harvested output");
			const view = checked<Container>(await s.call("container@1", { at: plain(furnace) }));
			assert(
				view.slots.some((slot) => slot.region === "result" && slot.name === "iron_ingot" && slot.count === 3),
				JSON.stringify(view),
			);
			checked(await s.call("transfer@1", { from: plain(furnace), item: "iron_ingot", count: 3 }));
			assert((await count("iron_ingot")) === 3, JSON.stringify(await inventory()));
			return `no late open/click packets; eventual transfer iron_ingot=3; ${dataRoot}`;
		});
	} finally {
		client.write = originalWrite;
		s.finish();
		try {
			await stopPending();
		} finally {
			await closeHarness(h);
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
