/**
 * surface@1 的维度守卫（批22 P1-6 下界语义）：下界没有正常意义的"露天"
 * （顶部基岩层），天空出口大扫描必须跳过，脱困腿（上游/竖井）照常可用。
 * 会话循环用共享能力基架；真实探测与寻路由真服场景验收。
 */
import { describe, expect, test } from "vitest";
import type { SurfaceProbe } from "../../.uina/worlds/minecraft/contracts/world.js";
import { failureOf, makeHarness } from "./mc-capability-harness.js";

function countingProbe() {
	const calls = { findSkyAccess: 0 };
	const probe: SurfaceProbe = {
		standable: async () => true,
		skyOpen: async () => true,
		findSkyAccess: async () => {
			calls.findSkyAccess++;
			return null;
		},
	};
	return { probe, calls };
}

function escapeHooks(dimension: string) {
	let reads = 0;
	return {
		self: {
			place: { world: "wld:t", worldRevision: "wrev:t", dimension, position: { x: 0, y: 40, z: 0 } },
			onGround: false,
			inWater: false,
		} as never,
		onSelf: (selfState: { onGround: boolean }) => {
			reads++;
			if (reads >= 2) selfState.onGround = true; // 第一条腿之后即满足出口判据
		},
	};
}

describe("surface@1 维度守卫", () => {
	test("主世界：查找天空出口；找不到时走竖井上升脱困", async () => {
		const { probe, calls } = countingProbe();
		const h = makeHarness(
			{ blocks: new Map(), inventory: { slots: [], counts: { dirt: 1 } } },
			{ ...escapeHooks("overworld"), surface: () => probe },
		);
		const result = (await h.ctx.call("surface@1", { maxTimeMs: 5000 })) as {
			escaped: boolean;
			reason: string | null;
		};
		expect(result).toMatchObject({ escaped: true, reason: "dug_shaft" });
		expect(calls.findSkyAccess).toBe(1);
	});

	test("下界：露天判据不可验证，派发前 WRONG_STATE 拒绝（§6.5 支持范围前置）", async () => {
		const { probe, calls } = countingProbe();
		const h = makeHarness(
			{ blocks: new Map(), inventory: { slots: [], counts: { dirt: 1 } } },
			{ ...escapeHooks("the_nether"), surface: () => probe },
		);
		const error = await failureOf(h.ctx.call("surface@1", { maxTimeMs: 5000 }));
		expect(error).toMatchObject({ code: "WRONG_STATE", dispatch: "not_sent" });
		expect(error.message).toContain("the_nether");
		// 未派发任何移动/扫描。
		expect(calls.findSkyAccess).toBe(0);
	});

	test("没有出口也没有垫块材料 → UNREACHABLE（主世界对照）", async () => {
		const { probe } = countingProbe();
		const h = makeHarness(
			{ blocks: new Map(), inventory: { slots: [], counts: {} } },
			{ ...escapeHooks("overworld"), surface: () => probe },
		);
		const error = await failureOf(h.ctx.call("surface@1", { maxTimeMs: 5000 }));
		expect(error).toMatchObject({ code: "UNREACHABLE" });
	});
});
