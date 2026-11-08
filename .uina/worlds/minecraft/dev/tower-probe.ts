/**
 * G30 对拍探针（批35 入库，creeper-probe 同例）：损伤阶梯的逐级爬升可靠性。
 *
 * 场景：1:1 下行走廊中抽掉一级踏步支撑（--gap 1，默认）制造 1 深坑，
 * 回程 goto 必须经"落入坑 → 1by1 tower（place+跳）→ 续爬"才能出去；
 * --gap 0 为对照（无坑，纯 1:1 链式跳——批35 纯节点规则修复的回归观测）。
 * 采样 100ms：debugState（路径节点含 toPlace/toBreak 长度、挖置标志）、键位、
 * 位置、速度、onGround、placeMisses。
 * 批35 实证（known-gaps §G30）：塔升放置链路完整工作（A* 规划塔升节点，执行器
 * 坑沿完成放置并跨缺口续爬）；残余 = 缺口跨越后连续 1 级台阶的弹跳彩票。
 * 批36 关闭（known-gaps §G30）：100ms 采样钉住退避残留键在空中与 forward 抵消
 * （f:1 b:1 同按，弧线变垂直起落）——修复 = 退避只拥有地面（离地即释放残留
 * back 键，计时保留落地后窗口内继续）。探针 10/10 连绿（基线 8/10），G30 全部
 * 关闭；本探针保留为该执行器面的回归观测入口。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import type { MineflayerBot } from "../driver/mineflayer/adapter.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario } from "./scenario.js";

const USER = process.env.MC_DEV_USER ?? "UinaDev";
/** --gap 0：不抽支撑（纯链式跳对照）；缺省或 --gap 1：抽支撑（塔升放置形态）。 */
const WITH_GAP = !(process.argv.includes("--gap") && process.argv[process.argv.indexOf("--gap") + 1] === "0");

const MINE = {
	body: { x1: 12040, y1: 180, z1: 11996, x2: 12055, y2: 200, z2: 12011 },
	start: { x: 12040.5, y: 201, z: 12000.5 },
	cavity: { x1: 12050, y1: 191, z1: 11999, x2: 12052, y2: 193, z2: 12001 },
	/** 塔升重建位：column 12045 的支撑格（fy=196 → 支撑 195）。 */
	gap: { x: 12045, y: 195, z: 12000 },
};

const GOTO_PROGRAM = String.raw`
async function main(mc, input) {
	const t0 = Date.now();
	const step = (name, detail) => {
		console.log('STEP ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
		mc.progress({ step: name });
	};
	try {
		step('goto_start', input.start);
		// 本探针专测坑内 1by1 tower（放置 + 跳）链路：施工能力必须显式授权，
		// 不能依赖 goto@1 现已关闭的默认垫块行为。
		await mc.call('goto@1', { at: input.start, tolerance: 2, digThrough: true, placeToReach: true, maxTimeMs: 60000 });
		step('goto_done');
		return { ok: true, ms: Date.now() - t0 };
	} catch (error) {
		step('goto_failed', String((error && error.code) || '') + ': ' + String((error && error.message) || error).slice(0, 300));
		return { ok: false, ms: Date.now() - t0 };
	}
}
`;

async function main(): Promise<void> {
	const dataRoot = mkdtempSync(join(tmpdir(), "uina-mc-tower-probe-"));
	const h = await openHarness("tower-probe", {
		dataRoot,
		binding: { world: "world:paper-bench", worldRevision: `revision:tower-probe-${Date.now()}` },
	});
	const s = makeScenario(h, "tower-probe");
	try {
		// ---- 场地：body 填石 + 洞室 + 1:1 下行走廊（顶净空 3）+ 塔升坑 + 材料。
		const b = MINE.body;
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/tp ${USER} ${MINE.start.x} ${MINE.start.y} ${MINE.start.z}`);
		for (let i = 0; i < 40; i++) {
			if ((await s.readBlock({ x: b.x1, y: b.y2, z: b.z1 })) != null) break;
			await sleep(300);
		}
		await s.command(`/difficulty peaceful`);
		await s.command(`/gamerule doMobSpawning false`);
		await s.command(`/gamerule doDaylightCycle false`);
		await s.command(`/time set day`);
		await s.command(`/kill @e[type=minecraft:item]`);
		await s.command(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:stone`);
		await s.command(
			`/fill ${MINE.cavity.x1} ${MINE.cavity.y1} ${MINE.cavity.z1} ${MINE.cavity.x2} ${MINE.cavity.y2} ${MINE.cavity.z2} minecraft:air`,
		);
		for (let x = 12041; x <= 12050; x++) {
			const fy = 201 - (x - 12040);
			await s.command(`/fill ${x} ${fy} 12000 ${x} ${fy + 2} 12000 minecraft:air`);
		}
		// 塔升坑：抽掉一级支撑 → 回程该列 2 深坑，必须 place+跳（--gap 0 跳过，复现挖升形态）。
		if (WITH_GAP) await s.command(`/setblock ${MINE.gap.x} ${MINE.gap.y} ${MINE.gap.z} minecraft:air`);
		await s.command(`/clear ${USER}`);
		await s.command(`/give ${USER} minecraft:cobblestone 16`);
		await s.command(`/give ${USER} minecraft:stone_pickaxe 1`);
		await s.command(`/gamemode survival ${USER}`);
		await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
		await s.command(`/tp ${USER} 12050.5 191 12000.5`);
		await waitForStill(h.bot, s.log);
		const gapBlock = await s.readBlock(MINE.gap);
		console.log(
			"[probe] gap mode:",
			WITH_GAP ? "gap (tower shape)" : "no-gap (dig-up shape)",
			"| gap block:",
			gapBlock?.name ?? "unreadable",
		);

		// ---- 采样：100ms 一拍（物理 50ms/拍，逐拍分辨率），直到程序结束。
		const bot = h.bot as unknown as MineflayerBot & {
			pathfinder?: {
				debugState?: () => {
					path: { x: number; y: number; z: number; toBreak: number | null; toPlace: number | null }[];
					goal: unknown;
					digging: boolean;
					placing: boolean;
				};
			};
		};
		const samples: string[] = [];
		const sampler = setInterval(() => {
			try {
				const p = bot.entity.position;
				const v = bot.entity.velocity;
				const grounded = (bot.entity as unknown as { onGround?: boolean }).onGround ? 1 : 0;
				const debug = bot.pathfinder?.debugState?.();
				const misses = (bot as unknown as { placeMisses?: { x: number; y: number; z: number }[] }).placeMisses ?? [];
				const keys = bot.controlState as unknown as Record<string, boolean>;
				const head = debug?.path?.[0];
				const keyStr = ["forward", "back", "jump", "sprint", "sneak"]
					.map((k) => `${k[0]}:${keys[k] ? 1 : 0}`)
					.join(" ");
				const placeNode = debug?.path?.find((n) => (n.toPlace ?? 0) > 0);
				samples.push(
					`${new Date().toISOString().slice(11, 23)} pos=${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` +
						` vel=${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)} g=${grounded}` +
						` path=${debug?.path?.length ?? -1} head=${head ? `${head.x},${head.y},${head.z}+${head.toPlace ?? 0}` : "-"}` +
						` placeNode=${placeNode ? `${placeNode.x},${placeNode.y},${placeNode.z}+${placeNode.toPlace}` : "-"}` +
						` dig=${debug?.digging ? 1 : 0} placing=${debug?.placing ? 1 : 0} miss=${misses.length} ${keyStr}`,
				);
			} catch {
				// 采样不给 goto 让路：读数失败跳过这一拍。
			}
		}, 100);

		// ---- 回程 goto。
		const acceptance = await h.runtime.submit(
			{ worldOwner: h.worldOwner, activation: h.activation },
			{
				requestId: `tower-probe-goto-${Date.now()}`,
				entry: {
					kind: "program",
					source: { code: GOTO_PROGRAM },
					input: { start: MINE.start } as unknown as JsonValue,
				},
				schedule: { kind: "enqueue" },
			},
		);
		if (acceptance.kind !== "accepted") throw new Error(`submit rejected: ${JSON.stringify(acceptance).slice(0, 400)}`);
		const reply = await h.runtime.wait(acceptance.snapshot.run, { timeoutMs: 120_000 });
		clearInterval(sampler);
		if (reply.kind === "result" && reply.snapshot.phase === "finished") {
			const full = await h.runtime.readRecord(reply.snapshot.record);
			const value = full.kind === "inline" ? (full.record.value as { value?: JsonValue }).value : undefined;
			console.log("[probe] GOTO RESULT:", JSON.stringify(value));
		} else {
			console.log("[probe] GOTO DID NOT FINISH:", JSON.stringify(reply.snapshot).slice(0, 600));
		}
		const pos = await s.serverPos(USER);
		console.log("[probe] final server pos:", JSON.stringify(pos));
		console.log("[probe] --- all samples ---");
		for (const line of samples) console.log(line);
	} finally {
		await closeHarness(h).catch(() => {});
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error("[probe] failed:", error);
		process.exit(1);
	},
);
