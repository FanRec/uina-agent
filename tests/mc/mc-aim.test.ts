/**
 * 派发闸门几何与受控转头步进（§4.1/§4.2）的单元回归。
 * 假世界用小步采样实现与 prismarine 同构的"首命中"语义：沿射线步进，
 * 首个进入的非空体素即命中——玻璃/墙体都按实心处理，不透明通道。
 */

import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import type { Vec3 } from "../../.uina/worlds/minecraft/contracts/values.js";
import {
	AIM_LIMITS,
	aimAtControlled,
	anglesTo,
	BLOCK_REACH,
	checkBlockHit,
	type HitGateWorld,
	nextAimStep,
	worldViewOf,
} from "../../.uina/worlds/minecraft/driver/body/aim.js";

const key = (at: Vec3): string => `${at.x},${at.y},${at.z}`;

/** 小步采样射线：返回首个进入的非空体素（与 prismarine 首命中同语义）。 */
function samplingWorld(blocks: Map<string, number[][]>): HitGateWorld {
	return {
		blockAt: (position) => {
			const shapes = blocks.get(key(position));
			return shapes == null ? null : { shapes };
		},
		raycast: async (eye, direction, range) => {
			const step = 0.02;
			const traveled = Math.ceil(range / step);
			for (let i = 1; i <= traveled; i++) {
				const point = {
					x: eye.x + direction.x * step * i,
					y: eye.y + direction.y * step * i,
					z: eye.z + direction.z * step * i,
				};
				const voxel = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
				if (blocks.has(key(voxel))) return { position: voxel };
			}
			return null;
		},
	};
}

const unitCube = [[0, 0, 0, 1, 1, 1]];
const bottomSlab = [[0, 0, 0, 1, 0.5, 1]];

describe("nextAimStep", () => {
	test("yaw takes the shortest arc: 350° to 0° turns +10°, not -350°", () => {
		const step = nextAimStep({ yaw: 350, pitch: 0 }, { yaw: 360, pitch: 0 });
		expect(step.yaw).toBeCloseTo(360, 5);
		expect(step.settled).toBe(false);
	});

	test("per-tick rate is clamped: a 180° turn needs multiple ticks", () => {
		let angles = { yaw: 0, pitch: 0 };
		let looks = 0;
		for (;;) {
			const step = nextAimStep(angles, { yaw: 180, pitch: 0 });
			if (step.settled) break;
			angles = { yaw: step.yaw, pitch: step.pitch };
			looks++;
			expect(looks).toBeLessThan(40);
		}
		expect(looks).toBe(Math.ceil(180 / AIM_LIMITS.yawDeg));
	});

	test("pitch is clamped to the legal range and the settle epsilon avoids end jitter", () => {
		const clamped = nextAimStep({ yaw: 0, pitch: 80 }, { yaw: 0, pitch: 120 });
		expect(clamped.pitch).toBeLessThanOrEqual(90);
		const settled = nextAimStep({ yaw: 10, pitch: 0 }, { yaw: 10.3, pitch: 0.2 });
		expect(settled.settled).toBe(true);
		expect(settled.yaw).toBe(10);
	});
});

describe("anglesTo", () => {
	test("a point due north of the eye looks straight ahead (yaw 0, pitch 0)", () => {
		const angles = anglesTo({ x: 0, y: 65, z: -5 }, { x: 0, y: 65, z: 0 });
		expect(angles.yaw).toBeCloseTo(0, 5);
		expect(angles.pitch).toBeCloseTo(0, 5);
	});
});

describe("checkBlockHit", () => {
	const eye: Vec3 = { x: 0.5, y: 66.5, z: 0.5 };
	const target: Vec3 = { x: 0, y: 64, z: 0 };

	test("an open target within reach hits the visible face with a real cursor", async () => {
		const blocks = new Map([[key(target), unitCube]]);
		const result = await checkBlockHit(samplingWorld(blocks), eye, target, { reach: BLOCK_REACH });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.hit.faceNumber).toBe(1); // 眼位在上方：命中的是顶面
		expect(result.hit.cursor.y).toBe(1);
		expect(result.hit.cursor.x).toBeCloseTo(0.5, 1);
		expect(result.hit.distance).toBeLessThanOrEqual(BLOCK_REACH);
	});

	test("a wall between eye and target blocks the interaction before dispatch", async () => {
		const blocks = new Map<string, number[][]>([
			[key(target), unitCube],
			[key({ x: 0, y: 65, z: 0 }), unitCube], // 眼与目标之间的墙
		]);
		const result = await checkBlockHit(samplingWorld(blocks), eye, target, { reach: BLOCK_REACH });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("UNREACHABLE");
		expect(result.occluder).toEqual({ x: 0, y: 65, z: 0 });
	});

	test("glass between eye and target is not a transparent channel", async () => {
		const blocks = new Map<string, number[][]>([
			[key(target), unitCube],
			[key({ x: 0, y: 65, z: 0 }), unitCube], // 玻璃按实心碰撞形状处理
		]);
		const result = await checkBlockHit(samplingWorld(blocks), eye, target, { reach: BLOCK_REACH });
		expect(result.ok).toBe(false);
	});

	test("distance is measured eye to hit point, not to the block center", async () => {
		// 眼位与目标中心只差 4 格（会骗过中心距初筛），但命中点在 4.5 格射程边缘之外。
		const far: Vec3 = { x: 6, y: 64, z: 0 };
		const blocks = new Map([[key(far), unitCube]]);
		const result = await checkBlockHit(samplingWorld(blocks), { x: 0.5, y: 64.5, z: 0.5 }, far, { reach: BLOCK_REACH });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("OUT_OF_REACH");
		expect(result.message).toContain("blocks from the eye");
	});

	test("a requested face is honored; when only another face is visible the specified face fails", async () => {
		const blocks = new Map([[key(target), unitCube]]);
		const topVisible = await checkBlockHit(samplingWorld(blocks), eye, target, {
			reach: BLOCK_REACH,
			requestedFace: { x: 0, y: 1, z: 0 },
		});
		expect(topVisible.ok).toBe(true);
		const northRequired = await checkBlockHit(samplingWorld(blocks), eye, target, {
			reach: BLOCK_REACH,
			requestedFace: { x: 0, y: 0, z: -1 }, // 北面背对眼位
		});
		expect(northRequired.ok).toBe(false);
	});

	test("a partial shape (bottom slab) yields a cursor on its real surface", async () => {
		const blocks = new Map([[key(target), bottomSlab]]);
		const result = await checkBlockHit(samplingWorld(blocks), eye, target, { reach: BLOCK_REACH });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.hit.faceNumber).toBe(1);
		expect(result.hit.cursor.y).toBeCloseTo(0.5, 1); // 板块顶面在 y=0.5，不是整格顶
	});

	test("an unloaded target is NOT_FOUND before any geometry runs", async () => {
		const result = await checkBlockHit(samplingWorld(new Map()), eye, target, { reach: BLOCK_REACH });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("NOT_FOUND");
	});

	test("a face normal that is not a unit axis direction is rejected without dispatch", async () => {
		const blocks = new Map([[key(target), unitCube]]);
		const result = await checkBlockHit(samplingWorld(blocks), eye, target, {
			reach: BLOCK_REACH,
			requestedFace: { x: 0.3, y: 1, z: 0 },
		});
		expect(result.ok).toBe(false);
	});
});

describe("worldViewOf", () => {
	test("prismarine raycast returns the hit block, so its position must be read from .position", async () => {
		// 真服形态：bot.world.raycast 返回 prismarine Block（坐标在 block.position）。
		// 读 hit.x 会得到 undefined，闸门把所有合法交互误判成 UNREACHABLE。
		const bot = {
			blockAt: () => ({ shapes: unitCube }),
			world: { raycast: async () => ({ position: { x: 3, y: 65, z: -2 } }) },
		};
		const view = worldViewOf(bot as never);
		const hit = await view.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 5);
		expect(hit).toEqual({ position: { x: 3, y: 65, z: -2 } });
	});
});

describe("aimAtControlled", () => {
	function fakeBot(start: { yaw: number; pitch: number }) {
		const looks: { yaw: number; pitch: number; force: boolean }[] = [];
		const bot = new EventEmitter() as EventEmitter & {
			entity: { position: Vec3; yaw: number; pitch: number; eyeHeight: number };
			look(yaw: number, pitch: number, force: boolean): Promise<void>;
		};
		bot.entity = {
			position: { x: 0.5, y: 64, z: 0.5 },
			yaw: start.yaw,
			pitch: start.pitch,
			eyeHeight: 1.62,
		};
		bot.look = async (yaw: number, pitch: number, force: boolean) => {
			looks.push({ yaw, pitch, force });
			bot.entity.yaw = yaw;
			bot.entity.pitch = pitch;
			// 角度立即生效；tick 由测试泵驱动（与真服连续物理 Tick 同构）。
		};
		return { bot, looks };
	}

	test("a 180° turn converges through rate-limited looks and never snaps in one frame", async () => {
		// 目标在正北（yaw=π），起点 yaw=-π（正南）→ 最短角差跨 0，按 12°/tick 收敛。
		const { bot, looks } = fakeBot({ yaw: -Math.PI + 0.01, pitch: 0 });
		// 连续物理 Tick 泵（与真服同构）：每 tick 至多走一步，速率断言才有意义。
		const pump = setInterval(() => bot.emit("physicsTick"), 1);
		try {
			await aimAtControlled(
				bot as never,
				{ x: 0.5, y: 65.62, z: -10 },
				{
					signal: new AbortController().signal,
				},
			);
		} finally {
			clearInterval(pump);
		}
		expect(looks.length).toBeGreaterThan(5);
		expect(looks.every((look) => look.force === false)).toBe(true);
		// 每一步的角差都不超过限速（弧度换算 12° ≈ 0.2094）。
		for (let i = 1; i < looks.length; i++) {
			const delta = Math.abs(looks[i]!.yaw - looks[i - 1]!.yaw);
			expect(delta).toBeLessThanOrEqual((AIM_LIMITS.yawDeg / 180) * Math.PI + 1e-9);
		}
	});

	test("an abort during aiming exits with INTERRUPTED and no dispatch ever happened", async () => {
		const controller = new AbortController();
		const { bot, looks } = fakeBot({ yaw: 0, pitch: 0 });
		// 先撤销再启动：一次 look 都不会发出。
		controller.abort();
		const attempt = aimAtControlled(bot as never, { x: 0.5, y: 65.62, z: 10 }, { signal: controller.signal });
		await expect(attempt).rejects.toMatchObject({ code: "INTERRUPTED", dispatch: "not_sent" });
		expect(looks).toHaveLength(0);
	});

	test("a stalled look send fails bounded instead of waiting forever", async () => {
		// look 永不 resolve（骑乘后停模拟形态）→ 1500ms 内 AIM_STALLED，有界不挂死。
		const looks: unknown[] = [];
		const bot = {
			entity: { position: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, pitch: 0, eyeHeight: 1.62 },
			look: (yaw: number, pitch: number, force: boolean) => {
				looks.push({ yaw, pitch, force });
				return new Promise<void>(() => {});
			},
		};
		const attempt = aimAtControlled(
			bot as never,
			{ x: 0.5, y: 65.62, z: 10 },
			{
				signal: new AbortController().signal,
			},
		);
		await expect(attempt).rejects.toMatchObject({ code: "AIM_STALLED", dispatch: "not_sent" });
		expect(looks.length).toBeGreaterThanOrEqual(1);
	});
});
