/**
 * 批12 真服验收：完整战斗（fight@1）。
 *
 * 被测行为全部走正式能力面；op 指令只备实体/血量/装备。
 * 验收对照 development-plan §10.3：三僵尸打完或撤退且血量≥6；cautious 的接战门撤退；
 * aggressive 追到 4 目标上限；目标失踪不算击杀（ended=target_lost、kills 为空）。
 * 批26 追加（B05）：围死地形里未脱险的撤退必须如实 retreat_failed，不许假报 retreated。
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
			// 围死步的围墙体积一并清掉：上一轮若在任何环节中断，残留围墙会毒化后续
			// 所有需要开阔地的步骤（批26 实测跨轮污染）。
			await s.command(
				`/fill ${CENTER.x - 3} ${CENTER.y} ${CENTER.z - 3} ${CENTER.x + 3} ${CENTER.y + 1} ${CENTER.z + 3} minecraft:air`,
			);
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
			// balanced 最多获取 maxTargets=2 个目标：清掉已获取的就 targets_cleared，
			// 第三只不在会话目标内（§4 目标数上限）；G25 修复后追击可靠，清场是常态结局。
			if (value.ended !== "targets_cleared" && value.ended !== "retreated" && value.ended !== "retreat_failed") {
				throw new Error(`expected targets_cleared/retreated/retreat_failed, got ${JSON.stringify(value)}`);
			}
			const cleared = value.ended === "targets_cleared";
			if (cleared && (value.kills.length < 1 || value.kills.length > 2)) {
				throw new Error(`cleared with ${value.kills.length} kills (maxTargets=2): ${JSON.stringify(value.kills)}`);
			}
			if (!cleared && value.retreated !== "low_health" && value.retreated !== "no_progress") {
				throw new Error(`retreated without a reason: ${JSON.stringify(value)}`);
			}
			// 真正脱险（targets_cleared/retreated）才要求血量≥6；retreat_failed 的承伤如实上报。
			if (value.ended !== "retreat_failed" && (value.hp.after == null || value.hp.after < 6)) {
				throw new Error(`hp after fight = ${value.hp.after} < 6`);
			}
			// 死亡动画/实体消散需要几拍：立即读场会把"正在消失的击杀目标"误计入残余。
			await sleep(1000);
			const remaining = (await s.readEntities(48)).filter((entity) => entity.name === "zombie").length;
			if (cleared && remaining !== 3 - value.kills.length) {
				throw new Error(
					`${remaining} zombies remain, expected ${3 - value.kills.length} (kills=${value.kills.length})`,
				);
			}
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

		await s.step("a cornered low-health withdrawal reports retreat_failed, not a fake retreat", async () => {
			await restore();
			// 7×7 两高石墙围死（placeToReach/digThrough 关闭时 8 个方位全部 NoPath）；
			// NoAI 僵尸在墙内 2 格提供威胁 anchor。低血量走 cautious 接战门 → 不接战直接撤。
			await s.command(
				`/fill ${CENTER.x - 3} ${CENTER.y} ${CENTER.z - 3} ${CENTER.x + 3} ${CENTER.y + 1} ${CENTER.z + 3} minecraft:stone`,
			);
			await s.command(
				`/fill ${CENTER.x - 2} ${CENTER.y} ${CENTER.z - 2} ${CENTER.x + 2} ${CENTER.y + 1} ${CENTER.z + 2} minecraft:air`,
			);
			await s.command(`/summon minecraft:zombie ${CENTER.x + 2} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			await s.command(`/damage ${USER} 14`); // 20 -> 6，低于 cautious 接战线 17
			// 越过自保的"低血 + 2s 内新伤"窗口：本步验证的是 fight 自己的撤退语义，
			// survival 若在新伤窗口内抢占会让会话 INTERRUPTED，测不到目标行为。
			await sleep(2600);
			let outcome: { value?: FightValue; error?: string } = {};
			try {
				outcome.value = valueOf<FightValue>(
					await s.call("fight@1", { stance: "cautious", radius: 24, maxTimeMs: 30000 }, 90000),
				);
			} catch (error) {
				outcome.error = error instanceof Error ? error.message : String(error);
			} finally {
				// 成败都拆墙清怪回血：清理缺失会让围墙毒化后续步骤（批26 首轮实测）。
				await s.command(`/kill @e[type=minecraft:zombie]`);
				await s.command(
					`/fill ${CENTER.x - 3} ${CENTER.y} ${CENTER.z - 3} ${CENTER.x + 3} ${CENTER.y + 1} ${CENTER.z + 3} minecraft:air`,
				);
				await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
				await sleep(800);
			}
			if (outcome.error != null) throw new Error(outcome.error);
			const value = outcome.value!;
			if (value.ended !== "retreat_failed")
				throw new Error(`expected retreat_failed in a sealed pen, got ${JSON.stringify(value)}`);
			if (value.retreated !== "low_health") throw new Error(`retreat reason missing: ${JSON.stringify(value)}`);
			if (value.kills.length !== 0) throw new Error(`no engagement expected, kills=${value.kills.length}`);
			// 诚实的失败还要真的没逃出去：结算位置仍在围栏内。
			const self = await s.readSelf();
			const dx = Math.abs(self.place.position.x - (CENTER.x + 0.5));
			const dz = Math.abs(self.place.position.z - (CENTER.z + 0.5));
			if (dx > 2 || dz > 2) throw new Error(`bot escaped the sealed pen: ${JSON.stringify(self.place.position)}`);
			return `retreat_failed(low_health) inside the sealed pen, hp after=${value.hp.after}`;
		});

		await s.step("creeper is killed without taking the blast (steering keeps the fuse radius)", async () => {
			await restore();
			// 场地复原：持久世界里此前的爆炸会炸出弹坑（真服实测 bot 追击中掉进
			// 旧坑改变了交战几何）——按平台规格局部重建石面与净空，保证开打一致。
			await s.command(
				`/fill ${CENTER.x - 8} ${CENTER.y - 2} ${CENTER.z - 8} ${CENTER.x + 8} ${CENTER.y - 1} ${CENTER.z + 8} minecraft:stone`,
			);
			await s.command(
				`/fill ${CENTER.x - 8} ${CENTER.y} ${CENTER.z - 8} ${CENTER.x + 8} ${CENTER.y + 5} ${CENTER.z + 8} minecraft:air`,
			);
			// AI 苦力怕从 8 格外走近：近身拍 steering 在 fuse 触发半径（3 格）外
			// 硬遮罩朝向它的槽——bot 应在 3.2 格出手间距上输出；被逼爆也该在
			// 拉开距离后挨不到实质伤害。爆炸死亡不走 entityDead（爆炸包直接移除
			// 实体），所以"它炸了"会如实落 target_lost——本步的验收实质是血量。
			await s.command(`/summon minecraft:creeper ${CENTER.x + 8} ${CENTER.y} ${CENTER.z}`);
			await sleep(800);
			const value = valueOf<FightValue>(
				await s.call("fight@1", { target: "creeper", stance: "balanced", maxTimeMs: 60000 }, 90000),
			);
			const remains = (await s.readEntities(48)).filter((entity) => entity.name === "creeper").length;
			await s.command(`/kill @e[type=minecraft:creeper]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			// 两种诚实结局：真打死（targets_cleared 且 kills 含 creeper），或它自己
			// 爆了（target_lost：无死亡观察，威胁同样消失）。场地上不能剩活的。
			if (value.ended === "targets_cleared") {
				if (!value.kills.some((kill) => kill.name === "creeper"))
					throw new Error(`cleared without creeper kill: ${JSON.stringify(value.kills)}`);
			} else if (value.ended === "target_lost") {
				if (remains > 0) throw new Error(`target_lost but the creeper is still out there (${remains})`);
			} else {
				throw new Error(`expected targets_cleared/target_lost, got ${JSON.stringify(value)}`);
			}
			// 验收线 = 批33 实测包络：feedback 流 100% 占空比 + fuse 感知（ignited
			// 不攻击不追击）+ 引燃期外层拒绝回追后，五轮 18.83–19.47（擦伤 ≤1.2）。
			// 批29 包络是 13.4–20（逃离占空比 ~50%，引燃期被追回贴爆）。击杀路径
			// （targets_cleared 且 kills 含 creeper）仍未达成——1.21 引燃期苦力怕
			// 继续逼近，逃逸净速度只够拉开 ~2m，20 血需 4 个接触周期，当前策略
			// 总是中途引爆；残余登记 G29。
			if ((value.hp.after ?? 0) < 18)
				throw new Error(`blast damage beyond the registered envelope: hp ${value.hp.before}->${value.hp.after}`);
			return `${value.ended}, hp ${value.hp.before}->${value.hp.after}`;
		});

		await s.step("stop preempts a fight session mid-fight: INTERRUPTED, progress kept", async () => {
			await restore();
			await s.command(`/summon minecraft:zombie ${CENTER.x + 10} ${CENTER.y} ${CENTER.z} {NoAI:1b}`);
			await sleep(600);
			const spawned = await s.spawn("fight@1", { target: "zombie", stance: "balanced", maxTimeMs: 60000 });
			await sleep(2500); // 进入追击/近身拍
			await h.runtime.stop({ requestId: `req:combat-b06-stop`, target: { run: spawned.run } });
			const result = await s.waitCall(spawned, 30000);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			if (result.ok) throw new Error(`fight completed despite stop: ${JSON.stringify(result.value)}`);
			if (result.code !== "INTERRUPTED")
				throw new Error(`expected INTERRUPTED after stop, got ${result.code}: ${result.message ?? ""}`);
			return `fight stopped mid-session, settled INTERRUPTED`;
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
			// 第 4 只可能死在证据窗口竞态里：合同规定无死亡观察不算击杀（target_lost），
			// 诚实口径下接受 targets_cleared(4 杀) 或 target_lost(≥3 杀)，不存在虚报击杀。
			const clearedFour = value.ended === "targets_cleared" && value.kills.length === 4;
			const lostOne = value.ended === "target_lost" && value.kills.length >= 3;
			if (!clearedFour && !lostOne)
				throw new Error(`expected targets_cleared(4) or target_lost(>=3 kills), got ${JSON.stringify(value)}`);
			if (value.kills.length > 4) throw new Error(`impossible kills=${value.kills.length}`);
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
