/**
 * 批 19/21 真服验收：导航爬阶（G21）、卡死快速失败与上行走廊净空（G24）。
 *
 * 被测行为全部走正式能力面（Runtime submit → callable）；op 指令只摆地形/给工具，
 * 不代替任何被测动作。断言用服务端真值（/data get Pos）与复读交叉核验。
 *
 * 批 19 改的是依赖执行器（patches/mineflayer-pathfinder）：上游把"延迟起跳才能过"
 * 的节点当成"直线可走"，执行器因此永不按跳跃键，1 格台阶走不上去、卡满 40s 墙钟。
 * 场景里的几何全部是批13/14 记录过的失败形态（1 格石台、1:1 上行阶梯），
 * 所以"爬上去了"本身就是修复证据；不需要另设旧行为开关。
 * 批 21 增加上行隧道步骤：1x2 上行 1:1 走廊由规划器自动加高（升坡列 ceiling 一并
 * 挖除，G24），挖通并走到终点；升坡列顶开天窗、平地段顶保持实心是世界级证据。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9850, y: 200, z: 9850 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-climb-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:climb-${Date.now()}` };
	const h = await openHarness("climb", { dataRoot, binding });
	const s = makeScenario(h, "climb");

	/** 服务端真值：客户端在台阶上会预测抬升，落地前不能只看 self。 */
	const serverPos = async (): Promise<{ x: number; y: number; z: number }> => {
		const pos = await s.serverPos(USER);
		if (pos == null) throw new Error("server Pos unavailable");
		return pos;
	};

	const reset = async (at: { x: number; y: number; z: number }): Promise<void> => {
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/tp ${USER} ${at.x} ${at.y} ${at.z}`);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);
	};

	try {
		await s.step("prepare a flat stone platform at y=199", async () => {
			// 显式指定维度：批19 的 transit 场景可能把身体留在下界，`/tp` 只换坐标不换维度。
			await s.command(`/execute in minecraft:overworld run tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await waitForStill(h.bot, h.log);
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(
				`/fill ${CENTER.x - 40} 199 ${CENTER.z - 40} ${CENTER.x + 40} 199 ${CENTER.z + 40} minecraft:stone`,
			);
			for (let y = 200; y <= 212; y += 4) {
				await s.command(
					`/fill ${CENTER.x - 40} ${y} ${CENTER.z - 40} ${CENTER.x + 40} ${y + 3} ${CENTER.z + 40} minecraft:air`,
				);
			}
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:diamond_pickaxe 1`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 25 true`);
			await s.command(`/effect give ${USER} minecraft:saturation 1 10 true`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const below = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
			if (below?.name !== "stone") throw new Error(`platform fill did not land: ${below?.name ?? "null"}`);
			return "81x81 stone at y=199, air 200..212, diamond_pickaxe";
		});

		await s.step("goto climbs a one-block step", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${CENTER.x - 10} 200 ${CENTER.z - 4} ${CENTER.x - 4} 200 ${CENTER.z + 4} minecraft:stone`);
			await reset({ x: CENTER.x + 0.5, y: 200, z: CENTER.z + 0.5 });
			const target = { x: CENTER.x - 7, y: 201, z: CENTER.z };
			const started = Date.now();
			const value = valueOf<{ at: { y: number }; ticks: number }>(
				await s.call("goto@1", { at: target, tolerance: 1, maxTimeMs: 30000 }, 40000),
			);
			const elapsed = Date.now() - started;
			const pos = await serverPos();
			if (Math.abs(pos.y - 201) > 0.6) throw new Error(`did not climb: server y=${pos.y.toFixed(2)}`);
			if (elapsed > 20000) throw new Error(`climb took ${elapsed}ms (batch13/14 failed at the 40s wall clock)`);
			return `server y=${pos.y.toFixed(2)} in ${elapsed}ms (${value.ticks} ticks, reported y=${value.at.y.toFixed(2)})`;
		});

		await s.step("goto walks up a three-level 1:1 staircase", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${CENTER.x + 2} 200 ${CENTER.z - 4} ${CENTER.x + 3} 200 ${CENTER.z + 4} minecraft:stone`);
			await s.command(`/fill ${CENTER.x + 4} 201 ${CENTER.z - 4} ${CENTER.x + 5} 201 ${CENTER.z + 4} minecraft:stone`);
			await s.command(`/fill ${CENTER.x + 6} 202 ${CENTER.z - 4} ${CENTER.x + 7} 202 ${CENTER.z + 4} minecraft:stone`);
			await reset({ x: CENTER.x + 0.5, y: 200, z: CENTER.z + 0.5 });
			const started = Date.now();
			await s.call("goto@1", { at: { x: CENTER.x + 7, y: 203, z: CENTER.z }, tolerance: 1, maxTimeMs: 30000 }, 40000);
			const elapsed = Date.now() - started;
			const pos = await serverPos();
			if (Math.abs(pos.y - 203) > 0.6) throw new Error(`staircase not climbed: server y=${pos.y.toFixed(2)}`);
			if (elapsed > 25000) throw new Error(`staircase took ${elapsed}ms`);
			return `server (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) in ${elapsed}ms`;
		});

		await s.step("tunnel climbs an ascending 1:1 corridor (G24 auto-widened headroom)", async () => {
			const x0 = CENTER.x - 30;
			const z0 = CENTER.z;
			await s.command(`/gamemode creative ${USER}`);
			// 清出施工区再浇整块石体：走廊必须挖在实体里，1x2 上行才测得到净空问题。
			await s.command(`/fill ${x0 - 2} 200 ${z0 - 2} ${x0 + 7} 206 ${z0 + 2} minecraft:air`);
			await s.command(`/fill ${x0 + 1} 200 ${z0 - 1} ${x0 + 6} 205 ${z0 + 1} minecraft:stone`);
			await reset({ x: x0 + 0.5, y: 200, z: z0 + 0.5 });
			const started = Date.now();
			const value = valueOf<{
				dug: number;
				stopped?: string;
				path: { at: { x: number; y: number; z: number }; name: string }[];
			}>(await s.call("tunnel@1", { to: { x: x0 + 4, y: 202, z: z0 }, maxTimeMs: 150000 }, 240000));
			const elapsed = Date.now() - started;
			if (value.stopped != null) throw new Error(`tunnel stopped early: ${value.stopped}`);
			if (value.dug < 8) throw new Error(`ascending corridor dug only ${value.dug} cells`);
			const pos = await serverPos();
			if (Math.abs(pos.x - (x0 + 4)) > 1.5 || Math.abs(pos.y - 202) > 1.5 || Math.abs(pos.z - z0) > 1.5) {
				throw new Error(`bot did not reach the corridor end: ${JSON.stringify(pos)}`);
			}
			// G24 证据：升坡列自身的 ceiling 被自动挖开（踏步上方 3 高净空），平地段顶保持实心。
			for (const at of [
				{ x: x0 + 1, y: 203, z: z0 },
				{ x: x0 + 2, y: 204, z: z0 },
			]) {
				const cell = await s.readBlock(at);
				if (cell?.name !== "air") {
					throw new Error(`ascender ceiling at ${at.x},${at.y},${at.z} is ${cell?.name ?? "null"}`);
				}
			}
			const flatTop = await s.readBlock({ x: x0 + 4, y: 204, z: z0 });
			if (flatTop?.name !== "stone") throw new Error(`flat ceiling was dug: ${flatTop?.name ?? "null"}`);
			return `${value.dug} dug in ${elapsed}ms, server (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
		});

		await s.step("a sealed shaft fails fast instead of burning the wall clock", async () => {
			const x0 = CENTER.x + 20;
			const z0 = CENTER.z;
			await s.command(`/gamemode creative ${USER}`);
			// 本步的前提是"密封且没有可用材料"：goto 的 placeToReach 默认 true（垫柱合法），
			// 上一步隧道挖落的圆石留在背包里就能垫柱翻墙（批21 实测）。清包是步骤复位的一部分。
			await s.command(`/clear ${USER}`);
			// 先把区块拉起来，且人站在井外：站在井位里被 /fill 埋进石头后会被服务端挤出去，
			// 井就不"密封"了（批19 实测：这样能稳定复现"进得去、出不来"）。
			await s.command(`/tp ${USER} ${x0 + 4.5} 200.1 ${z0 + 1.5}`);
			await waitForStill(h.bot, h.log);
			// 先清出干净的施工面：残留几何（前几步的台阶）会让井壁出现缺口，机器人直接走出去。
			await s.command(`/fill ${x0 - 2} 199 ${z0 - 2} ${x0 + 4} 203 ${z0 + 4} minecraft:air`);
			await s.command(`/fill ${x0 - 2} 199 ${z0 - 2} ${x0 + 4} 199 ${z0 + 4} minecraft:stone`);
			await s.command(`/fill ${x0} 200 ${z0} ${x0 + 2} 201 ${z0 + 2} minecraft:stone`);
			await s.command(`/fill ${x0 + 1} 200 ${z0 + 1} ${x0 + 1} 201 ${z0 + 1} minecraft:air`);
			const pocket = await s.readBlock({ x: x0 + 1, y: 200, z: z0 + 1 });
			if (pocket?.name !== "air") throw new Error(`shaft pocket was not carved: ${pocket?.name ?? "null"}`);
			const wall = await s.readBlock({ x: x0 + 1, y: 200, z: z0 + 2 });
			if (wall?.name !== "stone") throw new Error(`shaft wall is open: ${wall?.name ?? "null"}`);
			await reset({ x: x0 + 1.5, y: 200.1, z: z0 + 1.5 });
			const started = Date.now();
			const result = await s.call(
				"goto@1",
				{ at: { x: x0 + 1, y: 200, z: z0 + 12 }, tolerance: 1, maxTimeMs: 120000 },
				130000,
			);
			const elapsed = Date.now() - started;
			if (result.ok) throw new Error(`sealed shaft must not be reachable: ${JSON.stringify(result.value)}`);
			if (result.code !== "UNREACHABLE") throw new Error(`expected UNREACHABLE, got ${result.code}`);
			if (elapsed > 12000) throw new Error(`failure took ${elapsed}ms; the watchdog should settle it in seconds`);
			return `${result.code} in ${elapsed}ms (${result.message ?? ""})`;
		});

		await s.step("flat long-distance goto keeps its pace", async () => {
			// 前几步留在地面上的台阶/楼梯会改变起点高度，先清回平台。
			await s.command(`/gamemode creative ${USER}`);
			await s.command(
				`/fill ${CENTER.x - 40} 200 ${CENTER.z - 40} ${CENTER.x + 40} 202 ${CENTER.z + 40} minecraft:air`,
			);
			await reset({ x: CENTER.x + 0.5, y: 200, z: CENTER.z + 0.5 });
			const started = Date.now();
			await s.call("goto@1", { at: { x: CENTER.x + 30, y: 200, z: CENTER.z }, tolerance: 1, maxTimeMs: 30000 }, 40000);
			const elapsed = Date.now() - started;
			const pos = await serverPos();
			if (Math.abs(pos.x - (CENTER.x + 30)) > 2 || Math.abs(pos.y - 200) > 0.6) {
				throw new Error(`flat walk drifted: ${JSON.stringify(pos)}`);
			}
			if (elapsed > 20000) throw new Error(`flat 30-block walk took ${elapsed}ms`);
			return `30 blocks in ${elapsed}ms, server (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`;
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
