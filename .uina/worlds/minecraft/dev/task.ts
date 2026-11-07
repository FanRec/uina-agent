/**
 * 任务级基线：在真实世界里跑完整任务，终态由服务端判决。
 *
 * 存在的理由（development-plan.md §10.3 批34）：现有 34 个真服脚本都是模块级门，
 * 模块门可以同时全绿而整体表现不明。本文件提供一条与机制实现无关的口径：
 * 同一段 Program 在固定竞技场里从零完成一件事，通过与否只看世界变了什么。
 *
 * 三条纪律：
 * 1. 准备与断言在宿主，被测程序只做玩法动作——程序不能自己宣布成功。
 * 2. 预算只覆盖执行段；超时显式 stop，不让 tunnel/build 在断言期继续改世界。
 * 3. 失败必须可归因：带失败码、步名、位置与本轮库存，不写"失败了"。
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue, Vec3 } from "../contracts/values.js";
import { closeHarness, type DevHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type Scenario, makeScenario } from "./scenario.js";
import { MINE_PROGRAM, NIGHT_PROGRAM, SHELTER_PROGRAM } from "./task-programs.js";

const USER = process.env.MC_DEV_USER ?? "UinaDev";
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/** 竞技场：避开既有场景区（9500–9850、16000），全部几何由 op 指令生成，不依赖自然地形与种子。 */
const SHELTER = {
	platform: { x1: 11994, y: 200, z1: 11992, x2: 12012, z2: 12012 },
	base: { x: 12000, y: 201, z: 12002 },
	stand: { x: 12001.5, y: 201, z: 11999.5 },
	/** 四格原木竖柱：够 12 个原木，且不挡屋体与站位。 */
	trees: [
		{ x: 11997, y: 201, z: 11995 },
		{ x: 12007, y: 201, z: 11995 },
		{ x: 12009, y: 201, z: 12008 },
	],
};
const MINE = {
	body: { x1: 12040, y1: 180, z1: 11996, x2: 12055, y2: 200, z2: 12011 },
	start: { x: 12040.5, y: 201, z: 12000.5 },
	// 洞室 3 格净空。批34 实测：2 格净空 + 紧邻 1 格踏步是无解几何——起跳被
	// 腔顶削顶（脚只能抬 0.2 格），退到 1.23 格处起跳时身体又会探进 2 格列里。
	// 那不是被测能力，是场景把人锁死，所以洞室按玩家挖矿会留的高度给到 3 格。
	cavity: { x1: 12050, y1: 191, z1: 11999, x2: 12052, y2: 193, z2: 12001 },
	// tunnel 的终点地板：保持石头。曾是 iron_ore——tunnel 会把它当走廊挖掉，
	// 掉落物污染 collect 的计数起点。
	vein: { x: 12050, y: 191, z: 12000 },
	// 矿石格必须避开回程阶梯动线（z=12000、x=12040..12050 的 1:1 下行阶梯）：
	// 阶梯列地板下方的踏步块被 collect 挖掉 = 回程楼梯口被自己斩首（批34 探针实证，
	// 6 轮 returned 全挂的根因之一）。矿石集中在洞室东壁与南侧壁龛。
	ore: [
		{ x: 12053, y: 191, z: 12000 },
		{ x: 12053, y: 192, z: 12000 },
		{ x: 12054, y: 191, z: 12000 },
		{ x: 12049, y: 192, z: 12001 },
	],
};
const NIGHT = {
	platform: { x1: 12064, y: 200, z1: 12044, x2: 12096, z2: 12076 },
	center: { x: 12080.5, y: 201, z: 12060.5 },
	window: 60_000,
	lowHealth: 12,
	radius: 24,
	ringDistance: 13,
};

interface AssertionResult {
	name: string;
	ok: boolean;
	detail: string;
	/** true = 判决来自服务端回执，false = 来自客户端事实（都写明来源）。 */
	server: boolean;
}

interface ProgramRun {
	ok: boolean;
	code?: string;
	message?: string;
	value?: JsonValue;
	run: string;
	/** 失败时的调用记录摘录：带 code/message/hint/progress 与 guest console 尾，用于归因。 */
	raw?: string;
}

interface TaskDef {
	id: "shelter" | "mine" | "night";
	budgetMs: number;
	source: string;
	input: JsonValue;
	prepare: (s: Scenario, h: DevHarness) => Promise<void>;
	assert: (s: Scenario, program: ProgramRun, startPos: Vec3 | null) => Promise<AssertionResult[]>;
}

const argOf = (name: string): string | undefined => {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
};

function runProgram(
	h: DevHarness,
	requestId: string,
	source: string,
	input: JsonValue,
	budgetMs: number,
): Promise<ProgramRun> {
	return (async () => {
		const acceptance = await h.runtime.submit(
			{ worldOwner: h.worldOwner, activation: h.activation },
			{ requestId, entry: { kind: "program", source: { code: source }, input }, schedule: { kind: "enqueue" } },
		);
		if (acceptance.kind !== "accepted") {
			return { ok: false, code: "REJECTED", message: JSON.stringify(acceptance).slice(0, 800), run: "-" };
		}
		const run = acceptance.snapshot.run;
		const reply = await h.runtime.wait(run, { timeoutMs: budgetMs });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
			// 验收脚本放弃这个步骤时显式停自己的 Run：否则 tunnel/build 会在断言期继续改世界。
			await h.runtime.stop({ requestId: `stop:${requestId}`, target: { run } });
			return { ok: false, code: "TIMEOUT", message: reply.kind, run };
		}
		if (reply.snapshot.outcome !== "succeeded") {
			let detail = reply.snapshot.error?.message ?? "";
			let raw: string | undefined;
			try {
				const failed = await h.runtime.readRecord(reply.snapshot.record);
				if (failed.kind === "inline") {
					const value = failed.record.value as {
						error?: { code?: string; message?: string; hint?: string; progress?: unknown };
						progress?: unknown;
						consoleTail?: string;
					};
					raw = JSON.stringify(value).slice(0, 4000);
					if (value.error != null) {
						detail = [value.error.code, value.error.message, value.error.hint].filter(Boolean).join(" | ");
					}
				}
			} catch {
				/* 记录读不出：保持错误面 */
			}
			return {
				ok: false,
				code: reply.snapshot.error?.code ?? reply.snapshot.outcome,
				message: detail,
				run,
				raw,
			};
		}
		const full = await h.runtime.readRecord(reply.snapshot.record);
		const value = full.kind === "inline" ? (full.record.value as { value?: JsonValue }).value : undefined;
		return { ok: true, value, run };
	})();
}

const ok = (name: string, detail: string, server = true): AssertionResult => ({ name, ok: true, detail, server });
const bad = (name: string, detail: string, server = true): AssertionResult => ({ name, ok: false, detail, server });

function horizontal(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 3×3 木屋：14 格木板墙 + 1 扇门 + 9 格屋顶；门的上半由服务端补，不声明。 */
function shelterCells(
	base: Vec3,
): { at: Vec3; block: string | { name: string; properties: Record<string, string> } }[] {
	const cells: { at: Vec3; block: string | { name: string; properties: Record<string, string> } }[] = [];
	const perimeter: [number, number][] = [
		[0, 0],
		[1, 0],
		[2, 0],
		[0, 1],
		[2, 1],
		[0, 2],
		[1, 2],
		[2, 2],
	];
	for (const dy of [0, 1]) {
		for (const [dx, dz] of perimeter) {
			const at = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
			if (dx === 1 && dz === 0) {
				if (dy === 0) cells.push({ at, block: { name: "oak_door", properties: { half: "lower" } } });
				continue;
			}
			cells.push({ at, block: "oak_planks" });
		}
	}
	for (let dx = 0; dx < 3; dx++) {
		for (let dz = 0; dz < 3; dz++)
			cells.push({ at: { x: base.x + dx, y: base.y + 2, z: base.z + dz }, block: "oak_planks" });
	}
	return cells;
}

async function clearRegion(s: Scenario, from: Vec3, to: Vec3): Promise<void> {
	await s.command(`/fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} minecraft:air`);
}

async function killHostiles(s: Scenario): Promise<void> {
	for (const mob of ["zombie", "husk", "drowned", "skeleton", "creeper", "spider", "witch", "slime"]) {
		await s.command(`/kill @e[type=minecraft:${mob}]`);
	}
	await s.command("/kill @e[type=minecraft:item]");
}

const tasks: TaskDef[] = [
	{
		id: "shelter",
		budgetMs: 240_000,
		source: SHELTER_PROGRAM,
		input: {
			trees: SHELTER.trees,
			logs: 12,
			planks: 48,
			doors: 3,
			stand: SHELTER.stand,
			cells: shelterCells(SHELTER.base),
			buildMs: 180_000,
		} as unknown as JsonValue,
		prepare: async (s, h) => {
			const p = SHELTER.platform;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${SHELTER.stand.x} ${SHELTER.stand.y} ${SHELTER.stand.z}`);
			// 区块未加载时 /fill 静默失败；先确认锚点可读再建。
			for (let i = 0; i < 40; i++) {
				if ((await s.readBlock({ x: p.x1, y: p.y, z: p.z1 })) != null) break;
				await sleep(300);
			}
			await s.command(`/difficulty peaceful`);
			await s.command(`/gamerule doMobSpawning false`);
			await s.command(`/gamerule doDaylightCycle false`);
			await s.command(`/time set day`);
			await killHostiles(s);
			await s.command(`/fill ${p.x1} ${p.y} ${p.z1} ${p.x2} ${p.y} ${p.z2} minecraft:stone`);
			await clearRegion(s, { x: p.x1, y: p.y + 1, z: p.z1 }, { x: p.x2, y: p.y + 8, z: p.z2 });
			for (const tree of SHELTER.trees) {
				await s.command(`/fill ${tree.x} ${tree.y} ${tree.z} ${tree.x} ${tree.y + 3} ${tree.z} minecraft:oak_log`);
			}
			await s.command(`/clear ${USER}`);
			await s.command(`/gamemode survival ${USER}`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await s.command(`/tp ${USER} ${SHELTER.stand.x} ${SHELTER.stand.y} ${SHELTER.stand.z}`);
			await waitForStill(h.bot, s.log);
		},
		assert: async (s, _program) => {
			const results: AssertionResult[] = [];
			const cells = shelterCells(SHELTER.base);
			let wrong = 0;
			const firstWrong: string[] = [];
			for (const cell of cells) {
				const name = typeof cell.block === "string" ? cell.block : cell.block.name;
				if (await s.serverBlock(cell.at, name)) continue;
				wrong++;
				if (firstWrong.length < 3) firstWrong.push(`${name}@${cell.at.x},${cell.at.y},${cell.at.z}`);
			}
			results.push(
				wrong === 0
					? ok("structure", `${cells.length}/${cells.length} cells match on the server`)
					: bad("structure", `${wrong}/${cells.length} cells wrong; first: ${firstWrong.join(" ")}`),
			);
			const interior: { at: Vec3; air: boolean }[] = [];
			for (const dy of [0, 1]) {
				const at = { x: SHELTER.base.x + 1, y: SHELTER.base.y + dy, z: SHELTER.base.z + 1 };
				interior.push({ at, air: await s.serverBlock(at, "air") });
			}
			results.push(
				interior.every((cell) => cell.air)
					? ok("interior", "both interior cells are air")
					: bad("interior", `interior blocked: ${JSON.stringify(interior)}`),
			);
			const inventory = await s.serverInventory(USER);
			const door = inventory.counts.oak_door ?? 0;
			const planks = inventory.counts.oak_planks ?? 0;
			const surplusDetail = `oak_door=${door} oak_planks=${planks} (${inventory.source})${inventory.raw ? ` raw=${inventory.raw}` : ""}`;
			results.push(
				door >= 2 && planks >= 8
					? ok("surplus", surplusDetail, inventory.source === "server")
					: bad("surplus", surplusDetail, inventory.source === "server"),
			);
			const pos = await s.serverPos(USER);
			const outside =
				pos != null &&
				Math.abs(pos.y - SHELTER.base.y) < 1.2 &&
				(pos.x < SHELTER.base.x - 0.4 ||
					pos.x > SHELTER.base.x + 2.4 ||
					pos.z < SHELTER.base.z - 0.4 ||
					pos.z > SHELTER.base.z + 2.4);
			results.push(
				outside
					? ok("outside", `standing at ${JSON.stringify(pos)}`)
					: bad("outside", `not outside the house: ${JSON.stringify(pos)}`),
			);
			return results;
		},
	},
	{
		id: "mine",
		budgetMs: 300_000,
		source: MINE_PROGRAM,
		input: {
			vein: MINE.vein,
			start: MINE.start,
			ore: 4,
			digMs: 170_000,
			returnMs: 45_000,
			surfaceMs: 90_000,
			walkMs: 30_000,
		},
		prepare: async (s, h) => {
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
			await killHostiles(s);
			await s.command(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:stone`);
			await clearRegion(s, { x: b.x1, y: b.y2 + 1, z: b.z1 }, { x: b.x2, y: b.y2 + 6, z: b.z2 });
			const c = MINE.cavity;
			await clearRegion(s, { x: c.x1, y: c.y1, z: c.z1 }, { x: c.x2, y: c.y2, z: c.z2 });
			for (const ore of MINE.ore) await s.command(`/setblock ${ore.x} ${ore.y} ${ore.z} minecraft:iron_ore`);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:stone_pickaxe 1`);
			await s.command(`/gamemode survival ${USER}`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await s.command(`/tp ${USER} ${MINE.start.x} ${MINE.start.y} ${MINE.start.z}`);
			await waitForStill(h.bot, s.log);
		},
		assert: async (s, _program, startPos) => {
			const results: AssertionResult[] = [];
			const pos = await s.serverPos(USER);
			const back =
				pos != null && startPos != null && horizontal(pos, startPos) <= 3 && pos.y >= 200.5 && pos.y <= 201.8;
			results.push(
				back
					? ok("returned", `server pos ${JSON.stringify(pos)}`)
					: bad("returned", `server pos ${JSON.stringify(pos)} vs start ${JSON.stringify(startPos)}`),
			);
			const inventory = await s.serverInventory(USER);
			const iron = inventory.counts.raw_iron ?? 0;
			const cobble = inventory.counts.cobblestone ?? 0;
			const haulDetail = `raw_iron=${iron} cobblestone=${cobble} (${inventory.source})${inventory.raw ? ` raw=${inventory.raw}` : ""}`;
			results.push(
				iron >= 4 && cobble >= 8
					? ok("haul", haulDetail, inventory.source === "server")
					: bad("haul", haulDetail, inventory.source === "server"),
			);
			// 矿体本身是否还在：四个矿石格是 prepare 打进去的，服务端确认变空气才算真挖掉。
			// 路线形状（阶梯还是竖井、有没有回填）不归任务判——那是 tunnel@1 自己的验收。
			const left: string[] = [];
			for (const at of MINE.ore) {
				if (!(await s.serverBlock(at, "air"))) left.push(`${at.x},${at.y},${at.z}`);
			}
			results.push(
				left.length === 0
					? ok("ore_gone", `${MINE.ore.length} ore cells are air on the server`)
					: bad("ore_gone", `still solid at ${left.join(" ")}`),
			);
			return results;
		},
	},
	{
		id: "night",
		budgetMs: 180_000,
		source: NIGHT_PROGRAM,
		input: {
			windowMs: NIGHT.window,
			lowHealth: NIGHT.lowHealth,
			radius: NIGHT.radius,
			fleeDistance: 24,
		},
		prepare: async (s, h) => {
			const p = NIGHT.platform;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${NIGHT.center.x} ${NIGHT.center.y} ${NIGHT.center.z}`);
			for (let i = 0; i < 40; i++) {
				if ((await s.readBlock({ x: p.x1, y: p.y, z: p.z1 })) != null) break;
				await sleep(300);
			}
			await s.command(`/difficulty normal`);
			await s.command(`/gamerule doMobSpawning false`);
			await s.command(`/gamerule doDaylightCycle false`);
			await s.command(`/time set midnight`);
			await killHostiles(s);
			await s.command(`/fill ${p.x1} ${p.y} ${p.z1} ${p.x2} ${p.y} ${p.z2} minecraft:stone`);
			await clearRegion(s, { x: p.x1, y: p.y + 1, z: p.z1 }, { x: p.x2, y: p.y + 10, z: p.z2 });
			await s.command(`/clear ${USER}`);
			for (const item of ["iron_sword", "shield", "iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"]) {
				await s.command(`/give ${USER} minecraft:${item} 1`);
			}
			await s.command(`/gamemode survival ${USER}`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await s.command(`/tp ${USER} ${NIGHT.center.x} ${NIGHT.center.y} ${NIGHT.center.z}`);
			await waitForStill(h.bot, s.log);
			for (const piece of ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"]) {
				const slot =
					piece === "iron_helmet"
						? "head"
						: piece === "iron_chestplate"
							? "chest"
							: piece === "iron_leggings"
								? "legs"
								: "feet";
				const equipped = await s.call("equip@1", { item: piece, slot });
				if (!equipped.ok) throw new Error(`equip ${piece} failed: ${equipped.code} ${equipped.message ?? ""}`);
			}
			for (let i = 0; i < 4; i++) {
				const angle = (Math.PI * 2 * i) / 4;
				const x = NIGHT.center.x + Math.cos(angle) * NIGHT.ringDistance;
				const z = NIGHT.center.z + Math.sin(angle) * NIGHT.ringDistance;
				await s.command(`/summon minecraft:zombie ${x.toFixed(2)} ${NIGHT.center.y} ${z.toFixed(2)}`);
			}
			await sleep(800);
		},
		assert: async (s) => {
			const results: AssertionResult[] = [];
			const cleared = await s.serverProbe(
				`/execute if entity @e[type=minecraft:zombie,distance=..${NIGHT.radius},limit=1]`,
			);
			results.push(
				cleared
					? bad("cleared", `zombies still within ${NIGHT.radius}`)
					: ok("cleared", `no zombie within ${NIGHT.radius}`),
			);
			const vitals = await s.serverHealth(USER);
			const alive = vitals.health != null && vitals.health >= 8;
			results.push(
				alive
					? ok("health", `health=${vitals.health} food=${vitals.food}`)
					: bad("health", `health=${vitals.health} food=${vitals.food}`),
			);
			return results;
		},
	},
];

function gitState(): { rev: string; dirty: boolean } {
	try {
		const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
		const status = execFileSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" }).trim();
		return { rev, dirty: status.length > 0 };
	} catch {
		return { rev: "unknown", dirty: false };
	}
}

async function runTask(def: TaskDef, batch: string, round: number, git: { rev: string; dirty: boolean }) {
	const dataRoot = mkdtempSync(join(tmpdir(), `uina-mc-task-${def.id}-`));
	const h = await openHarness(`task-${def.id}`, {
		dataRoot,
		binding: { world: "world:paper-bench", worldRevision: `revision:task-${def.id}-${Date.now()}` },
	});
	const s = makeScenario(h, `task-${def.id}`);
	const dir = resolve(repoRoot, ".uina", "world-data", "minecraft", "task-runs", batch);
	let startPos: Vec3 | null = null;
	let endPos: Vec3 | null = null;
	let endInventory: Record<string, number> = {};
	let trace: { ms: number; pos: Vec3 | null }[] = [];
	let assertions: AssertionResult[] = [];
	let program: ProgramRun = { ok: false, code: "NOT_RUN", run: "-" };
	let elapsedMs = 0;
	let deathCursor: string | null = null;
	try {
		deathCursor = await s.eventCursor(["death"]);
		await def.prepare(s, h);
		startPos = await s.serverPos(USER);
		const t0 = performance.now();
		// 位置轨迹：走客户端事实（本地投影，不发指令），只用来区分"来回振荡"与"原地不动"；
		// 终态判决仍走 serverPos。3s 一次对执行几乎没有干扰。
		const sampler = setInterval(() => {
			void s
				.readSelf()
				.then((self) => trace.push({ ms: Math.round(performance.now() - t0), pos: self.place.position }))
				.catch(() => {});
		}, 3000);
		try {
			program = await runProgram(h, `req:task-${def.id}-${Date.now()}`, def.source, def.input, def.budgetMs);
		} finally {
			clearInterval(sampler);
		}
		elapsedMs = Math.round(performance.now() - t0);
		endPos = await s.serverPos(USER);
		// 归因用的最终库存走客户端事实（一次读取，不发指令）；判决用的库存另走服务端。
		endInventory = (await s.readInventory()).counts;
		assertions = await def.assert(s, program, startPos);
	} catch (error) {
		// 准备或断言环节异常也要落记录：一条出错的任务不该让整批没有数据。
		assertions.push(bad("harness", error instanceof Error ? error.message : String(error), false));
	}
	try {
		const deaths = (await s.eventsSince(deathCursor, ["death"])).events.length;
		assertions.push(
			deaths === 0
				? ok("no_death", "no death event since the run started")
				: bad("no_death", `${deaths} death event(s)`),
		);
	} catch (error) {
		assertions.push(bad("no_death", `unreadable: ${error instanceof Error ? error.message : String(error)}`, false));
	}
	if (!program.ok) assertions.unshift(bad("program", `${program.code}: ${program.message ?? ""}`.slice(0, 600)));
	const reportedMs = (program.value as { ms?: number } | undefined)?.ms;
	const timingTrusted = reportedMs == null || reportedMs <= elapsedMs * 1.1;
	const failed = assertions.find((entry) => !entry.ok);
	const record = {
		schema: "uina.mc.task-run@1",
		task: def.id,
		batch,
		round,
		pass: failed == null,
		elapsedMs,
		budgetMs: def.budgetMs,
		program: {
			ok: program.ok,
			code: program.code ?? null,
			run: program.run,
			value: program.value ?? null,
			raw: program.raw ?? null,
		},
		assertions,
		failure: failed == null ? null : { name: failed.name, detail: failed.detail },
		world: { startPos, endPos, endInventory, level: "bench", trace },
		timingTrusted,
		git,
	};
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${def.id}-r${round}.json`), `${JSON.stringify(record, null, "\t")}\n`);
		appendFileSync(
			join(dir, "summary.jsonl"),
			`${JSON.stringify({
				batch,
				round,
				task: def.id,
				pass: record.pass,
				elapsedMs,
				program: program.ok ? "ok" : (program.code ?? "failed"),
				failed: failed?.name ?? null,
				detail: failed?.detail ?? null,
			})}\n`,
		);
	} catch (error) {
		s.log(`record write failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const tag = record.pass ? "PASS" : "FAIL";
	s.log(`${tag} ${def.id} r${round} in ${elapsedMs}ms${failed == null ? "" : ` — ${failed.name}: ${failed.detail}`}`);
	for (const entry of assertions) s.log(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.name}: ${entry.detail}`);
	await closeHarness(h).catch((error: unknown) => s.log(`close failed: ${String(error)}`));
	return record.pass;
}

async function main(): Promise<void> {
	const wanted = argOf("--task") ?? "all";
	const rounds = Number(argOf("--rounds") ?? "1");
	const batch = argOf("--batch") ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const selected = wanted === "all" ? tasks : tasks.filter((task) => task.id === wanted);
	if (selected.length === 0)
		throw new Error(`unknown --task ${wanted}; expected all|${tasks.map((task) => task.id).join("|")}`);
	const git = gitState();
	console.log(
		`[mc-task] batch=${batch} rounds=${rounds} tasks=${selected.map((task) => task.id).join(",")} rev=${git.rev}`,
	);
	let failures = 0;
	for (let round = 1; round <= rounds; round++) {
		for (const task of selected) {
			console.log(`[mc-task] ---- ${task.id} round ${round}/${rounds}`);
			if (!(await runTask(task, batch, round, git))) failures++;
		}
	}
	console.log(
		`[mc-task] ${failures === 0 ? "ALL PASS" : `${failures} failing run(s)`}; records in .uina/world-data/minecraft/task-runs/${batch}`,
	);
	if (failures > 0) process.exitCode = 1;
}

await main();
