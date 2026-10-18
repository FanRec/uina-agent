import type { ActionAuthoring } from "../../../authoring/action.js";
import { during, keys, offset, timeline } from "../../../authoring/curves.js";
import { closeUp } from "./close_up.js";

type Points = readonly (readonly [number, number])[];
/** Hand-authored beats in normalized time; damping is left to the existing somatic pipeline. */
function conversational(durationMs: number, tracks: Readonly<Record<string, Points>>): ActionAuthoring {
	return (rng) => {
		const gain = 0.88 + rng() * 0.2;
		const time = timeline(durationMs);
		const whole = time.span("start", "end");
		const channels = Object.fromEntries(Object.entries(tracks).map(([axis, points]) => [axis, offset(during(whole, keys(points.map(([at, value]) => [at * durationMs, value * gain] as const))))]));
		return { timeline: time, torso: "absolute", channels };
	};
}

export const conversationalNod = conversational(1550, {
	"head.pitch": [
		[0, 0],
		[0.15, 0.6],
		[0.38, -3.2],
		[0.54, -3],
		[0.85, 0.2],
		[1, 0],
	],
	"torso.pitch": [
		[0, 0],
		[0.28, 0],
		[0.5, -0.6],
		[0.78, -0.2],
		[1, 0],
	],
});
export const conversationalShake = conversational(2050, {
	"head.yaw": [
		[0, 0],
		[0.2, 3],
		[0.34, 3],
		[0.62, -2.4],
		[0.74, -2.4],
		[1, 0],
	],
	"torso.yaw": [
		[0, 0],
		[0.29, 0.4],
		[0.48, 0.4],
		[0.72, -0.35],
		[1, 0],
	],
});
export const conversationalCurious = conversational(2800, {
	"head.roll": [
		[0, 0],
		[0.27, -3.5],
		[0.7, -3.5],
		[1, 0],
	],
	"head.pitch": [
		[0, 0],
		[0.3, -0.7],
		[0.75, -0.7],
		[1, 0],
	],
	"torso.roll": [
		[0, 0],
		[0.4, 0.45],
		[0.72, 0.45],
		[1, 0],
	],
});
export const conversationalGlance = conversational(2250, {
	"gaze.x": [
		[0, 0],
		[0.1, -0.28],
		[0.5, -0.28],
		[0.7, 0],
		[1, 0],
	],
	"head.yaw": [
		[0, 0],
		[0.1, 0],
		[0.3, -3],
		[0.58, -3],
		[1, 0],
	],
	"torso.yaw": [
		[0, 0],
		[0.24, 0],
		[0.45, -0.5],
		[0.65, -0.5],
		[1, 0],
	],
});
export const conversationalEmphasis = conversational(1850, {
	"head.pitch": [
		[0, 0],
		[0.26, 2.1],
		[0.55, 2.1],
		[0.82, -0.45],
		[1, 0],
	],
	"torso.pitch": [
		[0, 0],
		[0.38, 0.45],
		[0.65, 0.45],
		[1, 0],
	],
});
export const conversationalJoy = conversational(2650, {
	"head.pitch": [
		[0, 0],
		[0.25, 1.6],
		[0.5, 0.5],
		[0.7, 1],
		[1, 0],
	],
	"head.roll": [
		[0, 0],
		[0.3, -2.1],
		[0.72, -2.1],
		[1, 0],
	],
	"torso.roll": [
		[0, 0],
		[0.43, -0.4],
		[0.75, -0.4],
		[1, 0],
	],
	"mouth.form": [
		[0, 0],
		[0.2, 0.65],
		[0.75, 0.65],
		[1, 0],
	],
	"eyes.left.open": [
		[0, 0],
		[0.3, -0.7],
		[0.65, -0.7],
		[1, 0],
	],
	"eyes.right.open": [
		[0, 0],
		[0.3, -0.7],
		[0.65, -0.7],
		[1, 0],
	],
});
export const conversationalAvert = conversational(2950, {
	"gaze.x": [
		[0, 0],
		[0.12, 0.3],
		[0.5, 0.3],
		[0.62, 0.08],
		[0.8, 0.08],
		[1, 0],
	],
	"head.yaw": [
		[0, 0],
		[0.3, 3.8],
		[0.69, 3.8],
		[1, 0],
	],
	"head.pitch": [
		[0, 0],
		[0.4, -1.2],
		[0.7, -1.2],
		[1, 0],
	],
	"torso.yaw": [
		[0, 0],
		[0.44, 0.65],
		[0.74, 0.65],
		[1, 0],
	],
});
const near = conversational(4600, {
	"head.roll": [
		[0, 0],
		[0.28, -1.4],
		[0.62, -1.4],
		[0.77, 0.6],
		[1, 0],
	],
	"head.pitch": [
		[0, 0],
		[0.27, 2.2],
		[0.75, 2.2],
		[1, 0],
	],
	"mouth.form": [
		[0, 0],
		[0.2, 0.45],
		[0.8, 0.45],
		[1, 0],
	],
});
/** Preserve the existing verified spatial schedule; soften only the local performance. */
export const conversationalCloseUp: ActionAuthoring = (rng) => ({ ...near(rng), spatial: closeUp(rng).spatial });
