/**
 * 批 3 真服验收：P0 生产链（原木 → 工作台 → 木镐 → 石镐 → 铁锭 → 铁镐）。
 *
 * 准备只用 op 指令（传送、铺台、给料、放炉子），被测行为全部走正式 Runtime/能力/Driver/World。
 * 断言一律用独立事实交叉验证（inventory@1、block@1、container@1），不信返回值自报。
 */

import type { JsonValue, Vec3 } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill, type DevHarness } from "./harness.js";
import { makeScenario } from "./scenario.js";

interface CraftValue {
	crafted: number;
	produced: Record<string, number>;
	consumed: Record<string, number>;
	at?: { position: Vec3; dimension: string };
}
interface SmeltValue {
	produced: Record<string, number>;
	consumed: { input: { item: string; count: number }; fuel: { item: string; count: number } };
	at?: { position: Vec3; dimension: string };
}
interface LoadedValue {
	at: { position: Vec3; dimension: string };
	loaded: { input: { item: string; count: number }; fuel: { item: string; count: number } };
	readyAt: string;
	hint: string;
}
interface ContainerValue {
	type: string;
	slots: { region?: string; slot: number; name: string; count: number }[];
	freeSlots: number;
	properties: Record<string, JsonValue>;
}
interface RecipeValue {
	recipes: { station: string; pattern?: (string | null)[][]; ingredients: { item: string; count: number }[] }[];
}
interface ItemValue {
	sources?: { kind: string }[];
	fuel?: { ticks: number } | null;
}

async function main(): Promise<void> {
	const binding = { world: "world:paper-dev", worldRevision: `revision:craft-scenario-${Date.now()}` };
	const h: DevHarness = await openHarness("craft", { binding });
	const s = makeScenario(h, "CRAFT");
	const user = h.bot.username;
	const count = async (name: string): Promise<number> => (await s.readInventory()).counts[name] ?? 0;
	let furnaceAt: Vec3 = { x: 0, y: 0, z: 0 };
	let tableAt: Vec3 | null = null;
	let prepared = false;
	try {
		await s.step("prepare isolated platform and starting logs", async () => {
			await s.command(`/gamemode creative ${user}`);
			await s.command(`/tp ${user} 9000.5 205 9000.5`);
			const chunkDeadline = Date.now() + 15000;
			while ((await s.readBlock({ x: 9000, y: 199, z: 9000 })) == null) {
				if (Date.now() >= chunkDeadline) throw new Error("test-area chunk never became observable");
				await sleep(100);
			}
			await s.command(`/fill 8996 199 8996 9004 199 9004 minecraft:stone`);
			await s.command(`/tp ${user} 9000.5 200 9000.5`);
			await waitForStill(h.bot, s.log);
			await s.command(`/gamemode survival ${user}`);
			const self = await s.readSelf();
			if (!self.onGround) throw new Error(`test player did not settle: ${JSON.stringify(self.place)}`);
			const base = {
				x: Math.floor(self.place.position.x),
				y: Math.floor(self.place.position.y),
				z: Math.floor(self.place.position.z),
			};
			furnaceAt = { x: base.x + 2, y: base.y, z: base.z };
			await s.command(`/clear ${user}`);
			await s.command(`/setblock ${furnaceAt.x} ${furnaceAt.y} ${furnaceAt.z} minecraft:furnace`);
			await s.command(`/give ${user} minecraft:oak_log 12`);
			prepared = true;
			return `base=${JSON.stringify(base)} furnace=${JSON.stringify(furnaceAt)}`;
		});
		if (!prepared) {
			s.finish();
			return;
		}

		await s.step("craft 12 planks on the hand grid (3 batches)", async () => {
			const result = await s.call("craft@1", { item: "oak_planks", count: 12 }, 90000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as CraftValue;
			if (value.crafted !== 12 || value.consumed.oak_log !== 3) throw new Error(JSON.stringify(value));
			if ((await count("oak_planks")) !== 12 || (await count("oak_log")) !== 9)
				throw new Error(`inventory ok=${await count("oak_planks")} log=${await count("oak_log")}`);
			return JSON.stringify(value.produced);
		});

		await s.step("craft a crafting table (12 plank variants: recipe选择)", async () => {
			const result = await s.call("craft@1", { item: "crafting_table", count: 1 }, 60000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			if ((await count("crafting_table")) !== 1) throw new Error("no crafting table in inventory");
			return "crafting_table=1";
		});

		await s.step("craft 8 sticks on the hand grid", async () => {
			const result = await s.call("craft@1", { item: "stick", count: 8 }, 60000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			if ((await count("stick")) !== 8) throw new Error(`stick=${await count("stick")}`);
			return "stick=8";
		});

		await s.step("craft a wooden pickaxe: 3x3 places the table from the inventory", async () => {
			const result = await s.call("craft@1", { item: "wooden_pickaxe", count: 1 }, 90000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as CraftValue;
			if (value.crafted !== 1 || value.at == null) throw new Error(JSON.stringify(value));
			const placed = await s.readBlock(value.at.position);
			if (placed?.name !== "crafting_table") throw new Error(`table not at ${JSON.stringify(value.at.position)}`);
			tableAt = value.at.position;
			if (h.bot.currentWindow != null) throw new Error("crafting window left open");
			return `pickaxe=1 table=${JSON.stringify(tableAt)}`;
		});

		await s.step("craft a furnace on the placed table", async () => {
			await s.command(`/give ${user} minecraft:cobblestone 11`);
			const result = await s.call("craft@1", { item: "furnace", count: 1 }, 60000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			if ((await count("furnace")) !== 1) throw new Error("no furnace in inventory");
			return "furnace=1";
		});

		await s.step("craft a stone pickaxe reusing the nearby table", async () => {
			const result = await s.call("craft@1", { item: "stone_pickaxe", count: 1 }, 60000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			if ((await count("stone_pickaxe")) !== 1) throw new Error("no stone pickaxe");
			return "stone_pickaxe=1";
		});

		await s.step("smelt 3 iron with wait:false, then read progress and take the output", async () => {
			await s.command(`/give ${user} minecraft:raw_iron 3`);
			await s.command(`/give ${user} minecraft:coal 1`);
			const loaded = await s.call(
				"smelt@1",
				{ item: "iron_ingot", count: 3, fuel: "coal", at: plain(furnaceAt), wait: false },
				60000,
			);
			if (!loaded.ok) throw new Error(`${loaded.code}: ${loaded.message}`);
			const value = loaded.value as unknown as LoadedValue;
			if (value.loaded.input.count !== 3 || value.loaded.fuel.count !== 1) throw new Error(JSON.stringify(value));
			if (h.bot.currentWindow != null) throw new Error("furnace window left open after loading");

			const deadline = Date.now() + 45000;
			let output = 0;
			while (Date.now() < deadline) {
				const read = await s.call("container@1", { at: plain(furnaceAt) });
				if (read.ok) {
					const view = read.value as unknown as ContainerValue;
					if (view.type !== "minecraft:furnace") throw new Error(`unexpected window ${view.type}`);
					output = view.slots.filter((slot) => slot.region === "result").reduce((sum, slot) => sum + slot.count, 0);
					if (output >= 3) break;
				}
				await sleep(1000);
			}
			if (output < 3) throw new Error(`furnace produced ${output} of 3 within 45s`);
			const taken = await s.call("transfer@1", { from: plain(furnaceAt), item: "iron_ingot", count: 3 });
			if (!taken.ok) throw new Error(`${taken.code}: ${taken.message}`);
			const moved = (taken.value as unknown as { moved: Record<string, number> }).moved;
			if ((moved.iron_ingot ?? 0) !== 3 || (await count("iron_ingot")) !== 3)
				throw new Error(`moved=${JSON.stringify(moved)} inventory=${await count("iron_ingot")}`);
			return `readyAt=${value.readyAt} moved=${JSON.stringify(moved)}`;
		});

		await s.step("smelt 3 more iron with wait:true and confirm the furnace is empty", async () => {
			await s.command(`/give ${user} minecraft:raw_iron 3`);
			await s.command(`/give ${user} minecraft:coal 1`);
			const before = await count("iron_ingot");
			const result = await s.call(
				"smelt@1",
				{ item: "iron_ingot", count: 3, fuel: "coal", at: plain(furnaceAt), maxTimeMs: 60000 },
				120000,
			);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as SmeltValue;
			const after = await count("iron_ingot");
			if (after - before !== 3) throw new Error(`delta ${after - before}`);
			if (value.consumed.input.count !== 3 || value.consumed.fuel.count !== 1) throw new Error(JSON.stringify(value));
			if (h.bot.currentWindow != null) throw new Error("furnace window left open");
			const read = await s.call("container@1", { at: plain(furnaceAt) });
			let leftover: ContainerValue["slots"] = [];
			if (read.ok) {
				const view = read.value as unknown as ContainerValue;
				// 余燃料会留在炉子里：上一轮的燃烧刻数还没用完时，新燃料不会被消耗。
				leftover = view.slots.filter((slot) => slot.region !== "fuel");
				if (leftover.length !== 0) throw new Error(`input/result not empty: ${JSON.stringify(leftover)}`);
				leftover = view.slots;
			}
			return `iron_ingot=${after} furnace=${JSON.stringify(leftover)}`;
		});

		await s.step("craft an iron pickaxe: P0 chain closed", async () => {
			const result = await s.call("craft@1", { item: "iron_pickaxe", count: 1 }, 90000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as unknown as CraftValue;
			if (value.crafted !== 1 || value.consumed.iron_ingot !== 3) throw new Error(JSON.stringify(value));
			if ((await count("iron_pickaxe")) !== 1) throw new Error("no iron pickaxe");
			return `iron_pickaxe=1 consumed=${JSON.stringify(value.consumed)}`;
		});

		await s.step("missing materials are refused before touching the body", async () => {
			const result = await s.call("craft@1", { item: "diamond_pickaxe", count: 1 });
			if (result.ok || result.code !== "MISSING_MATERIAL") throw new Error(JSON.stringify(result));
			return result.code;
		});

		await s.step("an unknown fuel is refused instead of guessed", async () => {
			const result = await s.call("smelt@1", { item: "iron_ingot", count: 1, fuel: "dirt", at: plain(furnaceAt) });
			if (result.ok || result.code !== "MISSING_MATERIAL") throw new Error(JSON.stringify(result));
			return result.code;
		});

		await s.step("loading a furnace through transfer@1 is refused", async () => {
			await s.command(`/give ${user} minecraft:raw_iron 1`);
			const result = await s.call("transfer@1", { to: plain(furnaceAt), item: "raw_iron", count: 1 });
			if (result.ok || result.code !== "WRONG_STATE") throw new Error(JSON.stringify(result));
			return result.code;
		});

		await s.step("recipe@1 reports the smelting route and item@1 knows the fuel", async () => {
			// 查询走 World 直读，不是动作调用（recipe@1 没有 callable）。
			const recipe = await h.world.read<RecipeValue>({ ref: "recipe@1", input: { item: "iron_ingot", count: 3 } });
			const value = recipe.value as unknown as RecipeValue;
			const furnace = value.recipes.filter((entry) => entry.station === "furnace");
			if (furnace.length === 0) throw new Error(JSON.stringify(value.recipes.map((entry) => entry.station)));
			const item = await h.world.read<ItemValue>({ ref: "item@1", input: { name: "coal" } });
			const itemValue = item.value as unknown as ItemValue;
			if ((itemValue.fuel?.ticks ?? 0) !== 1600) throw new Error(JSON.stringify(itemValue.fuel));
			if (!itemValue.sources?.some((source) => source.kind === "smelt"))
				throw new Error(`coal sources ${JSON.stringify(itemValue.sources)}`);
			const pickaxe = await h.world.read<RecipeValue>({ ref: "recipe@1", input: { item: "iron_pickaxe" } });
			const shaped = (pickaxe.value as unknown as RecipeValue).recipes.find((entry) => entry.pattern != null);
			if (shaped == null) throw new Error("no shaped recipe for iron_pickaxe");
			return `furnace=${furnace.length} pattern=${JSON.stringify(shaped.pattern?.[0])} coalFuel=${itemValue.fuel?.ticks}`;
		});
	} finally {
		s.finish();
		await closeHarness(h);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
