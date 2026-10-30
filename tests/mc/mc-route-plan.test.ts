/**
 * route.plan@1 的确定性面：Move→steps/needs 推导（真适配器导出的纯函数）+
 * GotoDirector.plan 的输入校验/维度核验/状态接缝。寻路真值由真服场景验收；
 * 这里不 fake 一个世界来假装测过 A*。
 */

import { describe, expect, test } from "vitest";
import { GotoDirector, type GotoDeps } from "../../.uina/worlds/minecraft/driver/goto.js";
import { deriveSteps, type PlanMove } from "../../.uina/worlds/minecraft/driver/mineflayer/pathfinder.js";
import { failureOf } from "./mc-capability-harness.js";

function move(
	x: number,
	y: number,
	z: number,
	toBreak: unknown[] = [],
	toPlace: unknown[] = [],
	parkour = false,
): PlanMove {
	return { x, y, z, toBreak, toPlace, parkour };
}

describe("deriveSteps", () => {
	test("skips the start node, derives per-step actions and aggregates needs", () => {
		const { steps, needs } = deriveSteps([
			move(0, 64, 0), // 起点 Move（cost 0，无动作）
			move(1, 64, 0),
			move(2, 64, 0, [move(2, 65, 0)], []), // 需要挖掉头顶一格
			move(2, 65, 0, [], [move(2, 64, 0)]), // 垫一格上升
			move(3, 65, 0, [], [], true), // 跑酷
			move(3, 64, 0), // 下落
		]);
		expect(steps).toEqual([
			{ x: 1, y: 64, z: 0, action: "walk" },
			{ x: 2, y: 64, z: 0, action: "dig" },
			{ x: 2, y: 65, z: 0, action: "place" },
			{ x: 3, y: 65, z: 0, action: "jump" },
			{ x: 3, y: 64, z: 0, action: "walk" },
		]);
		expect(needs).toEqual({ dig: 1, place: 1 });
	});

	test("an ascent without parkour or actions reads as a jump", () => {
		expect(deriveSteps([move(0, 64, 0), move(0, 65, 0)])).toEqual({
			steps: [{ x: 0, y: 65, z: 0, action: "jump" }],
			needs: { dig: 0, place: 0 },
		});
	});

	test("a start-only path has no steps", () => {
		expect(deriveSteps([move(4, 64, 4)])).toEqual({ steps: [], needs: { dig: 0, place: 0 } });
	});
});

describe("GotoDirector.plan seams", () => {
	function director(overrides: Partial<GotoDeps> = {}): GotoDirector {
		const deps: GotoDeps = {
			assertActionAllowed: () => {},
			host: { state: "ready", identity: { account: "t" } } as never,
			bot: () =>
				({
					entity: { position: { x: 10, y: 64, z: 10 } },
					game: { dimension: "overworld" },
				}) as never,
			sink: {} as never,
			arbiter: {} as never,
			mintOp: () => "op:t:1",
			mintEff: () => "eff:t:1",
			...overrides,
		};
		return new GotoDirector(deps);
	}

	test("a plan never claims the arbiter goto slot", async () => {
		const d = director({
			arbiter: {
				tryClaimGoto: () => {
					throw new Error("plan must not claim the goto slot");
				},
				releaseGoto: () => {},
			} as never,
		});
		// 目标校验在寻路之前：跨维度目标在未触达寻路的情况下如实失败。
		await expect(
			d.plan({ at: { position: { x: 0, y: 64, z: 0 }, dimension: "minecraft:the_nether" } }),
		).rejects.toMatchObject({ code: "WRONG_STATE" });
	});

	test("cross-dimension targets are WRONG_STATE and invalid tolerances are INVALID_INPUT", async () => {
		const d = director();
		await expect(d.plan({ at: { position: { x: 0, y: 64, z: 0 }, dimension: "nether" } })).rejects.toMatchObject({
			code: "WRONG_STATE",
		});
		await expect(d.plan({ at: { x: 0, y: 64, z: 0 }, tolerance: 0 })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(d.plan({ at: { x: Number.NaN, y: 64, z: 0 } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});

	test("a missing client is DISCONNECTED before any pathfinding", async () => {
		const d = director({ host: { state: "end", identity: null } as never });
		expect(await failureOf(d.plan({ at: { x: 0, y: 64, z: 0 } }))).toMatchObject({ code: "DISCONNECTED" });
	});

	test("plan calls serialize instead of rejecting each other", async () => {
		const d = director();
		const first = d.plan({ at: { position: { x: 0, y: 64, z: 0 }, dimension: "nether" } });
		const second = d.plan({ at: { position: { x: 1, y: 64, z: 0 }, dimension: "nether" } });
		const results = await Promise.allSettled([first, second]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "WRONG_STATE" });
	});
});
