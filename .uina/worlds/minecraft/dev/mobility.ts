/**
 * 批12 真服验收：移动鲁棒性（follow/flee/surface）。
 *
 * 被测行为全部走正式能力面（Runtime submit → callable）；
 * op 指令只备地形/实体/状态（NoAI 实体、密封石箱、水柱），不代替任何被测动作。
 * 断言用独立事实交叉核验（entities 复读距离、self 复读 inWater/位置），不信任单次返回值。
 * fight 的战斗会话在 dev/combat.ts。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, type EntityView, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9500, y: 200, z: 9500 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

function flatGap(a: { x: number; z: number }, b: { x: number; z: number }): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 服务端权威位置：/data get entity 的 Pos 经 events@1 读回。
 * self@1 的 position 是客户端预测；独立复核用服务端真值，预测分叉时能现形。
 */
async function serverPos(
	h: Awaited<ReturnType<typeof openHarness>>,
	s: ReturnType<typeof makeScenario>,
): Promise<{ x: number; y: number; z: number }> {
	await s.command(`/data get entity ${USER} Pos`);
	const observation = await h.world.read<{ events?: { payload?: unknown }[] }>({
		ref: "events@1",
		input: { limit: 8 },
	});
	for (const event of [...(observation.value?.events ?? [])].reverse()) {
		const text = JSON.stringify(event.payload ?? "");
		// 指定路径的 /data get 直接返回坐标列表（无 "Pos:" 前缀）。
		const match = /\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/.exec(text);
		if (match) return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
	}
	throw new Error(`server Pos not found in recent events: ${JSON.stringify(observation.value).slice(0, 300)}`);
}

async function findEntity(s: ReturnType<typeof makeScenario>, name: string, radius = 64): Promise<EntityView> {
	const entities = await s.readEntities(radius);
	const found = entities.find((entity) => entity.name === name);
	if (found == null)
		throw new Error(`${name} not tracked within ${radius} (got ${entities.map((e) => e.name).join(",") || "none"})`);
	return found;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-mobility-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:mobility-${Date.now()}` };
	const h = await openHarness("mobility", { dataRoot, binding });
	const s = makeScenario(h, "mobility");
	try {
		await s.step("prepare platform and props", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			const deadline = Date.now() + 20000;
			for (;;) {
				const anchor = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
				if (anchor != null) break;
				if (Date.now() >= deadline) throw new Error("test-area chunk never became observable");
				await sleep(300);
			}
			// 空中平台夜晚会自然刷怪（首轮实测：僵尸把机器人打到 3 血、苦力怕收尾）。
			// 关闭天然生成 + peaceful：清除全部敌对并停止生成；flee 步骤临时切 easy 时
			// 也因 spawn_mobs=false 不会有天然敌对混入独立复核。
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:cow]`);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(
				`/fill ${CENTER.x - 50} 199 ${CENTER.z - 50} ${CENTER.x + 50} 199 ${CENTER.z + 50} minecraft:stone`,
			);
			// fill 之后再落位（dev/MC-WORLD.md 经验 21）。
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			// 归一化背包：combat 场景留下的剑/盾/甲会改变 surface 竖井寻路的挖掘
			// 代价模型（真服实测：持剑时寻路拒绝挖石，0 dug 空转到超时）。
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:dirt 16`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const self = await s.readSelf();
			const below = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
			if (Math.abs(self.place.position.y - CENTER.y) > 2 || below?.name !== "stone") {
				throw new Error(`bot not standing on the platform: y=${self.place.position.y} below=${below?.name ?? "null"}`);
			}
			const hostiles = (await s.readEntities(64)).filter((e) => e.kind === "hostile");
			if (hostiles.length > 0) {
				throw new Error(`hostiles remain on the platform: ${hostiles.map((e) => e.name).join(",")}`);
			}
			return "platform 101x101 @9500, spawn_mobs=false, no hostiles, dirt x16";
		});

		await s.step("follow tracks a relocated target and ends target_lost when tracking is gone", async () => {
			await s.command(`/summon minecraft:cow ${CENTER.x + 15} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			const spawned = await s.spawn("follow@1", { target: "cow", distance: 3, maxTimeMs: 40000 });
			await sleep(3000); // 第一段：走到 3 格内
			await s.command(`/tp @e[type=minecraft:cow,limit=1] ${CENTER.x + 35} ${CENTER.y} ${CENTER.z}`);
			await sleep(6000); // 第二段：目标移动后重新瞄准并追上
			const self = await s.readSelf();
			const cow = await findEntity(s, "cow");
			const gap = flatGap(self.place.position, cow.position);
			if (gap > 6) throw new Error(`follow did not catch up after the cow moved: gap=${gap.toFixed(2)}`);
			await s.command(`/tp @e[type=minecraft:cow,limit=1] ${CENTER.x + 300} ${CENTER.y} ${CENTER.z + 300}`);
			const result = await s.waitCall(spawned, 60000);
			const value = valueOf<{ ended: string; moved: boolean }>(result);
			if (value.ended !== "target_lost") throw new Error(`expected target_lost, got ${JSON.stringify(value)}`);
			if (value.moved !== true) throw new Error("follow reported moved=false despite chasing");
			await s.command(`/kill @e[type=minecraft:cow]`);
			return `caught up (gap ${gap.toFixed(2)} after re-target), ended=target_lost, moved=true`;
		});

		await s.step("follow a standing target ends with timeout at budget end", async () => {
			await s.command(`/summon minecraft:cow ${CENTER.x + 6} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			const value = valueOf<{ ended: string }>(
				await s.call("follow@1", { target: "cow", distance: 3, maxTimeMs: 2500 }, 30000),
			);
			if (value.ended !== "timeout") throw new Error(`expected timeout, got ${JSON.stringify(value)}`);
			await s.command(`/kill @e[type=minecraft:cow]`);
			return "ended=timeout with the budget exhausted";
		});

		await s.step("flee reaches the declared distance from the named threat", async () => {
			// peaceful 下敌对实体无法存在：flee 步骤临时切 easy（doMobSpawning 已关，无天然刷怪）。
			// 威胁点固定在 CENTER+30（远离机器人当前位）：避免"威胁刷在脚边"的退化方向。
			await s.command(`/difficulty easy`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/summon minecraft:zombie ${CENTER.x + 30} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			const value = valueOf<{ moved: boolean; distance: number; safe: boolean }>(
				await s.call("flee@1", { from: "zombie", distance: 24, maxTimeMs: 30000 }, 60000),
			);
			if (value.safe !== true || value.moved !== true) throw new Error(`flee not safe/moved: ${JSON.stringify(value)}`);
			if (value.distance < 24) throw new Error(`flee reported distance ${value.distance} < 24`);
			// 独立复核（服务端权威位置 vs NoAI 威胁）：允许 ≤1.5 格收尾动量滑移——
			// flee 保证的是测量时刻的距离，腿结束后冲刺惯性还会带走半格。
			const zombie = await findEntity(s, "zombie", 64);
			const bot = await serverPos(h, s);
			const gap = Math.hypot(bot.x - zombie.position.x, bot.z - zombie.position.z);
			if (gap < 22.5) {
				throw new Error(
					`independent gap ${gap.toFixed(2)} < 22.5 (bot=${JSON.stringify(bot)} zombie=${JSON.stringify(zombie.position)})`,
				);
			}
			return `safe=true, reported ${value.distance}, server gap ${gap.toFixed(2)}`;
		});

		await s.step("flee without from picks the nearest hostile", async () => {
			const value = valueOf<{ safe: boolean; distance: number }>(
				await s.call("flee@1", { distance: 20, maxTimeMs: 30000 }, 60000),
			);
			if (value.safe !== true) throw new Error(`flee not safe: ${JSON.stringify(value)}`);
			const zombie = await findEntity(s, "zombie", 64);
			const bot = await serverPos(h, s);
			const gap = Math.hypot(bot.x - zombie.position.x, bot.z - zombie.position.z);
			if (gap < 18.5) {
				throw new Error(
					`independent gap ${gap.toFixed(2)} < 18.5 (bot=${JSON.stringify(bot)} zombie=${JSON.stringify(zombie.position)})`,
				);
			}
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/difficulty peaceful`);
			return `default threat fled, server gap ${gap.toFixed(2)} ≥ 20`;
		});

		await s.step("surface digs out of a sealed stone box", async () => {
			const spot = { x: CENTER.x + 20, y: CENTER.y, z: CENTER.z };
			await s.command(`/gamemode creative ${USER}`);
			// 3x3 石壳（y..y+3），随后掏空中心柱：机器人被封在 y..y+2 的空气柱里，顶盖在 y+3。
			await s.command(
				`/fill ${spot.x - 1} ${spot.y} ${spot.z - 1} ${spot.x + 1} ${spot.y + 3} ${spot.z + 1} minecraft:stone`,
			);
			await s.command(`/fill ${spot.x} ${spot.y} ${spot.z} ${spot.x} ${spot.y + 2} ${spot.z} minecraft:air`);
			await s.command(`/tp ${USER} ${spot.x + 0.5} ${spot.y + 0.1} ${spot.z + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const roof = await s.readBlock({ x: spot.x, y: spot.y + 3, z: spot.z });
			if (roof?.name !== "stone") throw new Error(`seal failed: roof=${roof?.name ?? "null"}`);
			const before = await s.readSelf();
			const value = valueOf<{ at: { position: { y: number } }; escaped: boolean; reason: string | null }>(
				await s.call("surface@1", { maxTimeMs: 90000 }, 120000),
			);
			if (value.escaped !== true) throw new Error(`surface did not escape: ${JSON.stringify(value)}`);
			if (value.at.position.y <= before.place.position.y + 1) {
				throw new Error(`surface did not gain height: ${before.place.position.y} -> ${value.at.position.y}`);
			}
			const after = await s.readSelf();
			if (after.place.position.y <= before.place.position.y + 1) {
				throw new Error(`self position did not rise: ${after.place.position.y}`);
			}
			return `escaped reason=${value.reason ?? "null"}, y ${before.place.position.y} -> ${after.place.position.y}`;
		});

		await s.step("surface swims out of a sunken pool", async () => {
			const pool = { x: CENTER.x - 20, y: CENTER.y, z: CENTER.z };
			await s.command(`/gamemode creative ${USER}`);
			// 先清空再注水，且范围扩大到 ±2：历史轮次会在井区外留下残水/垫块，
			// 机器人会游出井口掉进残水囊里（真服实测：残水中溺水、自保打断 surface）。
			await s.command(`/fill ${pool.x - 2} 193 ${pool.z - 2} ${pool.x + 2} 202 ${pool.z + 2} minecraft:air`);
			await s.command(`/fill ${pool.x - 2} 193 ${pool.z - 2} ${pool.x + 2} 193 ${pool.z + 2} minecraft:stone`);
			// 平台层挖 3x3、深 5 的水井（195..199 全水），与平台面齐平，机器人从井底出发。
			await s.command(`/fill ${pool.x - 1} 195 ${pool.z - 1} ${pool.x + 1} 199 ${pool.z + 1} minecraft:water`);
			await s.command(`/tp ${USER} ${pool.x + 0.5} 196.2 ${pool.z + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await sleep(1200);
			const before = await s.readSelf();
			if (before.inWater !== true) throw new Error(`bot is not submerged: inWater=${before.inWater}`);
			const value = valueOf<{ escaped: boolean; reason: string | null }>(
				await s.call("surface@1", { maxTimeMs: 90000 }, 120000),
			);
			if (value.escaped !== true) throw new Error(`surface did not escape: ${JSON.stringify(value)}`);
			const after = await s.readSelf();
			if (after.inWater === true) throw new Error("bot still in water after surface");
			const gap = flatGap(after.place.position, pool);
			if (gap < 2) throw new Error(`bot did not leave the pool: gap=${gap.toFixed(2)}`);
			return `escaped reason=${value.reason ?? "null"}, left the pool (gap ${gap.toFixed(2)}), inWater=false`;
		});
	} finally {
		s.finish();
		await closeHarness(h);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
