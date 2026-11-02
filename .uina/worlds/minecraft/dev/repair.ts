/** Repair acceptance on the existing dedicated Paper world; all tested effects use Runtime/Driver. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemSelector, ItemValue, SelfState, TossOutcome } from "../contracts/body.js";
import type { CallContext, NativeCallable } from "../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import { protocolFor } from "../driver/mineflayer/protocol.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

function devCallable(
	ref: `${string}@${string}`,
	invoke: (ctx: CallContext, input: JsonValue) => Promise<JsonValue>,
): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: {
			ref,
			summary: "Repair acceptance through the public body contract",
			input: { type: "object" },
			output: { type: "object" },
			access: "act",
			implementation: "native",
			completion: { scope: "capability", description: "actual Driver operation result" },
			errors: [],
			requires: ["connection", "body"],
			examples: [],
		},
		invoke,
	};
}

const toss = devCallable("dev.repair.toss@1", async (ctx, input) => {
	const { item, count } = input as unknown as { item: ItemSelector; count: number };
	return plain(await ctx.withBody((scope) => scope.player.toss(item, count)));
});
const cancelMine = devCallable("dev.repair.mine@1", async (ctx, input) => {
	const { at } = input as unknown as { at: Vec3 };
	const self = (await ctx.world.read<SelfState>({ ref: "self@1", input: {} })).value;
	return ctx.withBody(async (scope) => {
		await ctx.progress({ stage: "body-held" });
		return plain(await scope.player.dig({ place: { ...self.place, position: at }, block: at }));
	});
});
const cancelSign = devCallable("dev.repair.sign@1", async (ctx, input) => {
	const { at } = input as unknown as { at: Vec3 };
	const self = (await ctx.world.read<SelfState>({ ref: "self@1", input: {} })).value;
	return ctx.withBody(async (scope) => {
		await scope.player.equip(null, "hand");
		return plain(
			await scope.player.writeSign(
				{ place: { ...self.place, position: at }, block: at },
				{ side: "front", lines: ["must_not_commit", "", "", ""] },
			),
		);
	});
});

interface Inventory {
	slots: ({ slot: number } & ItemValue)[];
	counts: Record<string, number>;
	held?: ItemValue;
}

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
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
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-repair-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:repair-${Date.now()}` };
	let h = await openHarness("repair", { dataRoot, binding, callables: [toss, cancelMine, cancelSign] });
	const s = makeScenario(h, "repair");
	const username = h.bot.username;
	const base = { x: 10000, y: 200, z: 10000 };
	const ore = { x: base.x + 2, y: base.y, z: base.z };
	const chest = { x: base.x - 2, y: base.y, z: base.z };
	const sign = { x: base.x, y: base.y, z: base.z + 2 };
	const inventory = async (): Promise<Inventory> =>
		(await h.world.read<Inventory>({ ref: "inventory@1", input: {} })).value;
	const resetItems = async () => {
		await s.command(`/clear ${username}`);
		await s.command(`/kill @e[type=minecraft:item,distance=..16]`);
	};
	const setBlock = async (at: Vec3, block: string) => {
		await s.command(`/setblock ${at.x} ${at.y} ${at.z} ${block}`);
		await until(
			() => s.readBlock(at),
			(value) => value?.name === block.split("[")[0].replace("minecraft:", ""),
			"setblock was not observed",
		);
	};
	const readSignData = async (expected: string): Promise<string> => {
		const messages: string[] = [];
		const onMessage = (text: string): void => {
			messages.push(text);
		};
		h.bot.on("messagestr", onMessage);
		try {
			await s.command(`/data get block ${sign.x} ${sign.y} ${sign.z} front_text.messages`);
			await until(
				async () => messages,
				(values) => values.some((text) => text.includes(expected)),
				"server sign data did not match",
			);
			return messages.find((text) => text.includes(expected))!;
		} finally {
			h.bot.removeListener("messagestr", onMessage);
		}
	};
	const submit = async (selector: string, input: JsonValue) => {
		const requestId = `req:${h.ns}:repair-${Date.now()}`;
		const accepted = await h.runtime.submit(
			{ worldOwner: h.worldOwner, activation: h.activation },
			{ requestId, entry: { kind: "call", selector, input }, schedule: { kind: "enqueue" } },
		);
		if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
		return { requestId, run: accepted.snapshot.run };
	};
	const cancelled = async (run: string) => {
		const reply = await h.runtime.wait(run, { timeoutMs: 10000 });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished" || reply.snapshot.outcome !== "cancelled")
			throw new Error(`expected cancelled: ${JSON.stringify(reply)}`);
		return reply.snapshot;
	};
	let prepared = false;
	try {
		await s.step("prepare existing dedicated test area and isolated runtime data", async () => {
			await s.command(`/gamemode creative ${username}`);
			await s.command(`/tp ${username} 10000.5 205 10000.5`);
			await until(
				() => s.readBlock({ x: base.x, y: 199, z: base.z }),
				(value) => value !== null,
				"test chunk did not load",
				15000,
			);
			await s.command(`/fill 9996 199 9996 10004 199 10004 minecraft:stone`);
			await s.command(`/fill 9996 200 9996 10004 203 10004 minecraft:air`);
			await s.command(`/tp ${username} 10000.5 200 10000.5`);
			await waitForStill(h.bot, s.log);
			const self = await s.readSelf();
			if (!self.onGround || Math.abs(self.place.position.y - 200) > 0.1)
				throw new Error(`platform not ready: ${JSON.stringify(self.place)}`);
			await s.command(`/gamemode survival ${username}`);
			await resetItems();
			prepared = true;
			return h.dataRoot;
		});
		if (!prepared) {
			s.finish();
			return;
		}
		await s.step("golden pickaxe cannot harvest diamond ore; rejection preserves the block", async () => {
			await setBlock(ore, "minecraft:diamond_ore");
			await s.command(`/give ${username} minecraft:golden_pickaxe 1`);
			const block = (
				await h.world.read<{ block: { harvest: { ok: boolean; requiredTools: string[] } } }>({
					ref: "block@1",
					input: { at: plain(ore) },
				})
			).value.block;
			if (block.harvest.ok || block.harvest.requiredTools.includes("golden_pickaxe"))
				throw new Error(JSON.stringify(block));
			const result = await s.call("mine@1", { at: plain(ore), tool: "golden_pickaxe", collect: false });
			if (result.ok || result.code !== "MISSING_TOOL" || (await s.readBlock(ore))?.name !== "diamond_ore")
				throw new Error(JSON.stringify(result));
			return "MISSING_TOOL; diamond ore unchanged";
		});
		await s.step("copper pickaxe harvests iron ore with a real server-confirmed break", async () => {
			await resetItems();
			await setBlock(ore, "minecraft:iron_ore");
			await s.command(`/give ${username} minecraft:copper_pickaxe 1`);
			const block = (
				await h.world.read<{ block: { harvest: { ok: boolean } } }>({ ref: "block@1", input: { at: plain(ore) } })
			).value.block;
			if (!block.harvest.ok) throw new Error("query rejected copper for iron");
			const value = valueOf<{ broken: boolean; tool: string }>(
				await s.call("mine@1", { at: plain(ore), tool: "copper_pickaxe", collect: false }),
			);
			if (!value.broken || value.tool !== "copper_pickaxe" || (await s.readBlock(ore))?.name !== "air")
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("automatic mining selects iron over ineligible gold for diamond", async () => {
			await resetItems();
			await setBlock(ore, "minecraft:diamond_ore");
			await s.command(`/give ${username} minecraft:golden_pickaxe 1`);
			await s.command(`/give ${username} minecraft:iron_pickaxe 1`);
			const value = valueOf<{ broken: boolean; tool: string }>(
				await s.call("mine@1", { at: plain(ore), collect: false }),
			);
			if (!value.broken || value.tool !== "iron_pickaxe" || (await s.readBlock(ore))?.name !== "air")
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("collect counts confirmed breaks and actually acquired dirt", async () => {
			await resetItems();
			await setBlock({ x: base.x + 1, y: base.y, z: base.z + 1 }, "minecraft:dirt");
			await setBlock({ x: base.x + 2, y: base.y, z: base.z + 1 }, "minecraft:dirt");
			const value = valueOf<{ mined: number; acquired: number; remaining: number }>(
				await s.call("collect@1", { item: "dirt", count: 2, radius: 4 }, 120000),
			);
			if (value.mined < 2 || value.acquired < 2 || value.remaining !== 0 || ((await inventory()).counts.dirt ?? 0) < 2)
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("equipment selection preserves components and remaining durability", async () => {
			await resetItems();
			await s.command(
				`/item replace entity ${username} inventory.0 with minecraft:iron_pickaxe[minecraft:damage=100] 1`,
			);
			await s.command(
				`/item replace entity ${username} inventory.1 with minecraft:iron_pickaxe[minecraft:damage=40] 1`,
			);
			const selected = (await inventory()).slots.find(
				(slot) => slot.name === "iron_pickaxe" && slot.durability === 210,
			);
			if (selected?.components == null)
				throw new Error(`complete item value unavailable: ${JSON.stringify(await inventory())}`);
			valueOf(
				await s.call("equip@1", {
					item: { name: "minecraft:iron_pickaxe", components: selected.components, minDurability: 200 },
				}),
			);
			if ((await inventory()).held?.durability !== 210) throw new Error("equipped the wrong damage variant");
			const value = valueOf<TossOutcome>(
				await s.call("dev.repair.toss@1", {
					item: { name: "iron_pickaxe", components: selected.components, minDurability: 200 },
					count: 1,
				}),
			);
			const remaining = (await inventory()).slots.filter((slot) => slot.name === "iron_pickaxe");
			if (
				value.receipt.completion !== "met" ||
				value.removed.iron_pickaxe !== 1 ||
				value.remaining !== 0 ||
				remaining.length !== 1 ||
				remaining[0]?.durability !== 150
			)
				throw new Error(JSON.stringify({ value, remaining }));
			await resetItems();
			await s.command(
				`/item replace entity ${username} inventory.0 with minecraft:iron_pickaxe[minecraft:max_damage=50,minecraft:damage=40] 1`,
			);
			const overridden = (await inventory()).slots.find((slot) => slot.name === "iron_pickaxe");
			if (overridden?.durability !== 10) throw new Error(`max_damage override ignored: ${JSON.stringify(overridden)}`);
			const rejected = await s.call("equip@1", { item: { name: "iron_pickaxe", minDurability: 100 } });
			if (rejected.ok || rejected.code !== "MISSING_MATERIAL")
				throw new Error(`invalid durability accepted: ${JSON.stringify(rejected)}`);
			return "selected durability=210; preserved 150; max_damage=50/damage=40 yields remaining=10 and rejects minDurability=100";
		});
		await s.step("precise toss confirms removed=3 and returns the cursor remainder", async () => {
			await resetItems();
			await s.command(`/give ${username} minecraft:dirt[minecraft:max_stack_size=16] 8`);
			if ((await inventory()).slots.find((slot) => slot.name === "dirt")?.stackSize !== 16)
				throw new Error("max_stack_size override ignored");
			const value = valueOf<TossOutcome>(await s.call("dev.repair.toss@1", { item: { name: "dirt" }, count: 3 }));
			if (
				value.receipt.completion !== "met" ||
				value.removed.dirt !== 3 ||
				value.remaining !== 0 ||
				(await inventory()).counts.dirt !== 5 ||
				h.bot.inventory.selectedItem != null
			)
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("public drop confirms each removed item name on the ground", async () => {
			await resetItems();
			await s.command(`/give ${username} minecraft:dirt 4`);
			const value = valueOf<{ dropped: Record<string, number>; remaining: number }>(
				await s.call("drop@1", { item: "dirt", count: 2 }),
			);
			if (value.dropped.dirt !== 2 || value.remaining !== 0 || (await inventory()).counts.dirt !== 2)
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("container transfer shares exact authoritative click semantics", async () => {
			await resetItems();
			await s.command(`/give ${username} minecraft:dirt 8`);
			await setBlock(chest, "minecraft:barrel");
			const value = valueOf<{ moved: Record<string, number> }>(
				await s.call("transfer@1", { to: plain(chest), item: "dirt", count: 3 }),
			);
			if (value.moved.dirt !== 3 || (await inventory()).counts.dirt !== 5 || h.bot.currentWindow != null)
				throw new Error(JSON.stringify(value));
			const read = valueOf<{ slots: { name: string; count: number }[] }>(
				await s.call("container@1", { at: plain(chest) }),
			);
			if (read.slots.filter((slot) => slot.name === "dirt").reduce((sum, slot) => sum + slot.count, 0) !== 3)
				throw new Error(JSON.stringify(read));
			return JSON.stringify(value);
		});
		await s.step("sign write receives actual editor and server block-entity confirmation", async () => {
			await setBlock(sign, "minecraft:oak_sign[rotation=8]");
			valueOf(await s.call("use@1", { at: plain(sign), text: "before_cancel", side: "front" }));
			return readSignData("before_cancel");
		});
		await s.step("cancellation on the real sign editor response prevents text submission", async () => {
			let run = "";
			let stopping: Promise<unknown> | null = null;
			const detach = protocolFor(h.bot).subscribe((notice) => {
				if (
					notice.kind === "sign_editor" &&
					notice.position.x === sign.x &&
					notice.position.y === sign.y &&
					notice.position.z === sign.z &&
					run !== ""
				)
					stopping = h.runtime.stop({ requestId: `stop:${run}:editor`, target: { run } });
			});
			try {
				run = (await submit("dev.repair.sign@1", { at: plain(sign) })).run;
				await cancelled(run);
				if (stopping === null) throw new Error("server never opened the sign editor");
				await stopping;
				return readSignData("before_cancel");
			} finally {
				detach();
			}
		});
		await s.step("navigation with placeToReach=false does not fill a gap or consume blocks", async () => {
			await resetItems();
			await s.command(`/give ${username} minecraft:dirt 5`);
			await setBlock({ x: base.x + 1, y: 199, z: base.z }, "minecraft:air");
			const result = await s.call("goto@1", {
				at: { x: base.x + 3.5, y: 200, z: base.z + 0.5 },
				tolerance: 1,
				placeToReach: false,
				digThrough: false,
				maxTimeMs: 10000,
			});
			if (!result.ok && result.code !== "UNREACHABLE" && result.code !== "TIMEOUT")
				throw new Error(JSON.stringify(result));
			if (
				(await inventory()).counts.dirt !== 5 ||
				(await s.readBlock({ x: base.x + 1, y: 199, z: base.z }))?.name !== "air"
			)
				throw new Error("navigation placed a block despite placeToReach=false");
			await s.command(`/tp ${username} 10000.5 200 10000.5`);
			await waitForStill(h.bot, s.log);
			return `outcome=${result.ok ? "reached" : result.code}; dirt=5; gap=air`;
		});
		await s.step("stopping an active dig retires its delayed finish", async () => {
			await resetItems();
			await setBlock(ore, "minecraft:obsidian");
			const { run } = await submit("dev.repair.mine@1", { at: plain(ore) });
			await until(
				async () => h.runtime.read(run),
				(snapshot) => snapshot.progress.stage === "body-held",
				"dig body was never acquired",
			);
			await sleep(100);
			await h.runtime.stop({ requestId: `stop:${run}:mining`, target: { run } });
			const result = await cancelled(run);
			await sleep(600);
			if ((await s.readBlock(ore))?.name !== "obsidian") throw new Error("cancelled dig changed the target");
			return `cancelled; unknownEffects=${result.unknownEffectCount}; obsidian unchanged`;
		});
		await s.step("query schema rejects fractional block coordinates before sampling", async () => {
			try {
				await h.world.read({ ref: "block@1", input: { at: { x: base.x + 0.5, y: base.y, z: base.z } } });
			} catch (error) {
				if ((error as { code?: string }).code === "INVALID_INPUT") return "INVALID_INPUT";
				throw error;
			}
			throw new Error("fractional GridPos was accepted");
		});
		await s.step("container history persists in the isolated data root after full reopen", async () => {
			const before = (
				await h.world.read<{ found: boolean; counts: Record<string, number> }>({
					ref: "container.last@1",
					input: { at: { position: plain(chest), dimension: "overworld" } },
				})
			).value;
			if (!before.found || before.counts.dirt !== 3) throw new Error(JSON.stringify(before));
			await closeHarness(h);
			h = await openHarness("repair-reopen", { dataRoot, binding });
			const after = (
				await h.world.read<{ found: boolean; counts: Record<string, number> }>({
					ref: "container.last@1",
					input: { at: { position: plain(chest), dimension: "overworld" } },
				})
			).value;
			if (!after.found || after.counts.dirt !== 3) throw new Error(JSON.stringify(after));
			return `${h.dataRoot}; historical dirt=3`;
		});
		s.finish();
	} finally {
		await closeHarness(h);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
