import { describe, expect, it } from "vitest";
import { MotionDirector } from "../.uina/apps/live2d/motion-director.js";

describe("Live2D motion director", () => {
	it("owns one arbiter and one frame composer", () => {
		const director = new MotionDirector();
		expect(director.composer.arbiter).toBe(director.arbiter);
	});
});
