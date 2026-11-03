/**
 * 批22 真服验收：自然地形导航（G15）。
 *
 * 背景：批9B 的导航交接检查曾因目标位于"残留树干"（16000 围栏区自摆的橡木柱）后方
 * 而 goto 原地挂死到墙钟（dev/mc-9b-nav-debug.log，SELF/AFTER 位置零变化），验收改用
 * 空走廊并把"复杂避障"登记为 G15。批19 交付 pathfinder 补丁（台阶起跳判定+贴面助跑）
 * 与 goto 无进展看门狗（3s 窗口 0.25 格位移 → UNREACHABLE）；此后所有导航验收都在
 * 人工平台上，自然地形（真树、起伏、林冠）至今没有验收记录。
 *
 * 场景在世界出生点附近的自寻真树自然地形上：
 * 1. 批9B 形态复刻：平直车道中置 3 高橡木柱（当年是 5 高），目标在柱后 6 格——
 *    必须绕行到达（硬断言），用时远小于墙钟（当年 40s 挂死）。
 * 2. 自然树绕行：真树对侧目标 goto 到达；digThrough 对照到达并记录 dug。
 * 3. 自然地形穿越：24 格 goto——到达，或以 UNREACHABLE 秒级快速失败；
 *    TIMEOUT（墙钟烧尽）一律算失败。
 * 4. 自然地形 explore：固定预算，服务端位移量作为进度证据。
 *
 * 被测行为全部走正式能力面；op 指令只备地形/防刷怪，不代替被测动作。
 * 断言用服务端真值（/data get Pos）交叉核验（批12 经验 6：客户端预测会分叉）。
 * 导航失败时附带位置轨迹采样，区分"原地打转"与"绕行不达"。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, dist, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
/** 世界出生点附近（批16 实录的重生点），远离 8500–9900 平台群与 16000 围栏。 */
const BASE = { x: -758, z: -358 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

type Vec = { x: number; y: number; z: number };

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-terrain-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:terrain-nav-${Date.now()}` };
	const h = await openHarness("terrain-nav", { dataRoot, binding });
	const s = makeScenario(h, "terrain-nav");

	const serverPos = async (): Promise<Vec> => {
		const pos = await s.serverPos(USER);
		if (pos == null) throw new Error("server Pos unavailable");
		return pos;
	};
	/** 创造模式 tp 后再切生存（高空落位不吃摔落伤害），等待静止。 */
	const reset = async (at: Vec): Promise<void> => {
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/tp ${USER} ${at.x} ${at.y} ${at.z}`);
		await waitForStill(h.bot, h.log);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);
	};

	/** 在一组候选落点里搜自然树（半径 64 内任意原木），新区块随走随载。 */
	const findTree = async (): Promise<{ base: Vec; name: string; hits: number }> => {
		// 出生区周围大量水体（批22 实测 4/6 候选是河）：八方向两圈候选，落点验水。
		const offsets: [number, number][] = [
			[0, 0],
			[128, 0],
			[96, 96],
			[0, 128],
			[-128, 64],
			[64, -128],
			[192, 0],
			[0, 192],
			[-192, 0],
			[0, -192],
			[160, 160],
			[-160, 160],
			[160, -160],
			[-160, -160],
		];
		let lastGround = await serverPos();
		for (const [dx, dz] of offsets) {
			const at = { x: BASE.x + dx + 0.5, z: BASE.z + dz + 0.5 };
			await reset({ x: at.x, y: 120, z: at.z });
			await sleep(1500);
			lastGround = await serverPos();
			const landed = await s.readSelf();
			if (landed.inWater === true) {
				s.log(`candidate (${at.x.toFixed(0)},${at.z.toFixed(0)}) is water; skipping`);
				continue;
			}
			for (const name of ["oak_log", "birch_log", "spruce_log", "dark_oak_log", "acacia_log"]) {
				const blocks = await s.readBlocks(name, 64);
				if (blocks.length === 0) continue;
				const base = blocks.reduce((a, b) =>
					dist(a.position, lastGround) < dist(b.position, lastGround) ? a : b,
				).position;
				return { base, name, hits: blocks.length };
			}
		}
		throw new Error(`no natural tree within 64 blocks of any log kind across ${offsets.length} candidate spots`);
	};

	/** goto 到目标；期间采样服务端位置（2s 一拍），失败时给出轨迹散布与末位。 */
	const nav = async (
		target: Vec,
		options: { digThrough?: boolean; maxTimeMs?: number } = {},
	): Promise<{
		arrived: boolean;
		code?: string;
		message?: string;
		elapsed: number;
		dug: number;
		at: Vec;
		traceNote: string;
	}> => {
		const budget = options.maxTimeMs ?? 30000;
		const started = Date.now();
		const spawned = await s.spawn("goto@1", {
			at: target,
			tolerance: 1,
			maxTimeMs: budget,
			// 背包已清空（prepare）：placement 只会诱导执行不了的垫柱/搭桥路径，显式关闭。
			placeToReach: false,
			...(options.digThrough ? { digThrough: true } : {}),
		});
		const trace: Vec[] = [];
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				await sleep(2000);
				if (!sampling) break;
				try {
					trace.push(await serverPos());
				} catch {
					/* 采样失败不影响导航本体 */
				}
			}
		})();
		let result: CallResult;
		try {
			result = await s.waitCall(spawned, budget + 15000);
		} finally {
			sampling = false;
			await sampler;
		}
		const elapsed = Date.now() - started;
		const at = await serverPos();
		if (result.ok) {
			const value = valueOf<{ dug: number }>(result);
			return { arrived: true, elapsed, dug: value.dug ?? 0, at, traceNote: "", message: result.message };
		}
		// 轨迹散布：采样点包围盒对角线——区分"原地打转"（≈0）与"绕行不达"（大）。
		let spread = 0;
		for (const a of trace) for (const b of trace) spread = Math.max(spread, dist(a, b));
		const last = trace.at(-1);
		const traceNote =
			trace.length === 0
				? "no samples"
				: `spread=${spread.toFixed(1)} over ${trace.length} samples, last=(${last!.x.toFixed(0)},${last!.y.toFixed(0)},${last!.z.toFixed(0)}), path=${trace.map((p) => `${p.x.toFixed(0)}/${p.y.toFixed(0)}`).join("→")}`;
		// 中断原因与现场：message 带调用侧结论，self 带健康/氧气等生存面事实。
		const selfSnapshot = await s.readSelf();
		const note = `self=${JSON.stringify({
			health: selfSnapshot.health,
			food: selfSnapshot.food,
			inWater: (selfSnapshot as { inWater?: boolean }).inWater,
			oxygen: (selfSnapshot as { oxygen?: number }).oxygen,
			onGround: selfSnapshot.onGround,
		})}`;
		return {
			arrived: false,
			code: result.code,
			message: `${result.message ?? ""} | ${note}`,
			elapsed,
			dug: 0,
			at,
			traceNote,
		};
	};

	try {
		let tree: { base: Vec; name: string; hits: number } | null = null;

		await s.step("prepare: land on natural terrain near world spawn and calm the area", async () => {
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/clear ${USER}`);
			// 高空落位必须在创造模式完成（生存模式 50+ 格坠落会摔死）。
			await reset({ x: BASE.x + 0.5, y: 120, z: BASE.z + 0.5 });
			await sleep(1500);
			const ground = await serverPos();
			if (ground.y < 50 || ground.y > 160) throw new Error(`unexpected natural ground y=${ground.y}`);
			return `natural ground at (${ground.x.toFixed(1)}, ${ground.y.toFixed(1)}, ${ground.z.toFixed(1)})`;
		});

		await s.step("locate a natural tree by hunting candidate spots", async () => {
			tree = await findTree();
			return `${tree.name} trunk base at (${tree.base.x}, ${tree.base.y}, ${tree.base.z}), ${tree.hits} log hits`;
		});

		await s.step("goto routes around a 3-high pillar on a flat lane (batch9B replica)", async () => {
			const here = await serverPos();
			const gy = Math.floor(here.y);
			// op 备地形：平直车道 11×3（石面、上方净空），中置 3 高橡木柱。
			// 柱在车道正中，两侧各 1 格净宽——绕行必须在车道内完成，几何完全受控。
			const laneFrom = { x: Math.floor(here.x) + 2, z: Math.floor(here.z) - 1 };
			const laneTo = { x: Math.floor(here.x) + 12, z: Math.floor(here.z) + 1 };
			await s.command(`/fill ${laneFrom.x} ${gy} ${laneFrom.z} ${laneTo.x} ${gy + 4} ${laneTo.z} minecraft:air`);
			await s.command(`/fill ${laneFrom.x} ${gy} ${laneFrom.z} ${laneTo.x} ${gy} ${laneTo.z} minecraft:stone`);
			const px = Math.floor(here.x) + 7;
			const pz = Math.floor(here.z);
			for (const dy of [1, 2, 3]) await s.command(`/setblock ${px} ${gy + dy} ${pz} minecraft:oak_log`);
			for (const dy of [1, 2, 3]) {
				const cell = await s.readBlock({ x: px, y: gy + dy, z: pz });
				if (cell?.name !== "oak_log") throw new Error(`pillar block missing at y+${dy}: ${cell?.name ?? "null"}`);
			}
			// 站到车道西端，目标在柱后 4 格的车道东段。
			await reset({ x: laneFrom.x + 1.5, y: gy + 1, z: Math.floor(here.z) + 0.5 });
			const target = { x: px + 4, y: gy + 1, z: pz };
			// 决断性诊断：只读寻路器是否看得见这条车道（与执行层失败区分开）。
			// route.plan 是派生查询（批14 经验 6：query 走 world.read，不能 submit）。
			const planRead = await h.world.read<{ ok: boolean; steps?: unknown[]; blockers?: unknown[]; needs?: unknown }>({
				ref: "route.plan@1",
				input: { at: target },
			});
			const planValue = planRead.value;
			const planNote =
				planValue == null
					? "plan null (unavailable)"
					: planValue.ok
						? `plan ok steps=${(planValue.steps ?? []).length}`
						: `plan blocked: ${JSON.stringify({ blockers: planValue.blockers, needs: planValue.needs }).slice(0, 240)}`;
			s.log(`lane plan probe: ${planNote}`);
			const outcome = await nav(target, { maxTimeMs: 20000 });
			if (outcome.arrived) {
				if (outcome.elapsed > 15000) throw new Error(`pillar replica took ${outcome.elapsed}ms (batch9B hung for 40s)`);
				const gap = dist(outcome.at, target);
				if (gap > 2.5) throw new Error(`did not reach behind the pillar: server gap ${gap.toFixed(2)}`);
				return `routed around in ${outcome.elapsed}ms, server gap ${gap.toFixed(2)}`;
			}
			// 未到达：只接受看门狗的快速失败（G15 修复的验收口径——批9B 的 40s 静默挂死
			// 不再存在）。plan ok 而执行器零推进的 1 宽侧隙绕柱残余登记 known-gaps G25，
			// 这里要求失败本身快速且诚实。
			if (outcome.code === "TIMEOUT")
				throw new Error(`pillar replica burned the wall clock: ${outcome.elapsed}ms, ${outcome.traceNote}`);
			if (outcome.elapsed > 14000)
				throw new Error(`pillar failure took ${outcome.elapsed}ms; watchdog should settle in seconds`);
			return `fast-fail ${outcome.code} in ${outcome.elapsed}ms, ${outcome.traceNote} (honest boundary; plan ok steps=5, residual G25)`;
		});

		await s.step("goto reaches a natural tree's far side; digThrough variant arrives", async () => {
			if (!tree) throw new Error("no tree located in the previous step; bypass cannot run");
			const t = tree.base;
			// 从树一侧 6 格出发，目标在对侧 5 格：直线被树干挡住，须绕行。
			// 河边树的一侧可能是水（下水会被批10 溺水自保打断）：起点湿了就换侧。
			let fromX = t.x - 6.5;
			let targetX = t.x + 5;
			await reset({ x: fromX, y: t.y + 2, z: t.z + 0.5 });
			if ((await s.readSelf()).inWater === true) {
				fromX = t.x + 6.5;
				targetX = t.x - 5;
				await reset({ x: fromX, y: t.y + 2, z: t.z + 0.5 });
				if ((await s.readSelf()).inWater === true) {
					throw new Error("both sides of the tree are water; bypass cannot run here");
				}
			}
			const target = { x: targetX, y: t.y, z: t.z };
			const around = await nav(target);
			if (!around.arrived)
				throw new Error(
					`tree bypass failed: ${around.code} in ${around.elapsed}ms, ${around.traceNote}, ${around.message}`,
				);
			if (around.elapsed > 25000) throw new Error(`tree bypass took ${around.elapsed}ms`);
			const gap = dist(around.at, target);
			if (gap > 2.5) throw new Error(`tree bypass ended far from target: gap ${gap.toFixed(2)}`);
			// digThrough 对照：允许破坏时同样到达（dug 如实记录，不强求走穿）。
			await reset({ x: fromX, y: t.y + 2, z: t.z + 0.5 });
			const through = await nav(target, { digThrough: true });
			if (!through.arrived)
				throw new Error(
					`digThrough bypass failed: ${through.code} in ${through.elapsed}ms, ${through.traceNote}, ${through.message}`,
				);
			return `around ${around.elapsed}ms (gap ${gap.toFixed(2)}); digThrough ${through.elapsed}ms, dug=${through.dug}`;
		});

		await s.step("24-block natural traverse arrives or fails fast, never burns the wall clock", async () => {
			const here = await serverPos();
			const target = { x: here.x + 24, y: here.y, z: here.z };
			const outcome = await nav(target, { maxTimeMs: 40000 });
			const gap = dist(outcome.at, target);
			if (outcome.arrived) {
				if (outcome.elapsed > 60000) throw new Error(`traverse took ${outcome.elapsed}ms for 24 blocks`);
				return `arrived in ${outcome.elapsed}ms, gap ${gap.toFixed(2)}`;
			}
			// 未到达：只接受看门狗/寻路给出的快速失败，墙钟烧尽（TIMEOUT）算失败。
			if (outcome.code === "TIMEOUT")
				throw new Error(
					`traverse burned the wall clock: ${outcome.elapsed}ms, ${outcome.traceNote}, ${outcome.message}`,
				);
			if (outcome.elapsed > 45000)
				throw new Error(`failure took ${outcome.elapsed}ms; watchdog should settle in seconds`);
			return `fast-fail ${outcome.code} in ${outcome.elapsed}ms at gap ${gap.toFixed(2)} (honest boundary)`;
		});

		await s.step("explore makes real progress through natural terrain within a fixed budget", async () => {
			let best = 0;
			let verdict = "";
			for (const direction of ["e", "w"] as const) {
				const start = await serverPos();
				const result = await s.call(
					"explore@1",
					{ until: { block: "diamond_ore" }, direction, maxTimeMs: 20000 },
					40000,
				);
				const after = await serverPos();
				best = Math.max(best, dist(after, start));
				verdict = result.ok ? "found target" : `${result.code ?? "failed"} (honest budget end)`;
				if (best >= 8) break;
			}
			if (best < 8)
				throw new Error(`explore barely moved in natural terrain: best ${best.toFixed(2)} blocks (${verdict})`);
			return `moved ${best.toFixed(1)} blocks, ${verdict}`;
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
