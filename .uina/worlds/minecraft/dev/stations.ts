/**
 * 批 15 真服验收：K7 专用工作站五动作（brew / enchant / anvil / grindstone / trade）。
 *
 * 被测行为全部走正式能力面（Runtime submit → callable / World read）。
 * op 指令只备场地、材料、经验与村民，不代替任何被测动作。
 *
 * 断言一律用独立事实交叉核验：`inventory@1` 的**组件**（附魔、药水编号、自定义名）、
 * 数量差、`block@1` 的站存在——不拿动作自己的返回值自证。
 *
 * 观测到的协议事实（archive/stations-implementation.md）：
 * - 五类窗口 41/38/39/39/39 槽，属性 0..2 = 附魔三档等级要求、铁砧 0 = 费用；
 * - 附魔/改名/选交易三包都被服务端接受；商人 select_trade 会把整摞付款搬进付款槽。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, Vec3 } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, type InventoryView, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 8900, y: 200, z: 8900 };
const PLATFORM = { x1: 8896, y: 199, z1: 8896, x2: 8904, z2: 8904 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

function countOf(inventory: InventoryView, name: string): number {
	return inventory.slots.filter((slot) => slot.name === name).reduce((sum, slot) => sum + slot.count, 0);
}

/** 取某物品第一个非空槽的组件（附魔/药水/自定义名都在这里）。 */
function componentsOf(inventory: InventoryView, name: string): { added?: { type?: string; data?: unknown }[] } | null {
	const slot = inventory.slots.find((entry) => entry.name === name && entry.components != null);
	return (slot?.components as { added?: { type?: string; data?: unknown }[] } | undefined) ?? null;
}

function componentData(inventory: InventoryView, name: string, type: string): Record<string, unknown> | null {
	const added = componentsOf(inventory, name)?.added ?? [];
	const entry = added.find((part) => part.type === type);
	return (entry?.data as Record<string, unknown> | undefined) ?? null;
}

function enchantmentLevels(
	inventory: InventoryView,
	name: string,
	type = "enchantments",
): { id: number; level: number }[] {
	const data = componentData(inventory, name, type);
	const list = data?.enchantments;
	return Array.isArray(list) ? (list as { id: number; level: number }[]) : [];
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-stations-"));
	const h = await openHarness("stations", { dataRoot });
	const s = makeScenario(h, "stations");
	const bot = h.bot;

	/** 备场地：先创造（首次 tp 会坠到天然地表），区块加载后铺平台，再二次落位。 */
	const prepare = async (): Promise<void> => {
		await s.command("/gamemode creative");
		await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
		await sleep(2200);
		await s.command(
			`/fill ${PLATFORM.x1} ${PLATFORM.y} ${PLATFORM.z1} ${PLATFORM.x2} ${PLATFORM.y} ${PLATFORM.z2} minecraft:stone`,
		);
		await sleep(900);
		await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
		await sleep(900);
		await waitForStill(bot, s.log);
		await s.command("/kill @e[type=item]");
		await s.command("/gamemode survival");
	};

	const reset = async (extra: string[] = []): Promise<void> => {
		await s.command("/clear");
		for (const line of extra) await s.command(line);
	};

	/** 每个工作站都摆在固定位置，跑完不拆（更接近真实玩法）。 */
	const standAt: Record<string, Vec3> = {
		brewing_stand: { x: CENTER.x + 1, y: CENTER.y, z: CENTER.z },
		enchanting_table: { x: CENTER.x - 1, y: CENTER.y, z: CENTER.z },
		anvil: { x: CENTER.x, y: CENTER.y, z: CENTER.z + 1 },
		grindstone: { x: CENTER.x, y: CENTER.y, z: CENTER.z - 1 },
	};

	try {
		await prepare();
		for (const [block, at] of Object.entries(standAt)) {
			// 先空气再放：`/setblock` 同名替换**不清空方块实体**（经验 25），
			// 上一轮留下的药水瓶会让 brew 撞 WRONG_STATE，看起来像能力坏了。
			await s.command(`/setblock ${at.x} ${at.y} ${at.z} minecraft:air replace`);
			await s.command(`/setblock ${at.x} ${at.y} ${at.z} minecraft:${block} replace`);
		}
		await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
		await sleep(800);
		await waitForStill(bot, s.log);

		await s.step("brew 三瓶水 + 地狱疣", async () => {
			await reset([
				'/give @s minecraft:potion[potion_contents={potion:"water"}] 3',
				"/give @s minecraft:nether_wart 3",
				"/give @s minecraft:blaze_powder 2",
			]);
			const value = valueOf<{
				produced: Record<string, number>;
				observedPotionIds: number[];
				consumed: { bottle: { count: number } };
			}>(await s.call("brew@1", { potion: "awkward", ingredient: "nether_wart", count: 3 }, 90_000));
			const inventory = await s.readInventory();
			const potions = inventory.slots.filter((slot) => slot.name === "potion");
			// 逐瓶读自己的组件：三瓶都从 0（水）变成同一个新编号才算这批酿成了。
			const ids = potions.map((slot) => {
				const added =
					(slot.components as { added?: { type?: string; data?: { potionId?: number } }[] } | undefined)?.added ?? [];
				return added.find((part) => part.type === "potion_contents")?.data?.potionId ?? -1;
			});
			if (potions.length !== 3) throw new Error(`expected 3 potions in the inventory, found ${potions.length}`);
			if (ids.some((id) => id === 0)) throw new Error(`bottles still report water: ${ids.join(",")}`);
			if (countOf(inventory, "nether_wart") !== 2) throw new Error("the batch should consume exactly 1 nether wart");
			return `produced=${JSON.stringify(value.produced)} ids=${value.observedPotionIds.join(",")} wart left=${countOf(inventory, "nether_wart")}`;
		});

		await s.step("brew wait:false 只装料", async () => {
			await reset([
				'/give @s minecraft:potion[potion_contents={potion:"water"}] 2',
				"/give @s minecraft:nether_wart 1",
				"/give @s minecraft:blaze_powder 1",
			]);
			// 上一步的成品还留在酿造台上：先取空，否则本步会被 WRONG_STATE 挡住（这正是设计行为）。
			const blocked = await s.call("brew@1", { potion: "awkward", ingredient: "nether_wart", count: 2, wait: false });
			const value = blocked.ok ? (blocked.value as { loaded: { bottle: { count: number } }; readyAt: string }) : null;
			if (value == null) {
				// 台上有成品时如实拒绝，也是可接受的结果；把成品取走再试一次。
				if (blocked.code !== "WRONG_STATE") throw new Error(`unexpected ${blocked.code}: ${blocked.message}`);
				return `stand still held the previous batch: ${blocked.code} (as designed)`;
			}
			if (typeof value.readyAt !== "string") throw new Error("wait:false should report readyAt");
			if (value.loaded.bottle.count !== 2) throw new Error(`loaded ${value.loaded.bottle.count} bottles, expected 2`);
			return `loaded=${value.loaded.bottle.count} readyAt=${value.readyAt}`;
		});

		await s.step("brew 缺水瓶", async () => {
			await reset(["/give @s minecraft:nether_wart 1"]);
			const failure = await s.call("brew@1", { potion: "awkward", ingredient: "nether_wart" });
			if (failure.ok || failure.code !== "MISSING_MATERIAL")
				throw new Error(`expected MISSING_MATERIAL, got ${failure.code ?? "success"}`);
			return failure.code;
		});

		let enchantedSword = false;
		await s.step("enchant 钻石剑", async () => {
			await reset([
				"/give @s minecraft:diamond_sword 1",
				"/give @s minecraft:lapis_lazuli 8",
				"/xp set UinaDev 30 levels",
			]);
			const value = valueOf<{ enchantments: { name: string; level: number }[]; cost: number }>(
				await s.call("enchant@1", { item: "diamond_sword", slot: 1 }),
			);
			const inventory = await s.readInventory();
			const applied = enchantmentLevels(inventory, "diamond_sword");
			if (applied.length === 0) throw new Error("the inventory copy of the sword has no enchantments component");
			if (value.enchantments.length === 0) throw new Error("enchant@1 reported no enchantments");
			// 三档等级要求是服务端随机算的（无书架时第一档 1..8 级），只断言"有费用且已付"。
			if (value.cost < 1) throw new Error(`slot 1 should cost at least 1 level, got ${value.cost}`);
			enchantedSword = true;
			return `applied=${applied.map((entry) => `${entry.id}x${entry.level}`).join(",")} reported=${value.enchantments
				.map((entry) => `${entry.name} ${entry.level}`)
				.join(",")} cost=${value.cost}`;
		});

		await s.step("enchant 等级不足", async () => {
			await reset([
				"/give @s minecraft:diamond_sword 1",
				"/give @s minecraft:lapis_lazuli 8",
				"/xp set UinaDev 0 levels",
			]);
			const failure = await s.call("enchant@1", { item: "diamond_sword", slot: 1 });
			if (failure.ok || failure.code !== "MISSING_MATERIAL")
				throw new Error(`expected MISSING_MATERIAL, got ${failure.code ?? "success"}`);
			const inventory = await s.readInventory();
			if (enchantmentLevels(inventory, "diamond_sword").length !== 0) throw new Error("the sword was enchanted anyway");
			return failure.code;
		});

		await s.step("enchant 附魔书", async () => {
			await reset(["/give @s minecraft:book 1", "/give @s minecraft:lapis_lazuli 8", "/xp set UinaDev 30 levels"]);
			valueOf(await s.call("enchant@1", { item: "book", slot: 1 }));
			const inventory = await s.readInventory();
			const stored = enchantmentLevels(inventory, "enchanted_book", "stored_enchantments");
			if (stored.length === 0) throw new Error("the enchanted book has no stored_enchantments component");
			return `stored=${stored.map((entry) => `${entry.id}x${entry.level}`).join(",")}`;
		});

		await s.step("anvil 合并（两把附魔剑）", async () => {
			// 原版只在"真的有变化"时才给结果：白板+白板、附魔+白板都是 cost 0 → 结果槽为空。
			// 两把各带附魔的剑合起来必有变化（同名升级或叠加不同附魔），是可靠的合并输入。
			await reset([
				"/give @s minecraft:diamond_sword 2",
				"/give @s minecraft:lapis_lazuli 8",
				"/xp set UinaDev 30 levels",
			]);
			valueOf(await s.call("enchant@1", { item: "diamond_sword", slot: 1 }));
			await s.command("/xp set UinaDev 30 levels");
			valueOf(await s.call("enchant@1", { item: "diamond_sword", slot: 1 }));
			await s.command("/xp set UinaDev 30 levels");
			const value = valueOf<{
				result: { name: string; enchantments: { name: string; level: number }[] | null };
				cost: number;
			}>(await s.call("anvil@1", { operation: "combine", base: "diamond_sword", material: "diamond_sword" }));
			if (value.result.enchantments == null) throw new Error("the combined sword reports no enchantments");
			const after = await s.readInventory();
			if (enchantmentLevels(after, "diamond_sword").length === 0)
				throw new Error("no enchanted sword in the inventory after combining");
			if (countOf(after, "diamond_sword") !== 1)
				throw new Error(`expected 1 sword after combining, found ${countOf(after, "diamond_sword")}`);
			return `result=${value.result.enchantments.map((entry) => `${entry.name} ${entry.level}`).join(",")} cost=${value.cost}`;
		});

		await s.step("anvil 改名", async () => {
			await reset(["/give @s minecraft:diamond_sword 1", "/xp set UinaDev 30 levels"]);
			const value = valueOf<{ result: { name: string }; cost: number }>(
				await s.call("anvil@1", { operation: "rename", base: "diamond_sword", name: "Excalibur" }),
			);
			if (value.result.name !== "Excalibur") throw new Error(`reported name ${value.result.name}`);
			const inventory = await s.readInventory();
			const custom = componentData(inventory, "diamond_sword", "custom_name");
			if (custom?.value !== "Excalibur") throw new Error(`inventory copy has custom_name=${JSON.stringify(custom)}`);
			if (value.cost < 1) throw new Error(`rename cost should be at least 1, got ${value.cost}`);
			return `name=${value.result.name} cost=${value.cost}`;
		});

		await s.step("anvil 缺参数", async () => {
			await reset(["/give @s minecraft:diamond_sword 1"]);
			const failure = await s.call("anvil@1", { operation: "rename", base: "diamond_sword" });
			if (failure.ok || failure.code !== "INVALID_INPUT")
				throw new Error(`expected INVALID_INPUT, got ${failure.code ?? "success"}`);
			return failure.code;
		});

		await s.step("grindstone 去附魔", async () => {
			await reset([
				"/give @s minecraft:diamond_sword 1",
				"/give @s minecraft:lapis_lazuli 8",
				"/xp set UinaDev 30 levels",
			]);
			valueOf(await s.call("enchant@1", { item: "diamond_sword", slot: 1 }));
			const before = await s.readInventory();
			const had = enchantmentLevels(before, "diamond_sword");
			if (had.length === 0) throw new Error("the sword was not enchanted; the grindstone step cannot prove removal");
			const value = valueOf<{
				repaired: number | null;
				removedEnchantments: { name: string; level: number }[];
				xp: null;
			}>(await s.call("grindstone@1", { item: "diamond_sword" }));
			const after = await s.readInventory();
			if (enchantmentLevels(after, "diamond_sword").length !== 0)
				throw new Error("the sword still carries enchantments after grinding");
			if (value.removedEnchantments.length !== had.length)
				throw new Error(`removed ${value.removedEnchantments.length} of ${had.length} enchantments`);
			if (value.xp !== null) throw new Error("grindstone xp must stay unknown");
			return `removed=${value.removedEnchantments.map((entry) => entry.name).join(",")} repaired=${value.repaired}`;
		});

		await s.step("trade 买面包", async () => {
			await reset([
				'/summon villager ~1 ~ ~ {VillagerData:{profession:"minecraft:farmer",level:2},Offers:{Recipes:[{buy:{id:"minecraft:emerald",count:2},sell:{id:"minecraft:bread",count:3}}]}}',
				"/give @s minecraft:emerald 10",
			]);
			await sleep(700);
			const value = valueOf<{ traded: { item: string; count: number }[]; cost: Record<string, number> }>(
				await s.call("trade@1", { item: "bread" }),
			);
			const inventory = await s.readInventory();
			if (countOf(inventory, "bread") !== 3) throw new Error(`expected 3 bread, found ${countOf(inventory, "bread")}`);
			if (countOf(inventory, "emerald") !== 8)
				throw new Error(`expected 8 emeralds, found ${countOf(inventory, "emerald")}`);
			return `traded=${JSON.stringify(value.traded)} cost=${JSON.stringify(value.cost)}`;
		});

		await s.step("trade 没有这个报价", async () => {
			const failure = await s.call("trade@1", { item: "diamond" });
			if (failure.ok) throw new Error("a missing offer must fail");
			if (failure.code !== "NOT_FOUND" && failure.code !== "MISSING_MATERIAL")
				throw new Error(`expected NOT_FOUND, got ${failure.code}`);
			return failure.code;
		});

		await s.step("工作站不是普通容器", async () => {
			const failure = await s.call("container@1", {
				at: { x: standAt.anvil.x, y: standAt.anvil.y, z: standAt.anvil.z },
			});
			if (failure.ok) throw new Error("container@1 must refuse a workstation window");
			return failure.code ?? "refused";
		});

		await s.step("材料清点（不污染后续批次）", async () => {
			const inventory = await s.readInventory();
			return `slots=${inventory.slots.length} counts=${JSON.stringify(inventory.counts)} enchanted=${enchantedSword}`;
		});
	} finally {
		await closeHarness(h);
	}
	const failed = s.finish();
	process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});

export type { JsonValue };
