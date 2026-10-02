import { describe, expect, it } from "vitest";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { CHANNEL_PRIORITY } from "../.uina/worlds/live2d/types.js";

describe("Live2D channel ownership", () => {
	it("removes preempted channels from a surviving lease", async () => {
		const arbiter = new MotionDirector();
		const oldLease = await arbiter.claim(["head", "gaze"], { priority: CHANNEL_PRIORITY.REFLEX, reason: "old" });
		await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION, reason: "new" });
		expect(oldLease.channels).toEqual(["gaze"]);
	});
});
