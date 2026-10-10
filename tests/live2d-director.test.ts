import { describe, expect, it } from "vitest";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { namedMotion } from "../.uina/worlds/live2d/motion-library.js";

describe("Live2D motion director", () => {
	it("checks all channels before evicting any existing leases", async () => {
		const director = new MotionDirector();
		const replaceable = await director.claim(["gaze"], { priority: 30 });
		const occupied = await director.claim(["head"], { priority: 100 });
		await expect(director.claim(["gaze", "head"], { atomic: true })).rejects.toThrow("locked");
		expect(director.getActiveLeases()).toEqual([replaceable, occupied]);
		expect(replaceable.signal.aborted).toBe(false);
		replaceable.release();
		occupied.release();
	});
	it("cannot promise atomic playback using a non-atomic external lease", async () => {
		const director = new MotionDirector();
		const motion = namedMotion("nod");
		const lease = await director.claim(motion.channels);
		await expect(director.play(motion, { lease, atomic: true })).rejects.toThrow("atomic lease");
		expect(director.getActiveLeases()).toEqual([lease]);
		expect(director.isPlaying()).toBe(false);
		lease.release();
	});
	it.each(["constructor", "toString", "unknown"])(
		"an unrecognized transition %s fails before acquiring any channel",
		async (transition) => {
			const director = new MotionDirector(() => 0.5);
			await expect(director.play(namedMotion("nod"), { transition: transition as never })).rejects.toThrow(
				"Unknown motion transition",
			);
			expect(director.getActiveLeases()).toEqual([]);
		},
	);
});
