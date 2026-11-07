/**
 * B04 苦力怕对拍探针（批29，方法学：一次抓全，先观测后归因）。
 *
 * 外部 100ms 采样（不动被测代码）：bot 位置/血量/控制键位/手持使用态 +
 * 苦力怕实体的完整 metadata 数组变化（swell/ignited 信号按相关性识别，
 * 不猜 schema）+ 服务端 Pos 对拍。一轮跑完输出完整时间线，
 * 回答：引燃发生在什么间距、逃离延迟有多大、爆炸时 bot 在几格外。
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

interface Sample {
	t: number;
	x: number;
	z: number;
	hp: number | null;
	fwd: boolean;
	back: boolean;
	sprint: boolean;
	shieldUsing: boolean;
	creeperGap: number | null;
	meta: string;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-creeper-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:creeper-probe-${Date.now()}` };
	const h = await openHarness("creeper-probe", { dataRoot, binding });
	const s = makeScenario(h, "creeper-probe");
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
			await s.command(`/difficulty easy`);
			await s.command(`/gamerule spawn_mobs false`);
			for (const mob of ["zombie", "skeleton", "creeper", "spider", "cave_spider", "drowned", "husk", "stray"]) {
				await s.command(`/kill @e[type=minecraft:${mob}]`);
			}
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command(`/effect clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_sword 1`);
			await s.command(`/give ${USER} minecraft:shield 1`);
			await s.command(`/give ${USER} minecraft:iron_helmet 1`);
			await s.command(`/give ${USER} minecraft:iron_chestplate 1`);
			await s.command(`/give ${USER} minecraft:iron_leggings 1`);
			await s.command(`/give ${USER} minecraft:iron_boots 1`);
			await s.command(`/gamemode survival ${USER}`);
			for (const [piece, slot] of [
				["iron_helmet", "head"],
				["iron_chestplate", "chest"],
				["iron_leggings", "legs"],
				["iron_boots", "feet"],
			] as const) {
				const equipped = await s.call("equip@1", { item: piece, slot });
				if (!equipped.ok) throw new Error(`equip ${piece} failed: ${equipped.code}`);
			}
			// 满血进入被测会话（上一场残留伤害会污染血量时间线）。
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await sleep(600);
			await waitForStill(h.bot, h.log);
			return "platform ready, iron gear equipped";
		});

		let samples: Sample[] = [];
		await s.step("fight one AI creeper with a full external timeline", async () => {
			// 场地复原：持久世界里旧爆炸的弹坑会改变交战几何（真服实测）。
			await s.command(
				`/fill ${CENTER.x - 8} ${CENTER.y - 2} ${CENTER.z - 8} ${CENTER.x + 8} ${CENTER.y - 1} ${CENTER.z + 8} minecraft:stone`,
			);
			await s.command(
				`/fill ${CENTER.x - 8} ${CENTER.y} ${CENTER.z - 8} ${CENTER.x + 8} ${CENTER.y + 5} ${CENTER.z + 8} minecraft:air`,
			);
			await s.command(`/summon minecraft:creeper ${CENTER.x + 10} ${CENTER.y} ${CENTER.z}`);
			await sleep(600);

			const bot = h.bot as unknown as {
				entity: { position: { x: number; y: number; z: number } };
				health: number | null;
				controlState?: Record<string, boolean>;
				usingHeldItem?: boolean;
				entities: Record<
					number,
					{ name?: string; position: { x: number; y: number; z: number }; metadata: unknown[] | null }
				>;
			};
			let sampling = true;
			let lastMeta = "";
			const t0 = Date.now();
			const sampler = (async () => {
				while (sampling) {
					await sleep(100);
					if (!sampling) break;
					try {
						let creeper: { gap: number | null } = { gap: null };
						for (const entity of Object.values(bot.entities)) {
							if (entity?.name !== "creeper") continue;
							const meta = entity.metadata ?? [];
							const sig = JSON.stringify(meta);
							if (sig !== lastMeta) {
								s.log(`metaΔ t=${Date.now() - t0}ms: ${sig.slice(0, 500)}`);
								lastMeta = sig;
							}
							creeper = {
								gap: Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z),
							};
						}
						samples.push({
							t: Date.now() - t0,
							x: bot.entity.position.x,
							z: bot.entity.position.z,
							hp: bot.health,
							fwd: bot.controlState?.forward === true,
							back: bot.controlState?.back === true,
							sprint: bot.controlState?.sprint === true,
							shieldUsing: bot.usingHeldItem === true,
							creeperGap: creeper.gap,
							meta: "",
						});
					} catch (err) {
						s.log(`sample error: ${err instanceof Error ? err.message : String(err)}`);
						break;
					}
				}
			})();
			const started = Date.now();
			const value = valueOf<{
				ended: string;
				kills: { name: string }[];
				hp: { before: number | null; after: number | null };
			}>(await s.call("fight@1", { target: "creeper", stance: "balanced", maxTimeMs: 60000 }, 90000));
			sampling = false;
			await sampler;
			await s.command(`/kill @e[type=minecraft:creeper]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			const elapsed = Date.now() - started;

			// 输出关键时间线：血量变化点 + 间距极值段（0.3 格粒度压缩）。
			s.log(`fight done in ${elapsed}ms: ${JSON.stringify(value)}`);
			let lastGap: number | "none" = Number.NaN;
			let lastHp: number | null = null;
			const lines: string[] = [];
			for (const smp of samples) {
				const gap = smp.creeperGap;
				const hpChanged = smp.hp !== lastHp;
				const gapBand = gap == null ? "none" : Math.round(gap * 3) / 3;
				if (hpChanged || gapBand !== lastGap) {
					const keys = [smp.fwd ? "F" : "", smp.back ? "B" : "", smp.sprint ? "S" : "", smp.shieldUsing ? "🛡" : ""]
						.filter(Boolean)
						.join("");
					lines.push(
						`t=${String(smp.t).padStart(5)} gap=${gap == null ? "-" : gap.toFixed(2)} hp=${smp.hp} keys=${keys || "-"}`,
					);
					lastGap = gapBand;
					lastHp = smp.hp;
				}
			}
			for (const line of lines) s.log(line);
			return `${value.ended}, hp ${value.hp.before}->${value.hp.after}, ${samples.length} samples`;
		});
	} finally {
		s.finish();
		await closeHarness(h);
		await sleep(200);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
