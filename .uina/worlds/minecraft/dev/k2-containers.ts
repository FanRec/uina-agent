/** 批 2 真服验收：准备只用 op 指令，受测行为走正式 Runtime/能力/Driver/World。 */

import type { SelfState } from "../contracts/body.js";
import type { NativeCallable } from "../contracts/capabilities.js";
import type { JsonValue, Vec3 } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import { closeHarness, type DevHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario } from "./scenario.js";

const checkWindow: NativeCallable<JsonValue, JsonValue> = {
	descriptor: {
		ref: "dev.window.check@1",
		summary: "Batch 2 stale revision and delegated-body checks",
		input: { type: "object" },
		output: { type: "object" },
		access: "act",
		implementation: "native",
		completion: { scope: "capability", description: "stale click rejected before dispatch" },
		errors: [],
		requires: ["body"],
		examples: [],
	},
	async invoke(ctx, input) {
		const raw = input as unknown as { at: Vec3; delegate?: boolean };
		return ctx.withBody(async (scope) => {
			if (raw.delegate) return plain(await scope.call("transfer@1", { to: raw.at, item: "dirt", count: 1 }));
			const self = (await ctx.world.read<SelfState>({ ref: "self@1", input: {} })).value;
			const window = await scope.player.openContainer({ place: { ...self.place, position: raw.at }, block: raw.at });
			try {
				const snapshot = (await window.snapshot()).value;
				const item = (snapshot.slots[0]?.item ?? null) as { name: string; count: number } | null;
				// G36 裁决之后，版本只是排序/诊断信息：内容对得上就必须放行。
				// 探针因此反过来验"旧版本号 + 正确内容"不会被拒。
				const receipt = await window.click({
					slot: 0,
					button: 0,
					mode: 0,
					expectedRevision: snapshot.revision - 1,
					expectedSlots: [
						{
							slot: 0,
							stack: { item: item == null ? null : { name: item.name }, count: item?.count ?? 0 },
						},
					],
					expectedCursor: { item: null, count: 0 },
				});
				if (receipt.dispatch !== "sent") throw new Error(`stale revision was rejected: ${receipt.dispatch}`);
				const lifted = (await window.snapshot()).value;
				if (item != null) {
					const cursor = lifted.cursor as { name: string; count: number } | null;
					if (cursor?.name !== item.name || cursor.count !== item.count)
						throw new Error("stale revision click did not move the expected stack");
					await window.click({
						slot: 0,
						button: 0,
						mode: 0,
						expectedRevision: lifted.revision,
						expectedSlots: [{ slot: 0, stack: { item: null, count: 0 } }],
						expectedCursor: { item: { name: cursor.name }, count: cursor.count },
					});
				}
				const restored = (await window.snapshot()).value;
				const restoredItem = restored.slots[0]?.item as { name: string; count: number } | null;
				if (restored.cursor != null || restoredItem?.name !== item?.name || restoredItem?.count !== item?.count)
					throw new Error("window probe did not restore the original stack");
				return { restored: true };
			} finally {
				await window.close();
			}
		});
	},
};

interface TransferValue {
	moved: Record<string, number>;
	remaining: Record<string, number>;
	containersChecked: number;
}
interface ContainerValue {
	slots: { slot: number; name: string; count: number }[];
	freeSlots: number;
}
interface LastValue {
	found: boolean;
	counts?: Record<string, number>;
	complete?: boolean;
}

async function main(): Promise<void> {
	const binding = { world: "world:paper-dev", worldRevision: `revision:container-scenario-${Date.now()}` };
	let h: DevHarness = await openHarness("containers", { binding, callables: [checkWindow] });
	const s = makeScenario(h, "CONTAINERS");
	let at: Vec3 = { x: 0, y: 0, z: 0 };
	let prepared = false;
	try {
		await s.step("prepare isolated nearby container", async () => {
			const username = h.bot.username;
			// 本场景保留的独立测试区；先在高处加载，再铺低于脚位的平台，避免填进玩家身体。
			await s.command(`/gamemode creative ${username}`);
			await s.command(`/tp ${username} 10000.5 205 10000.5`);
			const chunkDeadline = Date.now() + 15000;
			while ((await s.readBlock({ x: 10000, y: 199, z: 10000 })) == null) {
				if (Date.now() >= chunkDeadline) throw new Error("test-area chunk never became observable");
				await sleep(100);
			}
			await s.command(`/fill 9996 199 9996 10004 199 10004 minecraft:stone`);
			if ((await s.readBlock({ x: 10000, y: 199, z: 10000 }))?.name !== "stone")
				throw new Error("test platform was not created");
			await s.command(`/tp ${username} 10000.5 200 10000.5`);
			await waitForStill(h.bot, s.log);
			const self = await s.readSelf();
			if (
				!self.onGround ||
				Math.abs(self.place.position.y - 200) > 0.1 ||
				Math.abs(self.place.position.x - 10000.5) > 0.1
			)
				throw new Error(`test player did not settle on platform: ${JSON.stringify(self.place)}`);
			await s.command(`/gamemode survival ${username}`);
			at = {
				x: Math.floor(self.place.position.x) + 2,
				y: Math.floor(self.place.position.y),
				z: Math.floor(self.place.position.z),
			};
			await s.command(`/clear ${h.host.bot?.username ?? "UinaDev"}`);
			await s.command(`/setblock ${at.x} ${at.y} ${at.z} minecraft:air`);
			await s.command(`/setblock ${at.x} ${at.y} ${at.z} minecraft:barrel`);
			await s.command(`/kill @e[tag=uina_batch2_container]`);
			await s.command(`/item replace block ${at.x} ${at.y} ${at.z} container.0 with minecraft:dirt 12`);
			await s.command(`/give ${h.host.bot?.username ?? "UinaDev"} minecraft:dirt 20`);
			prepared = true;
			return JSON.stringify(at);
		});
		if (!prepared) {
			s.finish();
			return;
		}
		await s.step("container opens authoritative 27-slot contents and closes", async () => {
			const result = await s.call("container@1", { at: plain(at) });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as ContainerValue;
			if (value.slots.find((slot) => slot.slot === 0)?.count !== 12 || value.freeSlots !== 26)
				throw new Error(JSON.stringify(value));
			if (h.bot.currentWindow != null) throw new Error("container left open");
			return JSON.stringify(value);
		});
		await s.step("transfer to container exact 5 with cursor remainder returned", async () => {
			const result = await s.call("transfer@1", { to: plain(at), item: "dirt", count: 5 });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as TransferValue;
			if (value.moved.dirt !== 5 || (await s.readInventory()).counts.dirt !== 15)
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("transfer from container exact 3", async () => {
			const result = await s.call("transfer@1", { from: plain(at), item: "dirt", count: 3 });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as TransferValue;
			if (value.moved.dirt !== 3 || (await s.readInventory()).counts.dirt !== 18)
				throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("close and reopen verifies actual remaining 14", async () => {
			const result = await s.call("container@1", { at: plain(at) });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as ContainerValue;
			if (value.slots.reduce((sum, slot) => sum + (slot.name === "dirt" ? slot.count : 0), 0) !== 14)
				throw new Error(JSON.stringify(value));
			return "dirt=14; closed";
		});
		await s.step("stale revision with matching content permits the click and its reversal", async () => {
			const result = await s.call("dev.window.check@1", { at: plain(at) });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			return JSON.stringify(result.value);
		});
		await s.step("nearby delegated body transfers and retains ancestor ownership", async () => {
			const result = await s.call("dev.window.check@1", { at: plain(at), delegate: true });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			return JSON.stringify(result.value);
		});
		await s.step("source shortage preserves moved 15 and remaining 5", async () => {
			const before = (await s.readInventory()).counts.dirt ?? 0;
			const result = await s.call("transfer@1", { from: plain(at), item: "dirt", count: 20 });
			if (result.ok || result.code !== "MISSING_MATERIAL") throw new Error(JSON.stringify(result));
			const delta = ((await s.readInventory()).counts.dirt ?? 0) - before;
			if (delta !== 15) throw new Error(`inventory delta ${delta}`);
			return `MISSING_MATERIAL; moved=${delta}`;
		});
		await s.step("nearest finds an actual container and reports its identity", async () => {
			const result = await s.call("transfer@1", { to: "nearest", item: "dirt", count: 2 }, 120000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as TransferValue & { to: JsonValue };
			if (
				value.moved.dirt !== 2 ||
				value.to === "nearest" ||
				value.containersChecked < 1 ||
				value.containersChecked > 3
			)
				throw new Error(JSON.stringify(value));
			const take = await s.call("transfer@1", { from: value.to, all: true });
			if (!take.ok) throw new Error(`${take.code}: ${take.message}`);
			return JSON.stringify(value);
		});
		await s.step("full destination preserves confirmed partial quantity", async () => {
			await s.command(`/item replace block ${at.x} ${at.y} ${at.z} container.0 with minecraft:dirt 63`);
			for (let slot = 1; slot < 27; slot++)
				await s.command(`/item replace block ${at.x} ${at.y} ${at.z} container.${slot} with minecraft:stone 64`);
			const before = (await s.readInventory()).counts.dirt ?? 0;
			const result = await s.call("transfer@1", { to: plain(at), item: "dirt", count: 5 });
			if (result.ok || result.code !== "INVENTORY_FULL") throw new Error(JSON.stringify(result));
			const delta = before - ((await s.readInventory()).counts.dirt ?? 0);
			if (delta !== 1) throw new Error(`actual deposited quantity ${delta}`);
			// 只清本场景容器，为后面的历史检查恢复一个已核验的空容器。
			await s.command(`/setblock ${at.x} ${at.y} ${at.z} minecraft:air`);
			await s.command(`/setblock ${at.x} ${at.y} ${at.z} minecraft:barrel`);
			const read = await s.call("container@1", { at: plain(at) });
			if (!read.ok) throw new Error(`${read.code}: ${read.message}`);
			return "INVENTORY_FULL; moved=1, remaining=4; confirmed by player inventory";
		});
		await s.step("entity container transfer uses current full EntityRef", async () => {
			await s.command(`/kill @e[tag=uina_batch2_container]`);
			await s.command(`/summon minecraft:chest_minecart ${at.x} ${at.y} ${at.z + 2} {Tags:["uina_batch2_container"]}`);
			await s.command(
				`/item replace entity @e[tag=uina_batch2_container,limit=1,sort=nearest] container.0 with minecraft:dirt 4`,
			);
			const entities = (
				await h.world.read<{ entities: { ref: JsonValue; name: string }[] }>({
					ref: "entities@1",
					input: { radius: 16, kind: "all", limit: 128 },
				})
			).value.entities;
			const cart = entities.find((entity) => entity.name === "chest_minecart");
			if (cart == null)
				throw new Error(`chest minecart not tracked: ${entities.map((entity) => entity.name).join(",")}`);
			const result = await s.call("transfer@1", { from: cart.ref, item: "dirt", count: 2 });
			if (!result.ok || (result.value as unknown as TransferValue).moved.dirt !== 2)
				throw new Error(JSON.stringify(result));
			await s.command(`/kill @e[tag=uina_batch2_container]`);
			return JSON.stringify(result.value);
		});
		await s.step("container.last holds final observed contents", async () => {
			const value = (await h.world.read<LastValue>({ ref: "container.last@1", input: { at: plain(at) } })).value;
			if (!value.found || !value.complete || (value.counts?.dirt ?? 0) !== 0) throw new Error(JSON.stringify(value));
			return JSON.stringify(value);
		});
		await s.step("history survives full client/runtime/world close and reopen", async () => {
			const self = await s.readSelf();
			await closeHarness(h);
			h = await openHarness("containers-reopen", { binding, dataRoot: h.dataRoot, ns: h.ns });
			const value = (
				await h.world.read<LastValue>({
					ref: "container.last@1",
					input: { at: { position: plain(at), dimension: self.place.dimension } },
				})
			).value;
			if (!value.found || !value.complete || (value.counts?.dirt ?? 0) !== 0) throw new Error(JSON.stringify(value));
			return "same explicit world/revision, new binding and process-local identities";
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
