/**
 * Minecraft World K1 真服场景：9 查询 + 8 动作的真实闭环。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3–§4、
 * development-guide.md §5（游戏动作用真实服务端验证）。
 * 场景准备用 op 指令（setblock/give/summon）把地形与物品摆好；被测动作本身
 * 全部走正式能力层，不用指令代替挖/放/用/攻击。每步独立记录，最后汇总。
 * 运行前提：dev-env 服务端已启动，UinaDev 在 ops.json 中。
 */

import type { JsonValue, Vec3 } from "../contracts/values.js";
import { closeHarness, openHarness, sleep } from "./harness.js";
import { makeScenario } from "./scenario.js";

interface EventPage {
	events: { ref: string; payload: { kind: string; text?: string } }[];
	gaps: unknown[];
	next?: string;
	after?: string;
}

async function main(): Promise<void> {
	const h = await openHarness("k1");
	const { world } = h;
	const { call, readSelf, readBlock, readInventory, command, step, log, finish } = makeScenario(h, "k1");

	try {
		const self = await readSelf();
		const base = {
			x: Math.floor(self.place.position.x),
			y: Math.floor(self.place.position.y),
			z: Math.floor(self.place.position.z),
		};
		const A = { x: base.x + 2, y: base.y, z: base.z };
		const B = { x: base.x - 2, y: base.y, z: base.z };
		// 挖脚下那一格：掉落正落在身体位置上，dropped 的可观察性不依赖寻路精度。
		const C = { x: base.x, y: base.y - 1, z: base.z };
		log(`base=${JSON.stringify(base)} A=${JSON.stringify(A)} B=${JSON.stringify(B)} C=${JSON.stringify(C)}`);

		// ---- 场景准备（op 指令只摆地形/物品，不替代被测动作） ----
		// 复位玩家模式与遗留实体：创造模式不掉落、旧掉落物会干扰增量判断。
		await command("/gamemode survival UinaDev");
		await command("/kill @e[type=minecraft:item]");
		await command("/kill @e[type=minecraft:cow]");
		await command(`/setblock ${A.x} ${A.y - 1} ${A.z} minecraft:stone`);
		await command(`/setblock ${A.x} ${A.y} ${A.z} minecraft:air`);
		await command(`/setblock ${A.x} ${A.y + 1} ${A.z} minecraft:air`);
		await command(`/setblock ${B.x} ${B.y - 1} ${B.z} minecraft:stone`);
		await command(`/setblock ${B.x} ${B.y} ${B.z} minecraft:air`);
		await command(`/setblock ${C.x} ${C.y - 1} ${C.z} minecraft:stone`);
		await command(`/setblock ${C.x} ${C.y} ${C.z} minecraft:dirt`);
		await command(`/setblock ${C.x} ${C.y + 1} ${C.z} minecraft:air`);
		await command("/give UinaDev minecraft:dirt 8");
		await command("/give UinaDev minecraft:oak_sign 1");
		await command("/give UinaDev minecraft:lever 1");
		await command("/give UinaDev minecraft:bread 2");
		await command(`/summon minecraft:cow ${base.x + 1} ${base.y} ${base.z + 1} {NoAI:1b}`);
		await sleep(500);

		// ---- 只读查询 ----
		await step("world@1", async () => {
			const observation = await world.read<Record<string, JsonValue>>({ ref: "world@1", input: {} });
			const value = observation.value ?? {};
			if (value.dimension !== "overworld") throw new Error(`dimension ${String(value.dimension)}`);
			return `time=${String(value.timeOfDay)} weather=${String(value.weather)} biome=${String(value.biome)} gameMode=${String(value.gameMode)} difficulty=${String(value.difficulty)}`;
		});

		await step("item@1", async () => {
			const observation = await world.read<{ food: unknown; tool: unknown; sourcesComplete: boolean }>({
				ref: "item@1",
				input: { name: "apple" },
			});
			if (observation.value == null) throw new Error("null value");
			if (observation.value.food == null) throw new Error("apple has no food data");
			return `food=${JSON.stringify(observation.value.food)} sourcesComplete=${String(observation.value.sourcesComplete)}`;
		});

		await step("recipe@1", async () => {
			const observation = await world.read<{ recipes: unknown[]; plan?: { missing: Record<string, number> } }>({
				ref: "recipe@1",
				input: { item: "oak_planks", count: 4 },
			});
			if (observation.value == null || observation.value.recipes.length === 0) throw new Error("no recipes");
			return `recipes=${observation.value.recipes.length} missing=${JSON.stringify(observation.value.plan?.missing ?? {})}`;
		});

		await step("inventory@1 after give", async () => {
			const inventory = await readInventory();
			const need = { dirt: 8, oak_sign: 1, lever: 1 };
			for (const [item, count] of Object.entries(need)) {
				if ((inventory.counts[item] ?? 0) < count) {
					throw new Error(`${item}=${inventory.counts[item] ?? 0} < ${count}`);
				}
			}
			return `counts=${JSON.stringify(inventory.counts)} freeSlots?`;
		});

		// ---- 动作 ----
		await step("equip@1 dirt -> hand", async () => {
			const result = await call("equip@1", { item: "dirt", slot: "hand" });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const inventory = await readInventory();
			if (inventory.held?.name !== "dirt") throw new Error(`held=${inventory.held?.name ?? "none"}`);
			return `held=${inventory.held.name}x${inventory.held.count} slot=${String((result.value as { slot?: string }).slot)}`;
		});

		await step("place@1 dirt at A", async () => {
			const result = await call("place@1", { block: "dirt", at: A });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const block = await readBlock(A);
			if (block?.name !== "dirt") throw new Error(`A is ${block?.name ?? "null"}`);
			return `A=${block.name}`;
		});

		await step("place@1 oak_sign on A", async () => {
			const result = await call("place@1", { block: "oak_sign", at: { x: A.x, y: A.y + 1, z: A.z } });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const block = await readBlock({ x: A.x, y: A.y + 1, z: A.z });
			if (block == null || !block.name.includes("sign")) throw new Error(`above A is ${block?.name ?? "null"}`);
			return `${block.name} properties=${JSON.stringify(block.properties)}`;
		});

		await step("use@1 write sign (front)", async () => {
			const result = await call("use@1", {
				at: { x: A.x, y: A.y + 1, z: A.z },
				text: "hello\nbase",
				side: "front",
			});
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			return `effect=${String((result.value as { effect?: string }).effect)} changed=${String((result.value as { changed?: unknown }).changed)}`;
		});

		await step("place@1 lever at B", async () => {
			const result = await call("place@1", { block: "lever", at: B });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const block = await readBlock(B);
			if (block?.name !== "lever") throw new Error(`B is ${block?.name ?? "null"}`);
			return `${block.name} properties=${JSON.stringify(block.properties)}`;
		});

		await step("equip@1 null -> empty hand", async () => {
			const result = await call("equip@1", { item: null, slot: "hand" });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const inventory = await readInventory();
			if (inventory.held != null) throw new Error(`hand still holds ${inventory.held.name}`);
			return "hand empty";
		});

		await step("use@1 toggle lever", async () => {
			const before = await readBlock(B);
			const result = await call("use@1", { at: B });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const after = await readBlock(B);
			const changed = (result.value as { changed?: Record<string, unknown> }).changed ?? {};
			if (Object.keys(changed).length === 0) throw new Error("changed is empty");
			return `before=${JSON.stringify(before?.properties)} after=${JSON.stringify(after?.properties)} changed=${JSON.stringify(changed)}`;
		});

		await step("mine@1 dirt at C", async () => {
			// 可达性归调用方：先 goto 回脚下这块的正上方，再挖（mine 不寻路）。
			// 站在被挖格正上方，掉落就落在身体位置，dropped 才必然可观察。
			const approach = await call(
				"goto@1",
				{ at: { x: base.x + 0.5, y: base.y, z: base.z + 0.5 }, tolerance: 1 },
				60000,
			);
			if (!approach.ok) throw new Error(`approach failed: ${approach.code}: ${approach.message}`);
			const before = await readInventory();
			const start = await readSelf();
			const gap = Math.hypot(
				start.place.position.x - (C.x + 0.5),
				start.place.position.y - (C.y + 0.5),
				start.place.position.z - (C.z + 0.5),
			);
			// 掉落能被捡到的前提是站在被挖格上；站远了 dropped 必然为 null，那是站位问题不是挖掘问题。
			if (gap > 1.0)
				throw new Error(`approach left the body ${gap.toFixed(2)} blocks from C; pickup cannot be observed`);
			const result = await call("mine@1", { at: C }, 20000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message} (gap=${gap.toFixed(2)})`);
			const block = await readBlock(C);
			const after = await readInventory();
			const delta = (after.counts.dirt ?? 0) - (before.counts.dirt ?? 0);
			if (block != null && block.name !== "air") throw new Error(`C is still ${block.name}`);
			const near = await world.read<{
				entities: { name: string; position: Vec3; item: { name: string; count: number } | null }[];
			}>({
				ref: "entities@1",
				input: { kind: "all", radius: 6 },
			});
			const nearby = (near.value?.entities ?? []).map(
				(entity) =>
					`${entity.item?.name ?? entity.name}@${entity.position.x},${entity.position.y},${entity.position.z}`,
			);
			const dropped = (result.value as { dropped?: { name: string; count: number } }).dropped;
			if (dropped != null) {
				if (dropped.name !== "dirt" || delta < dropped.count) {
					throw new Error(`dropped=${JSON.stringify(dropped)} dirtDelta=${delta}`);
				}
				return `broken=${String((result.value as { broken?: boolean }).broken)} dirtDelta=${delta} dropped=${JSON.stringify(dropped)}`;
			}
			// 合同允许"没在窗口内观察到就不报 dropped"。这里用地面掉落物实体补证：
			// 挖完必须能找到 dirt 的掉落物（背包里或地上），否则才算这一步失败。
			const onGround = (near.value?.entities ?? []).reduce(
				(total, entity) => total + (entity.item?.name === "dirt" ? entity.item.count : 0),
				0,
			);
			if (delta <= 0 && onGround === 0) {
				throw new Error(
					`broken but no dirt drop observed (gap=${gap.toFixed(2)} dirtDelta=${delta}, near=${nearby.join("|") || "none"})`,
				);
			}
			return `broken=true dropped=null observed=${delta > 0 ? `inventory+${delta}` : `ground=${onGround}`}`;
		});

		await step("mine@1 out of reach -> UNREACHABLE", async () => {
			// 可达性归调用方：够不着的格子必须在派发前拒绝，不能"挖了但没掉落"。
			const far = { x: C.x + 8, y: C.y, z: C.z };
			await command(`/setblock ${far.x} ${far.y} ${far.z} minecraft:dirt`);
			const result = await call("mine@1", { at: far }, 20000);
			if (result.ok) throw new Error("mine@1 accepted a block 8 blocks away");
			if (result.code !== "UNREACHABLE") throw new Error(`expected UNREACHABLE, got ${result.code}: ${result.message}`);
			return `at=${far.x},${far.y},${far.z} code=${result.code}`;
		});

		await step("blocks@1 sees placed dirt", async () => {
			const observation = await world.read<{ blocks: { name: string }[]; count: number }>({
				ref: "blocks@1",
				input: { name: "dirt", radius: 8, limit: 8 },
			});
			const value = observation.value;
			if (value == null || value.count === 0) throw new Error("no dirt found");
			return `count=${value.count} names=${value.blocks.map((b) => b.name).join(",")}`;
		});

		await step("entities@1 sees summoned cow", async () => {
			const observation = await world.read<{ entities: { name: string; kind: string; distance: number }[] }>({
				ref: "entities@1",
				input: { kind: "passive", radius: 16 },
			});
			const cow = observation.value?.entities.find((entity) => entity.name === "cow");
			if (cow == null) throw new Error("no cow tracked");
			return `cow distance=${cow.distance} kind=${cow.kind}`;
		});

		await step("attack@1 cow", async () => {
			const result = await call("attack@1", { target: "cow" });
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const hit = (result.value as { hit?: boolean | null }).hit;
			if (hit !== true) throw new Error(`hit=${String(hit)}`);
			return `hit=true target=${JSON.stringify((result.value as { target?: unknown }).target)}`;
		});

		await step("eat@1 dirt -> WRONG_STATE (not food)", async () => {
			// 输入错误优先于状态：dirt 不是食物，即使此刻不饿也该说这一条。
			const result = await call("eat@1", { food: "dirt" }, 30000);
			if (result.ok) throw new Error("expected WRONG_STATE for a non-food item");
			if (result.code !== "WRONG_STATE") throw new Error(`expected WRONG_STATE, got ${result.code}: ${result.message}`);
			if (!/not food/.test(result.message ?? "")) throw new Error(`state masked the input error: ${result.message}`);
			return `code=${result.code} message=${result.message ?? ""}`;
		});

		await step("eat@1 bread when hungry", async () => {
			// 只改环境：饥饿效果把 food 拉到 20 以下，吃饭本身走正式能力。
			await command("/effect give UinaDev minecraft:hunger 3 255");
			await sleep(4000);
			const before = await readSelf();
			if (before.food == null || before.food >= 20)
				throw new Error(`hunger effect did not lower food (${String(before.food)})`);
			const breadBefore = (await readInventory()).counts.bread ?? 0;
			const result = await call("eat@1", { food: "bread", until: "count", count: 1 }, 30000);
			if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
			const value = result.value as {
				eaten?: { name: string; count: number }[];
				food?: { before: number | null; after: number | null };
			};
			const after = await readSelf();
			const breadAfter = (await readInventory()).counts.bread ?? 0;
			const eaten = value.eaten?.[0];
			if (eaten?.name !== "bread" || eaten.count !== 1) throw new Error(`eaten=${JSON.stringify(value.eaten)}`);
			if (value.food?.after == null || value.food.after <= (value.food.before ?? -1)) {
				throw new Error(`food did not increase: ${String(value.food?.before)} -> ${String(value.food?.after)}`);
			}
			if (after.food !== value.food.after)
				throw new Error(`sampled food ${String(after.food)} != reported ${String(value.food.after)}`);
			if (breadAfter !== breadBefore - 1) throw new Error(`bread ${breadBefore} -> ${breadAfter}, want -1`);
			return `food=${String(value.food.before)}->${String(value.food.after)} bread=${breadBefore}->${breadAfter}`;
		});

		await step("events@1 chat history + paging", async () => {
			// 契约：无 after 的读只给"最近 limit 条"+after，不给 next；next 只出现在 after 之后的正向分页。
			const tail = (await world.read<EventPage>({ ref: "events@1", input: { kinds: ["chat"], limit: 1 } })).value;
			const after = tail?.after;
			if (after == null) throw new Error("tail read has no after token");
			if (tail?.next != null) throw new Error("tail read must not hand out next");
			// 自己造证据：普通消息会被服务端回显成 chat 事件，不依赖环境里恰好有几条系统消息。
			for (const text of ["k1 ping 1", "k1 ping 2", "k1 ping 3"]) {
				const sent = await call("chat@1", { text });
				if (!sent.ok) throw new Error(`chat failed: ${sent.code} ${sent.message ?? ""}`);
			}
			await sleep(600);
			const texts = (page: EventPage | null | undefined): string =>
				(page?.events ?? []).map((event) => event.payload.text ?? event.ref).join("|");
			const first = (await world.read<EventPage>({ ref: "events@1", input: { after, limit: 2 } })).value;
			if (first == null || first.events.length !== 2) throw new Error(`forward page=${texts(first)}`);
			if (first.next == null) throw new Error(`2 of 3 pings fit the page but next is null: ${texts(first)}`);
			const second = (await world.read<EventPage>({ ref: "events@1", input: { cursor: first.next } })).value;
			if (second == null || second.events.length !== 1) throw new Error(`cursor page=${texts(second)}`);
			if (second.next != null) throw new Error("last page must not hand out next");
			const overlap = second.events.filter((event) => first.events.some((seen) => seen.ref === event.ref));
			if (overlap.length > 0) throw new Error(`cursor page repeated refs: ${texts(second)}`);
			// 增量读：游标之后再没有聊天事件，就是空页。
			const finalAfter = second.after ?? first.after;
			if (finalAfter == null) throw new Error("last page has no after token");
			const incremental = (
				await world.read<EventPage>({ ref: "events@1", input: { kinds: ["chat"], after: finalAfter } })
			).value;
			if (incremental == null || incremental.events.length !== 0) {
				throw new Error(`after read returned ${texts(incremental)}, want empty`);
			}
			return `page1=${texts(first)} page2=${texts(second)} gaps=${first.gaps.length} incremental=0`;
		});

		finish();
	} catch (err) {
		console.error("[mc-k1] K1 ERROR:", err);
		process.exitCode = 1;
	} finally {
		await closeHarness(h);
	}
}

await main();
