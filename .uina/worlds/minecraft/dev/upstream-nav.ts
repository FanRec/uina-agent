/**
 * 上游补丁批真服验收（M0：wall-gap / 执行器补丁 / 门语义 / 水规则 / 挖确认 / 拒放避让）。
 *
 * 在 199 高的受控平台上跑七个最小场景，被测行为全走能力面，op 只备地形：
 * 1. 闭木门穿越（canOpenDoors 已启用 + 执行器开门核验）：到达且门 open=true。
 * 2. 闭栅栏门穿越：同上。
 * 3. 1 深水洞游上岸（深水起跳面规则）：水洞中心 → 岸上目标，到达。
 * 4. 挖穿带水邻格的墙（digging.js 补丁：服务端确认才完成）：到达且 dug>0。
 * 5. 服务端拒放（盔甲架占中间桥位）→ 记录拒绝 → 重规划走邻位到达。
 * 6. 全宽沟槽 + 背包无料 → 规划了桥但执行不了 → 诚实快速失败，不假成功。
 * 7. 性能采样：门场景 goto 的 path_update 指标（搜索耗时/节点数）。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const BASE = { x: -758, z: -358 };
/** 高空受控平台（climb 同款高度，自然地形最高 ~120）。 */
const GY = 199;
const STAND = { x: BASE.x + 8, z: BASE.z };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

type Vec = { x: number; y: number; z: number };

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-upstream-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:upstream-nav-${Date.now()}` };
	const h = await openHarness("upstream-nav", { dataRoot, binding });
	const s = makeScenario(h, "upstream-nav");

	const serverPos = async (): Promise<Vec> => {
		const pos = await s.serverPos(USER);
		if (pos == null) throw new Error("server Pos unavailable");
		return pos;
	};
	const reset = async (at: Vec): Promise<void> => {
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/tp ${USER} ${at.x} ${at.y} ${at.z}`);
		await waitForStill(h.bot, h.log);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);
	};
	/** goto + path_update 指标采样（性能对比用）。 */
	const nav = async (
		target: Vec,
		options: { digThrough?: boolean; placeToReach?: boolean; maxTimeMs?: number; sample?: boolean } = {},
	) => {
		const budget = options.maxTimeMs ?? 25000;
		const started = Date.now();
		const spawned = await s.spawn("goto@1", {
			at: target,
			tolerance: 1,
			maxTimeMs: budget,
			...(options.digThrough ? { digThrough: true } : {}),
			...(options.placeToReach != null ? { placeToReach: options.placeToReach } : {}),
		});
		const metrics: { time: number; visited: number; generated: number; cost: number; status: string }[] = [];
		const bot = h.bot as unknown as {
			on(name: string, fn: (data: unknown) => void): void;
			removeListener(name: string, fn: (data: unknown) => void): void;
		};
		let sampling = options.sample === true;
		const onPathUpdate = (r: unknown): void => {
			if (!sampling) return;
			const { status, cost, visitedNodes, generatedNodes, time } = r as {
				status: string;
				cost: number;
				visitedNodes: number;
				generatedNodes: number;
				time: number;
			};
			metrics.push({ status, cost, visited: visitedNodes, generated: generatedNodes, time });
		};
		bot.on("path_update", onPathUpdate);
		let result: CallResult;
		try {
			result = await s.waitCall(spawned, budget + 15000);
		} finally {
			sampling = false;
			bot.removeListener("path_update", onPathUpdate);
		}
		const elapsed = Date.now() - started;
		const at = await serverPos();
		const search = metrics
			.filter((m) => m.status !== "partial")
			.map((m) => `t=${Math.round(m.time)}ms v=${m.visited} g=${m.generated}`)
			.join(", ");
		if (result.ok) {
			const value = valueOf<{ dug?: number }>(result);
			return { ok: true as const, elapsed, dug: value.dug ?? 0, at, search };
		}
		return {
			ok: false as const,
			code: result.code,
			message: result.message ?? "",
			elapsed,
			dug: 0,
			at,
			search,
		};
	};

	try {
		await s.step("prepare: 199 高受控平台 + 防刷怪 + 清包", async () => {
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/kill @e[type=minecraft:armor_stand]`);
			await s.command(`/clear ${USER}`);
			const px = BASE.x - 10;
			const qx = BASE.x + 62;
			await s.command(`/fill ${px} ${GY} ${BASE.z - 15} ${qx} ${GY} ${BASE.z + 15} minecraft:stone`);
			await s.command(`/fill ${px - 1} ${GY + 1} ${BASE.z - 16} ${qx + 1} ${GY + 9} ${BASE.z + 16} minecraft:air`);
			await reset({ x: STAND.x, y: GY + 1, z: STAND.z + 0.5 });
			const at = await serverPos();
			if (Math.abs(at.y - (GY + 1)) > 1.5) throw new Error(`platform stand y=${at.y}`);
			return `platform ${qx - px + 1} wide at y=${GY}, standing at (${at.x.toFixed(0)}, ${at.y.toFixed(1)}, ${at.z.toFixed(0)})`;
		});

		// ---- S1 闭木门 ----
		await s.step("closed oak door traversal: goto opens it and arrives (door open=true)", async () => {
			const wx = BASE.x + 18;
			const z = STAND.z;
			// 门两侧墙段（dz=0 留门位）
			await s.command(`/fill ${wx} ${GY + 1} ${z - 3} ${wx} ${GY + 2} ${z - 1} minecraft:stone`);
			await s.command(`/fill ${wx} ${GY + 1} ${z + 1} ${wx} ${GY + 2} ${z + 3} minecraft:stone`);
			await s.command(
				`/setblock ${wx} ${GY + 1} ${z} minecraft:oak_door[facing=east,half=lower,open=false,hinge=left]`,
			);
			await s.command(
				`/setblock ${wx} ${GY + 2} ${z} minecraft:oak_door[facing=east,half=upper,open=false,hinge=left]`,
			);
			const closed = await s.readBlock({ x: wx, y: GY + 1, z });
			if (closed?.properties?.open !== "false")
				throw new Error(`door not closed at setup: ${JSON.stringify(closed?.properties)}`);
			await reset({ x: BASE.x + 12.5, y: GY + 1, z: z + 0.5 });
			const target = { x: wx + 6, y: GY + 1, z };
			const outcome = await nav(target, { placeToReach: false, sample: true });
			if (!outcome.ok)
				throw new Error(
					`door traversal failed: ${outcome.code} ${outcome.message} at (${outcome.at.x.toFixed(1)},${outcome.at.y.toFixed(1)}) in ${outcome.elapsed}ms`,
				);
			if (outcome.elapsed > 20000) throw new Error(`door traversal too slow: ${outcome.elapsed}ms`);
			const door = await s.readBlock({ x: wx, y: GY + 1, z });
			if (door?.name !== "oak_door") throw new Error(`door cell now ${door?.name ?? "null"}`);
			if (door.properties?.open !== "true")
				throw new Error(`door should be open after traversal: ${JSON.stringify(door?.properties)}`);
			return `arrived in ${outcome.elapsed}ms, door open=true (gap ${Math.hypot(outcome.at.x - target.x, outcome.at.y - target.y, outcome.at.z - target.z).toFixed(2)}; searches ${outcome.search})`;
		});

		// ---- S2 闭栅栏门 ----
		await s.step("closed fence gate traversal: goto opens it and arrives (gate open=true)", async () => {
			const wx = BASE.x + 34;
			const z = STAND.z;
			// 栅栏门两侧墙段（dz=0 留门位）
			await s.command(`/fill ${wx} ${GY + 1} ${z - 3} ${wx} ${GY + 2} ${z - 1} minecraft:stone`);
			await s.command(`/fill ${wx} ${GY + 1} ${z + 1} ${wx} ${GY + 2} ${z + 3} minecraft:stone`);
			await s.command(`/setblock ${wx} ${GY + 1} ${z} minecraft:spruce_fence_gate[facing=east,open=false]`);
			await reset({ x: wx - 6.5, y: GY + 1, z: z + 0.5 });
			const target = { x: wx + 6, y: GY + 1, z };
			const outcome = await nav(target, { placeToReach: false });
			if (!outcome.ok)
				throw new Error(`gate traversal failed: ${outcome.code} ${outcome.message} in ${outcome.elapsed}ms`);
			const gate = await s.readBlock({ x: wx, y: GY + 1, z });
			if (gate?.properties?.open !== "true")
				throw new Error(`gate should be open: ${JSON.stringify(gate?.properties)}`);
			return `arrived in ${outcome.elapsed}ms, gate open=true`;
		});

		// ---- S3 1 深水洞游上岸 ----
		await s.step("1-deep water hole: swim out onto the bank (water takeoff rule)", async () => {
			const hx = BASE.x + 48;
			const z = STAND.z;
			// 1 深水洞（替换 199 层地板，四周地板围住不外流）；下方 198 层必须铺底，
			// 否则 bot 会掉穿平台落进真实水域——那不是被测场景，而是真实溺水（G26 根因）。
			await s.command(`/fill ${hx} ${GY} ${z} ${hx + 1} ${GY} ${z} minecraft:water`);
			await s.command(`/fill ${hx} ${GY - 1} ${z} ${hx + 1} ${GY - 1} ${z} minecraft:stone`);
			await reset({ x: hx + 0.5, y: GY + 0.9, z: z + 0.5 });
			const at = await serverPos();
			if (Math.abs(at.y - (GY + 0.9)) > 1.2 || at.x < hx - 0.5 || at.x > hx + 2.5)
				throw new Error(
					`bot left the water hole during setup: (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`,
				);
			const inWater = await s.readSelf();
			if ((inWater as { inWater?: boolean }).inWater !== true) throw new Error(`bot not in water at setup`);
			const target = { x: hx + 5, y: GY + 1, z };
			const outcome = await nav(target, { placeToReach: false });
			if (!outcome.ok) throw new Error(`swim-out failed: ${outcome.code} ${outcome.message} in ${outcome.elapsed}ms`);
			if (outcome.elapsed > 20000) throw new Error(`swim-out too slow: ${outcome.elapsed}ms`);
			return `swam out and arrived in ${outcome.elapsed}ms (server y=${outcome.at.y.toFixed(1)})`;
		});

		// ---- S4 挖穿墙 + 墙后水洞 ----
		await s.step("digThrough a wall with a water hole behind (server-confirmed dig)", async () => {
			const wx = BASE.x + 26;
			const z = STAND.z;
			// 17 宽石墙（GY+1/GY+2 墙身 + GY+3/GY+4 封顶）：封顶两层后"挖上两层爬墙"
			// 需要 3 格挖掘且站上墙顶仍无净空，挖穿 2 格平穿（~21）明确便宜于
			// 爬墙（~30+）与绕行（17 宽 ~29）。
			await s.command(`/fill ${wx} ${GY + 1} ${z - 8} ${wx} ${GY + 4} ${z + 8} minecraft:stone`);
			// 墙后地板挖水洞（四周地板围住），穿过墙后要游出去；同样必须铺底（G26 同款缺陷）
			await s.command(`/setblock ${wx + 1} ${GY} ${z} minecraft:water`);
			await s.command(`/setblock ${wx + 1} ${GY - 1} ${z} minecraft:stone`);
			await s.command(`/give ${USER} minecraft:iron_pickaxe 1`);
			await reset({ x: wx - 5.5, y: GY + 1, z: z + 0.5 });
			const target = { x: wx + 7, y: GY + 1, z };
			const outcome = await nav(target, { digThrough: true, placeToReach: false });
			if (!outcome.ok) throw new Error(`digThrough failed: ${outcome.code} ${outcome.message} in ${outcome.elapsed}ms`);
			if (outcome.dug < 2) throw new Error(`digThrough arrived without digging through (dug=${outcome.dug})`);
			// A* 可在 17 宽墙的任一列挖穿（等价代价，对角启发式选列），断言按目标行
			// 附近 3 列核对：至少一列的脚层已通。
			const columns: string[] = [];
			let passable = false;
			for (const dz of [-1, 0, 1]) {
				const wall = await s.readBlock({ x: wx, y: GY + 1, z: z + dz });
				const name = wall?.name ?? "air";
				columns.push(`${dz}:${name}`);
				if (name === "air" || name === "water") passable = true;
			}
			if (!passable) throw new Error(`dug wall cells are still stone (${columns.join(", ")})`);
			return `dug=${outcome.dug}, wall foot cells [${columns.join(", ")}], arrived in ${outcome.elapsed}ms`;
		});

		// ---- S5a 拒放避让：中间桥位被占 → 记录拒绝 → 重规划走邻位 ----
		await s.step(
			"server-refused placement: replan avoids the refused cell and arrives via a neighbour lane",
			async () => {
				const gx = BASE.x + 52;
				const z = STAND.z;
				// 回填 S3 水洞，避免与场景后段互相干扰
				await s.command(`/fill ${BASE.x + 48} ${GY} ${z} ${BASE.x + 49} ${GY} ${z} minecraft:stone`);
				// 7 宽地洞（199/200 层清空）——桥比绕行便宜；只占中间桥位
				await s.command(`/fill ${gx} ${GY} ${z - 3} ${gx + 1} ${GY + 2} ${z + 3} minecraft:air`);
				await s.command(`/summon minecraft:armor_stand ${gx + 0.5} ${GY} ${z + 0.5} {NoGravity:1b,Invisible:1b}`);
				await s.command(`/give ${USER} minecraft:dirt 16`);
				await reset({ x: gx - 2.5, y: GY + 1, z: z + 0.5 });
				const target = { x: gx + 4, y: GY + 1, z };
				const outcome = await nav(target, { placeToReach: true, maxTimeMs: 25000 });
				await s.command(`/kill @e[type=minecraft:armor_stand]`);
				if (!outcome.ok)
					throw new Error(`avoidance failed: ${outcome.code} ${outcome.message} in ${outcome.elapsed}ms`);
				if (outcome.elapsed > 30000) throw new Error(`avoidance too slow: ${outcome.elapsed}ms`);
				return `arrived in ${outcome.elapsed}ms via a neighbour lane (center bridge refused)`;
			},
		);

		// ---- S5b 无料兜底：全宽沟槽 + 背包无料 → 诚实快速失败，不假成功 ----
		await s.step("planned bridge without scaffolding material: honest fast failure, no fake success", async () => {
			const gx = BASE.x + 52;
			const z = STAND.z;
			// 全宽沟槽（横贯平台）：任何 z 行过沟都要垫块
			await s.command(`/fill ${gx} ${GY} ${BASE.z - 15} ${gx + 1} ${GY + 2} ${BASE.z + 15} minecraft:air`);
			await s.command(`/clear ${USER}`);
			await reset({ x: gx - 2.5, y: GY + 1, z: z + 0.5 });
			const target = { x: gx + 4, y: GY + 1, z };
			const outcome = await nav(target, { placeToReach: true, maxTimeMs: 15000 });
			if (outcome.ok) throw new Error(`bridging without material must not succeed`);
			if (!["UNREACHABLE", "TIMEOUT"].includes(outcome.code ?? "")) {
				throw new Error(`unexpected failure code ${outcome.code}: ${outcome.message}`);
			}
			if (outcome.elapsed > 30000) throw new Error(`no-material loop burned the wall clock: ${outcome.elapsed}ms`);
			if (outcome.at.x > gx + 0.95) throw new Error(`bot crossed into the gap: x=${outcome.at.x.toFixed(2)}`);
			return `${outcome.code} in ${outcome.elapsed}ms, stayed at x=${outcome.at.x.toFixed(2)} (gap at ${gx})`;
		});
	} finally {
		await s.command(`/kill @e[type=minecraft:armor_stand]`);
	}

	const failures = s.finish();
	if (failures > 0) process.exitCode = 1;
	await closeHarness(h);
}

main().catch((err) => {
	console.error("[mc-upstream-nav] FATAL", err);
	process.exitCode = 1;
});
