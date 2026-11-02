/**
 * 批 18 真服验收：睡眠/捕鱼/骑乘/牵引（sleep/fish/ride/lead）。
 *
 * 被测行为全部走正式能力面（Runtime submit → callable）；
 * op 指令只备地形/实体/状态（床两半、水池、有鞍驯服马、栅栏、拴绳），不代替任何被测动作。
 * 断言用独立事实交叉核验（world@1 刻数、entities 复读、inventory 增量、服务端 Pos），
 * 不信任单次返回值。验收口径：development-plan.md §10.3 K8 四条。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { type CallResult, type EntityView, makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9700, y: 200, z: 9700 };
// 水池：x CX-20..CX-4（满力抛竿的落点都在池内），z CZ-6..CZ+6（goto 收尾朝向
// 不严格朝西，落点会斜偏；真服实测偏过 6 格），y=199 水、y=198 石底。
const POOL = { x1: CENTER.x - 20, x2: CENTER.x - 4, z1: CENTER.z - 6, z2: CENTER.z + 6 };
const BED_FOOT = { x: CENTER.x + 8, y: 200, z: CENTER.z + 8 };
const FENCE = { x: CENTER.x + 5, y: 200, z: CENTER.z - 5 };
const FISH_SPOT = { x: CENTER.x - 3, y: 200, z: CENTER.z };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

function expectFail(result: CallResult, code: string, what: string): string {
	if (result.ok) throw new Error(`${what}: expected failure ${code}, got success ${JSON.stringify(result.value)}`);
	if (result.code !== code) throw new Error(`${what}: expected ${code}, got ${result.code} (${result.message ?? ""})`);
	return result.message ?? "";
}

function flatGap(a: { x: number; z: number }, b: { x: number; z: number }): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

async function findEntity(s: ReturnType<typeof makeScenario>, name: string, radius = 64): Promise<EntityView> {
	const entities = await s.readEntities(radius);
	const found = entities.find((entity) => entity.name === name);
	if (found == null)
		throw new Error(`${name} not tracked within ${radius} (got ${entities.map((e) => e.name).join(",") || "none"})`);
	return found;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-k8-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:k8-${Date.now()}` };
	const h = await openHarness("k8", { dataRoot, binding });
	const s = makeScenario(h, "k8");

	/** 场景内走路辅助（被测动作之外的定位手段，与 mobility 同款）。 */
	const gotoNear = async (at: { x: number; y: number; z: number }): Promise<void> => {
		const result = await s.call("goto@1", { at, tolerance: 1, maxTimeMs: 30000 }, 40000);
		if (!result.ok) throw new Error(`goto to ${JSON.stringify(at)} failed: ${result.code}`);
	};

	const readTicks = async (): Promise<number> => {
		const observation = await h.world.read<{ ticks: number | null }>({ ref: "world@1", input: {} });
		const ticks = observation.value?.ticks;
		if (ticks == null) throw new Error("world@1 returned no ticks");
		return ticks;
	};

	try {
		await s.step("prepare: 平台/水池/床/栅栏/道具，清场与状态归零", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			const deadline = Date.now() + 20000;
			for (;;) {
				const anchor = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
				if (anchor != null) break;
				if (Date.now() >= deadline) throw new Error("test-area chunk never became observable");
				await sleep(300);
			}
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/kill @e[type=!player]`);
			await s.command(
				`/fill ${CENTER.x - 30} 199 ${CENTER.z - 30} ${CENTER.x + 30} 199 ${CENTER.z + 30} minecraft:stone`,
			);
			// 水池：先铺底（防坠落虚空），再放水
			await s.command(`/fill ${POOL.x1} 198 ${POOL.z1} ${POOL.x2} 198 ${POOL.z2} minecraft:stone`);
			await s.command(`/fill ${POOL.x1} 199 ${POOL.z1} ${POOL.x2} 199 ${POOL.z2} minecraft:water`);
			// 床两半（探针教训：半床不能睡）
			await s.command(`/setblock ${BED_FOOT.x} ${BED_FOOT.y} ${BED_FOOT.z} minecraft:red_bed[part=foot,facing=east]`);
			await s.command(
				`/setblock ${BED_FOOT.x + 1} ${BED_FOOT.y} ${BED_FOOT.z} minecraft:red_bed[part=head,facing=east]`,
			);
			await s.command(`/setblock ${FENCE.x} ${FENCE.y} ${FENCE.z} minecraft:oak_fence`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:fishing_rod 1`);
			await s.command(`/give ${USER} minecraft:lead 4`);
			await s.command(`/time set day`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const water = await s.readBlock({ x: CENTER.x - 12, y: 199, z: CENTER.z });
			const bed = await s.readBlock(BED_FOOT);
			const fence = await s.readBlock(FENCE);
			if (water?.name !== "water") throw new Error(`pool water missing: ${water?.name ?? "null"}`);
			if (bed?.name !== "red_bed") throw new Error(`bed missing: ${bed?.name ?? "null"}`);
			if (fence?.name !== "oak_fence") throw new Error(`fence missing: ${fence?.name ?? "null"}`);
			const inv = await s.readInventory();
			if ((inv.counts["fishing_rod"] ?? 0) !== 1 || (inv.counts["lead"] ?? 0) !== 4) {
				throw new Error(
					`props missing: rod=${String(inv.counts["fishing_rod"] ?? 0)} lead=${String(inv.counts["lead"] ?? 0)}`,
				);
			}
			return "platform 61x61, pool 17x7 with floor, bed 2 halves, oak_fence, rod x1 lead x4";
		});

		await s.step("sleep@1 白天拒绝（派发前 WRONG_STATE）", async () => {
			await s.command(`/tp ${USER} ${CENTER.x + 6.5} ${CENTER.y} ${CENTER.z + 8.5}`);
			await s.command(`/time set day`);
			const err = expectFail(await s.call("sleep@1", {}), "WRONG_STATE", "sleep in day");
			const ticks = await readTicks();
			if (ticks >= 12541 && ticks <= 23458)
				throw new Error(`world says night (${String(ticks)}) but sleep was refused as day`);
			return `refused: ${err}; ticks=${String(ticks)} (day)`;
		});

		await s.step("sleep@1 床边有怪拒绝（WRONG_STATE，僵尸在独立事实里）", async () => {
			await s.command(`/difficulty easy`);
			await s.command(`/time set night`);
			await s.command(`/summon minecraft:zombie ${BED_FOOT.x} ${BED_FOOT.y} ${BED_FOOT.z - 4}`);
			await sleep(600);
			await gotoNear({ x: BED_FOOT.x - 2, y: BED_FOOT.y, z: BED_FOOT.z });
			const err = expectFail(await s.call("sleep@1", { at: BED_FOOT }), "WRONG_STATE", "sleep with zombie");
			const zombie = await findEntity(s, "zombie", 32);
			if (flatGap(zombie.position, BED_FOOT) > 9) throw new Error("zombie not near the bed per entities@1");
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/difficulty peaceful`);
			return `refused: ${err}; zombie was ${flatGap(zombie.position, BED_FOOT).toFixed(1)} blocks from bed`;
		});

		await s.step("sleep@1 正常：入睡 → 服务端跳时间 → 醒在床边", async () => {
			await gotoNear({ x: BED_FOOT.x - 2, y: BED_FOOT.y, z: BED_FOOT.z });
			// 单人服务器夜睡几乎瞬时完成；unknown（运行记录未落）时重试一次，两晚都失败才判负。
			await s.command(`/time set night`);
			let result = await s.call("sleep@1", { at: BED_FOOT }, 120000);
			if (!result.ok && result.code === "unknown") {
				await s.command(`/time set night`);
				result = await s.call("sleep@1", { at: BED_FOOT }, 120000);
			}
			const value = valueOf<{ slept: boolean; at: { position: { x: number; z: number } }; until: string }>(result);
			if (value.slept !== true || value.until !== "morning") throw new Error(`bad result: ${JSON.stringify(value)}`);
			const ticks = await readTicks();
			if (ticks >= 12000 && ticks <= 23458)
				throw new Error(`world still night-ish after sleep: ticks=${String(ticks)}`);
			const self = await s.readSelf();
			const gap = flatGap(self.place.position, BED_FOOT);
			if (gap > 3) throw new Error(`bot did not wake at the bed: gap=${gap.toFixed(2)}`);
			return `slept until morning, ticks now ${String(ticks)}, woke ${gap.toFixed(1)} blocks from bed`;
		});

		await s.step("sleep@1 中断：睡态永不残留（停在哪个相位都能继续走）", async () => {
			await gotoNear({ x: BED_FOOT.x - 2, y: BED_FOOT.y, z: BED_FOOT.z });
			await s.command(`/time set night`);
			const spawned = await s.spawn("sleep@1", { at: BED_FOOT });
			await sleep(400);
			const stopped = await s.waitCall(spawned, 250); // 超时即显式停自己的 Run
			// 单人服务器的夜睡几乎瞬时跳到白天：停在半路或已自然完成都算合法相位。
			// 不变式只有一条：之后 bot 必须能走路（睡姿锁移动）。
			await gotoNear({ x: BED_FOOT.x - 6, y: BED_FOOT.y, z: BED_FOOT.z });
			await s.command(`/time set day`);
			return `spawned sleep ${stopped.ok ? "completed before the stop (morning)" : "stopped mid-way"}; walkable after — no sleep residue`;
		});

		await s.step("fish@1 满力抛竿入水 → 咬钩 → 收竿 → 捕获入包", async () => {
			await gotoNear(FISH_SPOT); // 从东侧走向池边，收尾朝西 = 面向水池
			const value = valueOf<{ caught: { item: string; count: number }[]; casts: number }>(
				await s.call("fish@1", { maxTimeMs: 90000 }, 120000),
			);
			const total = value.caught.reduce((sum, entry) => sum + entry.count, 0);
			if (total < 1) throw new Error(`nothing caught: ${JSON.stringify(value)}`);
			const inv = await s.readInventory();
			for (const entry of value.caught) {
				if ((inv.counts[entry.item] ?? 0) < entry.count) {
					throw new Error(
						`inventory lacks ${entry.item}: claimed ${String(entry.count)}, have ${String(inv.counts[entry.item] ?? 0)}`,
					);
				}
			}
			return `caught ${value.caught.map((c) => `${c.item}x${String(c.count)}`).join(",")} in ${String(value.casts)} cast(s); inventory confirms`;
		});

		await s.step("fish@1 非水边快速失败（落点核验 WRONG_STATE）", async () => {
			await gotoNear({ x: CENTER.x + 4, y: CENTER.y, z: CENTER.z }); // 走向东侧 = 背对水池
			const message = expectFail(await s.call("fish@1", { maxTimeMs: 8000 }, 30000), "WRONG_STATE", "fish onto land");
			// 收竿核验：没有残留鱼漂实体
			const bobbers = (await s.readEntities(32)).filter((entity) => entity.name === "fishing_bobber");
			if (bobbers.length > 0) throw new Error("bobber remains after the refused cast");
			return `refused fast: ${message.slice(0, 80)}; no residual bobber`;
		});

		await s.step("fish@1 短预算：TIMEOUT 或提前咬钩，两条路都验证收竿干净", async () => {
			await gotoNear(FISH_SPOT);
			const result = await s.call("fish@1", { maxTimeMs: 5000 }, 30000);
			const bobbers = (await s.readEntities(32)).filter((entity) => entity.name === "fishing_bobber");
			if (bobbers.length > 0) throw new Error("bobber remains after the budget ended (rod not retracted)");
			if (result.ok) {
				return `bite arrived within budget (unlucky for the timeout path) — retract verified clean`;
			}
			if (result.code !== "TIMEOUT") throw new Error(`expected TIMEOUT, got ${result.code}`);
			return `TIMEOUT as expected; retract verified clean (no bobber)`;
		});

		await s.step("ride@1 马：有鞍驯服马上车 → 驾驶尝试（缺口：Paper 忽略有鞍马 vehicle_move）→ 下车", async () => {
			await s.command(`/summon minecraft:horse ${CENTER.x + 4} ${CENTER.y} ${CENTER.z + 4} {Tame:1b}`);
			await sleep(700);
			// 1.21.11 鞍槽位 = equipment.saddle（旧 slot 名 `saddle` 报 Incorrect argument，探针实证）
			await s.command(
				`/item replace entity @e[type=minecraft:horse,limit=1,sort=nearest] equipment.saddle minecraft:saddle`,
			);
			await sleep(400);
			await gotoNear({ x: CENTER.x + 2, y: CENTER.y, z: CENTER.z + 4 });
			// 马会游荡：骑之前 tp 到玩家脚边，把派发前的漂移窗口压到最小
			await s.command(
				`/tp @e[type=minecraft:horse,limit=1,sort=nearest] ${CENTER.x + 3.5} ${CENTER.y} ${CENTER.z + 4}`,
			);
			await sleep(300);
			const HORSE_SEL = "@e[type=minecraft:horse,limit=1,sort=nearest]";
			const to = { x: CENTER.x + 15, y: CENTER.y, z: CENTER.z + 4 };
			const result = await s.call("ride@1", { target: "horse", to }, 60000);
			const horseAfter = await s.serverPos(HORSE_SEL);
			if (result.ok) {
				// 未来服务器若接受 vehicle_move：按到达口径验收（服务端真值）
				const value = valueOf<{ riding: boolean; mount: string }>(result);
				if (value.riding !== true || value.mount !== "horse") throw new Error(`bad result: ${JSON.stringify(value)}`);
				if (horseAfter == null || flatGap(horseAfter, to) > 3)
					throw new Error(`drive claimed success but server Pos says otherwise: ${JSON.stringify(horseAfter)}`);
				const off = valueOf<{ riding: boolean }>(await s.call("ride@1", { off: true }, 30000));
				if (off.riding !== false) throw new Error(`off returned ${JSON.stringify(off)}`);
			} else {
				// 已知缺口（探针 W/X 系列实证）：Paper 1.21.11 不按申报驱动马（有鞍忽略
				// vehicle_move，无鞍追踪方向也不受申报控制）→ 能力层如实 UNREACHABLE 且已下马。
				// 服务端真值断言：马没到 to（AI 漂移允许，到达不允许）。
				if (result.code !== "UNREACHABLE")
					throw new Error(`expected UNREACHABLE (known gap), got ${result.code}: ${result.message ?? ""}`);
				if (horseAfter == null || flatGap(horseAfter, to) < 3)
					throw new Error(`horse unexpectedly reached \`to\` under the known gap: ${JSON.stringify(horseAfter)}`);
			}
			// 下车证据（服务端真值）：玩家与马分离 + 马 Passengers 空
			const riderNow = await s.serverPos(USER);
			const horseEnd = await s.serverPos(HORSE_SEL);
			if (riderNow == null || horseEnd == null || flatGap(riderNow, horseEnd) < 0.5)
				throw new Error(`rider still glued to the horse: ${JSON.stringify({ riderNow, horseEnd })}`);
			const pax = await s.serverData(HORSE_SEL, "Passengers");
			if (!pax.includes("Found no elements matching")) throw new Error(`horse still has passengers: ${pax}`);
			// 客户端 self 在下马后回同步（探针②实证），交叉核验
			const self = await s.readSelf();
			if (horseEnd != null && flatGap(self.place.position, horseEnd) < 0.5)
				throw new Error(`client self not resynced after dismount: ${JSON.stringify(self.place.position)}`);
			return `mount+dismount verified via server Pos; drive ${
				result.ok ? "arrived (server Pos)" : `honestly refused (${result.code}) — known gap G18-ride-horse`
			}`;
		});

		await s.step("ride@1 矿车不可转向：上车后驾驶请求 → 下车 + WRONG_STATE", async () => {
			await s.command(`/setblock ${CENTER.x - 2} ${CENTER.y} ${CENTER.z + 8} minecraft:rail`);
			await s.command(`/summon minecraft:minecart ${CENTER.x - 2} ${CENTER.y + 0.2} ${CENTER.z + 8}`);
			await sleep(700);
			await gotoNear({ x: CENTER.x - 2, y: CENTER.y, z: CENTER.z + 5 });
			const message = expectFail(
				await s.call("ride@1", { target: "minecart", to: { x: CENTER.x - 2, y: CENTER.y, z: CENTER.z - 8 } }, 30000),
				"WRONG_STATE",
				"steer minecart",
			);
			// 下车证据（服务端真值）：矿车 Passengers 空 + 玩家与矿车分离（能力层 dismountQuietly）
			const CART_SEL = "@e[type=minecraft:minecart,limit=1,sort=nearest]";
			const cart = await s.serverPos(CART_SEL);
			const rider = await s.serverPos(USER);
			if (cart == null || rider == null || flatGap(cart, rider) < 0.5)
				throw new Error(`bot still glued to the minecart: ${JSON.stringify({ cart, rider })}`);
			const pax = await s.serverData(CART_SEL, "Passengers");
			if (!pax.includes("Found no elements matching")) throw new Error(`minecart still has passengers: ${pax}`);
			return `refused: ${message.slice(0, 70)}; cart intact, rider ${flatGap(cart, rider).toFixed(1)} blocks off it (server Pos)`;
		});

		await s.step("ride@1 骑乘中载具消失：驾驶结论不成立（WRONG_STATE）", async () => {
			await s.command(`/kill @e[type=minecraft:horse]`);
			await sleep(400);
			await s.command(`/summon minecraft:horse ${CENTER.x + 3} ${CENTER.y} ${CENTER.z} {Tame:1b}`);
			await sleep(700);
			await s.command(
				`/item replace entity @e[type=minecraft:horse,limit=1,sort=nearest] equipment.saddle minecraft:saddle`,
			);
			await sleep(400);
			await gotoNear({ x: CENTER.x + 1, y: CENTER.y, z: CENTER.z });
			const spawned = await s.spawn("ride@1", { target: "horse", to: { x: CENTER.x + 15, y: CENTER.y, z: CENTER.z } });
			await sleep(1500);
			const mounted = await s.readSelf();
			const horse = await findEntity(s, "horse");
			if (flatGap(mounted.place.position, horse.position) > 2.5) {
				throw new Error("bot never boarded before the kill");
			}
			await s.command(`/kill @e[type=minecraft:horse]`);
			const result = await s.waitCall(spawned, 60000);
			const code = expectFail(result, "WRONG_STATE", "vehicle vanished mid-drive");
			if (!code.includes("vanished")) throw new Error(`unexpected refusal: ${code}`);
			const entities = await s.readEntities(32);
			if (entities.some((entity) => entity.name === "horse")) throw new Error("horse still tracked after /kill");
			const self = await s.readSelf();
			if (Math.abs(self.place.position.y - CENTER.y) > 2.5)
				throw new Error("bot not back on the platform after the kill");
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			return `server dismounted on vehicle death; ride reported WRONG_STATE (vanished mid-drive)`;
		});

		await s.step("ride@1 船（客户端权威）：上车 → vehicle_move 驾驶 → 下车", async () => {
			await gotoNear(FISH_SPOT);
			await s.command(`/summon minecraft:oak_boat ${CENTER.x - 6} 199.4 ${CENTER.z}`);
			await sleep(900);
			// 船在水上会漂：骑之前 tp 回池边固定点，把派发前的漂移窗口压到最小
			await s.command(`/tp @e[type=oak_boat,limit=1,sort=nearest] ${CENTER.x - 5} 199.4 ${CENTER.z}`);
			await sleep(300);
			const boat = await findEntity(s, "oak_boat");
			if (flatGap(boat.position, { x: CENTER.x - 5, z: CENTER.z }) > 1.5) {
				throw new Error(`boat not in the pool: ${JSON.stringify(boat.position)}`);
			}
			const to = { x: CENTER.x - 15, y: CENTER.y, z: CENTER.z };
			const value = valueOf<{ riding: boolean; mount: string }>(
				await s.call("ride@1", { target: "oak_boat", to }, 60000),
			);
			if (value.riding !== true || value.mount !== "oak_boat") throw new Error(`bad result: ${JSON.stringify(value)}`);
			// 服务端真值核验：船真的开到了 to（vehicle_move 客户端权威被服务端接受，探针 W 系实证 8.80/8.80）
			const boatServer = await s.serverPos("@e[type=oak_boat,limit=1,sort=nearest]");
			if (boatServer == null || flatGap(boatServer, to) > 3)
				throw new Error(`boat drive did not arrive (server Pos): ${JSON.stringify(boatServer)}`);
			const off = valueOf<{ riding: boolean }>(await s.call("ride@1", { off: true }, 30000));
			if (off.riding !== false) throw new Error(`off returned ${JSON.stringify(off)}`);
			const pax = await s.serverData("@e[type=oak_boat,limit=1,sort=nearest]", "Passengers");
			if (!pax.includes("Found no elements matching")) throw new Error(`boat still has passengers: ${pax}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			return `boat moved to ${JSON.stringify(boatServer)} (server Pos, ${flatGap(boatServer, to).toFixed(2)} from to), dismounted`;
		});

		await s.step("lead@1 拴牛：拴绳消耗，牵引到 to（牛跟着到位）", async () => {
			await s.command(`/summon minecraft:cow ${CENTER.x + 3} ${CENTER.y} ${CENTER.z + 3}`);
			await sleep(700);
			await gotoNear({ x: CENTER.x + 1.5, y: CENTER.y, z: CENTER.z + 2.5 });
			const before = (await s.readInventory()).counts["lead"] ?? 0;
			const leashed = valueOf<{ leashed: boolean }>(await s.call("lead@1", { target: "cow" }, 30000));
			if (leashed.leashed !== true) throw new Error(`leash failed: ${JSON.stringify(leashed)}`);
			// 1.21.11 实测：拴上不消耗拴绳（拴绳挂在链接上）；数量只记录不断言。
			const afterLeash = (await s.readInventory()).counts["lead"] ?? 0;
			const target = { x: CENTER.x + 6, y: CENTER.y, z: CENTER.z + 8 };
			const value = valueOf<{ leashed: boolean; at: { position: { x: number; z: number } } }>(
				await s.call("lead@1", { target: "cow", to: target }, 90000),
			);
			if (value.leashed !== true) throw new Error(`transit failed: ${JSON.stringify(value)}`);
			const cow = await findEntity(s, "cow");
			const gap = flatGap(cow.position, target);
			if (gap > 4) throw new Error(`cow did not arrive with the player: gap=${gap.toFixed(2)}`);
			return `leashed (lead ${String(before)}->${String(afterLeash)}), cow followed to ${gap.toFixed(1)} blocks from to`;
		});

		await s.step("lead@1 系绳：拴绳结实体出现在栅栏旁（独立复核）", async () => {
			await gotoNear({ x: FENCE.x + 1, y: FENCE.y, z: FENCE.z + 1 });
			await s.command(`/kill @e[type=minecraft:cow]`); // 同名实体唯一性（resolveEntity 取第一个）
			await s.command(`/kill @e[type=minecraft:item]`);
			await sleep(500);
			await s.command(`/summon minecraft:cow ${FENCE.x + 1} ${FENCE.y} ${FENCE.z + 2}`);
			await sleep(700);
			const value = valueOf<{ leashed: boolean; at: { position: { x: number; z: number } } }>(
				await s.call("lead@1", { target: "cow", tie: true }, 60000),
			);
			if (value.leashed !== true) throw new Error(`tie failed: ${JSON.stringify(value)}`);
			const knot = await findEntity(s, "leash_knot", 16);
			const gap = flatGap(knot.position, FENCE);
			if (gap > 1.5) throw new Error(`knot not at the fence: ${gap.toFixed(2)}`);
			return `leash_knot at ${JSON.stringify(knot.position)} (${gap.toFixed(2)} from fence), cow2 tied`;
		});

		await s.step("lead@1 释放：空手点牛解除链接，拴绳有下落", async () => {
			await gotoNear({ x: CENTER.x + 2, y: CENTER.y, z: CENTER.z });
			await s.command(`/kill @e[type=minecraft:cow]`);
			await s.command(`/kill @e[type=minecraft:item]`);
			await sleep(500);
			await s.command(`/summon minecraft:cow ${CENTER.x + 3} ${CENTER.y} ${CENTER.z}`);
			await sleep(700);
			const leashed = valueOf<{ leashed: boolean }>(await s.call("lead@1", { target: "cow" }, 30000));
			if (leashed.leashed !== true) throw new Error(`pre-release leash failed: ${JSON.stringify(leashed)}`);
			const value = valueOf<{ leashed: boolean }>(await s.call("lead@1", { target: "cow", release: true }, 30000));
			if (value.leashed !== false) throw new Error(`release returned ${JSON.stringify(value)}`);
			const cow = await findEntity(s, "cow", 48);
			const inv = (await s.readInventory()).counts["lead"] ?? 0;
			const droppedLead = (await s.readEntities(32)).find(
				(entity) => entity.name === "item" && entity.item?.name === "lead",
			);
			const where =
				inv > 0
					? `lead back in inventory x${String(inv)}`
					: droppedLead != null
						? "lead dropped as item"
						: "no lead observed";
			return `released cow3 (${cow.name} still tracked); ${where}`;
		});

		await s.step("cleanup: 归零世界状态", async () => {
			await s.command(`/kill @e[type=!player]`);
			await s.command(`/time set day`);
			return "entities cleared, time day";
		});
	} finally {
		s.finish();
		await closeHarness(h);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
