import type { ActionAuthoring } from "../../../authoring/action.js";
import type { BackgroundPhrase } from "../../../authoring/catalog.js";
import { absolute, offset, during, keys, timeline } from "../../../authoring/curves.js";

/** Complete head/body targets with independent holds. Runtime joins these from the previous phrase. */
function restPhrase(kind: "quiet" | "look" | "weight" | "tilt" | "smile", thinking = false): ActionAuthoring {
	return (rng) => {
		const between = (a: number, b: number) => a + rng() * (b - a);
		const side = rng() < 0.5 ? -1 : 1;
		const duration = between(4000, 10000);
		const time = timeline(duration);
		const whole = time.span("start", "end");
		const yaw = side * between(0.4, kind === "look" ? 3.8 : 1.8);
		const roll = side * between(0.3, kind === "tilt" ? 4.2 : 1.5);
		const pitch = thinking ? between(0.6, 2) : between(-0.8, 0.8);
		const headDelay = between(100, 220);
		const bodyDelay = headDelay + between(120, 280);
		const settle = between(650, 1100);
		const held = (value: number, _delay: number) => absolute(during(whole, () => value));
		// Absolute targets deliberately retain their endpoint. Runtime supplies the incoming interpolation.
		const secondary = (value: number, delay: number) =>
			absolute(
				during(
					whole,
					keys([
						[0, value * 0.55],
						[delay, value * 0.55],
						[delay + settle, value],
						[duration * 0.78, value],
						[duration, value * 0.85],
					]),
				),
			);
		return {
			timeline: time,
			torso: "absolute",
			channels: {
				"head.yaw": held(yaw, headDelay),
				"head.roll": held(roll, headDelay),
				"head.pitch": held(pitch, headDelay),
				"torso.yaw": secondary(yaw * (kind === "weight" ? 0.65 : 0.25), bodyDelay),
				"torso.roll": secondary(roll * (kind === "weight" ? 0.65 : 0.25), bodyDelay),
				"torso.pitch": secondary(pitch * 0.2, bodyDelay),
				"gaze.x": held(kind === "look" || thinking ? side * between(0.12, 0.3) : between(-0.035, 0.035), 0),
				"gaze.y": held(thinking ? 0.22 : between(-0.025, 0.06), 0),
				"mouth.form": held(kind === "smile" ? between(0.18, 0.32) : between(0.02, 0.08), headDelay),
			},
		};
	};
}

const join = {
	durationMs: 850,
	delays: {
		"head.yaw": 160,
		"head.pitch": 160,
		"head.roll": 160,
		"torso.yaw": 360,
		"torso.pitch": 360,
		"torso.roll": 360,
		"mouth.form": 160,
	},
};
export const idlePhrases: readonly BackgroundPhrase[] = [{ id: "quiet", weight: 4, join, motion: restPhrase("quiet") }, ...(["look", "weight", "tilt", "smile"] as const).map((id) => ({ id, weight: 1.5, join, motion: restPhrase(id) }))];
export const thinkingPhrases: readonly BackgroundPhrase[] = [
	{ id: "consider", join, motion: restPhrase("look", true) },
	{ id: "listen", join, motion: restPhrase("quiet", true) },
	{ id: "ponder", join, motion: restPhrase("tilt", true) },
];

/** A sparse speech accent: no eyelids, mouth, gaze, or spatial effects. */
export const speechAccent: ActionAuthoring = (rng) => {
	const duration = 600 + rng() * 500;
	const strength = 0.65 + rng() * 0.6;
	const side = rng() < 0.5 ? -1 : 1;
	const time = timeline(duration);
	const whole = time.span("start", "end");
	const beat = (gain: number, lag = 0) =>
		offset(
			during(
				whole,
				keys([
					[0, 0],
					[duration * 0.12 + lag, gain * 0.2],
					[duration * 0.4 + lag, -gain],
					[duration * 0.72 + lag, gain * 0.12],
					[duration, 0],
				]),
			),
		);
	return {
		timeline: time,
		torso: "absolute",
		channels: {
			"head.pitch": beat(strength),
			"head.roll": beat(strength * 0.28 * side),
			"torso.pitch": beat(strength * 0.18, duration * 0.08),
		},
	};
};
