/**
 * 批32 真服验收：explore@1 前沿覆盖探索（refactor-v2 M6）。
 *
 * 背景：旧实现是四向 24 格腿游标——一个方向一次 UNREACHABLE 整向判死，四条腿
 * 走完即宣称穷尽；曲折通道（90° 转弯）必然在起点附近全向判死，真实空间没被
 * 覆盖就报 NOT_FOUND。01-DESIGN §6 判其不可信，批32 换成前沿覆盖：每站 region
 * 观察盒更新稀疏覆盖图，走向信息增益最大的 route.plan 可达前沿。
 *
 * 场景（199 高受控平台 + 地下密封室）：
 * 1. 之字走廊寻矿：起点石室 → 北向走廊 → 东向走廊（90° 转弯）→ …；diamond_ore
 *    距起点直线 33.1 > 32（首扫不可见），机器人在走廊 B 中段进入 32 扫描半径
 *    （traveled ≈ 24，已跨一个弯）；断言 found、traveled 真实位移、服务端位置
 *    贴近矿石。旧游标在该地形首轮 n/e/s/w 全被墙判死，到不了矿。
 * 2. 地下密封室诚实穷尽：实心岩层中的 6×6 密封室——观察盒内除室内空气全是
 *    岩石，无任何前沿；断言 UNREACHABLE、traveled 0、秒级返回（不烧墙钟）。
 *
 * 场景基建教训（本轮实证）：/fill 对未加载区块静默失败且 Paper /fill 上限
 * 32768 格——必须先把玩家 tp 进现场（区块柱随玩家加载）再 build、大体量 fill
 * 拆半，并用客户端 readBlock 核验关键几何。
 *
 * 被测行为全部走正式能力面；op 指令只备地形/防刷怪，不代替被测动作。
 * 断言用服务端真值（/data get Pos）交叉核验（批12 经验 6）。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, dist, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
/** 平台西南角（远离 8500–9900 平台群、16000 围栏与 terrain-nav 车道）。 */
const BX = -640;
const BZ = -360;
const GY = 199;

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

type Vec = { x: number; y: number; z: number };

/** 本地格 → 绝对坐标。 */
const at = (i: number, y: number, j: number): Vec => ({ x: BX + i, y, z: BZ + j });

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-explore-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:explore-frontier-${Date.now()}` };
	const h = await openHarness("explore-frontier", { dataRoot, binding });
	const s = makeScenario(h, "explore-frontier");

	const serverPos = async (): Promise<Vec> => {
		const pos = await s.serverPos(USER);
		if (pos == null) throw new Error("server Pos unavailable");
		return pos;
	};
	/** 创造模式 tp 后再切生存（高空落位不吃摔落伤害），等待静止。 */
	const reset = async (i: number, j: number, y = GY + 1): Promise<void> => {
		const p = at(i, y, j);
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/tp ${USER} ${p.x} ${p.y} ${p.z}`);
		await waitForStill(h.bot, h.log);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);
		await sleep(2500); // 等客户端区块稳定，首站 region 读不再大面积 -1
	};
	const fill = (i0: number, j0: number, i1: number, j1: number, y0: number, y1: number, block: string): Promise<void> =>
		s.command(`/fill ${BX + i0} ${y0} ${BZ + j0} ${BX + i1} ${y1} ${BZ + j1} ${block}`);
	/** 3 高墙一列。 */
	const wall = (i0: number, j0: number, i1: number, j1: number): Promise<void> =>
		fill(i0, j0, i1, j1, GY + 1, GY + 3, "minecraft:stone");

	const ore = at(44, GY + 1, 50);
	try {
		await s.step("prepare: 防刷怪 + 清包 + 先落位平台中心（加载区块）", async () => {
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/kill @e[type=minecraft:armor_stand]`);
			await s.command(`/clear ${USER}`);
			// 批27 教训：/fill 对未加载区块静默失败。先 tp 到平台中心（区块柱随玩家加载），
			// 再 build——72×72 平台全部坐标距中心 ≤51 格，处于服务端视距内。
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${BX + 36} 130 ${BZ + 36}`);
			await waitForStill(h.bot, h.log);
			return "relocated to platform center";
		});

		await s.step("build: 之字迷宫 + 地下密封室 + 矿石", async () => {
			await fill(0, 0, 71, 71, GY, GY, "minecraft:stone");
			// Paper /fill 上限 32768 格：72×72×8=41472 必须拆半。
			await fill(0, 0, 71, 35, GY + 1, GY + 8, "minecraft:air");
			await fill(0, 36, 71, 71, GY + 1, GY + 8, "minecraft:air");
			// 起点石室 i∈[8,15] j∈[50,57]，北墙开口 i 11..12。
			await wall(7, 58, 16, 58);
			await wall(7, 49, 10, 49);
			await wall(13, 49, 16, 49);
			await wall(7, 49, 7, 58);
			await wall(16, 49, 16, 58);
			// 走廊 A（北向）i∈[11,12] j∈[26,49]。
			await wall(10, 26, 10, 49);
			await wall(13, 28, 13, 49);
			// 走廊 B（东向）j∈[26,27] i∈[13,36]；北墙连带封住走廊 A 顶。
			await wall(10, 25, 38, 25);
			await wall(13, 28, 35, 28);
			// 走廊 C（南向）i∈[36,37] j∈[28,41]。
			await wall(35, 28, 35, 41);
			await wall(38, 28, 38, 41);
			// 远端矿室 i∈[32,47] j∈[42,53]，北墙开口 i 36..37。
			await wall(32, 41, 35, 41);
			await wall(38, 41, 47, 41);
			await wall(31, 41, 31, 54);
			await wall(48, 41, 48, 54);
			await wall(31, 54, 48, 54);
			// 地下密封室（对照步）：实心岩层 72×72×8（拆半 fill）中空 6×6×3，
			// i∈[58,63] j∈[10,15]，脚 y188、头 y189、地 y187、顶 y191。
			await fill(0, 0, 71, 35, 185, 192, "minecraft:stone");
			await fill(0, 36, 71, 71, 185, 192, "minecraft:stone");
			await fill(58, 10, 63, 15, 188, 190, "minecraft:air");
			// 矿石在矿室东南地面：距起点直线 hypot(33,3)=33.1 > 32。
			await s.command(`/setblock ${BX + 44} ${GY + 1} ${BZ + 50} minecraft:diamond_ore`);
			// fill 静默失败（未加载区块/超上限）只能靠事后核验——客户端视角抽查关键几何。
			const floor = await s.readBlock(at(36, GY, 36));
			if (floor?.name !== "stone") throw new Error(`platform floor not built: ${floor?.name}`);
			const westWall = await s.readBlock(at(10, GY + 1, 40));
			const corridor = await s.readBlock(at(12, GY + 1, 40));
			const sealedWall = await s.readBlock(at(57, 188, 12));
			const sealedFloorBlock = await s.readBlock(at(60, 187, 12));
			const oreBlock = await s.readBlock(ore);
			if (westWall?.name !== "stone" || corridor?.name !== "air") {
				throw new Error(`maze geometry wrong: wall=${westWall?.name} corridor=${corridor?.name}`);
			}
			if (sealedWall?.name !== "stone" || sealedFloorBlock?.name !== "stone") {
				throw new Error(`sealed room geometry wrong: wall=${sealedWall?.name} floor=${sealedFloorBlock?.name}`);
			}
			if (oreBlock?.name !== "diamond_ore") throw new Error(`ore not placed: ${oreBlock?.name}`);
			return "maze + sealed room + ore ready (client-verified)";
		});

		await s.step("frontier explore crosses the zigzag and finds the ore", async () => {
			await reset(11, 53);
			const started = Date.now();
			const result = await s.call("explore@1", { until: { block: "diamond_ore" }, maxTimeMs: 240000 }, 300000);
			const elapsed = Date.now() - started;
			if (!result.ok) throw new Error(`explore failed: ${result.code}: ${result.message ?? ""}`);
			const value = valueOf<{
				found: { kind: string; name: string; at: { position: Vec } };
				traveled: number;
				scanned: number;
			}>(result);
			if (value.found.kind !== "block" || value.found.name !== "diamond_ore") {
				throw new Error(`unexpected find: ${JSON.stringify(value.found)}`);
			}
			// 进入走廊 B（跨过北向走廊 + 90° 弯）才可能进入 32 扫描半径：真实位移 ≥20。
			if (value.traveled < 20) throw new Error(`traveled ${value.traveled} — did not really cross the zigzag`);
			if (value.scanned < 3) throw new Error(`scanned ${value.scanned} — expected multi-stop coverage`);
			const pos = await serverPos();
			const gap = dist(pos, ore);
			if (gap > 34) throw new Error(`server pos ${JSON.stringify(pos)} is ${gap.toFixed(1)} from the ore`);
			return `found diamond_ore, traveled ${value.traveled}, scanned ${value.scanned}, ${elapsed}ms, server gap ${gap.toFixed(1)}`;
		});

		await s.step("sealed room: honest UNREACHABLE without navigation or wall-clock burn", async () => {
			await reset(60, 12, 188);
			const before = await serverPos();
			const started = Date.now();
			const result = await s.call("explore@1", { until: { block: "diamond_ore" }, maxTimeMs: 20000 }, 30000);
			const elapsed = Date.now() - started;
			if (result.ok) throw new Error("sealed room reported a find — coverage honesty broken");
			if (result.code !== "UNREACHABLE") {
				throw new Error(`expected UNREACHABLE, got ${result.code}: ${result.message ?? ""}`);
			}
			// 场景不读调用 progress（world 未变证明）：服务端位置不动才是"没有派发导航"。
			const after = await serverPos();
			if (dist(before, after) > 1) {
				throw new Error(`sealed room moved the bot: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
			}
			if (elapsed > 10000) throw new Error(`exhaustion burned ${elapsed}ms — no frontier should settle instantly`);
			return `UNREACHABLE in ${elapsed}ms, server pos unmoved (no frontier inside sealed coverage)`;
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
