/**
 * world-scan（SurfaceProbe 实现）的确定性测试：站立/露天判据与露天出口查找。
 * 寻路真值与真实区块加载由真服场景验收；这里用脚本化列数据证明纯判定逻辑，
 * 不 fake 一个世界来假装测过加载。
 */
import { describe, expect, test } from "vitest";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { findSkyAccess, skyOpenAt, standableAt } from "../../.uina/worlds/minecraft/driver/mineflayer/world-scan.js";

type Block = { name: string; boundingBox: "empty" | "block" | "fluid" };

function boundingOf(name: string): Block["boundingBox"] {
	if (name === "air") return "empty";
	if (name === "water" || name === "lava") return "empty"; // prismarine 流体 boundingBox=empty
	return "block";
}

/** 脚本化世界：列数据 Map + blockAt 替身；未写入的格 = 未加载（null）。 */
function makeBot(columns: Map<string, Block | null>, dimension = "overworld"): MineflayerBot {
	return {
		game: { dimension },
		blockAt: (position: { x: number; y: number; z: number }) => {
			const entry = columns.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`);
			return entry === undefined ? null : entry;
		},
	} as unknown as MineflayerBot;
}

describe("standableAt", () => {
	test("脚下实心 + 上两格非固体非液体 → true", () => {
		const world = new Map<string, Block | null>();
		for (const [x, z] of [[10, 10]] as const) {
			for (let y = 60; y <= 66; y++) world.set(`${x},${y},${z}`, { name: "air", boundingBox: "empty" });
			world.set(`${x},59,${z}`, { name: "stone", boundingBox: "block" });
		}
		const bot = makeBot(world);
		expect(standableAt(bot, { x: 10.4, y: 60, z: 10.6 })).toBe(true);
	});

	test("脚下非实心 / 脚或头在水中 → false", () => {
		const world = new Map<string, Block | null>();
		const fill = (x: number, name: string, y0: number, y1: number) => {
			for (let y = y0; y <= y1; y++) world.set(`${x},${y},0`, { name, boundingBox: boundingOf(name) });
		};
		// 干地列：实心地面 + 两格空气
		fill(0, "air", 62, 66);
		world.set("0,61,0", { name: "stone", boundingBox: "block" });
		// 水列：脚/头在水中
		fill(8, "water", 62, 65);
		world.set("8,61,0", { name: "sand", boundingBox: "block" });
		const bot = makeBot(world);
		expect(standableAt(bot, { x: 0, y: 62, z: 0 })).toBe(true);
		expect(standableAt(bot, { x: 8, y: 62, z: 0 })).toBe(false); // 脚在水里
		expect(standableAt(bot, { x: 8, y: 64, z: 0 })).toBe(false); // 下方 63 是水，非实心
	});

	test("任一格未加载 → null（未知，不猜）", () => {
		const bot = makeBot(new Map());
		expect(standableAt(bot, { x: 0, y: 64, z: 0 })).toBe(null);
	});
});

describe("skyOpenAt", () => {
	test("头顶全空气 → true；头顶有实体块 → false", () => {
		const world = new Map<string, Block | null>();
		const fillColumn = (x: number, z: number, ground: number, roof: number | null) => {
			for (let y = 70; y <= 319; y++) {
				const name = roof != null && y === roof ? "stone" : "air";
				world.set(`${x},${y},${z}`, { name, boundingBox: boundingOf(name) });
			}
			world.set(`${x},${ground},${z}`, { name: "stone", boundingBox: "block" });
			for (let y = ground + 1; y <= 69; y++) world.set(`${x},${y},${z}`, { name: "air", boundingBox: "empty" });
		};
		fillColumn(0, 0, 64, null); // 露天
		fillColumn(8, 0, 40, 70); // 顶部有盖（洞穴顶）
		const bot = makeBot(world);
		expect(skyOpenAt(bot, { x: 0, y: 65, z: 0 })).toBe(true);
		expect(skyOpenAt(bot, { x: 8, y: 41, z: 0 })).toBe(false);
	});

	test("柱路径未加载 → null", () => {
		const world = new Map<string, Block | null>();
		world.set("0,63,0", { name: "stone", boundingBox: "block" });
		const bot = makeBot(world);
		expect(skyOpenAt(bot, { x: 0, y: 64, z: 0 })).toBe(null);
	});

	test("液体不遮天：水下抬头仍是露天（站立判据另行排除水）", () => {
		const world = new Map<string, Block | null>();
		for (let y = 67; y <= 319; y++) world.set(`0,${y},0`, { name: "air", boundingBox: "empty" });
		for (let y = 63; y <= 66; y++) world.set(`0,${y},0`, { name: "water", boundingBox: "empty" });
		world.set("0,62,0", { name: "sand", boundingBox: "block" });
		const bot = makeBot(world);
		expect(skyOpenAt(bot, { x: 0, y: 64, z: 0 })).toBe(true);
		expect(standableAt(bot, { x: 0, y: 64, z: 0 })).toBe(false);
	});
});

describe("findSkyAccess", () => {
	test("取最近的可站露天柱；水柱被站立判据排除", async () => {
		const world = new Map<string, Block | null>();
		const fillColumn = (x: number, z: number, ground: number, waterTop: number | null) => {
			if (waterTop != null) {
				for (let y = waterTop + 1; y <= 319; y++) world.set(`${x},${y},${z}`, { name: "air", boundingBox: "empty" });
				for (let y = ground + 1; y <= waterTop; y++)
					world.set(`${x},${y},${z}`, { name: "water", boundingBox: "empty" });
			} else {
				for (let y = ground + 1; y <= 319; y++) world.set(`${x},${y},${z}`, { name: "air", boundingBox: "empty" });
			}
			world.set(`${x},${ground},${z}`, { name: waterTop != null ? "sand" : "stone", boundingBox: "block" });
		};
		fillColumn(3, 0, 64, null); // 干岸：脚位 y=65
		fillColumn(1, 0, 65, 67); // 水柱：海底 65，水 66..67 → 脚位在水中，不可站
		const bot = makeBot(world);
		const access = await findSkyAccess(bot, { x: 0, y: 64, z: 0 }, 8);
		expect(access).toEqual({ x: 3, y: 65, z: 0 });
	});

	test("半径内无可用柱 → null", async () => {
		const bot = makeBot(new Map());
		expect(await findSkyAccess(bot, { x: 0, y: 64, z: 0 }, 8)).toBe(null);
	});
});
