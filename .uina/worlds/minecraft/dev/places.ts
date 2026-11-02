/**
 * 批11 真服验收：领域记录 + 地点（remember/forget/places）+ 路径试算（route.plan）+ 探索（explore）。
 *
 * 被测行为全部走正式能力面（Runtime submit → callable / World read）；
 * op 指令只备地形/实体，不代替任何被测动作。断言用独立事实交叉核验
 * （places 读回、block/实体读数、站位复读），不信任单次返回值。
 * 关闭重开用同一 dataRoot + 同一 binding：领域记录跨进程存活的直接证据。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelfState } from "../contracts/body.js";
import type { Vec3 } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 8500, y: 200, z: 8500 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

interface PlaceEntry {
	name: string;
	at: { position: Vec3; dimension: string };
	kind: string;
	note?: string;
	savedAt: string;
}

async function readPlaces(
	h: Awaited<ReturnType<typeof openHarness>>,
	input: { kind?: string; near?: number },
): Promise<PlaceEntry[]> {
	const observation = await h.world.read<{ places: PlaceEntry[] }>({ ref: "places@1", input });
	return observation.value?.places ?? [];
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-places-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:places-${Date.now()}` };
	let h = await openHarness("places", { dataRoot, binding });
	const ns = h.ns;
	const s = makeScenario(h, "places");
	try {
		await s.step("prepare platform and props", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			const deadline = Date.now() + 20000;
			for (;;) {
				const anchor = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
				if (anchor != null) break;
				if (Date.now() >= deadline) throw new Error("test-area chunk never became observable");
				await sleep(300);
			}
			await s.command(
				`/fill ${CENTER.x - 50} 199 ${CENTER.z - 50} ${CENTER.x + 50} 199 ${CENTER.z + 50} minecraft:stone`,
			);
			// fill 之后再落位（dev/MC-WORLD.md 经验 21）：先 tp 后 fill 会先坠到天然地表。
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command(`/setblock ${CENTER.x} 200 ${CENTER.z - 40} minecraft:diamond_block`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const self = await s.readSelf();
			const below = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
			if (Math.abs(self.place.position.y - CENTER.y) > 2 || below == null || below.name !== "stone") {
				throw new Error(
					`bot is not standing on the platform: y=${self.place.position.y} below=${below?.name ?? "null"}`,
				);
			}
			return "platform 101x101 @8500, bot standing on it, diamond marker 40 north";
		});

		await s.step("remember creates, overwrites by name, keeps explicit dimension", async () => {
			const created = valueOf<{ name: string; at: { position: Vec3; dimension: string }; kind: string }>(
				await s.call("remember@1", { name: "home", kind: "home" }),
			);
			const self = await s.readSelf();
			if (
				Math.hypot(created.at.position.x - self.place.position.x, created.at.position.z - self.place.position.z) > 1
			) {
				throw new Error(`remember without at did not use the current position: ${JSON.stringify(created.at)}`);
			}
			await s.call("remember@1", { name: "home", at: { x: CENTER.x + 2, y: CENTER.y, z: CENTER.z + 2 }, kind: "home" });
			const homes = await readPlaces(h, { kind: "home" });
			if (homes.length !== 1 || Math.abs(homes[0]!.at.position.x - (CENTER.x + 2)) > 0.01) {
				throw new Error(`same-name overwrite failed: ${JSON.stringify(homes)}`);
			}
			await s.call("remember@1", {
				name: "nether-spot",
				at: { position: { x: 100, y: 64, z: 100 }, dimension: "minecraft:the_nether" },
				kind: "mine",
			});
			const mines = await readPlaces(h, { kind: "mine" });
			if (mines.length !== 1 || mines[0]!.at.dimension !== "minecraft:the_nether") {
				throw new Error(`explicit dimension not preserved: ${JSON.stringify(mines)}`);
			}
			const rejected = await s.call("remember@1", { name: "x".repeat(33) });
			// 名字超限在 Runtime 受理（schema 校验）或能力层被拒；两条路径都必须拒绝且不落记录。
			const rejectedAsInvalid = rejected.code === "INVALID_INPUT" || (rejected.message ?? "").includes("INVALID_INPUT");
			if (rejected.ok || !rejectedAsInvalid) {
				throw new Error(
					`33-char name should fail INVALID_INPUT, got ${rejected.code ?? "ok"} ${rejected.message ?? ""}`,
				);
			}
			return "home overwritten in place; nether-spot keeps its dimension; long name rejected";
		});

		await s.step("near filters by current dimension distance", async () => {
			await s.call("remember@1", {
				name: "far-away",
				at: { x: CENTER.x + 200, y: CENTER.y, z: CENTER.z },
				kind: "other",
			});
			const near = await readPlaces(h, { near: 16 });
			const names = near.map((p) => p.name).sort();
			if (JSON.stringify(names) !== JSON.stringify(["home"])) {
				throw new Error(`near 16 should list only home, got ${JSON.stringify(names)}`);
			}
			return "near 16 keeps home, drops far-away and the nether record";
		});

		await s.step("forget removes exactly the named record", async () => {
			const removed = valueOf<{ removed: boolean }>(await s.call("forget@1", { name: "far-away" }));
			if (removed.removed !== true) throw new Error("forget did not report removed");
			const again = await s.call("forget@1", { name: "far-away" });
			if (again.ok || again.code !== "NOT_FOUND") {
				throw new Error(`second forget should be NOT_FOUND, got ${again.code ?? "ok"}`);
			}
			const names = (await readPlaces(h, {})).map((p) => p.name).sort();
			if (names.includes("far-away")) throw new Error("forgotten place still listed");
			return "removed=true then NOT_FOUND";
		});

		await s.step("route.plan shapes a real route without moving", async () => {
			const before = await s.readSelf();
			const observation = await h.world.read<{
				ok: boolean;
				distance: number;
				steps: { at: Vec3; action: string }[];
				needs: { dig: number; place: number };
				estTimeSec: number | null;
			}>({ ref: "route.plan@1", input: { at: { x: CENTER.x + 30, y: CENTER.y, z: CENTER.z }, tolerance: 2 } });
			const plan = observation.value;
			if (plan == null || !plan.ok || plan.steps.length === 0 || plan.estTimeSec == null) {
				throw new Error(`open-terrain plan should succeed: ${JSON.stringify(observation)}`);
			}
			if (observation.cursor !== null) throw new Error("route.plan must not be waitable (cursor null)");
			const after = await s.readSelf();
			if (
				Math.hypot(after.place.position.x - before.place.position.x, after.place.position.z - before.place.position.z) >
				0.5
			) {
				throw new Error("route.plan moved the player");
			}
			return `ok plan: ${plan.steps.length} steps, est ${plan.estTimeSec}s, player unmoved`;
		});

		await s.step("explore finds the prepared block and reports coverage", async () => {
			const value = valueOf<{
				found: { kind: string; name: string; at: { position: Vec3 } };
				traveled: number;
				scanned: number;
			}>(await s.call("explore@1", { until: { block: "diamond_block" }, maxTimeMs: 120000 }, 150000));
			if (value.found.kind !== "block" || value.found.name !== "diamond_block") {
				throw new Error(`unexpected find: ${JSON.stringify(value.found)}`);
			}
			if (value.traveled <= 0 || value.scanned < 2) {
				throw new Error(`coverage not reported: traveled=${value.traveled} scanned=${value.scanned}`);
			}
			const marker = await s.readBlock({ x: CENTER.x, y: CENTER.y, z: CENTER.z - 40 });
			if (marker == null || marker.name !== "diamond_block") throw new Error("marker block vanished");
			return `found diamond_block after ${value.scanned} scans, traveled ${value.traveled}`;
		});

		await s.step("route.plan reports blockers behind a wall and dig-through needs", async () => {
			// 先把机器人固定到平台中部：explore 的停点不可控，可能就贴在墙线上。
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 5.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const wallZ = CENTER.z - 20;
			await s.command(
				`/fill ${CENTER.x - 50} ${CENTER.y} ${wallZ} ${CENTER.x + 50} ${CENTER.y + 2} ${wallZ} minecraft:stone`,
			);
			const before = await s.readSelf();
			if (Math.abs(before.place.position.y - CENTER.y) > 2)
				throw new Error(`bot not on the platform: ${JSON.stringify(before.place.position)}`);
			// 目标必须与机器人分居墙两侧：机器人在南侧（z 更大），目标取北侧。
			const targetZ = wallZ - 20;
			const blocked = await h.world.read<{
				ok: boolean;
				steps: unknown[];
				blockers: { at: Vec3; reason: string }[];
			}>({ ref: "route.plan@1", input: { at: { x: CENTER.x, y: CENTER.y, z: targetZ }, placeToReach: false } });
			if (blocked.value == null || blocked.value.ok || blocked.value.blockers.length === 0) {
				throw new Error(`plan past a wall should return ok:false with blockers: ${JSON.stringify(blocked.value)}`);
			}
			const through = await h.world.read<{ ok: boolean; needs: { dig: number; place: number } }>({
				ref: "route.plan@1",
				input: { at: { x: CENTER.x, y: CENTER.y, z: targetZ }, digThrough: true, placeToReach: false },
			});
			if (through.value == null || !through.value.ok || through.value.needs.dig < 2) {
				throw new Error(`digThrough plan should cross with dig>=2: ${JSON.stringify(through.value)}`);
			}
			const after = await s.readSelf();
			if (
				Math.hypot(after.place.position.x - before.place.position.x, after.place.position.z - before.place.position.z) >
				0.5
			) {
				throw new Error("route.plan moved the player");
			}
			// 拆墙恢复地形，给后续 explore/goto 一块完整平台。
			await s.command(
				`/fill ${CENTER.x - 50} ${CENTER.y} ${wallZ} ${CENTER.x + 50} ${CENTER.y + 2} ${wallZ} minecraft:air`,
			);
			return `blocked plan ok:false (blockers=${blocked.value.blockers.length}); digThrough needs dig=${through.value.needs.dig}; player unmoved`;
		});

		await s.step("explore timeout keeps honest coverage", async () => {
			const timeout = await s.call("explore@1", { until: { block: "dragon_egg" }, maxTimeMs: 1000 }, 60000);
			if (timeout.ok || timeout.code !== "TIMEOUT") {
				throw new Error(`dragon_egg within 1s should TIMEOUT, got ${timeout.code ?? "ok"}`);
			}
			return "TIMEOUT with budget exhausted (progress lives in the call record)";
		});

		await s.step("explore finds a summoned cow with a stable ref", async () => {
			await s.command(`/summon minecraft:cow ${CENTER.x + 10} ${CENTER.y} ${CENTER.z + 10}`);
			await sleep(500);
			const value = valueOf<{
				found: { kind: string; name: string; ref?: { networkId: number } };
				traveled: number;
				scanned: number;
			}>(await s.call("explore@1", { until: { entity: "cow" }, maxTimeMs: 120000 }, 150000));
			if (value.found.kind !== "entity" || value.found.name !== "cow" || value.found.ref?.networkId == null) {
				throw new Error(`cow find should carry a ref: ${JSON.stringify(value.found)}`);
			}
			return `cow found, networkId=${value.found.ref.networkId}`;
		});

		await s.log("closing harness for the restart check");
		await closeHarness(h);
		// 同 dataRoot + 同 binding + 同 ns：runtime.db 的 world_owner 与历史库分区身份都复用。
		h = await openHarness("places-reopen", { dataRoot, binding, ns });
		const s2 = makeScenario(h, "places-reopen");
		try {
			await s2.step("places survive close/reopen and drive a goto", async () => {
				const names = (await readPlaces(h, {})).map((p) => p.name).sort();
				if (JSON.stringify(names) !== JSON.stringify(["home", "nether-spot"])) {
					throw new Error(`records lost across restart: ${JSON.stringify(names)}`);
				}
				const home = (await readPlaces(h, { kind: "home" }))[0]!;
				const gotoResult = await s2.call(
					"goto@1",
					{ at: { x: home.at.position.x, y: home.at.position.y, z: home.at.position.z }, tolerance: 1 },
					60000,
				);
				if (!gotoResult.ok) throw new Error(`goto to remembered home failed: ${gotoResult.code}`);
				const self: SelfState = await s2.readSelf();
				const gap = Math.hypot(
					self.place.position.x - home.at.position.x,
					self.place.position.y - home.at.position.y,
					self.place.position.z - home.at.position.z,
				);
				if (gap > 2) throw new Error(`goto to remembered home left ${gap.toFixed(2)} blocks`);
				return `home (rev from record) drove a goto; final gap ${gap.toFixed(2)}`;
			});
		} finally {
			s2.finish();
		}
	} finally {
		s.finish();
		await closeHarness(h);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
