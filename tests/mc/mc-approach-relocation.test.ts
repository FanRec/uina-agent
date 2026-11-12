/**
 * 局部自治换位（§5）：Driver 以"视线受阻、零派发"拒绝时，允许释放 Body、
 * 走到少量安全站位再试；已派发/未知效果、没有安全站位都不得重放。
 *
 * 这里的假 ctx 只模拟调用边界：world 读 self/region，withBody 计次并执行 work，
 * goto 记录目标。候选站位的世界几何由 blocks 地图给出。
 */

import { describe, expect, test } from "vitest";
import { callFailure, type JsonValue, type Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import { withRelocation } from "../../.uina/worlds/minecraft/capabilities/shared/approach.js";

type Block = { name: string; properties: Record<string, string> };

const key = (at: Vec3): string => `${at.x},${at.y},${at.z}`;

function regionOf(
	from: Vec3,
	to: Vec3,
	blocks: Map<string, Block>,
): {
	origin: Vec3;
	shape: [number, number, number];
	palette: { name: string; properties: Record<string, string> }[];
	cells: number[];
} {
	const origin = {
		x: Math.min(from.x, to.x),
		y: Math.min(from.y, to.y),
		z: Math.min(from.z, to.z),
	};
	const nx = Math.abs(to.x - from.x) + 1;
	const ny = Math.abs(to.y - from.y) + 1;
	const nz = Math.abs(to.z - from.z) + 1;
	const palette = [{ name: "air", properties: {} }];
	const paletteIndex = new Map<string, number>([["air{}", 0]]);
	const cells: number[] = new Array(nx * ny * nz).fill(0);
	for (let y = origin.y; y < origin.y + ny; y++) {
		for (let z = origin.z; z < origin.z + nz; z++) {
			for (let x = origin.x; x < origin.x + nx; x++) {
				const index = (y - origin.y) * nx * nz + (z - origin.z) * nx + (x - origin.x);
				const block = blocks.get(key({ x, y, z }));
				if (block == null) continue;
				const paletteKey = `${block.name}${JSON.stringify(block.properties)}`;
				let slot = paletteIndex.get(paletteKey);
				if (slot == null) {
					slot = palette.length;
					palette.push(block);
					paletteIndex.set(paletteKey, slot);
				}
				cells[index] = slot;
			}
		}
	}
	return { origin, shape: [nx, ny, nz], palette, cells };
}

const self = {
	place: {
		world: "world:t",
		worldRevision: "rev:t",
		dimension: "minecraft:overworld",
		position: { x: 3.5, y: 64, z: 0.5 },
	},
	look: null,
};

/** 平坦石台：y=63 实心，y=64/65 空气；目标工作台在 (0,64,0)。 */
function arena(extra: Record<string, Block> = {}): Map<string, Block> {
	const blocks = new Map<string, Block>();
	for (let x = -3; x <= 3; x++) {
		for (let z = -3; z <= 3; z++) blocks.set(key({ x, y: 63, z }), { name: "stone", properties: {} });
	}
	blocks.set(key({ x: 0, y: 64, z: 0 }), { name: "crafting_table", properties: {} });
	for (const [at, block] of Object.entries(extra)) blocks.set(at, block);
	return blocks;
}

interface Harness {
	ctx: Parameters<typeof withRelocation>[0];
	attempts: () => number;
	gotos: Vec3[];
}

function harness(options: {
	blocks: Map<string, Block>;
	failures: unknown[];
	work?: () => Promise<string>;
	gotoFails?: Set<string>;
}): Harness {
	let attempt = 0;
	const gotos: Vec3[] = [];
	const ctx = {
		run: "run:t",
		segment: "seg:t",
		callId: "call:t",
		signal: new AbortController().signal,
		progress: async () => undefined,
		world: {
			async read<T>(query: { ref: string; input: JsonValue }): Promise<T> {
				if (query.ref === "self@1") {
					return {
						value: structuredClone(self),
						observedAt: "2026-01-01T00:00:00.000Z",
						source: "server",
						coverage: "complete",
						unknown: [],
						evidence: [],
						cursor: null,
					} as unknown as T;
				}
				if (query.ref === "region@1") {
					const raw = query.input as unknown as { from: Vec3; to: Vec3 };
					return {
						value: regionOf(raw.from, raw.to, options.blocks),
						observedAt: "2026-01-01T00:00:00.000Z",
						source: "server",
						coverage: "complete",
						unknown: [],
						evidence: [],
						cursor: null,
					} as unknown as T;
				}
				throw new Error(`unexpected query ${query.ref}`);
			},
		},
		async call(ref: string, input: JsonValue): Promise<JsonValue> {
			if (ref !== "goto@1") throw new Error(`unexpected call ${ref}`);
			const at = (input as unknown as { at: Vec3 }).at;
			gotos.push(at);
			if (options.gotoFails?.has(key(at)) === true) {
				throw callFailure({
					code: "UNREACHABLE",
					source: "environment",
					message: "no path to the candidate spot",
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				});
			}
			return {};
		},
		async withBody<T>(work: (scope: unknown) => Promise<T>): Promise<T> {
			const index = attempt++;
			const failure = options.failures[index];
			if (failure != null) throw failure;
			return await work({ player: {} });
		},
	} as unknown as Parameters<typeof withRelocation>[0];
	return { ctx, attempts: () => attempt, gotos };
}

const blocked = (): unknown =>
	callFailure({
		code: "UNREACHABLE",
		source: "world",
		message: "line of sight is blocked",
		dispatch: "not_sent",
		effects: [],
		recoverable: true,
	});

describe("withRelocation", () => {
	test("a blocked, never-dispatched interaction retries once from a safe standing spot", async () => {
		const h = harness({ blocks: arena(), failures: [blocked()] });
		const value = await withRelocation(h.ctx, { x: 0, y: 64, z: 0 }, "crafting_table", async () => "opened");
		expect(value).toBe("opened");
		expect(h.attempts()).toBe(2);
		expect(h.gotos).toHaveLength(1);
		// 换位只挑"脚/头空气、脚下实心"的邻格，不选目标格本身。
		expect(h.gotos[0]).not.toEqual({ x: 0, y: 64, z: 0 });
	});

	test("an already dispatched failure is never retried from another spot", async () => {
		const dispatched = callFailure({
			code: "TARGET_NOT_MET",
			source: "world",
			message: "the click was dispatched but not confirmed",
			dispatch: "sent",
			effects: ["eff:1"],
			recoverable: false,
		});
		const h = harness({ blocks: arena(), failures: [dispatched] });
		await expect(
			withRelocation(h.ctx, { x: 0, y: 64, z: 0 }, "crafting_table", async () => "opened"),
		).rejects.toMatchObject({ code: "TARGET_NOT_MET" });
		expect(h.attempts()).toBe(1);
		expect(h.gotos).toHaveLength(0);
	});

	test("no safe standing spot returns the original blocked failure without walking anywhere", async () => {
		// 目标四周脚位都被实心方块占满：没有候选，不能挖、不能搭。
		const extra: Record<string, Block> = {};
		for (const [dx, dz] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
			[1, 1],
			[1, -1],
			[-1, 1],
			[-1, -1],
			[2, 0],
			[-2, 0],
			[0, 2],
			[0, -2],
		] as const) {
			extra[key({ x: dx, y: 64, z: dz })] = { name: "stone", properties: {} };
			extra[key({ x: dx, y: 65, z: dz })] = { name: "stone", properties: {} };
		}
		const h = harness({ blocks: arena(extra), failures: [blocked()] });
		await expect(
			withRelocation(h.ctx, { x: 0, y: 64, z: 0 }, "crafting_table", async () => "opened"),
		).rejects.toMatchObject({ code: "UNREACHABLE", dispatch: "not_sent" });
		expect(h.gotos).toHaveLength(0);
	});

	test("a candidate that cannot be walked to is skipped in favour of the next one", async () => {
		const h = harness({ blocks: arena(), failures: [blocked()] });
		// 让所有候选的 goto 都失败：换位有界结束，不无限循环。
		h.ctx.call = (async (ref: string, input: JsonValue) => {
			if (ref !== "goto@1") throw new Error(`unexpected call ${ref}`);
			h.gotos.push((input as unknown as { at: Vec3 }).at);
			throw callFailure({
				code: "UNREACHABLE",
				source: "environment",
				message: "no path",
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		}) as typeof h.ctx.call;
		await expect(
			withRelocation(h.ctx, { x: 0, y: 64, z: 0 }, "crafting_table", async () => "opened"),
		).rejects.toMatchObject({ code: "UNREACHABLE" });
		expect(h.gotos.length).toBeLessThanOrEqual(2);
	});
});
