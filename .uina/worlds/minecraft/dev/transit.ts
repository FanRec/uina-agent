/**
 * 批 19 真服验收：transit@1 跨维度旅行（建门 → 点亮 → 进门 → 落地 → 返回）。
 *
 * 被测行为全部走正式能力面；op 指令只摆地形/给材料，不代替任何被测动作。
 * 断言用服务端真值（/data get Pos）+ 客户端维度包（self.place.dimension）双源：
 * 维度切换只有服务端说了算，坐标只有服务端不受客户端预测影响。
 *
 * 场景顺序刻意先失败面再成功面：
 * 1) 空手 → MISSING_MATERIAL（不派发、不占身体）；
 * 2) 给材料 → 在平地上建 4x5 门（14 格黑曜石）+ 打火石点亮 + 走进去；
 * 3) 从下界原路返回 → 复用下界侧的门（reason=found）；
 * 4) 再进一次 → 复用主世界侧刚建的门（reason=found）。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
/** 与 climb 场景的平台（z 9810..9890）错开 10 格，避免互相覆盖几何。 */
const CENTER = { x: 9850, y: 200, z: 9900 };
/** 一次跨维度调用要等区块生成，预算给足；场景侧的等待比能力面预算再多 20s。 */
const CALL_BUDGET_MS = 300000;
const CALL_TIMEOUT_MS = CALL_BUDGET_MS + 20000;

interface TransitValue {
	reached: boolean;
	dimension: string;
	at: { x: number; y: number; z: number };
	stages: { kind: string; ok: boolean; reason?: string }[];
}

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

/** 维度名裸形式：self@1 与能力面输出都可能是 `the_nether` 或 `minecraft:the_nether`。 */
function dim(name: string): string {
	return name.replace(/^minecraft:/, "");
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-transit-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:transit-${Date.now()}` };
	const h = await openHarness("transit", { dataRoot, binding });
	const s = makeScenario(h, "transit");

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
		await s.step("prepare a clean platform with no portal in range", async () => {
			// 上一轮可能把身体留在了下界：`/tp` 只换坐标不换维度，必须显式指定主世界，
			// 否则后面的 `/fill`、`readBlocks`、`self.place.dimension` 全都作用在下界。
			await s.command(`/execute in minecraft:overworld run tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await waitForStill(h.bot, h.log);
			const here = (await s.readSelf()).place.dimension;
			if (dim(here) !== "overworld") throw new Error(`expected to stand in the overworld, got ${here}`);
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(
				`/fill ${CENTER.x - 20} 199 ${CENTER.z - 20} ${CENTER.x + 20} 199 ${CENTER.z + 20} minecraft:stone`,
			);
			// 这一段同时清掉上一轮留下的门与框（air 200..232 覆盖它们），场景才能重复跑。
			for (let y = 200; y <= 232; y += 4) {
				await s.command(
					`/fill ${CENTER.x - 20} ${y} ${CENTER.z - 20} ${CENTER.x + 20} ${y + 3} ${CENTER.z + 20} minecraft:air`,
				);
			}
			await s.command(`/effect give ${USER} minecraft:instant_health 1 25 true`);
			await s.command(`/effect give ${USER} minecraft:saturation 1 10 true`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const below = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
			if (below?.name !== "stone") throw new Error(`platform fill did not land: ${below?.name ?? "null"}`);
			// 就近有现成的门，"建门"这条路径根本不会被走到——先确认半径 64 内是空的。
			const nearby = await s.readBlocks("nether_portal", 64);
			if (nearby.length > 0) {
				throw new Error(`a portal is still within 64 blocks: ${JSON.stringify(nearby.slice(0, 3))}`);
			}
			return `overworld 41x41 stone at y=199, air 200..232, no portal within 64`;
		});

		await s.step("no obsidian and no flint → MISSING_MATERIAL", async () => {
			await s.command(`/clear ${USER}`);
			await reset({ x: CENTER.x + 0.5, y: CENTER.y, z: CENTER.z + 0.5 });
			const before = (await s.readSelf()).place.dimension;
			const result = await s.call(
				"transit@1",
				{ destination: { dimension: "minecraft:the_nether" }, maxTimeMs: CALL_BUDGET_MS },
				CALL_TIMEOUT_MS,
			);
			if (result.ok) throw new Error(`expected a failure without materials, got ${JSON.stringify(result.value)}`);
			if (result.code !== "MISSING_MATERIAL") throw new Error(`expected MISSING_MATERIAL, got ${result.code}`);
			if (!(result.message ?? "").includes("14")) throw new Error(`message lost the cost: ${result.message}`);
			const after = (await s.readSelf()).place.dimension;
			if (after !== before) throw new Error(`dimension changed on a failed call: ${before} -> ${after}`);
			return `${result.code}: ${result.message}`;
		});

		await s.step("build 14 obsidian, light it, walk in, land in the nether", async () => {
			await s.command(`/give ${USER} minecraft:obsidian 14`);
			await s.command(`/give ${USER} minecraft:flint_and_steel 1`);
			await sleep(300);
			const started = Date.now();
			const value = valueOf<TransitValue>(
				await s.call(
					"transit@1",
					{ destination: { dimension: "minecraft:the_nether" }, maxTimeMs: CALL_BUDGET_MS },
					CALL_TIMEOUT_MS,
				),
			);
			const elapsed = Date.now() - started;
			const portal = value.stages.find((stage) => stage.kind === "portal");
			if (portal?.reason == null || !portal.reason.includes("built")) {
				throw new Error(`expected a freshly built portal, got ${JSON.stringify(portal)}`);
			}
			if (!portal.reason.includes("14")) throw new Error(`only part of the frame was placed: ${portal.reason}`);
			const self = await s.readSelf();
			if (dim(self.place.dimension) !== "the_nether") throw new Error(`self still reports ${self.place.dimension}`);
			if (value.dimension !== "the_nether") throw new Error(`reported dimension ${value.dimension}`);
			const here = await s.readBlocks("nether_portal", 32);
			if (here.length === 0) throw new Error("no portal block around the landing point in the nether");
			const pos = await serverPos();
			return `${portal.reason} in ${elapsed}ms; nether (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}), ${here.length} portal blocks nearby`;
		});

		await s.step("walk back through the nether-side portal and reuse it", async () => {
			const started = Date.now();
			const value = valueOf<TransitValue>(
				await s.call(
					"transit@1",
					{ destination: { dimension: "minecraft:overworld" }, maxTimeMs: CALL_BUDGET_MS },
					CALL_TIMEOUT_MS,
				),
			);
			const elapsed = Date.now() - started;
			const portal = value.stages.find((stage) => stage.kind === "portal");
			if (portal?.reason !== "found")
				throw new Error(`expected the existing portal to be reused, got ${JSON.stringify(portal)}`);
			const self = await s.readSelf();
			if (dim(self.place.dimension) !== "overworld") throw new Error(`self still reports ${self.place.dimension}`);
			const pos = await serverPos();
			// 1:8 链接 + 传送门搜索半径：回到原址附近而不是另一块大陆。
			const drift = Math.hypot(pos.x - CENTER.x, pos.z - CENTER.z);
			if (drift > 32) throw new Error(`came back ${drift.toFixed(1)} blocks away from the build site`);
			return `found + entered in ${elapsed}ms; back at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}), ${drift.toFixed(1)} blocks off`;
		});

		await s.step("reuse the overworld-side portal for a second trip", async () => {
			const started = Date.now();
			const value = valueOf<TransitValue>(
				await s.call(
					"transit@1",
					{ destination: { dimension: "minecraft:the_nether" }, maxTimeMs: CALL_BUDGET_MS },
					CALL_TIMEOUT_MS,
				),
			);
			const elapsed = Date.now() - started;
			const portal = value.stages.find((stage) => stage.kind === "portal");
			if (portal?.reason !== "found") throw new Error(`expected reuse, got ${JSON.stringify(portal)}`);
			const self = await s.readSelf();
			if (dim(self.place.dimension) !== "the_nether") throw new Error(`self still reports ${self.place.dimension}`);
			const pos = await serverPos();
			return `found + entered in ${elapsed}ms; nether (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
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
