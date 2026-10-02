import { describe, it, expect } from "vitest";
import { CUE_ALIASES, CANONICAL_CUE_IDS, resolveCueToBeat } from "../.uina/worlds/live2d/parameter-mapper.js";
import { live2dAffordance } from "../.uina/worlds/live2d/runtime.js";

/**
 * 单一事实来源一致性测试：
 * 守护「对外声明（affordance.cues，注入大模型提示词）与解析端（CUE_BEAT_TABLE/别名）」
 * 永不漂移。声明出来的每个 cue 与别名必须真的能被 resolveCueToBeat 解析，
 * 否则模型按提示词用了 cue、派发层却静默丢弃（2026-09-21 的真实缺陷类型）。
 */
describe("Live2D cue 声明与解析单一事实来源一致性", () => {
	it("每个规范 id 都被声明且附带非空说明", () => {
		expect(CANONICAL_CUE_IDS.length).toBeGreaterThan(0);
		expect(live2dAffordance.cues.map((c) => c.id).sort()).toEqual(
			[...CANONICAL_CUE_IDS].sort(),
		);
		for (const cue of live2dAffordance.cues) {
			expect(cue.description.trim(), `cue "${cue.id}" 缺少说明`).not.toBe("");
		}
	});

	it("每条对外声明的 cue id 都能被派发层解析", () => {
		for (const cue of live2dAffordance.cues) {
			expect(resolveCueToBeat(cue.id), `规范 id "${cue.id}" 解析失败`).not.toBeNull();
		}
	});

	it("声明的别名都能被派发层解析", () => {
		for (const cue of live2dAffordance.cues) {
			for (const alias of cue.aliases ?? []) {
				expect(resolveCueToBeat(alias), `别名 "${alias}"→${cue.id} 解析失败`).not.toBeNull();
			}
		}
	});

	it("别名表无孤儿：每个别名指向的规范 id 都在规范表中", () => {
		for (const [, canonical] of Object.entries(CUE_ALIASES)) {
			expect(CANONICAL_CUE_IDS).toContain(canonical);
		}
	});

	it("BodyRouter 能够通过 supportsCue 或别名匹配成功路由 sparkle、修饰符与复合线索", async () => {
		const { BodyRouter } = await import("../.uina/extensions/embodiment/body-router.js");
		const router = new BodyRouter();
		let deliveredCue = "";
		const fakeEndpoint = {
			bodyId: "live2d_mo",
			bodyType: "avatar_2d" as const,
			affordance: () => live2dAffordance,
			state: () => ({ online: true }),
			emitCue: (id: string) => { deliveredCue = id; },
			safeStop: async () => {},
			supportsCue: (id: string) => resolveCueToBeat(id) !== null,
		};
		router.registerEndpoint(fakeEndpoint);

		expect(router.dispatchCue("sparkle")).toBe(true);
		expect(deliveredCue).toBe("sparkle");

		expect(router.dispatchCue("smile:0.8")).toBe(true);
		expect(deliveredCue).toBe("smile:0.8");

		expect(router.dispatchCue("tilt_left,smile")).toBe(true);
		expect(deliveredCue).toBe("tilt_left,smile");

		expect(router.dispatchCue("head=tilt_left,face=smug")).toBe(true);
		expect(deliveredCue).toBe("head=tilt_left,face=smug");

		expect(router.dispatchCue("completely_unknown_action")).toBe(false);
	});
});

