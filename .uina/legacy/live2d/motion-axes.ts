import type { Live2DChannel } from "./types.js";

/** Units and resting values are motion facts, independent of Cubism/VTS. */
const axis = (channel: Live2DChannel, min: number, max: number, neutral = 0, angular = false) =>
	Object.freeze({ channel, min, max, neutral, angular });
export const AXES = Object.freeze({
	"head.yaw": axis("head", -30, 30, 0, true),
	"head.pitch": axis("head", -30, 30, 0, true),
	"head.roll": axis("head", -30, 30, 0, true),
	"torso.yaw": axis("torso", -15, 15, 0, true),
	"torso.pitch": axis("torso", -15, 15, 0, true),
	"torso.roll": axis("torso", -15, 15, 0, true),
	"torso.breath": axis("torso", 0, 1, 0.5),
	"gaze.x": axis("gaze", -1, 1),
	"gaze.y": axis("gaze", -1, 1),
	"eyes.left.open": axis("eyes", 0, 1, 1),
	"eyes.right.open": axis("eyes", 0, 1, 1),
	"eyes.left.smile": axis("eyes", 0, 1),
	"eyes.right.smile": axis("eyes", 0, 1),
	"brows.left": axis("eyes", -1, 1),
	"brows.right": axis("eyes", -1, 1),
	"face.blush": axis("eyes", 0, 1),
	"mouth.open": axis("mouth", 0, 1),
	"mouth.form": axis("mouth", -1, 1),
	"mouth.x": axis("mouth", -1, 1),
	"mouth.pucker": axis("mouth", -1, 1),
	"jaw.shrug": axis("mouth", 0, 1),
	"jaw.open": axis("mouth", 0, 1),
	"mouth.cheekPuff": axis("mouth", 0, 1),
});
export type MotionAxis = keyof typeof AXES | `${string}.${string}`;
export interface ControlMetadata { channel: Live2DChannel; min: number; max: number; neutral: number; angular?: boolean; }
export type ControlTable = Readonly<Record<string, ControlMetadata>>;
export type AxisValues = Record<string, number>;
export const AXIS_NAMES = Object.freeze(Object.keys(AXES) as MotionAxis[]);
export const NEUTRAL_AXES: Readonly<Record<MotionAxis, number>> = Object.freeze(
	Object.fromEntries(AXIS_NAMES.map((name) => [name, AXES[name as keyof typeof AXES].neutral])) as Record<MotionAxis, number>,
);
export function isMotionAxis(name: string): name is MotionAxis {
	return Object.hasOwn(AXES, name);
}
export function clampAxis(name: string, value: number): number {
	if (!isMotionAxis(name)) throw new Error(`Unknown motion axis: ${name}`);
	return Math.max(AXES[name as keyof typeof AXES].min, Math.min(AXES[name as keyof typeof AXES].max, value));
}
