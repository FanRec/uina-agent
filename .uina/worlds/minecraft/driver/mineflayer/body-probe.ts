/**
 * S0 证据探针（身体交互升级决策 §7）：一次连服抓全四类事实，先观测后归因。
 *
 * 1. 击退：入站 entity_velocity 原始解码值 / Mineflayer 换算后的 entity.velocity /
 *    物理 Tick 位移 / 服务端 Pos —— 静止、行走、寻路三种状态各一次。
 * 2. 交互闸门：发包前的眼位、朝向、射线首命中与目标面；隔墙必须零发包，
 *    半砖等部分形状必须能按真实命中面成功。
 * 3. 挖掘：出站 player_action / animation 包的时间序列；中断后挥手是否停止。
 * 4. GUI：窗口同步包与"是否存在可见渲染通道"（headless 客户端没有渲染面）。
 * 5. 局部自治：工作台在墙另一侧时先零派发、再绕过去用；封死时明确失败。
 * 6. 战斗：多人围攻与苦力怕引燃期的攻击/转头包间隔（逐帧响应有没有断）。
 *
 * 出站包经 client.write 包装记录（不改被测代码）；探针只读与驱动输入。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMinecraftClient } from "./adapter.js";
import { closeHarness, DEV_SERVER, openHarness, sleep, waitForStill } from "../../dev/harness.js";
import { makeScenario } from "../../dev/scenario.js";

const USER = "UinaDev";
const ATTACKER = "UinaAttacker";
const BASE = { x: 9500, y: 200, z: 9500 };

interface PacketRow {
	t: number;
	name: string;
	params: Record<string, unknown>;
	/** 发包瞬间的身体位置：用来区分"原地派发"与"换位后才派发"。 */
	pos: { x: number; y: number; z: number } | null;
}

interface VelocityRow {
	t: number;
	entityId: number;
	raw: { x: number; y: number; z: number };
	decoded: { x: number; y: number; z: number } | null;
}

interface MotionRow {
	t: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	onGround: boolean;
}

const fmt = (v: { x: number; y: number; z: number }): string =>
	`(${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)})`;

/**
 * 逐帧响应判据：客户端每物理 Tick 必发 position / position_look；朝向不变时
 * mineflayer 可以不发 look。所以"卡没卡"要看运动包间隔，只看 look 会把
 * "直线逃跑、朝向没变"误判成停顿。
 */
const motionPackets = (rows: PacketRow[]): PacketRow[] =>
	rows.filter((row) => row.name === "position" || row.name === "position_look" || row.name === "look");

const maxGap = (rows: PacketRow[]): number | null => {
	const gaps = rows.slice(1).map((row, index) => row.t - rows[index]!.t);
	return gaps.length === 0 ? null : Math.max(...gaps);
};

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-body-probe-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:body-probe-${Date.now()}` };
	const h = await openHarness("body-probe", { dataRoot, binding });
	const s = makeScenario(h, "body-probe");
	const bot = h.bot;
	// biome-ignore lint/suspicious/noExplicitAny: 探针只读协议层，生产类型不暴露 _client
	const client = (bot as any)._client as {
		write(name: string, params: unknown): void;
		on(event: string, listener: (packet: Record<string, unknown>) => void): void;
	};
	const outbound: PacketRow[] = [];
	const velocities: VelocityRow[] = [];
	const motions: MotionRow[] = [];
	const originalWrite = client.write.bind(client);
	client.write = (name: string, params: unknown): void => {
		// 深拷贝：Mineflayer 复用同一个 lastSent 对象作为包参数（physics.js），
		// 存引用会让所有记录行都显示最后一次的 yaw/pitch。structuredClone 支持 BigInt。
		const at = bot.entity?.position;
		outbound.push({
			t: Date.now(),
			name,
			params: structuredClone(params ?? {}) as Record<string, unknown>,
			pos: at == null ? null : { x: at.x, y: at.y, z: at.z },
		});
		originalWrite(name, params);
	};
	client.on("entity_velocity", (packet) => {
		const velocity = packet.velocity as { x: number; y: number; z: number } | undefined;
		const entityId = packet.entityId as number | undefined;
		if (velocity == null || entityId == null) return;
		const own = entityId === bot.entity?.id;
		velocities.push({
			t: Date.now(),
			entityId,
			raw: { ...velocity },
			decoded: own && bot.entity != null ? { ...bot.entity.velocity } : null,
		});
	});
	let sampling = false;
	const sampler = setInterval(() => {
		if (!sampling || bot.entity == null) return;
		motions.push({
			t: Date.now(),
			x: bot.entity.position.x,
			y: bot.entity.position.y,
			z: bot.entity.position.z,
			vx: bot.entity.velocity.x,
			vy: bot.entity.velocity.y,
			vz: bot.entity.velocity.z,
			onGround: bot.entity.onGround,
		});
	}, 50);
	let attacker: ReturnType<typeof connectMinecraftClient> | null = null;
	try {
		await s.step("prepare flat arena and gear", async () => {
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await s.command(
				`/fill ${BASE.x - 10} ${BASE.y - 2} ${BASE.z - 10} ${BASE.x + 10} ${BASE.y - 1} ${BASE.z + 10} minecraft:stone`,
			);
			await s.command(
				`/fill ${BASE.x - 10} ${BASE.y} ${BASE.z - 10} ${BASE.x + 10} ${BASE.y + 4} ${BASE.z + 10} minecraft:air`,
			);
			await s.command(`/kill @e[type=minecraft:item]`);
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/gamerule keep_inventory true`);
			await s.command(`/difficulty easy`);
			await s.command(`/effect clear ${USER}`);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_sword 1`);
			await s.command(`/give ${USER} minecraft:iron_pickaxe 1`);
			await s.command(`/give ${USER} minecraft:stone_slab 8`);
			await s.command(`/give ${USER} minecraft:crafting_table 1`);
			await s.command(`/gamemode survival ${USER}`);
			await s.command(`/effect give ${USER} minecraft:instant_health 1 4 true`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await sleep(500);
			await waitForStill(bot, h.log);
			attacker = connectMinecraftClient({
				host: DEV_SERVER.host,
				port: DEV_SERVER.port,
				username: ATTACKER,
				version: DEV_SERVER.version,
			});
			const deadline = Date.now() + 15000;
			while (attacker.entity == null || attacker.username == null) {
				if (Date.now() > deadline) throw new Error("attacker did not spawn");
				await sleep(200);
			}
			await s.command(`/gamemode survival ${ATTACKER}`);
			await s.command(`/effect clear ${ATTACKER}`);
			await s.command(`/tp ${ATTACKER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z - 1.2}`);
			await sleep(600);
			return `arena at ${BASE.x},${BASE.y},${BASE.z}; attacker=${attacker.username}`;
		});

		const hitOnce = async (tag: string): Promise<string> => {
			if (attacker == null) throw new Error("attacker missing");
			const p = bot.entity.position;
			await s.command(`/tp ${ATTACKER} ${p.x} ${p.y} ${p.z - 1.4}`);
			await sleep(180);
			await attacker.lookAt(p.offset(0, 1.2, 0));
			attacker.attack(bot.entity);
			await sleep(900);
			const own = velocities.filter((row) => row.entityId === bot.entity.id);
			const first = own[0];
			const row = motions.find((motion) => motion.t >= (first?.t ?? 0));
			const after = motions.filter((motion) => motion.t >= (first?.t ?? 0));
			const drift =
				row != null && after.length > 1
					? Math.hypot(after[after.length - 1]!.x - row.x, after[after.length - 1]!.z - row.z)
					: 0;
			return `${tag}: packets=${own.length} raw=${first != null ? fmt(first.raw) : "none"} decoded=${
				first?.decoded != null ? fmt(first.decoded) : "none"
			} horizontalDrift=${drift.toFixed(3)}`;
		};

		await s.step("knockback while standing", async () => {
			sampling = true;
			velocities.length = 0;
			motions.length = 0;
			const detail = await hitOnce("idle");
			sampling = false;
			return detail;
		});

		await s.step("knockback while walking", async () => {
			bot.setControlState("forward", true);
			await sleep(700);
			sampling = true;
			velocities.length = 0;
			motions.length = 0;
			const detail = await hitOnce("walking");
			bot.setControlState("forward", false);
			sampling = false;
			return detail;
		});

		await s.step("knockback while pathfinding", async () => {
			const spawned = await s.spawn("goto@1", {
				at: { x: BASE.x + 8, y: BASE.y, z: BASE.z + 0.5 },
				tolerance: 1,
				maxTimeMs: 15000,
			});
			await sleep(700);
			sampling = true;
			velocities.length = 0;
			motions.length = 0;
			const detail = await hitOnce("goto");
			sampling = false;
			await s.waitCall(spawned, 16000);
			return detail;
		});

		await s.step("blocked interaction behind a wall dispatches nothing from the start", async () => {
			await s.command(`/setblock ${BASE.x + 3} ${BASE.y} ${BASE.z + 1} minecraft:stone`);
			await s.command(`/setblock ${BASE.x + 3} ${BASE.y + 1} ${BASE.z + 1} minecraft:stone`);
			await s.command(`/setblock ${BASE.x + 4} ${BASE.y} ${BASE.z + 1} minecraft:chest`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 1.5}`);
			await sleep(600);
			outbound.length = 0;
			const start = await s.readSelf();
			const result = await s.call("container@1", { at: { x: BASE.x + 4, y: BASE.y, z: BASE.z + 1 } });
			const sends = outbound.filter((row) => row.name === "block_place");
			// 从出发位置发出的交互包：>0 就是隔墙派发，=0 才说明闸门挡住了第一次尝试。
			const fromStart = sends.filter(
				(row) =>
					row.pos != null && Math.hypot(row.pos.x - start.place.position.x, row.pos.z - start.place.position.z) < 0.75,
			).length;
			return `ok=${result.ok} code=${result.code ?? "none"} dispatch=${sends.length} fromStart=${fromStart} at=[${sends
				.map((row) => (row.pos == null ? "?" : `${row.pos.x.toFixed(1)},${row.pos.z.toFixed(1)}`))
				.join(" ")}] start=${start.place.position.x.toFixed(1)},${start.place.position.z.toFixed(1)}`;
		});

		await s.step("partial shape is hittable on its real face", async () => {
			// 门是部分形状（一格厚、两格高）：命中面必须来自真实 AABB，而不是方块中心。
			await s.command(`/setblock ${BASE.x + 2} ${BASE.y} ${BASE.z} minecraft:oak_door[half=lower,facing=north]`);
			await s.command(`/setblock ${BASE.x + 2} ${BASE.y + 1} ${BASE.z} minecraft:oak_door[half=upper,facing=north]`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await sleep(400);
			outbound.length = 0;
			const result = await s.call("use@1", { at: { x: BASE.x + 2, y: BASE.y, z: BASE.z } });
			const sends = outbound.filter((row) => row.name === "block_place");
			const packet = sends[0]?.params as
				| {
						location?: { x: number; y: number; z: number };
						direction?: number;
						cursorX?: number;
						cursorY?: number;
						cursorZ?: number;
				  }
				| undefined;
			const opened = await s.readBlock({ x: BASE.x + 2, y: BASE.y, z: BASE.z });
			return `ok=${result.ok} code=${result.code ?? "none"} sends=${sends.length} face=${packet?.direction ?? "none"} cursor=${
				packet != null ? `(${packet.cursorX},${packet.cursorY},${packet.cursorZ})` : "none"
			} open=${opened?.properties.open ?? "?"}`;
		});

		await s.step("180-degree turn is spread over ticks before dispatch", async () => {
			await s.command(`/setblock ${BASE.x} ${BASE.y} ${BASE.z - 3} minecraft:oak_door[half=lower,facing=south]`);
			await s.command(`/setblock ${BASE.x} ${BASE.y + 1} ${BASE.z - 3} minecraft:oak_door[half=upper,facing=south]`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await sleep(400);
			// 先朝南（yaw 0），目标在北（yaw 180）：整段转头必须逐 Tick 限速。
			await bot.look(Math.PI, 0, true);
			await sleep(200);
			// 记录 aim 期间每次 look 调用参数与发包 yaw：区分"逐步转头"与"瞬转"。
			const lookCalls: number[] = [];
			const entityYaws: number[] = [];
			const originalLook = bot.look.bind(bot);
			bot.look = async (yaw: number, pitch: number, force?: boolean) => {
				lookCalls.push((yaw * 180) / Math.PI);
				const result = await originalLook(yaw, pitch, force ?? false);
				entityYaws.push((bot.entity.yaw * 180) / Math.PI);
				return result;
			};
			outbound.length = 0;
			const aimStarted = Date.now();
			const result = await s.call("use@1", { at: { x: BASE.x, y: BASE.y, z: BASE.z - 3 } });
			bot.look = originalLook;
			const looks = outbound.filter((row) => row.name === "look" || row.name === "position_look");
			const yaws = looks.map((row) => row.params.yaw as number);
			const steps = yaws.slice(1).map((yaw, index) => {
				let delta = Math.abs(yaw - yaws[index]!);
				if (delta > 180) delta = 360 - delta;
				return delta;
			});
			const maxStep = steps.length === 0 ? 0 : Math.max(...steps);
			const sends = outbound.filter((row) => row.name === "block_place");
			const placeIndex = outbound.findIndex((row) => row.name === "block_place");
			const looksBeforeDispatch = outbound
				.slice(0, placeIndex < 0 ? undefined : placeIndex)
				.filter((row) => row.name === "look" || row.name === "position_look").length;
			const head = looks.slice(0, 10).map((row) => `${row.t - aimStarted}ms/${row.params.yaw as number}`);
			return `ok=${result.ok} code=${result.code ?? "none"} entityYaws=[${entityYaws.map((value) => value.toFixed(0)).join(",")}] lookCalls=${lookCalls.length} [${lookCalls
				.map((value) => value.toFixed(0))
				.join(
					",",
				)}] lookPackets=${looks.length} [${yaws.map((value) => value.toFixed(0)).join(",")}] beforeDispatch=${looksBeforeDispatch} sends=${
				sends.length
			} maxYawStep=${maxStep.toFixed(1)}deg head=${head.join(" | ")}`;
		});

		await s.step("dig packet timeline and continuous swings", async () => {
			await s.command(`/setblock ${BASE.x - 2} ${BASE.y} ${BASE.z} minecraft:iron_block`);
			await s.command(`/tp ${USER} ${BASE.x - 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await sleep(400);
			outbound.length = 0;
			const result = await s.call("mine@1", { at: { x: BASE.x - 2, y: BASE.y, z: BASE.z } }, 20000);
			const actions = outbound.filter((row) => row.name === "block_dig");
			const animations = outbound.filter((row) => row.name === "arm_animation");
			const start = actions[0]?.t ?? 0;
			return `ok=${result.ok} code=${result.code ?? "none"} actions=${actions.map((row) => `${row.params.status}@${row.t - start}ms`).join(",")} swings=${
				animations.length
			} swingGaps=${animations
				.slice(1)
				.map((row, index) => row.t - animations[index]!.t)
				.join(",")}`;
		});

		await s.step("cancelled dig stops swings and sends one cancel", async () => {
			await s.command(`/setblock ${BASE.x - 2} ${BASE.y + 1} ${BASE.z} minecraft:stone`);
			await s.command(`/tp ${USER} ${BASE.x - 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await sleep(300);
			outbound.length = 0;
			const spawned = await s.spawn("mine@1", { at: { x: BASE.x - 2, y: BASE.y + 1, z: BASE.z } });
			await sleep(450);
			const stoppedAt = Date.now();
			await h.runtime.stop({ requestId: `stop:${spawned.requestId}`, target: { run: spawned.run } });
			await sleep(900);
			const actions = outbound.filter((row) => row.name === "block_dig");
			const animations = outbound.filter((row) => row.name === "arm_animation");
			const cancel = actions.find((row) => row.params.status === 1);
			const swingsAfterCancel =
				cancel == null ? animations.length : animations.filter((row) => row.t > cancel.t).length;
			return `actions=${actions.map((row) => `${row.params.status}@${row.t - stoppedAt}ms`).join(",")} swings=${animations.length} afterCancel=${swingsAfterCancel} stopToCancel=${cancel == null ? "none" : `${cancel.t - stoppedAt}ms`}`;
		});

		await s.step("gui window packets and rendering channel", async () => {
			await s.command(`/setblock ${BASE.x + 1} ${BASE.y} ${BASE.z - 2} minecraft:chest`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z - 0.5}`);
			await sleep(400);
			outbound.length = 0;
			const result = await s.call("container@1", {
				at: { x: BASE.x + 1, y: BASE.y, z: BASE.z - 2 },
			});
			const opens = outbound.filter((row) => row.name === "window_click").length;
			const clicks = outbound.filter((row) => row.name === "window_click").length;
			// 渲染通道核查：headless 客户端只有协议窗口状态（container.last@1 数据投影），
			// 没有任何可被观众看到的画面出口；这里如实记录，不假装存在。
			const visible = false;
			return `ok=${result.ok} code=${result.code ?? "none"} windowClicks=${opens} windowClickPackets=${clicks} visibleRenderChannel=${visible}`;
		});

		// ---- §8 反例一：工作台在墙另一侧（直线 < 4.5 格，视线被挡） ----
		await s.step("workstation behind a wall relocates without breaking blocks", async () => {
			const wallX = BASE.x + 2;
			const tableAt = { x: BASE.x + 3, y: BASE.y, z: BASE.z };
			// 墙 5 格宽、两层高，两端留口：绕过去是合法换位，不需要挖穿。
			await s.command(`/fill ${wallX} ${BASE.y} ${BASE.z - 2} ${wallX} ${BASE.y + 1} ${BASE.z + 2} minecraft:stone`);
			await s.command(`/setblock ${tableAt.x} ${tableAt.y} ${tableAt.z} minecraft:crafting_table`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_ingot 3`);
			await s.command(`/give ${USER} minecraft:stick 2`);
			await sleep(500);
			outbound.length = 0;
			const start = await s.readSelf();
			const result = await s.call("craft@1", { item: "iron_pickaxe", station: "crafting_table" }, 45000);
			const places = outbound.filter((row) => row.name === "block_place");
			// 从出发位置发出的交互包数：>0 说明闸门放过了隔墙派发。
			const fromStart = places.filter(
				(row) =>
					row.pos != null && Math.hypot(row.pos.x - start.place.position.x, row.pos.z - start.place.position.z) < 0.75,
			).length;
			const inventory = await s.readInventory();
			return `ok=${result.ok} code=${result.code ?? "none"} dispatch=${places.length} fromStart=${fromStart} at=[${places
				.map((row) => (row.pos == null ? "?" : `${row.pos.x.toFixed(1)},${row.pos.z.toFixed(1)}`))
				.join(" ")}] pickaxes=${inventory.counts.iron_pickaxe ?? 0}`;
		});

		// ---- §8 反例二：工作台被封死，任何换位都到不了 ----
		await s.step("sealed workstation fails as a blocked interaction", async () => {
			// 先移走上一格的工作台，避免就近站台选到它。
			await s.command(`/setblock ${BASE.x + 3} ${BASE.y} ${BASE.z} minecraft:air`);
			const tableAt = { x: BASE.x + 1, y: BASE.y, z: BASE.z + 3 };
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			// 目标四周（含 ±2 环）灌满石头：直线 2.5 格，但没有任何合法站位。
			await s.command(
				`/fill ${tableAt.x - 2} ${tableAt.y - 1} ${tableAt.z - 2} ${tableAt.x + 2} ${tableAt.y + 1} ${tableAt.z + 2} minecraft:stone`,
			);
			await s.command(`/setblock ${tableAt.x} ${tableAt.y} ${tableAt.z} minecraft:crafting_table`);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_ingot 3`);
			await s.command(`/give ${USER} minecraft:stick 2`);
			await sleep(400);
			outbound.length = 0;
			const result = await s.call("craft@1", { item: "iron_pickaxe", station: "crafting_table" }, 45000);
			const places = outbound.filter((row) => row.name === "block_place");
			return `ok=${result.ok} code=${result.code ?? "none"} dispatch=${places.length}`;
		});

		// ---- §8 反例三：多人围攻下的逐帧响应 ----
		await s.step("fight keeps per-frame steering under a mob pile", async () => {
			const FIGHT = { x: BASE.x + 24, y: BASE.y, z: BASE.z };
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/kill @e[type=minecraft:creeper]`);
			await s.command(
				`/fill ${FIGHT.x - 8} ${FIGHT.y - 2} ${FIGHT.z - 8} ${FIGHT.x + 8} ${FIGHT.y - 1} ${FIGHT.z + 8} minecraft:stone`,
			);
			await s.command(
				`/fill ${FIGHT.x - 8} ${FIGHT.y} ${FIGHT.z - 8} ${FIGHT.x + 8} ${FIGHT.y + 4} ${FIGHT.z + 8} minecraft:air`,
			);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_sword 1`);
			// 抗性 + 回血：目的是测逐帧节奏，不是测伤害包络（那是 dev:mc:combat 的事）。
			await s.command(`/effect give ${USER} minecraft:resistance 120 4 true`);
			await s.command(`/effect give ${USER} minecraft:regeneration 120 2 true`);
			await s.command(`/tp ${USER} ${FIGHT.x + 0.5} ${FIGHT.y} ${FIGHT.z + 0.5}`);
			await sleep(400);
			for (const [dx, dz] of [
				[2.5, 0],
				[-2.5, 0.5],
				[0, 2.5],
			] as const) {
				await s.command(`/summon minecraft:zombie ${FIGHT.x + dx} ${FIGHT.y} ${FIGHT.z + dz} {PersistenceRequired:1b}`);
			}
			await sleep(600);
			outbound.length = 0;
			const result = await s.call(
				"fight@1",
				{ radius: 16, stance: "aggressive", retreatHealth: 0, maxTimeMs: 20000 },
				40000,
			);
			const attacks = outbound.filter(
				(row) => row.name === "attack" || (row.name === "use_entity" && row.params.mouse === 1),
			);
			const looks = outbound.filter((row) => row.name === "look" || row.name === "position_look");
			const attackGaps = attacks.slice(1).map((row, index) => row.t - attacks[index]!.t);
			const lookGap = maxGap(looks);
			const motionGap = maxGap(motionPackets(outbound));
			const value = result.value as
				| { ended?: string; kills?: unknown[]; hp?: { before: number | null; after: number | null } }
				| undefined;
			return `ok=${result.ok} code=${result.code ?? "none"} ended=${value?.ended ?? "?"} kills=${
				value?.kills?.length ?? 0
			} hp=${value?.hp?.before ?? "?"}->${value?.hp?.after ?? "?"} attacks=${attacks.length} maxAttackGap=${
				attackGaps.length === 0 ? "none" : `${Math.max(...attackGaps)}ms`
			} maxMotionGap=${motionGap == null ? "none" : `${motionGap}ms`} maxLookGap=${
				lookGap == null ? "none" : `${lookGap}ms`
			}`;
		});

		// ---- §8 反例四：苦力怕引燃期仍然逐帧在动 ----
		await s.step("fight keeps steering through a creeper fuse", async () => {
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/kill @e[type=minecraft:creeper]`);
			await s.command(`/tp ${USER} ${BASE.x + 24.5} ${BASE.y} ${BASE.z + 0.5}`);
			await s.command(`/effect give ${USER} minecraft:resistance 120 4 true`);
			await s.command(`/effect give ${USER} minecraft:regeneration 120 2 true`);
			await s.command(`/summon minecraft:creeper ${BASE.x + 27.5} ${BASE.y} ${BASE.z + 0.5} {PersistenceRequired:1b}`);
			await sleep(500);
			outbound.length = 0;
			const result = await s.call("fight@1", { target: "creeper", stance: "balanced", maxTimeMs: 20000 }, 40000);
			const attacks = outbound.filter(
				(row) => row.name === "attack" || (row.name === "use_entity" && row.params.mouse === 1),
			);
			const looks = outbound.filter((row) => row.name === "look" || row.name === "position_look");
			const lookGap = maxGap(looks);
			const motionGap = maxGap(motionPackets(outbound));
			const value = result.value as
				| { ended?: string; hp?: { before: number | null; after: number | null } }
				| undefined;
			const alive = (await s.readEntities(24)).filter((entity) => entity.name === "creeper").length;
			return `ok=${result.ok} code=${result.code ?? "none"} ended=${value?.ended ?? "?"} hp=${
				value?.hp?.before ?? "?"
			}->${value?.hp?.after ?? "?"} attacks=${attacks.length} maxMotionGap=${
				motionGap == null ? "none" : `${motionGap}ms`
			} maxLookGap=${lookGap == null ? "none" : `${lookGap}ms`} creepersLeft=${alive}`;
		});
		await s.step("dig from facing away turns per tick before the first dig packet", async () => {
			await s.command(`/setblock ${BASE.x + 2} ${BASE.y} ${BASE.z} minecraft:oak_log`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 0.5}`);
			await sleep(300);
			// 目标在 +x，把朝向摆到 -x（yaw=+90°）：挖之前必须逐 Tick 转回来。
			await bot.look(Math.PI / 2, 0, true);
			await sleep(200);
			outbound.length = 0;
			const result = await s.call("mine@1", { at: { x: BASE.x + 2, y: BASE.y, z: BASE.z } }, 20000);
			const looks = outbound.filter((row) => row.name === "look" || row.name === "position_look");
			const firstDig = outbound.find((row) => row.name === "block_dig");
			const looksBeforeDig = firstDig == null ? 0 : looks.filter((row) => row.t < firstDig.t).length;
			const swings = outbound.filter((row) => row.name === "arm_animation").length;
			if (!result.ok || looksBeforeDig < 2)
				throw new Error(`dig must turn before dispatching: ok=${result.ok} looksBeforeDig=${looksBeforeDig}`);
			return `ok=${result.ok} code=${result.code ?? "none"} looks=${looks.length} looksBeforeDig=${looksBeforeDig} swings=${swings}`;
		});

		await s.step("entity interaction behind a wall dispatches nothing", async () => {
			// 前面的封死工作台步骤会留下 5×3×5 石头；这里先清出测试空地，再摆墙。
			await s.command(`/kill @e[type=minecraft:zombie]`);
			await s.command(`/fill ${BASE.x} ${BASE.y} ${BASE.z} ${BASE.x + 3} ${BASE.y + 2} ${BASE.z + 2} minecraft:air`);
			await sleep(200);
			await s.command(`/setblock ${BASE.x + 1} ${BASE.y} ${BASE.z + 1} minecraft:stone`);
			await s.command(`/setblock ${BASE.x + 1} ${BASE.y + 1} ${BASE.z + 1} minecraft:stone`);
			await s.command(`/tp ${USER} ${BASE.x + 0.5} ${BASE.y} ${BASE.z + 1.5}`);
			await s.command(
				`/summon minecraft:zombie ${BASE.x + 2.7} ${BASE.y} ${BASE.z + 1.5} {NoAI:1b,PersistenceRequired:1b}`,
			);
			await sleep(500);
			const zombie = (await s.readEntities(8)).find((entity) => entity.name === "zombie");
			if (zombie == null) throw new Error("zombie did not spawn");
			outbound.length = 0;
			const result = await s.call("use@1", { entity: { networkId: zombie.ref.networkId } }, 15000);
			const uses = outbound.filter((row) => row.name === "use_entity").length;
			if (result.ok || result.code !== "UNREACHABLE" || uses !== 0)
				throw new Error(`blocked entity must not activate: ok=${result.ok} code=${result.code} use=${uses}`);
			return `ok=${result.ok} code=${result.code ?? "none"} use_entity=${uses} msg=${result.message ?? ""}`;
		});

		await s.step("entity interaction in the open dispatches exactly one activation", async () => {
			await s.command(`/setblock ${BASE.x + 1} ${BASE.y} ${BASE.z + 1} minecraft:air`);
			await s.command(`/setblock ${BASE.x + 1} ${BASE.y + 1} ${BASE.z + 1} minecraft:air`);
			await sleep(300);
			const zombie = (await s.readEntities(8)).find((entity) => entity.name === "zombie");
			if (zombie == null) throw new Error("zombie disappeared");
			outbound.length = 0;
			const selfNow = await s.readSelf();
			const head = await s.readBlock({ x: BASE.x, y: BASE.y + 1, z: BASE.z + 1 });
			const ahead = await s.readBlock({ x: BASE.x + 1, y: BASE.y + 1, z: BASE.z + 1 });
			const result = await s.call("use@1", { entity: { networkId: zombie.ref.networkId } }, 15000);
			const uses = outbound.filter((row) => row.name === "use_entity").length;
			if (!result.ok || uses !== 1)
				throw new Error(`open entity must activate exactly once: ok=${result.ok} code=${result.code} use=${uses}`);
			return `ok=${result.ok} code=${result.code ?? "none"} use_entity=${uses} self=${JSON.stringify(
				selfNow.place.position,
			)} head=${head?.name} ahead=${ahead?.name} zombie=${JSON.stringify(zombie.position)} msg=${result.message ?? ""}`;
		});
	} finally {
		clearInterval(sampler);
		(attacker as { quit?: () => void } | null)?.quit?.();
		await closeHarness(h);
	}
	process.exitCode = s.finish();
}

await main();
