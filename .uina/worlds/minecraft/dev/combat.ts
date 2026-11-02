/**
 * 批12 真服验收：完整战斗（fight@1）。
 *
 * 被测行为全部走正式能力面；op 指令只备实体/血量/装备。
 * 验收对照 development-plan §10.3：三僵尸打完或撤退且血量≥6；cautious 的接战门撤退；
 * aggressive 追到 4 目标上限；目标失踪不算击杀（ended=target_lost、kills 为空）。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9500, y: 200, z: 9500 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

interface FightValue {
	ended: string;
	kills: { name: string; drops: Record<string, number> }[];
	hp: { before: number | null; after: number | null };
	retreated?: string;
	stance: string;
	retreatHealth: number | null;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-combat-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:combat-${Date.now()}` };
	const h = await openHarness("combat", { dataRoot, binding });
	const s = makeScenario(h, "combat");
	try {
		await s.step("prepare platform and gear", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			const deadline = Date.now() + 20000;
			for (;;) {
				const anchor = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
				if (anchor != null) break;
				if (Date.now() >= deadline) throw new Error("test-area chunk never became observable");
				await sleep(300);
			}
			// mobility 场景可能把难度留在 peaceful；战斗验收需要敌对实体与真实伤害。
			await s.command(`/difficulty easy`);
			await s.command(`/gamerule spawn_mobs false`);
			// type= 只收实体 ID，没有 "monster" 标签——逐类清（历史轮次的自然刷怪
			// 会在平台上跨轮累积 creeper/skeleton/spider，首轮实战就是这么被围殴的）。
			for (const mob of [
				"zombie",
				"skeleton",
				"creeper",
				"spider",
				"cave_spider",
				"enderman",
				"witch",
				"phantom",
				"slime",
				"drowned",
				"husk",
				"stray",
				"bogged",
				"pillager",
				"zombified_piglin",
			]) {
				await s.command(`/kill @e[type=minecraft:${mob}]`);
			}
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command(`/effect clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_sword 1`);
			await s.command(`/give ${USER} minecraft:shield 1`);
			// 全套铁甲：无甲承伤 ~7/s（3 僵尸）会在单次循环内打穿撤退线（首轮实测当场死亡）；
			// 铁甲后 ~3/s，fight 的循环粒度接得住，撤退/清场两条路都真实可达。
			await s.command(`/give ${USER} minecraft:iron_helmet 1`);
			await s.command(`/give ${USER} minecraft:iron_chestplate 1`);
			await s.command(`/give ${USER} minecraft:iron_leggings 1`);
			await s.command(`/give ${USER} minecraft:iron_boots 1`);
			await s.command(`/gamemode survival ${USER}`);
			// 护甲走 equip@1 正式能力面穿上去。
			for (const piece of ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"]) {
				const slot =
					piece === "iron_helmet"
						? "head"
						: piece === "iron_chestplate"
							? "chest"
							: piece === "iron_leggings"
								? "legs"
								: "feet";
				const equipped = await s.call("equip@1", { item: piece, slot });
				if (!equipped.ok) throw new Error(`equip ${piece} failed: ${equipped.code}`);
			}
			await waitForStill(h.bot, h.log);
			const self = await s.readSelf();
			if (Math.abs(self.place.position.y - CENTER.y) > 2)
				throw new Error(`bot not on the platform: ${JSON.stringify(self.place.position)}`);
			const hostiles = (await s.readEntities(64)).filter((e) => e.kind === "hostile");
			if (hostiles.length > 0) throw new Error(`hostiles remain: ${hostiles.map((e) => e.name).join(",")}`);
			return "platform ready, spawn_mobs=false, iron gear equipped via equip@1";
		});

		/** 战斗步骤间的复活复位守卫：死亡后机器人会重生在世界出生点，后续步骤必须先拉回来。 */
		async function restore(): Promise<void> {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await s.command(`/gamemode survival ${USER}`);
			await sleep(1200);
			const self = await s.readSelf();
			if ((self.health ?? 0) <= 0) throw new Error("bot is dead after restore");
		}

		await s.step("balanced fight clears or honestly retreats from three chasing zombies (hp>=6)", async () => {
			for (const [dx, dz] of [
				[14, 0],
				[-12, 8],
				[4, -15],
			] as const) {
				await s.command(`/summon minecraft:zombie ${CENTER.x + dx} ${CENTER.y} ${CENTER.z + dz}`);
			}
			await sleep(800);
			const value = valueOf<FightValue>(
				await s.call(
					"fight@1",
					{
						radius: 24,
						stance: "balanced",
						// 撤退线显式抬高：3 僵尸围殴下的脱离接触还要挨 3-4 点（真服实测
						// 默认撤退线 8 落地只剩 ~5.2），为脱离成本留余量——合同允许显式覆盖。
						retreatHealth: 12,
						maxTimeMs: 120000,
					},
					150000,
				),
			);
			if (value.ended !== "targets_cleared" && value.ended !== "retreated") {
				throw new Error(`expected targets_cleared or retreated, got ${JSON.stringify(value)}`);
			}
			const cleared = value.ended === "targets_cleared";
			if (cleared && value.kills.length !== 3) {
				throw new Error(`cleared but kills=${value.kills.length}: ${JSON.stringify(value.kills)}`);
			}
			if (!cleared && value.retreated !== "low_health" && value.retreated !== "no_progress") {
				throw new Error(`retreated without a reason: ${JSON.stringify(value)}`);
			}
			if (value.hp.after == null || value.hp.after < 6) {
				throw new Error(`hp after fight = ${value.hp.after} < 6`);
			}
			const remaining = (await s.readEntities(48)).filter((entity) => entity.name === "zombie").length;
			if (cleared && remaining > 0) throw new Error(`${remaining} zombies still tracked after targets_cleared`);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			return `ended=${value.ended}${value.retreated ? `(${value.retreated})` : ""}, kills=${value.kills.length}, hp ${value.hp.before}->${value.hp.after}`;
		});

		await s.step("cautious engage gate withdraws instead of fighting at low health", async () => {
			await restore();
			await s.command(`/summon minecraft:zombie ${CENTER.x + 10} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			await s.command(`/damage ${USER} 14`); // 20 -> 6，低于 cautious 接战线 17
			await sleep(600);
			const value = valueOf<FightValue>(
				await s.call("fight@1", { stance: "cautious", radius: 24, maxTimeMs: 20000 }, 60000),
			);
			if (value.ended !== "retreated" || value.retreated !== "low_health") {
				throw new Error(`expected retreated(low_health), got ${JSON.stringify(value)}`);
			}
			if (value.kills.length !== 0) throw new Error(`no engagement expected, kills=${value.kills.length}`);
			const zombie = (await s.readEntities(64)).find((entity) => entity.name === "zombie");
			if (zombie == null) throw new Error("the passive zombie vanished (it should never be engaged)");
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await sleep(800);
			const healed = await s.readSelf();
			if ((healed.health ?? 0) < 18) throw new Error(`heal failed: health=${healed.health}`);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			return `retreated low_health with kills=0, healed to ${healed.health}`;
		});

		await s.step("aggressive engages up to four targets and clears them", async () => {
			await restore();
			for (const [dx, dz] of [
				[8, 2],
				[-8, 2],
				[2, -9],
				[-2, 9],
			] as const) {
				await s.command(`/summon minecraft:zombie ${CENTER.x + dx} ${CENTER.y} ${CENTER.z + dz} {NoAI:1b}`);
			}
			await sleep(800);
			const value = valueOf<FightValue>(
				await s.call("fight@1", { stance: "aggressive", radius: 24, maxTimeMs: 180000 }, 210000),
			);
			if (value.ended !== "targets_cleared") throw new Error(`expected targets_cleared, got ${JSON.stringify(value)}`);
			if (value.kills.length !== 4) throw new Error(`expected 4 kills, got ${value.kills.length}`);
			if (value.stance !== "aggressive") throw new Error(`stance mismatch: ${value.stance}`);
			await s.command(`/kill @e[type=minecraft:item]`);
			return `4 NoAI zombies cleared, hp ${value.hp.before}->${value.hp.after}`;
		});

		await s.step("a target lost without death evidence ends target_lost, not a kill", async () => {
			await restore();
			await s.command(`/summon minecraft:zombie ${CENTER.x + 10} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			await s.command(`/effect give @e[type=minecraft:zombie,limit=1] minecraft:resistance 60 4 true`);
			const spawned = await s.spawn("fight@1", { target: "zombie", stance: "balanced", maxTimeMs: 60000 });
			await sleep(4000); // 接近并命中数次，但抗性 80% 保证存活且无死亡观察
			await s.command(`/tp @e[type=minecraft:zombie,limit=1] ${CENTER.x + 400} ${CENTER.y} ${CENTER.z + 400}`);
			const value = valueOf<FightValue>(await s.waitCall(spawned, 120000));
			if (value.ended !== "target_lost") throw new Error(`expected target_lost, got ${JSON.stringify(value)}`);
			if (value.kills.length !== 0)
				throw new Error(`vanished target must not count as kill: ${JSON.stringify(value.kills)}`);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			return `ended=target_lost with kills=0`;
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
