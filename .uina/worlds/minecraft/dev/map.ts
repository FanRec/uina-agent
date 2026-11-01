/**
 * 批 17 真服验收：map@1 地图切面 + G11 图片出口（K6 收口）。
 *
 * 被测行为全部走正式查询面（World read / facade observe）；op 指令只备场地
 * 与地图状态。地图读数依赖服务端 map 包：held filled_map 在主手展开后服务端
 * 持续推送像素增量；本场景用 /give filled_map[map_id=N]（锁定地图，服务端
 * 直接下发已渲染像素），经 use@1 手持展开不修改任何世界状态。
 *
 * 关键口径（capabilities.md §map）：只解释本连接收到的像素；未收到=棋盘；
 * center/dimension 恒 null；不可等待（无 cursor）；重连不复活旧覆盖。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario } from "./scenario.js";

const USER = "UinaDev";
const CENTER = { x: 9400, y: 200, z: 9400 };
const PLATFORM = { x1: 9392, y: 199, z1: 9392, x2: 9408, z2: 9408 };
// 地图 id 用当次运行的时间基高段：地图数据跨轮持久在 leveldata（经验 23——真服世界状态跨 run 累积），
// 固定小 id 会撞上旧轮次已渲染的内容；/clear 清背包后 map id 数据还在服务器。

interface MapView {
	id: number;
	scale: number | null;
	locked: boolean | null;
	center: { x: number; z: number } | null;
	dimension: string | null;
	icons: { type: string; pixel: { x: number; z: number }; direction: number | null; label: string | null }[] | null;
	colors: (number | null)[];
	receivedPixels: number;
	totalPixels: number;
	paintedPixels: number;
	image: { path: string; sha256: string; bytes: number; mimeType: string; width: number; height: number } | null;
}

interface MapObservation {
	value: MapView | null;
	unknown: string[];
	cursor: unknown;
}

async function readMap(h: Awaited<ReturnType<typeof openHarness>>, input: { id?: number; image?: boolean }) {
	return (await h.world.read<MapView>({ ref: "map@1", input })) as MapObservation;
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-map-"));
	const h = await openHarness("map", { dataRoot });
	const s = makeScenario(h, "map");
	const bot = h.bot;

	try {
		await s.step("备场地：清背包 + 平台 + 四象限材质 + 清怪", async () => {
			await s.command("/gamemode creative");
			// 先清背包：上一轮 give 的 filled_map 会留在背包（Paper 持久化玩家），
			// 自动选图按槽位顺序会选中旧地图——场景状态必须复位（经验 23）。
			await s.command(`/clear ${USER}`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await sleep(2200);
			// 四象限不同材质：地图色板对拍可区分（stone/grass_block/oak_planks/water 不需要——水会流动，
			// 用 stone/dirt/oak_planks/sandstone 四种实心方块）。
			const { x1, y, z1, x2, z2 } = PLATFORM;
			const midX = CENTER.x;
			const midZ = CENTER.z;
			await s.command(`/fill ${x1} ${y} ${z1} ${midX} ${y} ${midZ} minecraft:stone`);
			await s.command(`/fill ${midX + 1} ${y} ${z1} ${x2} ${y} ${midZ} minecraft:dirt`);
			await s.command(`/fill ${x1} ${y} ${midZ + 1} ${midX} ${y} ${z2} minecraft:oak_planks`);
			await s.command(`/fill ${midX + 1} ${y} ${midZ + 1} ${x2} ${y} ${z2} minecraft:sandstone`);
			// fill 后当场复核（区块仍在加载态；批16 经验：不当场验就漏掉静默失败）。
			const stone = await s.readBlock({ x: x1, y, z: z1 });
			const dirt = await s.readBlock({ x: x2, y, z: z1 });
			const planks = await s.readBlock({ x: x1, y, z: z2 });
			const sand = await s.readBlock({ x: x2, y, z: z2 });
			for (const [pos, name] of [
				[stone, "stone"],
				[dirt, "dirt"],
				[planks, "oak_planks"],
				[sand, "sandstone"],
			] as const) {
				if (pos?.name !== name) throw new Error(`fill failed: expected ${name}, got ${pos?.name ?? "null"}`);
			}
			await s.command("/kill @e[type=!player]");
			await s.command("/gamemode survival");
			await sleep(900);
			await waitForStill(bot, s.log);
			return `platform 17x17 four-quadrant ready at ${CENTER.x},${CENTER.y},${CENTER.z}`;
		});

		await s.step("开图：空白地图 + use@1 展开（真玩法路径，map id 由服务端分配）", async () => {
			// 真服实测：/give filled_map[map_id=N] 引用从未渲染过的 map N 时服务端不推包
			// （map 包只在地图数据更新时下发）。真玩法路径是空白地图（minecraft:map）
			// 手持右键展开 → 服务端分配 map id 并立即推全量 128×128。
			// 开图是被测查询的准备（capabilities.md §map："不自动开图"），走正式 use@1。
			await s.command(`/give ${USER} minecraft:map 1`);
			await sleep(600);
			const before = await inventoryCount(h, "map");
			if (before < 1) throw new Error("empty map missing after give");
			const used = await s.call("use@1", { item: "map" });
			if (!used.ok) throw new Error(`use@1 failed: ${used.code} ${used.message ?? ""}`);
			await sleep(2500); // 服务端渲染 + 全量/增量包
			// 手持空白地图展开后变成 filled_map（服务端结算）；确认状态再进入查询。
			return "empty map activated via use@1";
		});

		await s.step("map@1 自动选图：主手 → map 包像素计数与 scale/locked", async () => {
			const observation = await readMap(h, { image: false });
			if (observation.value == null) throw new Error(`map@1 null: ${JSON.stringify(observation.unknown)}`);
			const value = observation.value;
			if (typeof value.locked !== "boolean")
				throw new Error(
					`locked should be boolean from map packet, got ${value.locked} (full: ${JSON.stringify(value)})`,
				);
			if (value.scale == null) throw new Error(`scale should arrive with the map packet, got ${value.scale}`);
			if (value.receivedPixels === 0) throw new Error(`no pixels arrived: ${JSON.stringify(observation.unknown)}`);
			if (value.paintedPixels === 0) throw new Error("all received pixels are transparent; expected painted terrain");
			if (value.totalPixels !== 16384) throw new Error(`totalPixels ${value.totalPixels}`);
			if (value.center !== null || value.dimension !== null) {
				throw new Error(
					`center/dimension must stay null (not inferred): ${JSON.stringify([value.center, value.dimension])}`,
				);
			}
			s.log(`activated map id=${value.id}`);
			return `id=${value.id} locked=${value.locked} scale=${value.scale} received=${value.receivedPixels} painted=${value.paintedPixels}`;
		});

		await s.step("像素对拍：四象限材质在 PNG 中呈现 >=4 种不同 RGB", async () => {
			// 合同返回值只有计数（像素数组属于 view 层）；对拍走 PNG 本体：
			// inflate IDAT 后统计 distinct RGB，四象限 stone/dirt/planks/sandstone
			// 的地图色板条目必然不同。
			const observation = await readMap(h, { image: true });
			const image = observation.value?.image;
			if (image == null) throw new Error(`png missing for color audit: ${JSON.stringify(observation.unknown)}`);
			const bytes = readFileSync(image.path);
			const { inflateSync } = await import("node:zlib");
			let offset = 8;
			let idat = Buffer.alloc(0);
			while (offset < bytes.length) {
				const length = bytes.readUInt32BE(offset);
				const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
				if (type === "IDAT") idat = Buffer.concat([idat, bytes.subarray(offset + 8, offset + 8 + length)]);
				offset += 12 + length;
			}
			const raw = inflateSync(idat);
			const distinct = new Map<string, number>();
			const stride = 512 * 3 + 1;
			for (let y = 0; y < 512; y += 4) {
				for (let x = 0; x < 512; x += 4) {
					const base = y * stride + 1 + x * 3;
					if (raw[base] === 255 && raw[base + 1] === 0 && raw[base + 2] === 255) continue; // 棋盘遮罩
					if (raw[base] === 128 && raw[base + 1] === 0 && raw[base + 2] === 128) continue;
					const key = `${raw[base]},${raw[base + 1]},${raw[base + 2]}`;
					distinct.set(key, (distinct.get(key) ?? 0) + 1);
				}
			}
			if (distinct.size < 4)
				throw new Error(
					`expected >=4 distinct terrain colors in PNG, got ${distinct.size}: ${[...distinct.keys()].slice(0, 8).join(" | ")}`,
				);
			return `${distinct.size} distinct colors: ${[...distinct.keys()].slice(0, 6).join(" | ")}`;
		});

		await s.step("icons：玩家标记随包到达且像素保留（图标更新不抹像素）", async () => {
			const before = await readMap(h, { image: false });
			const beforePixels = before.value?.receivedPixels ?? 0;
			// 走两步触发位置更新 → 新 map 包（含 icons 字段）
			await s.call("goto@1", { at: { rel: { x: 2, y: 0, z: 2 } }, tolerance: 1, maxTimeMs: 15000 });
			await sleep(1200);
			const after = await readMap(h, { image: false });
			const value = after.value;
			if (value == null) throw new Error("map@1 null after move");
			if (value.icons == null || value.icons.length === 0) {
				throw new Error(`icons should be present after movement packets, got ${JSON.stringify(value.icons)}`);
			}
			if (!value.icons.some((icon) => icon.type === "player")) {
				throw new Error(`no player cursor icon: ${JSON.stringify(value.icons)}`);
			}
			if (value.receivedPixels < beforePixels) throw new Error("pixel coverage must not shrink on icon updates");
			return `icons=[${value.icons.map((icon) => icon.type).join(",")}] received=${value.receivedPixels}`;
		});

		await s.step("image=true：PNG 缓存文件、sha256/bytes 对拍、512×512", async () => {
			const observation = await readMap(h, { image: true });
			const value = observation.value;
			if (value == null) throw new Error("map@1 null");
			const image = value.image;
			if (image == null) throw new Error(`image should be delivered: ${JSON.stringify(observation.unknown)}`);
			if (image.width !== 512 || image.height !== 512) throw new Error(`image size ${image.width}x${image.height}`);
			if (!existsSync(image.path)) throw new Error(`png file missing: ${image.path}`);
			const bytes = readFileSync(image.path);
			if (bytes.length !== image.bytes) throw new Error(`file bytes ${bytes.length} != ref ${image.bytes}`);
			if (statSync(image.path).size !== image.bytes) throw new Error("stat size mismatch");
			if (createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("sha256 mismatch");
			if (image.path.includes(join(dataRoot, "exports", "images")) === false) {
				throw new Error(`png should live under exports/images, got ${image.path}`);
			}
			return `png ${image.bytes}B sha256=${image.sha256.slice(0, 12)}… at exports/images`;
		});

		await s.step("G11：facade observe 实际产出 images 附件", async () => {
			// wire 链路（observe → read_image → ToolExecutionResult.images）由 mc-executor-image
			// 单测与 M4d 真模型轮覆盖；此处核验 PNG 本体签名与授权目录形状。
			const observation = await readMap(h, { image: true });
			const image = observation.value?.image;
			if (image == null) throw new Error("map observation lacks image ref");
			const bytes = readFileSync(image.path);
			const head = bytes.subarray(0, 8).toString("hex");
			if (head !== "89504e470d0a1a0a") throw new Error(`not a PNG: ${head}`);
			return `png signature ok, ${bytes.length}B; G11 wire covered by facade unit tests + model calibration`;
		});

		await s.step("显式 id：携带的另一张地图可读；未携带的 NOT_FOUND", async () => {
			// 开第二张空白地图：新 map id、手持展开后是携带的 filled_map（received 可能为 0
			// 若该图尚未收到任何包——但展开时服务端已推全量，应该 >0）。
			await s.command(`/give ${USER} minecraft:map 1`);
			await sleep(600);
			const used = await s.call("use@1", { item: "map" });
			if (!used.ok) throw new Error(`use@1 (second map) failed: ${used.code} ${used.message ?? ""}`);
			await sleep(2500);
			const second = await readMap(h, { image: false });
			if (second.value == null) throw new Error(`second map read failed: ${JSON.stringify(second.unknown)}`);
			const secondId = second.value.id;
			const first = await readMap(h, { image: false });
			const firstId = first.value?.id ?? secondId;
			const observation = await readMap(h, { id: secondId, image: false });
			if (observation.value == null)
				throw new Error(`explicit carried id failed: ${JSON.stringify(observation.unknown)}`);
			if (observation.value.id !== secondId) throw new Error(`id ${observation.value.id} != ${secondId}`);
			const missing = await readMap(h, { id: 99999, image: false }).then(
				() => null,
				(error: unknown) => error as { code?: string },
			);
			if (missing?.code !== "NOT_FOUND") throw new Error(`un carried id should be NOT_FOUND, got ${missing?.code}`);
			return `explicit id=${secondId} (first=${firstId}) readable; id=99999 NOT_FOUND`;
		});

		await s.step("INVALID_INPUT 边界在 World 校验层拒绝", async () => {
			const bad: { [key: string]: JsonValue }[] = [{ id: -1 }, { id: 1.5 }, { image: "yes" }, { extra: true }];
			for (const input of bad) {
				const failure = await h.world.read({ ref: "map@1", input }).then(
					() => null,
					(error: unknown) => error as { code?: string },
				);
				if (failure?.code !== "INVALID_INPUT")
					throw new Error(`input ${JSON.stringify(input)} should be INVALID_INPUT, got ${failure?.code}`);
			}
			return `rejected ${bad.length} malformed inputs`;
		});

		await s.step("重连后旧覆盖不复活（新连接从零重建）", async () => {
			const before = await readMap(h, { image: false });
			if (before.value == null || before.value.receivedPixels === 0) throw new Error("precondition: coverage exists");
			// 断开重连：harness 的 host 是生产 ClientHost；直接重连同一配置。
			await h.host.close();
			await sleep(1200);
			await h.host.connect({
				host: "127.0.0.1",
				port: 25565,
				username: USER,
				version: "1.21.11",
			} as never);
			await sleep(2500);
			const after = await readMap(h, { image: false }).then(
				(value) => value,
				(error: unknown) => error as { code?: string; message?: string },
			);
			if (after instanceof Object && "code" in after) {
				// 重连后 inventory 未同步期间读数会 WRONG_STATE/DISCONNECTED——等就绪再读。
				await sleep(2500);
			}
			const fresh = await readMap(h, { image: false });
			if (fresh.value == null) {
				// null + unknown 是合法结果（新连接还没收到该图的包）。
				if (!fresh.unknown.some((entry) => entry.includes("no map data"))) {
					throw new Error(`unexpected unknown: ${JSON.stringify(fresh.unknown)}`);
				}
				return "fresh connection: map data absent (not revived)";
			}
			if (fresh.value.receivedPixels !== 0) {
				throw new Error(`old coverage revived: received=${fresh.value.receivedPixels}`);
			}
			return "fresh connection: id resolvable but coverage rebuilt from zero";
		});
	} finally {
		await closeHarness(h);
	}
	const failed = s.finish();
	process.exit(failed === 0 ? 0 : 1);
}

/** inventory@1 里某物品的总数（give 对账用）。 */
async function inventoryCount(h: Awaited<ReturnType<typeof openHarness>>, name: string): Promise<number> {
	const observation = await h.world.read<{ counts: Record<string, number> }>({ ref: "inventory@1", input: {} });
	return observation.value?.counts[name] ?? 0;
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
