/**
 * G31 探针：下行阶梯走廊第一段走不动（`dev:mc:spatial` 两条 tunnel 步）。
 *
 * 只回答一个问题：**客户端读到的方块和服务端说的一致吗？**
 *
 * 场景按 `dev/spatial.ts` 的 S3 原样重放（同坐标、同 fill、同 tp）。走廊本身仍交给
 * `tunnel@1` 走正式能力面；探针不做替代执行，只在失败后对拍两侧读数：
 * 1. `region@1` 一次读回整盒（客户端视图，含 palette 与 xzy 索引）；
 * 2. 对客户端报 air 的走廊中心线格，逐格 `/execute if block ... air` 问服务端；
 * 3. 打印不一致清单 + 卡住时的实际站位与脚下三格。
 *
 * 判据：只要出现"客户端 air / 服务端 stone"，缓存滞后成立，G31 归到读前复核；
 * 若全部一致，则问题在走廊计划或走位本身，回到 planner/stepTo 那一侧。
 *
 * 用法：`pnpm dev:mc:corridor-probe`
 */

import type { BlockStateValue } from "../contracts/body.js";
import type { Vec3 } from "../contracts/values.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, waitForStill } from "./harness.js";
import { makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9500, y: 200, z: 9500 };
const X0 = CENTER.x + 15;
const Z0 = CENTER.z;

interface RegionValue {
	origin: Vec3;
	shape: [number, number, number];
	palette: BlockStateValue[];
	cells: number[];
	missing: number;
}

function nameAt(value: RegionValue, at: Vec3): string | null {
	const [nx, , nz] = value.shape;
	const ix = at.x - value.origin.x;
	const iy = at.y - value.origin.y;
	const iz = at.z - value.origin.z;
	if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iz >= nz || iy >= value.shape[1]) return null;
	const index = iy * nx * nz + iz * nx + ix;
	const paletteIndex = value.cells[index];
	if (paletteIndex == null || paletteIndex < 0) return null;
	return value.palette[paletteIndex]?.name ?? null;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-corridor-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:corridor-${Date.now()}` };
	const h = await openHarness("corridor-probe", { dataRoot, binding });
	const s = makeScenario(h, "corridor-probe");
	try {
		// —— 与 dev/spatial.ts 的 S3 完全同构 ——
		await s.command(`/gamemode creative ${USER}`);
		await s.command(`/fill ${X0} 196 ${Z0 - 2} ${X0 + 12} 204 ${Z0 + 2} minecraft:stone`);
		await s.command(`/setblock ${X0 + 2} 201 ${Z0} minecraft:gravel`);
		await s.command(`/setblock ${X0 + 2} 202 ${Z0} minecraft:gravel`);
		await s.command(`/fill ${X0} 200 ${Z0} ${X0} 201 ${Z0} minecraft:air`);
		await s.command(`/tp ${USER} ${X0 + 0.5} 200.1 ${Z0 + 0.5}`);
		await s.command(`/clear ${USER}`);
		await s.command(`/give ${USER} minecraft:iron_pickaxe 1`);
		await s.command(`/effect give ${USER} minecraft:instant_health 1 25 true`);
		await s.command(`/effect give ${USER} minecraft:saturation 1 10 true`);
		await s.command(`/gamemode survival ${USER}`);
		await waitForStill(h.bot, h.log);

		const result = await s.call("tunnel@1", { to: { x: X0 + 8, y: 196, z: Z0 }, maxTimeMs: 150000 }, 240000);
		console.log(`tunnel: ok=${result.ok} code=${result.ok ? "-" : result.code}`);
		if (!result.ok) console.log(`  message: ${result.message ?? ""}`);
		if (result.value !== undefined) console.log(`  value: ${JSON.stringify(result.value).slice(0, 1200)}`);

		// —— 卡住时的站位（服务端权威） ——
		const self = await s.readSelf();
		console.log(
			`client pos (${self.place.position.x.toFixed(2)}, ${self.place.position.y.toFixed(2)}, ${self.place.position.z.toFixed(2)}) onGround=${String(self.onGround)}`,
		);

		// —— 整盒一次读回（客户端视图） ——
		const box = { from: { x: X0, y: 195, z: Z0 - 2 }, to: { x: X0 + 12, y: 202, z: Z0 + 2 } };
		const observation = await h.world.read<RegionValue>({ ref: "region@1", input: box });
		if (observation.value == null) throw new Error(`region read failed: ${observation.unknown.join("; ")}`);
		const region = observation.value;

		// —— 走廊中心线：客户端报 air 的格，逐格问服务端 ——
		const suspects: Vec3[] = [];
		for (let x = X0; x <= X0 + 12; x += 1) {
			for (let y = 196; y <= 201; y += 1) {
				const at = { x, y, z: Z0 };
				if (nameAt(region, at) === "air") suspects.push(at);
			}
		}
		console.log(
			`client view: ${suspects.length} air cell(s) on the corridor centreline (x ${X0}..${X0 + 12}, y 196..201)`,
		);

		const divergent: { at: Vec3; client: string; server: string }[] = [];
		// 只抽样问服务端：全问会拖成几分钟。取前 24 个，足够判断是否成片。
		for (const at of suspects.slice(0, 24)) {
			const isAir = await s.serverBlock(at, "air");
			if (!isAir) divergent.push({ at, client: "air", server: "not air" });
		}
		console.log(`server cross-check: ${Math.min(24, suspects.length)} sampled, ${divergent.length} divergent`);
		for (const entry of divergent)
			console.log(
				`  DIVERGENT (${entry.at.x},${entry.at.y},${entry.at.z}) client=${entry.client} server=${entry.server}`,
			);

		// —— 卡住位置脚下三格两侧对照 ——
		const feet = {
			x: Math.floor(self.place.position.x),
			y: Math.floor(self.place.position.y),
			z: Math.floor(self.place.position.z),
		};
		console.log(`around the bot at (${feet.x},${feet.y},${feet.z}):`);
		for (const offset of [
			{ dy: -1, label: "below" },
			{ dy: 0, label: "feet" },
			{ dy: 1, label: "head" },
			{ dy: 2, label: "above head" },
		]) {
			const at = { x: feet.x, y: feet.y + offset.dy, z: feet.z };
			const clientName = nameAt(region, at) ?? "(outside box)";
			const serverAir = await s.serverBlock(at, "air");
			console.log(`  ${offset.label.padEnd(11)} client=${clientName} server=${serverAir ? "air" : "solid"}`);
		}

		console.log(
			divergent.length > 0 ? "VERDICT: client cache is stale after the bulk /fill" : "VERDICT: both sides agree",
		);
	} finally {
		await closeHarness(h);
	}
}

await main();
