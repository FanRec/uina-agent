/**
 * Minecraft World K2 真服场景：物品在身体与世界之间的闭环（collect / pickup / drop）。
 *
 * 唯一定义来源：docs/proposals/mc/development-plan.md §10.2 批 1、
 * modules/capabilities.md §4 collect/pickup/drop。
 * 每个采集步骤都先在"当前位置旁边"摆好自己的目标方块，不假设上一步结束后还站在原地；
 * 被测行为全部走能力层，op 指令只摆地形、发物品、清背包。
 * 11 步覆盖成功的整链与四条失败面（物品无来源、没工具、数量不足、背包满）。
 * 运行前提：dev-env 服务端已启动，UinaDev 在 ops.json 中。
 */

import { closeHarness, openHarness, sleep } from "./harness.js";
import { type EntityView, makeScenario } from "./scenario.js";

interface CollectValue {
	mined: number;
	acquired: number;
	collected: Record<string, number>;
	remaining: number;
	toolsUsed: string[];
}

interface Vec3Like {
	x: number;
	y: number;
	z: number;
}

function expectCode(result: { ok: boolean; code?: string }, expected: string, label: string): void {
	if (result.ok) throw new Error(`${label}: expected ${expected}, got success`);
	if (result.code !== expected) throw new Error(`${label}: expected ${expected}, got ${result.code ?? "?"}`);
}

function groundCount(entities: EntityView[], name: string): number {
	return entities
		.filter((entity) => entity.item?.name === name)
		.reduce((total, entity) => total + (entity.item?.count ?? 0), 0);
}

async function main(): Promise<void> {
	const h = await openHarness("k2");
	const { call, readSelf, readBlock, readInventory, readEntities, readBlocks, command, step, finish, log } =
		makeScenario(h, "k2");

	try {
		// ---- 布置：只做环境准备，不铺平台（铺错一层就会把自己埋进方块） ----
		await command("/gamemode survival UinaDev");
		await command("/time set day");
		await command("/weather clear");
		await command("/kill @e[type=minecraft:item]");
		await command("/clear UinaDev");
		await sleep(1500);
		const settled = await readSelf();
		if (settled.onGround !== true) {
			throw new Error(`not standing on ground: y=${settled.place.position.y} onGround=${String(settled.onGround)}`);
		}
		await command("/give UinaDev minecraft:wooden_pickaxe 1");
		await sleep(400);
		const here = async (): Promise<Vec3Like> => {
			const current = await readSelf();
			return {
				x: Math.floor(current.place.position.x),
				y: Math.floor(current.place.position.y),
				z: Math.floor(current.place.position.z),
			};
		};
		log(`base=${JSON.stringify(await here())}`);

		// ---- 1 采集：徒手挖土（目标就摆在两格外） ----
		await step("collect@1 dirt x3", async () => {
			const at = await here();
			for (const block of [
				{ x: at.x + 2, y: at.y, z: at.z },
				{ x: at.x + 3, y: at.y, z: at.z },
				{ x: at.x + 2, y: at.y + 1, z: at.z },
			]) {
				await command(`/setblock ${block.x} ${block.y} ${block.z} minecraft:dirt`);
			}
			await sleep(300);
			const before = await readInventory();
			const result = await call("collect@1", { item: "dirt", count: 3, radius: 8 }, 120000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
			const value = result.value as unknown as CollectValue;
			const after = await readInventory();
			const delta = (after.counts.dirt ?? 0) - (before.counts.dirt ?? 0);
			if (value.acquired < 3 || value.remaining !== 0) {
				throw new Error(`acquired=${value.acquired} remaining=${value.remaining}`);
			}
			if (delta < 3) throw new Error(`dirtDelta=${delta}`);
			// 足量即停：多挖两格以内算观察延迟，挖成一片就是逻辑失控。
			if (value.mined > 5) throw new Error(`mined=${value.mined} for 3 items`);
			return `mined=${value.mined} acquired=${value.acquired} collected=${JSON.stringify(value.collected)} delta=${delta}`;
		});

		// ---- 2 采集：徒手原木 ----
		await step("collect@1 oak_log x2", async () => {
			const at = await here();
			await command(`/setblock ${at.x + 1} ${at.y} ${at.z} minecraft:oak_log`);
			await command(`/setblock ${at.x + 1} ${at.y + 1} ${at.z} minecraft:oak_log`);
			await sleep(300);
			const placed = await readBlock({ x: at.x + 1, y: at.y, z: at.z });
			if (placed?.name !== "oak_log") throw new Error(`setblock did not take: ${placed?.name ?? "null"}`);
			const visible = (await readBlocks("oak_log", 8)).length;
			const before = await readInventory();
			const result = await call("collect@1", { item: "oak_log", count: 2, radius: 8 }, 120000);
			if (!result.ok)
				throw new Error(
					`${result.code}: ${result.message ?? ""} [placed=${placed?.name ?? "null"} blocks@1=${visible}]`,
				);
			const value = result.value as unknown as CollectValue;
			const after = await readInventory();
			const delta = (after.counts.oak_log ?? 0) - (before.counts.oak_log ?? 0);
			if (value.acquired < 2 || value.remaining !== 0) {
				throw new Error(`acquired=${value.acquired} remaining=${value.remaining}`);
			}
			if (delta < 2) throw new Error(`oakLogDelta=${delta}`);
			if (value.toolsUsed.length !== 0) throw new Error(`unexpected tools: ${value.toolsUsed.join(",")}`);
			return `mined=${value.mined} acquired=${value.acquired} tools=[] delta=${delta}`;
		});

		// ---- 3 采集：物品名 → 方块反查（stone 掉 cobblestone），工具按需装备 ----
		await step("collect@1 cobblestone x2 (pickaxe)", async () => {
			const at = await here();
			await command(`/setblock ${at.x} ${at.y} ${at.z + 2} minecraft:stone`);
			await command(`/setblock ${at.x} ${at.y} ${at.z + 3} minecraft:stone`);
			await sleep(300);
			const before = await readInventory();
			const result = await call(
				"collect@1",
				{ item: "cobblestone", count: 2, radius: 8, tool: "wooden_pickaxe" },
				120000,
			);
			if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
			const value = result.value as unknown as CollectValue;
			const after = await readInventory();
			const delta = (after.counts.cobblestone ?? 0) - (before.counts.cobblestone ?? 0);
			if (value.acquired < 2) throw new Error(`acquired=${value.acquired}`);
			if (!value.toolsUsed.includes("wooden_pickaxe")) throw new Error(`toolsUsed=${value.toolsUsed.join(",")}`);
			if (delta < 2) throw new Error(`cobblestoneDelta=${delta}`);
			return `mined=${value.mined} acquired=${value.acquired} tools=${value.toolsUsed.join(",")} delta=${delta}`;
		});

		// ---- 4 失败面：这件物品没有方块来源 ----
		await step("collect@1 bread -> NOT_FOUND", async () => {
			const result = await call("collect@1", { item: "bread", count: 1 });
			expectCode(result, "NOT_FOUND", "bread");
			return `code=${result.code} message=${result.message ?? ""}`;
		});

		// ---- 5 失败面：没工具，且不该为此走位 ----
		await step("collect@1 cobblestone without pickaxe -> MISSING_TOOL (no move)", async () => {
			await command("/clear UinaDev");
			const before = await here();
			const result = await call("collect@1", { item: "cobblestone", count: 1, radius: 8 });
			expectCode(result, "MISSING_TOOL", "no pickaxe");
			const after = await here();
			const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y) + Math.abs(after.z - before.z);
			if (moved !== 0) throw new Error(`moved ${moved} blocks before failing`);
			return `code=${result.code} moved=0`;
		});

		// ---- 6 丢弃：完成由地面掉落物实体证明 ----
		await step("drop@1 dirt x2", async () => {
			await command("/give UinaDev minecraft:dirt 6");
			const result = await call("drop@1", { item: "dirt", count: 2 }, 30000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
			const value = result.value as unknown as { dropped: Record<string, number>; remaining: number };
			if (value.dropped.dirt !== 2 || value.remaining !== 0) {
				throw new Error(`dropped=${JSON.stringify(value.dropped)} remaining=${value.remaining}`);
			}
			return `dropped=${JSON.stringify(value.dropped)}`;
		});

		// ---- 7 拾取：把物品放在 4 格外，走过去捡（自己丢的会被立刻吸走） ----
		await step("pickup@1 dirt x2 (4 blocks away)", async () => {
			const at = await here();
			const spot = { x: at.x + 4, y: at.y, z: at.z };
			await command(`/setblock ${spot.x} ${spot.y - 1} ${spot.z} minecraft:stone`);
			await command(`/setblock ${spot.x} ${spot.y} ${spot.z} minecraft:air`);
			await command(
				`/summon minecraft:item ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} {Item:{id:"minecraft:dirt",count:2}}`,
			);
			await sleep(300);
			const listDirt = async (): Promise<string[]> =>
				(await readEntities(8))
					.filter((entity) => entity.item?.name === "dirt")
					.map((entity) => `#${entity.ref.networkId}x${entity.item?.count}@${entity.distance.toFixed(1)}`);
			const before = await listDirt();
			const laid = groundCount(await readEntities(8), "dirt");
			if (laid < 2) throw new Error(`summoned item not visible: ground dirt=${laid}`);
			const result = await call("pickup@1", { item: "dirt", radius: 8 }, 60000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""} [before ${before.join(",")}]`);
			const value = result.value as unknown as { picked: Record<string, number> };
			const after = await listDirt();
			if ((value.picked.dirt ?? 0) < 2) {
				throw new Error(
					`picked=${JSON.stringify(value.picked)} before=[${before.join(",")}] after=[${after.join(",")}]`,
				);
			}
			return `picked=${JSON.stringify(value.picked)} before=[${before.join(",")}] after=[${after.join(",")}]`;
		});

		// ---- 8 失败面：数量不足 ----
		await step("drop@1 dirt x99 -> MISSING_MATERIAL", async () => {
			const result = await call("drop@1", { item: "dirt", count: 99 });
			expectCode(result, "MISSING_MATERIAL", "99 dirt");
			return `code=${result.code} message=${result.message ?? ""}`;
		});

		// ---- 9 失败面：包里没有 ----
		await step("drop@1 bread -> NOT_FOUND", async () => {
			const result = await call("drop@1", { item: "bread" });
			expectCode(result, "NOT_FOUND", "bread");
			return `code=${result.code} message=${result.message ?? ""}`;
		});

		// ---- 10 失败面：地面没有东西可捡 ----
		await step("pickup@1 empty ground -> NOT_FOUND", async () => {
			await command("/kill @e[type=minecraft:item]");
			const result = await call("pickup@1", { radius: 4 });
			expectCode(result, "NOT_FOUND", "empty ground");
			return `code=${result.code} message=${result.message ?? ""}`;
		});

		// ---- 11 失败面：背包满，且不该为此挖第一格 ----
		await step("collect@1 with a full inventory -> INVENTORY_FULL (no mining)", async () => {
			await command("/clear UinaDev");
			for (let i = 0; i < 36; i++) await command("/give UinaDev minecraft:stone 64");
			const inventory = await readInventory();
			if (inventory.freeSlots !== 0) throw new Error(`freeSlots=${String(inventory.freeSlots)}`);
			const at = await here();
			for (const block of [
				{ x: at.x + 2, y: at.y, z: at.z },
				{ x: at.x + 3, y: at.y, z: at.z },
			]) {
				await command(`/setblock ${block.x} ${block.y} ${block.z} minecraft:dirt`);
			}
			await sleep(300);
			const before = (await readBlocks("dirt", 8)).length;
			const result = await call("collect@1", { item: "dirt", count: 1, radius: 8 });
			expectCode(result, "INVENTORY_FULL", "full inventory");
			const after = (await readBlocks("dirt", 8)).length;
			if (after !== before) throw new Error(`dirt blocks changed ${before} -> ${after}`);
			return `code=${result.code} freeSlots=0 dirtBlocks=${before}->${after}`;
		});

		// ---- 收尾 ----
		await command("/clear UinaDev");
		await command("/kill @e[type=minecraft:item]");

		finish();
	} catch (err) {
		console.error("[mc-k2] K2 ERROR:", err);
		process.exitCode = 1;
	} finally {
		await closeHarness(h);
	}
}

await main();
