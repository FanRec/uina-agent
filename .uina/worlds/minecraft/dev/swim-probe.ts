/**
 * 水洞爬岸的重复探针：`dev:mc:upstream-nav` 的 S3 步偶发 "pathfinder found no path"
 * （2026-11-09 实测 8 轮里 1 次失败，失败时 bot 在洞里 y≈199.29、A* 几乎立刻放弃）。
 *
 * 只回答一个问题：**同一几何反复跑，失败是怎么分布的、失败时机器人在哪、A* 搜了多少？**
 * 场景与 S3 同构（1 深水洞 + 198 层铺底 + 目标脚下实心），走正式 `goto@1`，
 * 不用 /tp 作弊，不替代被测行为。
 *
 * 用法：`pnpm dev:mc:swim-probe [轮数]`（缺省 8）
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const GY = 199;
const BASE = { x: -758, z: -358 };
const HX = BASE.x + 48;
const Z = BASE.z + 8;

interface Round {
	round: number;
	ok: boolean;
	elapsed: number;
	code?: string;
	at: { x: number; y: number; z: number };
	searches: string;
	inWater: boolean | null;
}

async function main(): Promise<void> {
	const rounds = Number(process.argv[2] ?? 8);
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-swim-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:swim-${Date.now()}` };
	const h = await openHarness("swim-probe", { dataRoot, binding });
	const s = makeScenario(h, "swim-probe");
	const bot = h.bot as unknown as {
		on(name: string, fn: (data: unknown) => void): void;
		removeListener(name: string, fn: (data: unknown) => void): void;
	};
	const results: Round[] = [];
	try {
		// 平台：73 宽、y=199 实心、y=198 铺底（与 upstream-nav 的 prepare 同量级，
		// 只是缩到够用的范围——探针不测平台铺设本身）。
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/fill ${BASE.x} ${GY} ${BASE.z} ${BASE.x + 72} ${GY} ${BASE.z + 20} minecraft:stone`);
		await s.command(`/fill ${BASE.x} ${GY - 1} ${BASE.z} ${BASE.x + 72} ${GY - 1} ${BASE.z + 20} minecraft:stone`);
		await s.command(`/fill ${BASE.x} ${GY + 1} ${BASE.z} ${BASE.x + 72} ${GY + 6} ${BASE.z + 20} minecraft:air`);
		await s.command(`/gamerule spawn_mobs false`);
		await s.command(`/difficulty peaceful`);

		for (let round = 1; round <= rounds; round++) {
			// 水洞：替换 199 层地板两格，198 层铺底（否则会掉穿平台落进真实水域）。
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${HX} ${GY} ${Z} ${HX + 1} ${GY} ${Z} minecraft:water`);
			await s.command(`/fill ${HX} ${GY - 1} ${Z} ${HX + 1} ${GY - 1} ${Z} minecraft:stone`);
			await s.command(`/tp ${USER} ${HX + 0.5} ${GY + 0.9} ${Z + 0.5}`);
			await waitForStill(h.bot, h.log);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const self = await s.readSelf();
			await s.command(`/setblock ${HX + 5} ${GY} ${Z} minecraft:stone`);

			const metrics: string[] = [];
			const onPathUpdate = (r: unknown): void => {
				const { status, visitedNodes, generatedNodes, time } = r as {
					status: string;
					visitedNodes: number;
					generatedNodes: number;
					time: number;
				};
				if (status === "partial") return;
				metrics.push(`t=${Math.round(time)}ms v=${visitedNodes} g=${generatedNodes}`);
			};
			bot.on("path_update", onPathUpdate);
			const started = Date.now();
			let result: CallResult;
			try {
				const spawned = await s.spawn("goto@1", {
					at: { x: HX + 5, y: GY + 1, z: Z },
					tolerance: 1,
					maxTimeMs: 25000,
					placeToReach: false,
				} satisfies JsonValue);
				result = await s.waitCall(spawned, 40000);
			} finally {
				bot.removeListener("path_update", onPathUpdate);
			}
			const elapsed = Date.now() - started;
			const at = (await s.serverPos(USER)) ?? self.place.position;
			results.push({
				round,
				ok: result.ok,
				elapsed,
				...(result.ok ? {} : { code: result.code }),
				at,
				searches: metrics.join(", ") || "none",
				inWater: (self as { inWater?: boolean | null }).inWater ?? null,
			});
			await sleep(500);
		}

		console.log("\nround  result   ms    y      x       searches");
		for (const entry of results)
			console.log(
				`${String(entry.round).padStart(5)}  ${(entry.ok ? "ok" : (entry.code ?? "fail")).padEnd(7)} ${String(entry.elapsed).padStart(5)}  ${entry.at.y.toFixed(2)}  ${entry.at.x.toFixed(2)}  ${entry.searches}`,
			);
		const failed = results.filter((entry) => !entry.ok);
		console.log(`\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
	} finally {
		await closeHarness(h);
	}
}

await main();
