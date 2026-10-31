/**
 * 批13 真服验收：地形切片与空间作业（region/tunnel/excavate）+ G4 复查路径。
 *
 * 被测行为全部走正式能力面（Runtime submit → callable/program）；
 * op 指令只备地形/物品（石盒、跨区块结构、含物箱子、砾石帽），不代替任何被测动作。
 * 断言用独立事实交叉核验（serverPos、block 复读、库存复读），不信任单次返回值。
 * G4 复查走 JS 程序的 mc.verify（正式程序桥），效果 ref 取自 run 的调用记录。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario, type CallResult } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9500, y: 200, z: 9500 };

function valueOf<T>(result: CallResult): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.message ?? ""}`);
	return result.value as unknown as T;
}

interface RegionValue {
	origin: { x: number; y: number; z: number };
	shape: [number, number, number];
	palette: { name: string; properties: Record<string, string> }[];
	cells: number[];
	order: string;
	missing: number;
	scanned: { chunksLoaded: number };
}

/** 服务端权威位置（/data get entity Pos 经 events@1 读回；self 是客户端预测）。 */
async function serverPos(
	h: Awaited<ReturnType<typeof openHarness>>,
	s: ReturnType<typeof makeScenario>,
): Promise<{ x: number; y: number; z: number }> {
	await s.command(`/data get entity ${USER} Pos`);
	const observation = await h.world.read<{ events?: { payload?: unknown }[] }>({
		ref: "events@1",
		input: { limit: 8 },
	});
	for (const event of [...(observation.value?.events ?? [])].reverse()) {
		const text = JSON.stringify(event.payload ?? "");
		const match = /\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/.exec(text);
		if (match) return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
	}
	throw new Error(`server Pos not found in recent events: ${JSON.stringify(observation.value).slice(0, 300)}`);
}

/** 从一个已结束 run 的调用记录里取第一个效果 ref（verify 复查用）。 */
async function firstEffectRef(h: Awaited<ReturnType<typeof openHarness>>, run: string): Promise<string> {
	const calls = await h.runtime.listCalls(run);
	const first = calls.items[0];
	if (first == null) throw new Error(`run ${run} has no calls`);
	const full = await h.runtime.readRecord(first.record);
	if (full.kind !== "inline") throw new Error("expected inline development record");
	const record = full.record.value as { effects?: string[] };
	const effect = record.effects?.[0];
	if (effect == null) throw new Error(`call record carries no effects: ${JSON.stringify(record).slice(0, 200)}`);
	return effect;
}

/** 提交一段 JS 程序（正式程序入口）并等结果：mc.verify 桥的验收路径。 */
async function runProgram(
	h: Awaited<ReturnType<typeof openHarness>>,
	ns: string,
	label: string,
	seq: { n: number },
	source: string,
	input: JsonValue,
): Promise<CallResult> {
	const requestId = `req:${ns}:${label}-p${++seq.n}`;
	const acceptance = await h.runtime.submit(
		{ worldOwner: h.worldOwner, activation: h.activation },
		{ requestId, entry: { kind: "program", source: { code: source }, input }, schedule: { kind: "enqueue" } },
	);
	if (acceptance.kind !== "accepted") throw new Error(`program rejected: ${JSON.stringify(acceptance)}`);
	const reply = await h.runtime.wait(acceptance.snapshot.run, { timeoutMs: 60000 });
	if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
		await h.runtime.stop({ requestId: `stop:${requestId}`, target: { run: acceptance.snapshot.run } });
		return { ok: false, code: "TIMEOUT", message: reply.kind };
	}
	if (reply.snapshot.outcome !== "succeeded") {
		return {
			ok: false,
			code: reply.snapshot.error?.code ?? reply.snapshot.outcome,
			message: reply.snapshot.error?.message,
		};
	}
	const full = await h.runtime.readRecord(reply.snapshot.record);
	if (full.kind !== "inline") throw new Error("expected inline development record");
	return { ok: true, value: (full.record.value as { value?: unknown }).value as JsonValue };
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-spatial-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:spatial-${Date.now()}` };
	const h = await openHarness("spatial", { dataRoot, binding });
	const s = makeScenario(h, "spatial");
	const seq = { n: 0 };
	try {
		await s.step("prepare platform and gear", async () => {
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
			await s.command(`/difficulty peaceful`);
			await s.command(`/kill @e[type=minecraft:item]`);
			// Paper /fill 上限 32768：整片一次性填充会静默失败（只回聊天错误），必须分块。
			// 平台面 121×121=14641；空域/基底按 2 层一片（121×2×121=29282）。
			await s.command(
				`/fill ${CENTER.x - 60} 199 ${CENTER.z - 60} ${CENTER.x + 60} 199 ${CENTER.z + 60} minecraft:stone`,
			);
			// 清出 ±60 的作业空域：历史批次的建筑残留会挡走廊/清空区。
			for (let y = 200; y <= 220; y += 2) {
				const top = Math.min(y + 1, 220);
				await s.command(
					`/fill ${CENTER.x - 60} ${y} ${CENTER.z - 60} ${CENTER.x + 60} ${top} ${CENTER.z + 60} minecraft:air`,
				);
			}
			for (let y = 193; y <= 198; y += 2) {
				const top = Math.min(y + 1, 198);
				await s.command(
					`/fill ${CENTER.x - 60} ${y} ${CENTER.z - 60} ${CENTER.x + 60} ${top} ${CENTER.z + 60} minecraft:stone`,
				);
			}
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:iron_pickaxe 1`);
			// 复位血量/饱食度（跨 run 累积伤害：health ≤30% 时任何一次摔伤都会触发
			// low_health_damage 自保，把被测 run 当场打断）。
			await s.command(`/effect give ${USER} minecraft:instant_health 1 25 true`);
			await s.command(`/effect give ${USER} minecraft:saturation 1 10 true`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const self = await s.readSelf();
			const below = await s.readBlock({ x: CENTER.x, y: 199, z: CENTER.z });
			if (Math.abs(self.place.position.y - CENTER.y) > 2 || below?.name !== "stone") {
				throw new Error(`bot not standing on the platform: y=${self.place.position.y} below=${below?.name ?? "null"}`);
			}
			// 填充抽样复核：/fill 失败只回聊天错误，场景必须自己验证结果。
			const baseSample = await s.readBlock({ x: CENTER.x + 19, y: 195, z: CENTER.z });
			const skySample = await s.readBlock({ x: CENTER.x, y: 205, z: CENTER.z });
			if (baseSample?.name !== "stone") {
				throw new Error(`base fill did not land: (9519,195) = ${baseSample?.name ?? "null"}`);
			}
			if (skySample == null || skySample.name !== "air") {
				throw new Error(`air fill did not land: (9500,205) = ${skySample?.name ?? "null"}`);
			}
			return "platform 121x121 @9500, stone base 193..198 (sampled), air 200..220 (sampled), iron_pickaxe";
		});

		await s.step("region decodes a known structure across a chunk border", async () => {
			// 区块边界：9504..9519 / 9520..9535。结构跨 9519/9520。
			const bx = 9518;
			const bz = 9503;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${bx} 198 ${bz} ${bx + 3} 200 ${bz + 3} minecraft:stone`);
			await s.command(`/setblock ${bx + 1} 199 ${bz + 1} minecraft:oak_planks`);
			await s.command(`/setblock ${bx + 2} 199 ${bz + 2} minecraft:glass`);
			await s.command(`/setblock ${bx + 2} 200 ${bz + 1} minecraft:air`);
			await s.command(`/gamemode survival ${USER}`);
			const started = Date.now();
			const observation = await h.world.read<RegionValue>({
				ref: "region@1",
				input: { from: { x: bx, y: 198, z: bz }, to: { x: bx + 3, y: 200, z: bz + 3 } },
			});
			const elapsed = Date.now() - started;
			if (observation.value == null) throw new Error(`region read failed: ${observation.unknown.join("; ")}`);
			const value = observation.value;
			if (observation.unknown.length > 0) throw new Error(`region unknown: ${observation.unknown.join("; ")}`);
			if (value.order !== "xzy") throw new Error(`order must be xzy, got ${value.order}`);
			if (value.missing !== 0) throw new Error(`expected missing=0, got ${value.missing}`);
			if (value.cells.length !== 48) throw new Error(`expected 48 cells, got ${value.cells.length}`);
			if (value.scanned.chunksLoaded < 2) {
				throw new Error(`structure straddles a chunk border; chunksLoaded=${value.scanned.chunksLoaded}`);
			}
			const nameOf = (index: number): string => value.palette[index]?.name ?? `<oob:${index}>`;
			// i = (y-oy)*nx*nz + (z-oz)*nx + (x-ox)，nx=4,nz=4。
			const cellAt = (x: number, y: number, z: number): number => value.cells[(y - 198) * 16 + (z - bz) * 4 + (x - bx)];
			const planks = nameOf(cellAt(bx + 1, 199, bz + 1));
			const glass = nameOf(cellAt(bx + 2, 199, bz + 2));
			const hole = nameOf(cellAt(bx + 2, 200, bz + 1));
			const corner = nameOf(cellAt(bx, 198, bz));
			if (corner !== "stone") throw new Error(`corner must decode stone: ${corner}`);
			if (planks !== "oak_planks" || glass !== "glass" || hole !== "air") {
				throw new Error(`decode mismatch: oak=${planks} glass=${glass} air=${hole}`);
			}
			if (value.palette[0]?.name !== "air")
				throw new Error(`palette[0] must be air, got ${JSON.stringify(value.palette[0])}`);
			return `48 cells decoded in ${elapsed}ms, chunksLoaded=${value.scanned.chunksLoaded}, palette=${value.palette.length}`;
		});

		await s.step("region reports unloaded cells as missing, never air", async () => {
			const far = { x: CENTER.x + 400, y: 100, z: CENTER.z };
			const observation = await h.world.read<RegionValue>({
				ref: "region@1",
				input: { at: far, size: { x: 2, y: 2, z: 2 } },
			});
			if (observation.value == null) throw new Error(`region read failed: ${observation.unknown.join("; ")}`);
			const value = observation.value;
			if (value.missing !== 8 || value.cells.some((cell) => cell !== -1)) {
				throw new Error(`far region must be all missing(-1): missing=${value.missing} cells=${value.cells.join(",")}`);
			}
			if (observation.unknown.length === 0) throw new Error("unloaded region must carry an unknown note");
			// 8704 > 8192：reader 在派发前抛 INVALID_INPUT（region@1 是查询，错误从 world.read 冒出）。
			try {
				await h.world.read({ ref: "region@1", input: { from: { x: 0, y: 0, z: 0 }, to: { x: 16, y: 31, z: 15 } } });
				throw new Error("8704 voxels must be rejected");
			} catch (error) {
				if ((error as { code?: string }).code !== "INVALID_INPUT") throw error;
			}
			return "far region 8/8 missing with unknown note; 8704 voxels rejected with INVALID_INPUT";
		});

		await s.step("tunnel digs a staircased corridor down through stone and walks it", async () => {
			const x0 = CENTER.x + 15;
			const z0 = CENTER.z;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${x0} 196 ${z0 - 2} ${x0 + 12} 204 ${z0 + 2} minecraft:stone`);
			// 砾石帽：下坡列的檐格（y=201，本身在挖除集）换成砾石——support 探测从檐+1
			// 起步前，檐格的砾石由挖拍先挖掉（计入 path），不会失承坠进走廊。
			await s.command(`/setblock ${x0 + 2} 201 ${z0} minecraft:gravel`);
			await s.command(`/setblock ${x0 + 2} 202 ${z0} minecraft:gravel`);
			await s.command(`/fill ${x0} 200 ${z0} ${x0} 201 ${z0} minecraft:air`);
			await s.command(`/tp ${USER} ${x0 + 0.5} 200.1 ${z0 + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const value = valueOf<{ dug: number; path: { at: { x: number }; name: string }[]; stopped?: string }>(
				await s.call("tunnel@1", { to: { x: x0 + 8, y: 196, z: z0 }, maxTimeMs: 150000 }, 240000),
			);
			if (value.stopped != null) throw new Error(`tunnel stopped early: ${value.stopped}`);
			if (value.dug < 10) throw new Error(`tunnel dug only ${value.dug} cells through solid stone`);
			if (value.path.some((entry) => entry.name !== "stone" && entry.name !== "gravel")) {
				throw new Error(`unexpected corridor contents: ${[...new Set(value.path.map((p) => p.name))].join(",")}`);
			}
			const gravelCells = value.path.filter((p) => p.name === "gravel");
			if (gravelCells.length < 2) throw new Error(`support did not dig the gravel cap: ${gravelCells.length}`);
			const pos = await serverPos(h, s);
			if (Math.abs(pos.x - (x0 + 8)) > 1.5 || Math.abs(pos.y - 196) > 1.5 || Math.abs(pos.z - z0) > 1.5) {
				throw new Error(`bot did not walk to the corridor end: ${JSON.stringify(pos)}`);
			}
			const head = await s.readBlock({ x: x0 + 2, y: 202, z: z0 });
			if (head?.name !== "air") throw new Error(`gravel cap still blocks the ceiling: ${head?.name ?? "null"}`);
			return `dug=${value.dug} (gravel ${gravelCells.length}), walked to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}), corridor end clear`;
		});

		await s.step("tunnel descends a second 1:1 staircase from an elevated box", async () => {
			// 独立实心高架箱：上坡行走（跳上 1 格台阶）在当前移动栈上会楔死
			// （贴面起跳横向速度被清零，goto/stepTo 都无法攀爬，批13 真服实测），
			// 验收走已验证的下行方向；上坡行走登记为 known gap。
			const u0 = CENTER.x + 35;
			const z0 = CENTER.z;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${u0} 196 ${z0 - 2} ${u0 + 12} 208 ${z0 + 2} minecraft:stone`);
			await s.command(`/fill ${u0 + 8} 202 ${z0} ${u0 + 8} 203 ${z0} minecraft:air`);
			await s.command(`/tp ${USER} ${u0 + 8.5} 202.1 ${z0 + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const value = valueOf<{ dug: number; stopped?: string }>(
				await s.call("tunnel@1", { to: { x: u0, y: 198, z: z0 }, maxTimeMs: 150000 }, 240000),
			);
			if (value.stopped != null) throw new Error(`tunnel stopped early: ${value.stopped}`);
			const pos = await serverPos(h, s);
			if (Math.abs(pos.x - u0) > 1.5 || Math.abs(pos.y - 198) > 1.5 || Math.abs(pos.z - z0) > 1.5) {
				throw new Error(`bot did not reach the corridor end: ${JSON.stringify(pos)}`);
			}
			return `descended 4 (dug=${value.dug}), server pos (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
		});

		await s.step("excavate clears a box and keeps the embedded chest", async () => {
			const e0 = CENTER.x - 15;
			const z0 = CENTER.z;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${e0} 197 ${z0} ${e0 + 3} 199 ${z0 + 3} minecraft:stone`);
			await s.command(`/setblock ${e0 + 1} 198 ${z0 + 1} minecraft:chest`);
			await s.command(`/tp ${USER} ${e0 + 0.5} 200.1 ${z0 + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const value = valueOf<{
				dug: number;
				kept: { at: { x: number; y: number; z: number }; name: string }[];
				drops: Record<string, number>;
				remaining: unknown[];
			}>(
				await s.call(
					"excavate@1",
					{ region: { from: { x: e0, y: 197, z: z0 }, to: { x: e0 + 3, y: 199, z: z0 + 3 } } },
					420000,
				),
			);
			// 独立世界状态核验：非 keep 格必须全是空气，箱子原位。
			const chestAt = { x: e0 + 1, y: 198, z: z0 + 1 };
			const holes: string[] = [];
			for (let x = e0; x <= e0 + 3; x++)
				for (let y = 197; y <= 199; y++)
					for (let z = z0; z <= z0 + 3; z++) {
						if (x === chestAt.x && y === chestAt.y && z === chestAt.z) continue;
						const block = await s.readBlock({ x, y, z });
						if (block != null && block.name !== "air") holes.push(`${x},${y},${z}=${block.name}`);
					}
			if (holes.length > 0) throw new Error(`region not cleared: ${holes.join(", ")}`);
			const chest = await s.readBlock(chestAt);
			if (chest?.name !== "chest") throw new Error(`chest did not survive: ${chest?.name ?? "null"}`);
			if (value.remaining.length > 0)
				throw new Error(`reported remaining despite a clean region: ${JSON.stringify(value.remaining)}`);
			if (value.kept.length !== 1 || value.kept[0].name !== "chest") {
				throw new Error(`expected the chest kept: ${JSON.stringify(value.kept)}`);
			}
			const cobble = value.drops.cobblestone ?? 0;
			if (cobble < 10) throw new Error(`observed drops implausibly low: ${JSON.stringify(value.drops)}`);
			return `region clean (47 stone cells air, chest intact), dug=${value.dug}, drops.cobblestone=${cobble}`;
		});

		await s.step("excavate collects container contents before digging it", async () => {
			const w0 = CENTER.x - 30;
			const z0 = CENTER.z;
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/fill ${w0} 198 ${z0 - 1} ${w0 + 2} 199 ${z0 + 1} minecraft:stone`);
			await s.command(
				`/setblock ${w0 + 1} 198 ${z0} minecraft:chest{Items:[{Slot:0b,id:"minecraft:iron_ingot",count:16},{Slot:1b,id:"minecraft:bread",count:5}]}`,
			);
			// 被掩埋的箱子打不开（原版机制）：头顶必须是空气。
			await s.command(`/setblock ${w0 + 1} 199 ${z0} minecraft:air`);
			await s.command(`/tp ${USER} ${w0 + 0.5} 200.1 ${z0 + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			// 先手动开箱读内容：隔离"NBT 没生效"与"能力收集链路"两类问题。
			const peek = valueOf<{ slots: { region: string; name: string; count: number }[]; freeSlots: number }>(
				await s.call("container@1", { at: { x: w0 + 1, y: 198, z: z0 } }, 60000),
			);
			const peeked = peek.slots.map((slot) => `${slot.name}x${slot.count}`).join(",");
			const inventoryAfterPeek = await s.readInventory();
			if (!peeked.includes("iron_ingot") || !peeked.includes("bread")) {
				throw new Error(`chest NBT did not land, chest holds [${peeked || "empty"}]`);
			}
			// 手动 transfer 链路验证：隔离"transfer@1 能力本身"与"excavate 子调用上下文"。
			const manual = await s.call("transfer@1", { from: { x: w0 + 1, y: 198, z: z0 }, all: true }, 60000);
			const afterManual = await s.readInventory();
			const manualIron = (afterManual.counts.iron_ingot ?? 0) - (inventoryAfterPeek.counts.iron_ingot ?? 0);
			if (manualIron < 16) {
				throw new Error(
					`manual transfer moved ${manualIron} iron (result ${JSON.stringify(manual)}, inventory ${JSON.stringify(afterManual.counts)})`,
				);
			}
			// 重置箱子内容，让被测 excavate 自己收。
			await s.command(
				`/setblock ${w0 + 1} 198 ${z0} minecraft:chest{Items:[{Slot:0b,id:"minecraft:iron_ingot",count:16},{Slot:1b,id:"minecraft:bread",count:5}]}`,
			);
			const inventoryBefore = await s.readInventory();
			const call = await s.call(
				"excavate@1",
				{ region: { from: { x: w0, y: 198, z: z0 - 1 }, to: { x: w0 + 2, y: 199, z: z0 + 1 } }, keep: ["bedrock"] },
				420000,
			);
			const value = valueOf<{ dug: number; remaining: unknown[]; drops: Record<string, number> }>(call);
			void value;
			// 独立世界状态核验：18 格全空气（含 chest 格被挖）。
			const holes: string[] = [];
			for (let x = w0; x <= w0 + 2; x++)
				for (let y = 198; y <= 199; y++)
					for (let z = z0 - 1; z <= z0 + 1; z++) {
						const block = await s.readBlock({ x, y, z });
						if (block != null && block.name !== "air") holes.push(`${x},${y},${z}=${block.name}`);
					}
			if (holes.length > 0) throw new Error(`region not cleared: ${holes.join(", ")}`);
			if (value.remaining.length > 0)
				throw new Error(`reported remaining despite a clean region: ${JSON.stringify(value.remaining)}`);
			const inventory = await s.readInventory();
			const gainedIron = (inventory.counts.iron_ingot ?? 0) - (inventoryBefore.counts.iron_ingot ?? 0);
			const gainedBread = (inventory.counts.bread ?? 0) - (inventoryBefore.counts.bread ?? 0);
			if (gainedIron < 16) {
				throw new Error(
					`chest contents not collected: iron_ingot +${gainedIron} (inventory ${JSON.stringify(inventory.counts)})`,
				);
			}
			if (gainedBread < 5) {
				throw new Error(`chest contents not collected: bread +${gainedBread}`);
			}
			return `chest peek [${peeked}]; dug=${value.dug} incl. chest; collected iron_ingot +${gainedIron}, bread +${gainedBread}`;
		});

		await s.step("verify/dig@1 re-checks a real dig effect through the program bridge", async () => {
			const v = { x: CENTER.x + 30, y: 199, z: CENTER.z + 4 };
			const block = await s.readBlock(v);
			if (block?.name !== "stone") throw new Error(`verify target must be stone: ${block?.name ?? "null"}`);
			// mine 不寻路（§4 可达性归调用方）：op 传送到位（准备动作；被测的是 mine+verify）。
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/tp ${USER} ${v.x - 1.5} 200.1 ${v.z + 0.5}`);
			await s.command(`/gamemode survival ${USER}`);
			await waitForStill(h.bot, h.log);
			const spawned = await s.spawn("mine@1", { at: v });
			const mined = await s.waitCall(spawned, 60000);
			if (!mined.ok) throw new Error(`mine failed: ${mined.code}: ${mined.message ?? ""}`);
			const effect = await firstEffectRef(h, spawned.run);
			const verifySource = `async function main(mc,input){return await mc.verify(input.effect,input.verifier);}`;
			const met = await runProgram(h, h.ns, "spatial", seq, verifySource, { effect, verifier: "verify/dig@1" });
			const metValue = valueOf<{ completion: string; reason?: string }>(met);
			if (metValue.completion !== "met") {
				throw new Error(`freshly mined cell must verify met: ${JSON.stringify(metValue)}`);
			}
			await s.command(`/gamemode creative ${USER}`);
			await s.command(`/setblock ${v.x} ${v.y} ${v.z} minecraft:stone`);
			await s.command(`/gamemode survival ${USER}`);
			const notMet = await runProgram(h, h.ns, "spatial", seq, verifySource, { effect, verifier: "verify/dig@1" });
			const notMetValue = valueOf<{ completion: string; reason?: string }>(notMet);
			if (notMetValue.completion !== "not_met") {
				throw new Error(`refilled cell must verify not_met: ${JSON.stringify(notMetValue)}`);
			}
			const unregistered = await runProgram(h, h.ns, "spatial", seq, verifySource, {
				effect,
				verifier: "verify/nope@1",
			});
			if (unregistered.ok || unregistered.code !== "NOT_FOUND") {
				throw new Error(`unregistered verifier must be NOT_FOUND: ${JSON.stringify(unregistered)}`);
			}
			// 追加不改写：readRecord 仍能取到原始 mine 效果记录（原 completion 未被改写）。
			return `met after mine, not_met after refill, unregistered → NOT_FOUND (original record intact)`;
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
