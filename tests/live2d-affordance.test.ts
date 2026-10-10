import { describe, it, expect } from "vitest";
import { MOTION_NAMES, namedMotion, supportsMotion } from "../.uina/worlds/live2d/motion-library.js";
import { live2dAffordance } from "../.uina/worlds/live2d/runtime.js";
import { BASE_POSE_NAMES } from "../.uina/worlds/live2d/types.js";

describe("Live2D authored motion declarations", () => {
	it("every advertised motion comes from the executable catalog", () => {
		expect(live2dAffordance.cues.map((c) => c.id).sort()).toEqual([...MOTION_NAMES, ...BASE_POSE_NAMES].sort());
		for (const cue of live2dAffordance.cues) {
			expect(cue.description.trim()).not.toBe("");
			if (supportsMotion(cue.id)) expect(namedMotion(cue.id).channels.length).toBeGreaterThan(0);
		}
	});
	it("routes authored motion names, and rejects removed expression syntax", async () => {
		const { BodyRouter } = await import("../.uina/extensions/embodiment/body-router.js");
		const router = new BodyRouter();
		let delivered = "";
		router.registerEndpoint({
			bodyId: "live2d",
			bodyType: "avatar_2d",
			affordance: () => live2dAffordance,
			state: () => ({ online: true }),
			emitCue: (id) => {
				delivered = id;
			},
			safeStop: async () => {},
			supportsCue: supportsMotion,
		});
		expect(router.dispatchCue("double_nod")).toBe(true);
		expect(delivered).toBe("double_nod");
		for (const id of ["warm_smile", "smile:0.8", "tilt_left,smile", "head=nod", "constructor"]) {
			expect(router.dispatchCue(id)).toBe(false);
			expect(router.dispatchCue(id, "live2d")).toBe(false);
		}
		expect(router.dispatchCue("double_nod", "live2d")).toBe(true);
	});
});

/**
 * expose 前缀漂移钉：同一 expose 前缀在 live2d（world）与 embodiment/voice（extension）
 * 各有一份声明。分层设计禁止 world import extension，因此无法在源码层收口为单一事实来源，
 * 只能靠本测试把「静默漂移」变成响亮失败（前缀改了一边、忘改另一边时在此炸开）。
 */
describe("expose 前缀跨层声明一致性", () => {
	it("BODY_ENDPOINT_EXPOSED_PREFIX 在 live2d 与 embodiment 两处声明全等", async () => {
		const [{ BODY_ENDPOINT_EXPOSED_PREFIX: a }, { BODY_ENDPOINT_EXPOSED_PREFIX: b }] = await Promise.all([
			import("../.uina/worlds/live2d/contracts.js"),
			import("../.uina/extensions/embodiment/types.js"),
		]);
		expect(a).toBe(b);
		expect(a).toBe("body.endpoint:");
	});

	it("VOICE_LEVEL_SINK_EXPOSED_PREFIX 在 live2d 与 voice 两处声明全等", async () => {
		const [{ VOICE_LEVEL_SINK_EXPOSED_PREFIX: a }, { VOICE_LEVEL_SINK_EXPOSED_PREFIX: b }] = await Promise.all([
			import("../.uina/worlds/live2d/contracts.js"),
			import("../.uina/extensions/voice/events.js"),
		]);
		expect(a).toBe(b);
		expect(a).toBe("voice.levelSink:");
	});
});
