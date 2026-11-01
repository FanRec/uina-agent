/**
 * 批14 真服验收：蓝图与施工（build.plan / build / Raw→Target→Project）。
 *
 * 被测行为全部走正式能力面：动作经 Runtime submit，查询经 `world.read`（query 不提交成
 * 调用，Runtime 以 USE_MC_READ 明确拒绝）。op 指令只备地形与物品（平台、清空体积、给料），
 * 不代替任何被测动作。
 *
 * 断言用独立事实交叉核验：施工结果按 `region@1` 逐格统计 + 关键格 `block@1` 复读
 * （含门的 half、火把的名字），不用 build 自己的返回值证明它建对了。
 *
 * 蓝图原件用入库夹具 tests/mc/fixtures/house.schem（脚本生成，见
 * scripts/make-mc-schem-fixture.mjs）；`keep` 蓝图带 target.json，
 * 用来证明"已有 Target 用其明确语义、本次 airPolicy 不参与"与 preserve/unknown 的处理。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario, type CallResult } from "./scenario.js";

const USER = "UinaDev";
/** 地板在 y=CENTER.y，平台在 y-1。四个落点互不重叠，共用一个平台。 */
const CENTER = { x: 9600, y: 200, z: 9600 };
const SECOND = { x: 9608, y: 200, z: 9600 };
const THIRD = { x: 9600, y: 200, z: 9608 };
const KEEP = { x: 9596, y: 200, z: 9596 };
const PLATFORM = { x1: 9593, y: 199, z1: 9593, x2: 9615, z2: 9613 };
const SPAWN = { x: 9597.5, y: CENTER.y, z: 9602.5 };

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 夹具目录：源码入口在 `.uina/worlds/minecraft/dev/`，产物入口在 `dist/.uina/.../dev/`，
 * 两者的仓库根深度不同。向上找而不是写死相对层数，源码与产物才读同一份夹具。
 */
function fixturesDir(): string {
	let current = here;
	for (let depth = 0; depth < 8; depth++) {
		const candidate = join(current, "tests", "mc", "fixtures");
		if (existsSync(join(candidate, "house.schem"))) return candidate;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`fixtures directory not found above ${here}`);
}

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface RegionValue {
	origin: { x: number; y: number; z: number };
	shape: [number, number, number];
	palette: { name: string; properties: Record<string, string> }[];
	cells: number[];
	missing: number;
}

function countByName(region: RegionValue): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const index of region.cells) {
		if (index < 0) continue;
		const name = region.palette[index]!.name;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

interface PlanValue {
	blueprint?: { ref: string; digest: string };
	targets: { at: { x: number; y: number; z: number }; kind: string; block?: unknown; reason?: string }[];
	need: Record<string, number>;
	missing: Record<string, number>;
	blocked: { at: unknown; by: string }[];
	unreachable: { at: unknown }[];
	estTicks: number;
}

interface BuildValue {
	placed: number;
	cleared: number;
	skipped: number;
	remaining: unknown[];
	scaffoldsUsed: number;
	blueprint?: { ref: string; digest: string };
}

interface Failure {
	code?: string;
	message?: string;
	progress?: { placed?: number; remainingCount?: number } & Record<string, unknown>;
}

function kindsOf(plan: PlanValue): Record<string, number> {
	return plan.targets.reduce<Record<string, number>>((counts, cell) => {
		counts[cell.kind] = (counts[cell.kind] ?? 0) + 1;
		return counts;
	}, {});
}

function keepTargetJson(anchor: { x: number; y: number; z: number }): string {
	const at = (dx: number, dy: number, dz: number) => [anchor.x + dx, anchor.y + dy, anchor.z + dz];
	return JSON.stringify({
		schema: "minecraft:construction.target@1",
		cells: [
			{ at: at(0, 0, 0), kind: "set", block: "glass" },
			{ at: at(1, 0, 0), kind: "set", block: "glass" },
			{ at: at(2, 0, 0), kind: "clear" },
			{ at: at(0, 0, 1), kind: "preserve" },
			{ at: at(1, 0, 1), kind: "unknown", reason: "design source was unreadable" },
			{ at: at(2, 0, 1), kind: "set", block: "glass" },
		],
	});
}

interface CallFailureRecord {
	code?: string;
	message?: string;
	progress?: { placed?: number; remainingCount?: number } & Record<string, unknown>;
}

/**
 * RunSummary 的 error 只带 code/message；hint/progress 只在调用记录里
 * （dev/MC-WORLD.md 的契约现状）。要看进度就必须读失败的调用记录。
 */
async function failedCallOf(
	h: Awaited<ReturnType<typeof openHarness>>,
	run: string,
): Promise<{ error?: CallFailureRecord }> {
	const calls = await h.runtime.listCalls(run);
	for (const item of calls.items) {
		const full = await h.runtime.readRecord(item.record);
		if (full.kind !== "inline") continue;
		const record = full.record.value as { error?: CallFailureRecord };
		if (record.error != null) return record;
	}
	return {};
}

/**
 * 跑一次 build 并结算；失败时把调用记录里的 `progress.remaining` 逐格原因并进错误信息——
 * "29 格没对上"没有解释力，模型与开发者需要的都是"哪些格、为什么"。
 */
async function runBuild(
	h: Awaited<ReturnType<typeof openHarness>>,
	s: ReturnType<typeof makeScenario>,
	input: JsonValue,
	timeoutMs: number,
): Promise<BuildValue> {
	const spawned = await s.spawn("build@1", input);
	const reply = await h.runtime.wait(spawned.run, { timeoutMs });
	if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
		await h.runtime.stop({ requestId: `stop:${spawned.requestId}`, target: { run: spawned.run } });
		throw new Error(`build did not finish: ${reply.kind}`);
	}
	if (reply.snapshot.outcome !== "succeeded") {
		const failed = await failedCallOf(h, spawned.run);
		const progress = failed.error?.progress as { remaining?: unknown[]; placed?: number } | undefined;
		const detail = JSON.stringify(progress?.remaining ?? []).slice(0, 1200);
		throw new Error(`${failed.error?.code}: ${failed.error?.message} [placed ${progress?.placed ?? 0}] ${detail}`);
	}
	const full = await h.runtime.readRecord(reply.snapshot.record);
	if (full.kind !== "inline") throw new Error("expected inline development record");
	return (full.record.value as unknown as { value: BuildValue }).value;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-build-"));
	const fixtureDir = fixturesDir();
	const fixture = readFileSync(join(fixtureDir, "house.schem"));
	const variant = readFileSync(join(fixtureDir, "house-v2.schem"));

	// 蓝图先落盘：Library 只登记字节，解释归 Construction（场景不替它做转换）。
	for (const name of ["house", "second", "third", "keep"]) {
		mkdirSync(join(dataRoot, "blueprints", name), { recursive: true });
		copyFileSync(join(fixtureDir, "house.schem"), join(dataRoot, "blueprints", name, "design.schem"));
	}
	writeFileSync(join(dataRoot, "blueprints", "keep", "target.json"), keepTargetJson(KEEP), "utf8");

	const binding = { world: "world:paper-dev", worldRevision: `revision:build-${Date.now()}` };
	const h = await openHarness("build", { dataRoot, binding });
	const s = makeScenario(h, "build");
	const readPlan = async (name: string, at: { x: number; y: number; z: number }): Promise<PlanValue> => {
		const observation = await h.world.read<PlanValue>({
			ref: "build.plan@1",
			input: { from: { kind: "blueprint", name }, at, airPolicy: "preserve" } as JsonValue,
		});
		if (observation.value == null) throw new Error(`build.plan ${name} returned no value`);
		return observation.value;
	};
	const readRegion = async (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => {
		const observation = await h.world.read<RegionValue>({ ref: "region@1", input: { from, to } as JsonValue });
		if (observation.value == null) throw new Error("region@1 returned no value");
		return observation.value;
	};
	const buildInput = (name: string, at: { x: number; y: number; z: number }, extra: JsonValue = {}): JsonValue => ({
		from: { kind: "blueprint", name },
		at,
		airPolicy: "preserve",
		...(extra as Record<string, JsonValue>),
	});

	try {
		await s.step("prepare platform and gear, stage blueprints", async () => {
			// 先创造模式再 teleport：生存模式落进未加载区块会摔死（批13 经验 24 的变体）。
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/tp ${USER} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
			const deadline = Date.now() + 20000;
			for (;;) {
				if ((await s.readBlock({ x: PLATFORM.x1 + 1, y: PLATFORM.y, z: PLATFORM.z1 + 1 })) != null) break;
				if (Date.now() >= deadline) throw new Error("test-area chunk never became observable");
				await sleep(300);
			}
			await s.command(
				`/fill ${PLATFORM.x1} ${PLATFORM.y} ${PLATFORM.z1} ${PLATFORM.x2} ${PLATFORM.y} ${PLATFORM.z2} minecraft:stone`,
			);
			await s.command(
				`/fill ${PLATFORM.x1} ${CENTER.y} ${PLATFORM.z1} ${PLATFORM.x2} ${CENTER.y + 6} ${PLATFORM.z2} minecraft:air`,
			);
			await s.command(`/tp ${USER} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
			await s.command(`/clear ${USER}`);
			await s.command(`/kill @e[type=minecraft:item]`);
			// 部分备料：下面的 build 必须因缺料被拒绝，而不是先动手再报错。
			await s.command(`/give ${USER} minecraft:oak_planks 40`);
			await s.command(`/give ${USER} minecraft:oak_door 1`);
			await s.command(`/give ${USER} minecraft:wooden_pickaxe 1`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 25 true`);
			await s.command(`/effect give ${USER} minecraft:saturation 1 10 true`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, s.log);
			const self = await s.readSelf();
			const below = await s.readBlock({ x: Math.floor(SPAWN.x), y: PLATFORM.y, z: Math.floor(SPAWN.z) });
			if (Math.abs(self.place.position.y - CENTER.y) > 2 || below?.name !== "stone") {
				throw new Error(`bot not on the platform: y=${self.place.position.y} below=${below?.name ?? "null"}`);
			}
			// /fill 失败只回聊天错误：抽样复核填充结果（批12 经验 24）。
			const corner = await s.readBlock({ x: PLATFORM.x2, y: PLATFORM.y, z: PLATFORM.z2 });
			if (corner?.name !== "stone") throw new Error(`platform corner is ${corner?.name ?? "missing"}`);
			return `platform ${PLATFORM.x2 - PLATFORM.x1 + 1}x${PLATFORM.z2 - PLATFORM.z1 + 1}, fixture ${fixture.length}B`;
		});

		await s.step("build.plan on a raw .schem: digest, kinds, need", async () => {
			const plan = await readPlan("house", CENTER);
			if (plan.blueprint?.digest !== sha256(fixture)) {
				throw new Error(`digest ${plan.blueprint?.digest} != sha256(design.schem)`);
			}
			const kinds = kindsOf(plan);
			if (kinds.set !== 74) throw new Error(`expected 74 set targets, got ${JSON.stringify(kinds)}`);
			if (kinds.preserve !== 26) throw new Error(`expected 26 preserve targets, got ${JSON.stringify(kinds)}`);
			if (plan.need.oak_planks !== 71) throw new Error(`need.oak_planks ${plan.need.oak_planks} != 71`);
			if (plan.estTicks <= 0) throw new Error("estTicks must be positive");
			return `targets ${JSON.stringify(kinds)}, need ${JSON.stringify(plan.need)}, missing ${JSON.stringify(plan.missing)}`;
		});

		await s.step("build without material: MISSING_MATERIAL before any block moves", async () => {
			const plan = await readPlan("house", CENTER);
			// 只给了 40 木板 / 1 门 / 0 火把，缺口必须等于 need 减实有。
			const expected = {
				oak_planks: plan.need.oak_planks - 40,
				oak_door: plan.need.oak_door - 1,
				torch: plan.need.torch,
			};
			for (const [name, count] of Object.entries(expected)) {
				if (plan.missing[name] !== count) {
					throw new Error(`missing.${name} ${plan.missing[name]} != ${count} (plan ${JSON.stringify(plan.missing)})`);
				}
			}
			for (const name of Object.keys(plan.missing)) {
				if (!(name in expected)) throw new Error(`unexpected missing entry ${name}`);
			}
			const result = await s.call("build@1", buildInput("house", CENTER));
			if (result.ok) throw new Error("build should refuse without material");
			if (result.code !== "MISSING_MATERIAL") throw new Error(`expected MISSING_MATERIAL, got ${result.code}`);
			const corner = await s.readBlock(CENTER);
			if (corner != null && corner.name !== "air") throw new Error(`build moved a block: ${corner.name} at origin`);
			return `missing ${JSON.stringify(plan.missing)}`;
		});

		await s.step("give the rest: plan reports no gap and no conflict", async () => {
			await s.command(`/give ${USER} minecraft:oak_planks 300`);
			await s.command(`/give ${USER} minecraft:oak_door 8`);
			await s.command(`/give ${USER} minecraft:torch 8`);
			await s.command(`/give ${USER} minecraft:glass 16`);
			await s.command(`/give ${USER} minecraft:cobblestone 8`);
			await sleep(400);
			const plan = await readPlan("house", CENTER);
			if (Object.keys(plan.missing).length > 0) throw new Error(`still missing ${JSON.stringify(plan.missing)}`);
			if (plan.blocked.length > 0) throw new Error(`unexpected conflicts ${JSON.stringify(plan.blocked)}`);
			return `need ${JSON.stringify(plan.need)}, estTicks ${plan.estTicks}`;
		});

		await s.step("build the house and verify it against the world", async () => {
			// 可达性归调用方（§4 总则）：先站进盒内中心，再让 build 四面施工。
			// 这不代替被测行为——build 不做绕行寻路，站位是调用方的责任。
			await s.command(`/tp ${USER} ${CENTER.x + 2.5} ${CENTER.y} ${CENTER.z + 2.5}`);
			await sleep(400);
			const result = await runBuild(h, s, buildInput("house", CENTER), 600000);
			// 门的上下半是两格：放好下半时服务端自动补上半，于是上半被正确判成"已匹配"计入
			// skipped 而不是 placed。所以完成口径是 placed + skipped 覆盖全部目标，不是 placed 等于 set 数。
			if (result.remaining.length > 0) throw new Error(`remaining ${JSON.stringify(result.remaining)}`);
			if (result.placed + result.skipped !== 100) {
				throw new Error(`placed ${result.placed} + skipped ${result.skipped} != 100 targets`);
			}
			const counts = countByName(await readRegion(CENTER, { x: CENTER.x + 4, y: CENTER.y + 3, z: CENTER.z + 4 }));
			if (counts.oak_planks !== 71) throw new Error(`world holds ${counts.oak_planks} planks, expected 71`);
			if (counts.oak_door !== 2) throw new Error(`world holds ${counts.oak_door} door parts, expected 2`);
			if (counts.torch !== 1) throw new Error(`world holds ${counts.torch} torches, expected 1`);
			// 房子建完是封闭的，建造者在里面；后续步骤要先把它挪出来（场景准备，不是被测行为）。
			await s.command(`/tp ${USER} ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
			await sleep(300);
			const lower = await s.readBlock({ x: CENTER.x + 2, y: CENTER.y, z: CENTER.z });
			const upper = await s.readBlock({ x: CENTER.x + 2, y: CENTER.y + 1, z: CENTER.z });
			if (lower?.properties.half !== "lower" || upper?.properties.half !== "upper") {
				throw new Error(`door halves wrong: ${JSON.stringify([lower?.properties, upper?.properties])}`);
			}
			const inside = await s.readBlock({ x: CENTER.x + 3, y: CENTER.y + 1, z: CENTER.z + 3 });
			if (inside?.name !== "air") throw new Error(`interior is ${inside?.name}, expected air`);
			return `placed ${result.placed}, skipped ${result.skipped}, world ${JSON.stringify(counts)}`;
		});

		await s.step("build.plan prefers target.json over the raw design", async () => {
			const plan = await readPlan("keep", KEEP);
			const expected = sha256(readFileSync(join(dataRoot, "blueprints", "keep", "target.json")));
			if (plan.blueprint?.digest !== expected) {
				throw new Error(`digest ${plan.blueprint?.digest} is not the target.json digest ${expected}`);
			}
			const kinds = kindsOf(plan);
			if (plan.targets.length !== 6) throw new Error(`expected 6 targets from target.json, got ${plan.targets.length}`);
			if (kinds.set !== 3 || kinds.clear !== 1 || kinds.preserve !== 1 || kinds.unknown !== 1) {
				throw new Error(`unexpected kinds ${JSON.stringify(kinds)}`);
			}
			return `kinds ${JSON.stringify(kinds)}, digest from target.json`;
		});

		await s.step("build respects clear / preserve / unknown", async () => {
			// 站位归调用方：站到小结构旁边再建（6 格外的原地施工不是这个能力的职责）。
			await s.command(`/tp ${USER} ${KEEP.x + 1.5} ${KEEP.y} ${KEEP.z + 2.5}`);
			await s.command(`/setblock ${KEEP.x + 2} ${KEEP.y} ${KEEP.z} minecraft:stone`);
			await s.command(`/setblock ${KEEP.x} ${KEEP.y} ${KEEP.z + 1} minecraft:chest`);
			await sleep(300);
			const result = valueOf<BuildValue>(await s.call("build@1", buildInput("keep", KEEP), 120000));
			if (result.placed !== 3) throw new Error(`placed ${result.placed} != 3`);
			if (result.cleared !== 1) throw new Error(`cleared ${result.cleared} != 1`);
			if (result.skipped !== 2) throw new Error(`skipped ${result.skipped} != 2 (preserve+unknown)`);
			const cleared = await s.readBlock({ x: KEEP.x + 2, y: KEEP.y, z: KEEP.z });
			const preserved = await s.readBlock({ x: KEEP.x, y: KEEP.y, z: KEEP.z + 1 });
			if (cleared?.name !== "air") throw new Error(`clear target still holds ${cleared?.name}`);
			if (preserved?.name !== "chest") throw new Error(`preserve target became ${preserved?.name}`);
			return `placed ${result.placed}, cleared ${result.cleared}, skipped ${result.skipped}`;
		});

		await s.step("changing the design after planning is CONFLICT, not a silent rebuild", async () => {
			const before = await readPlan("second", SECOND);
			const digest = before.blueprint!.digest;
			writeFileSync(join(dataRoot, "blueprints", "second", "design.schem"), variant);
			const result = await s.call("build@1", buildInput("second", SECOND, { expectDigest: digest }));
			if (result.ok) throw new Error("build should refuse a changed design");
			if (result.code !== "CONFLICT") throw new Error(`expected CONFLICT, got ${result.code}`);
			const untouched = await s.readBlock({ x: SECOND.x + 3, y: SECOND.y + 1, z: SECOND.z + 3 });
			if (untouched != null && untouched.name !== "air") {
				throw new Error(`conflicting build still placed ${untouched.name}`);
			}
			return `CONFLICT with stale digest ${digest.slice(0, 12)}…`;
		});

		await s.step("re-plan on the new bytes: the diff is exactly the changed cell", async () => {
			const plan = await readPlan("second", SECOND);
			if (plan.need.cobblestone !== 1) throw new Error(`expected need.cobblestone 1, got ${JSON.stringify(plan.need)}`);
			if (plan.blocked.length > 0) throw new Error(`unexpected conflicts ${JSON.stringify(plan.blocked)}`);
			await s.command(`/tp ${USER} ${SECOND.x + 2.5} ${SECOND.y} ${SECOND.z + 2.5}`);
			await sleep(400);
			const result = await runBuild(h, s, buildInput("second", SECOND), 600000);
			if (result.remaining.length > 0) throw new Error(`remaining ${JSON.stringify(result.remaining)}`);
			if (result.placed + result.skipped !== 100) {
				throw new Error(`placed ${result.placed} + skipped ${result.skipped} != 100 targets`);
			}
			return `placed ${result.placed}, need ${JSON.stringify(plan.need)}`;
		});

		await s.step("re-running build only fixes real differences", async () => {
			const result = valueOf<BuildValue>(await s.call("build@1", buildInput("second", SECOND), 120000));
			if (result.placed !== 0 || result.cleared !== 0) {
				throw new Error(`idempotent build did ${result.placed} placed / ${result.cleared} cleared`);
			}
			if (result.skipped !== 100) throw new Error(`skipped ${result.skipped} != 100`);
			return `placed 0, cleared 0, skipped ${result.skipped}`;
		});

		await s.step("513 explicit cells are rejected before dispatch", async () => {
			const cells = Array.from({ length: 513 }, (_, index) => ({
				at: { x: KEEP.x + (index % 13), y: KEEP.y + 3, z: KEEP.z + Math.floor(index / 13) },
				block: "cobblestone",
			}));
			const planFailure = await h.world
				.read({ ref: "build.plan@1", input: { cells } as JsonValue })
				.then(() => null)
				.catch((error: Failure) => error);
			if (planFailure?.code !== "INVALID_INPUT") {
				throw new Error(`build.plan@1 accepted 513 cells (code ${planFailure?.code})`);
			}
			const callFailure = await s
				.call("build@1", { cells } as JsonValue)
				.then(() => null)
				.catch((error: Error) => error);
			if (callFailure == null || !/INVALID_INPUT/.test(String(callFailure.message))) {
				throw new Error(`build@1 accepted 513 cells: ${String(callFailure?.message ?? "no error")}`);
			}
			return "both build.plan@1 and build@1 reject 513 cells with INVALID_INPUT";
		});

		await s.step("a small budget times out with partial progress reported", async () => {
			// 同样先把身体放到盒内中心：不然"1s 内一格没建成"会因为无支撑提前收尾，
			// 变成 TARGET_NOT_MET 而不是 TIMEOUT，断言就成了时序抽奖。
			await s.command(`/tp ${USER} ${THIRD.x + 2.5} ${THIRD.y} ${THIRD.z + 2.5}`);
			await sleep(400);
			const spawned = await s.spawn("build@1", buildInput("third", THIRD, { maxTimeMs: 1000 }));
			const reply = await h.runtime.wait(spawned.run, { timeoutMs: 180000 });
			if (reply.kind !== "result") throw new Error(`no result: ${reply.kind}`);
			if (reply.snapshot.phase !== "finished") throw new Error(`still ${reply.snapshot.phase}`);
			if (reply.snapshot.outcome === "succeeded") throw new Error("build should have run out of budget");
			const failed = await failedCallOf(h, spawned.run);
			if (failed.error?.code !== "TIMEOUT") {
				const progress = failed.error?.progress as { remaining?: unknown[]; placed?: number } | undefined;
				throw new Error(
					`expected TIMEOUT, got ${failed.error?.code} (placed ${progress?.placed ?? 0}) ${JSON.stringify(progress?.remaining ?? []).slice(0, 700)}`,
				);
			}
			const progress = failed.error.progress;
			// 1s 预算下不可能建成多少，这里要证的是"超预算时如实停手并交代还剩多少"。
			// 断言用总量守恒：已结算 + 剩下的必须等于设计格数，否则 remaining 就是在少报。
			const counts = progress as
				| { placed?: number; cleared?: number; skipped?: number; remainingCount?: number }
				| undefined;
			const total =
				(counts?.placed ?? 0) + (counts?.cleared ?? 0) + (counts?.skipped ?? 0) + (counts?.remainingCount ?? 0);
			if (total !== 100) {
				throw new Error(`TIMEOUT progress does not add up to 100: ${JSON.stringify(progress).slice(0, 500)}`);
			}
			if ((counts?.remainingCount ?? 0) <= 0)
				throw new Error(`TIMEOUT reported nothing left: ${JSON.stringify(progress)}`);
			return `TIMEOUT with ${counts?.remainingCount} left, ${counts?.placed} placed, ${counts?.skipped} skipped`;
		});
	} finally {
		s.finish();
		await closeHarness(h);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
