/**
 * M2 搜索预算诊断探针（批28）：山头目标 A* 搜索画像与启发式权重 A/B。
 *
 * 背景：known-gaps G25 残余——24 格自然穿越在目标位于山头时，A* 5s think budget
 * 搜不完（5.8 万节点）诚实 Timeout。本探针不修改任何补丁，直接驱动上游
 * getPathFromTo 读取 visitedNodes / time / cost，对同一几何对比不同启发式权重
 * （权重只改扩展顺序：g 不变、合法性不变、isEnd 不变）。
 *
 * 诊断用脚本，不是验收门；正式验收走 dev:mc:terrain-nav / upstream-nav。
 */

import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vec3 } from "../contracts/values.js";
import { toMineflayerVec3 } from "../driver/mineflayer/adapter.js";
import { configureMovements, deriveSteps, loadPathfinderPlugin } from "../driver/mineflayer/pathfinder.js";
import { closeHarness, dist, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario } from "./scenario.js";

/** 经 mineflayer 解析链取 mineflayer-pathfinder（与 driver/mineflayer/pathfinder.ts 同口径）。 */
const pf = createRequire(createRequire(import.meta.url).resolve("mineflayer/package.json"))(
	"mineflayer-pathfinder",
) as { goals: { GoalNear: new (x: number, y: number, z: number, r: number) => { heuristic: (node: Vec3) => number } } };

const USER = "UinaDev";
const BASE = { x: -758, z: -358 };

type BotAny = Parameters<typeof loadPathfinderPlugin>[0];

interface SearchOutcome {
	status: string;
	timeMs: number;
	visitedNodes: number;
	cost: number;
	pathLength: number;
	dig: number;
	place: number;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-navperf-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:nav-perf-${Date.now()}` };
	const h = await openHarness("nav-perf", { dataRoot, binding });
	const s = makeScenario(h, "nav-perf");
	const bot = h.bot as BotAny;

	const serverPos = async (): Promise<Vec3> => {
		const pos = await s.serverPos(USER);
		if (pos == null) throw new Error("server Pos unavailable");
		return pos;
	};
	const reset = async (at: Vec3): Promise<void> => {
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/tp ${USER} ${at.x} ${at.y} ${at.z}`);
		await waitForStill(h.bot, h.log);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);
	};

	/** 客户端已加载列的表面高度（最高实心格 y）。 */
	const surfaceHeight = (x: number, z: number, around: number): number | null => {
		for (let y = around + 24; y >= around - 32; y--) {
			const b = h.bot.blockAt(toMineflayerVec3({ x, y, z }), false);
			if (b == null) return null; // 未加载列：整列放弃
			if (b.boundingBox === "block") return y;
		}
		return null;
	};

	/** 直接驱动上游搜索（只读，等价 planPath 的口径但保留画像字段）。 */
	const search = async (target: Vec3, weight: number, budgetMs = 5000): Promise<SearchOutcome> => {
		loadPathfinderPlugin(bot);
		configureMovements(bot, { sprint: true, digThrough: false, placeToReach: false });
		const assembly = (
			bot as unknown as { pathfinder: { movements: { heuristicWeight: number }; getPathFromTo: Function } }
		).pathfinder;
		// 适配层默认已带 MOVEMENTS_POLICY.heuristicWeight=3；A/B 需要直接控制字段，
		// goal.heuristic 不再包装（权重全部走 Movements，与生产路径同口径）。
		assembly.movements.heuristicWeight = weight;
		const goal = new pf.goals.GoalNear(target.x, target.y, target.z, 1);
		const iterator = assembly.getPathFromTo(assembly.movements, h.bot.entity.position, goal, {
			optimizePath: false,
			timeout: budgetMs,
		}) as IterableIterator<{
			result: {
				status: string;
				cost: number;
				time: number;
				visitedNodes: number;
				path: { x: number; y: number; z: number; toBreak: unknown[]; toPlace: unknown[] }[];
			};
		}>;
		for (;;) {
			const step = iterator.next();
			if (step.done) break;
			const { result } = step.value;
			if (result.status === "partial") {
				await new Promise<void>((resolve) => setImmediate(resolve));
				continue;
			}
			const { steps } = deriveSteps(result.path as never);
			return {
				status: result.status,
				timeMs: Math.round(result.time),
				visitedNodes: result.visitedNodes,
				cost: Math.round(result.cost * 100) / 100,
				pathLength: steps.length,
				dig: steps.filter((st) => st.action === "dig").length,
				place: steps.filter((st) => st.action === "place").length,
			};
		}
		throw new Error("generator ended without terminal status");
	};

	try {
		await s.step("prepare: land on natural terrain near spawn", async () => {
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await reset({ x: BASE.x + 0.5, y: 120, z: BASE.z + 0.5 });
			await sleep(1500);
			const ground = await serverPos();
			return `natural ground at (${ground.x.toFixed(1)}, ${ground.y.toFixed(1)}, ${ground.z.toFixed(1)})`;
		});

		let hill: { x: number; y: number; z: number } | null = null;
		await s.step("locate a natural hill 16-32 blocks out with >=5 height gain", async () => {
			const offsets: [number, number][] = [
				[0, 0],
				[128, 0],
				[0, 128],
				[-128, 64],
				[64, -128],
				[192, 0],
				[0, 192],
				[-192, 0],
				[0, -192],
				[160, 160],
				[-160, 160],
			];
			for (const [dx, dz] of offsets) {
				const at = { x: BASE.x + dx + 0.5, y: 120, z: BASE.z + dz + 0.5 };
				await reset(at);
				await sleep(1500);
				const here = await serverPos();
				const gy = Math.floor(here.y);
				const cx = Math.floor(here.x);
				const cz = Math.floor(here.z);
				let best: { x: number; y: number; z: number; d: number } | null = null;
				for (let ex = -40; ex <= 40; ex += 2) {
					for (let ez = -40; ez <= 40; ez += 2) {
						const y = surfaceHeight(cx + ex, cz + ez, gy);
						if (y == null) continue;
						const d = Math.hypot(ex, ez);
						if (d < 16 || d > 32) continue;
						if (y - gy < 5) continue;
						if (best == null || y > best.y) best = { x: cx + ex, y, z: cz + ez, d };
					}
				}
				if (best != null) {
					hill = { x: best.x, y: best.y, z: best.z };
					return `spot (${cx},${cz}) gy=${gy}: hill at (${best.x},${best.y},${best.z}) gain ${best.y - gy}, dist ${best.d.toFixed(1)}`;
				}
				s.log(`spot (${cx},${cz}) gy=${gy}: no hill, trying next`);
			}
			throw new Error("no hill found at any candidate spot");
		});

		let flat: { x: number; y: number; z: number } | null = null;
		{
			const here = await serverPos();
			const gy = Math.floor(here.y);
			flat = { x: here.x + 24, y: gy, z: here.z };
		}

		for (const [label, target] of [
			["flat-24", flat],
			["hill", hill],
		] as const) {
			if (target == null) continue;
			for (const weight of [1, 2, 3, 4]) {
				const outcome = await search(target, weight);
				s.log(
					`${label} w=${weight}: ${outcome.status} time=${outcome.timeMs}ms visited=${outcome.visitedNodes} cost=${outcome.cost} steps=${outcome.pathLength} dig=${outcome.dig} place=${outcome.place}`,
				);
			}
		}

		// 最优权重的稳定性：连续三次。
		if (hill != null) {
			for (let i = 0; i < 3; i++) {
				const outcome = await search(hill, 3);
				s.log(
					`hill w=3 run${i + 1}: ${outcome.status} time=${outcome.timeMs}ms visited=${outcome.visitedNodes} cost=${outcome.cost}`,
				);
			}
		}

		// 端到端：真实 goto@1 到山头目标（known-gaps 残余的原始失败形态是
		// 实机 goto Timeout，不只是 planPath）。预算 40s，到达即 PASS。
		if (hill != null) {
			const started = Date.now();
			const result = await s.call("goto@1", { at: hill, tolerance: 1, maxTimeMs: 40000, placeToReach: false }, 55000);
			const elapsed = Date.now() - started;
			const at = await serverPos();
			const gap = dist(at, hill);
			if (!result.ok) {
				throw new Error(`goto to hill failed: ${result.code} in ${elapsed}ms, server gap ${gap.toFixed(2)}`);
			}
			if (gap > 2.5) throw new Error(`goto ended far from hill target: gap ${gap.toFixed(2)}`);
			s.log(`goto hill: arrived in ${elapsed}ms, server gap ${gap.toFixed(2)}`);
		}

		const here = await serverPos();
		s.log(`final bot position (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)})`);
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
