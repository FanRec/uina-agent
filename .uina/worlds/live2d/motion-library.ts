import { AXES, AXIS_NAMES, NEUTRAL_AXES, type AxisValues, type MotionAxis } from "./motion-axes.js";
import {
	compileMotion,
	delay,
	motion,
	parallel,
	pose,
	sequence,
	track,
	transform,
	withSpeech,
	type CompiledMotion,
	type MotionDefinition,
} from "./motion.js";
import type { BasePoseName, ExpressBeat, ExpressParams, Live2DChannel, SpeechPolicy } from "./types.js";

const head = (values: AxisValues, ms = 1000) =>
	pose(
		ms,
		{
			"head.yaw": 0,
			"head.pitch": 0,
			"head.roll": 0,
			...values,
		},
		"baseline-offset",
		["head.yaw", "head.pitch", "head.roll"].filter((a) => !values[a as MotionAxis]) as MotionAxis[],
	);
const gesture = (axis: MotionAxis, points: readonly (readonly [number, number])[], ms: number) =>
	parallel(head({}, ms), motion(ms, track(axis, points, "baseline-offset")));
// All head tracks are offsets, so the explicit gesture can add to the zero resting tracks.
export const HEAD_MOTIONS = {
	neutral: head({}),
	turn_left: head({ "head.yaw": -12 }),
	turn_right: head({ "head.yaw": 12 }),
	tilt_left: head({ "head.roll": 12 }),
	tilt_right: head({ "head.roll": -12 }),
	lowered: head({ "head.pitch": -7 }),
	lifted: head({ "head.pitch": 7 }),
	nod: gesture(
		"head.pitch",
		[
			[0, 0],
			[320, -9],
			[760, 0],
		],
		760,
	),
	shake: gesture(
		"head.yaw",
		[
			[0, 0],
			[300, 12],
			[720, -12],
			[1150, 0],
		],
		1150,
	),
} satisfies Record<string, MotionDefinition>;
export const GAZE_MOTIONS = {
	user: pose(1000, { "gaze.x": 0, "gaze.y": 0 }),
	away_left: pose(1000, { "gaze.x": -0.95, "gaze.y": 0 }),
	away_right: pose(1000, { "gaze.x": 0.95, "gaze.y": 0 }),
	down: pose(1000, { "gaze.x": 0, "gaze.y": -0.85 }),
	side_peek: pose(1000, { "gaze.x": 0.85, "gaze.y": -0.2 }),
} satisfies Record<string, MotionDefinition>;
const neutralFace = Object.fromEntries(
	AXIS_NAMES.filter((a) => ["eyes", "mouth"].includes(AXES[a].channel)).map((a) => [a, NEUTRAL_AXES[a]]),
);
const face = (values: AxisValues) => {
	const targets = { ...neutralFace, ...values };
	return pose(
		1000,
		targets,
		"absolute",
		AXIS_NAMES.filter((a) => a === "face.blush" || targets[a] === NEUTRAL_AXES[a]),
	);
};
export const FACE_MOTIONS = {
	shy: face({
		"face.blush": 0.65,
		"brows.left": -0.18,
		"brows.right": -0.18,
		"eyes.left.open": 0.88,
		"eyes.right.open": 0.88,
		"eyes.left.smile": 0.25,
		"eyes.right.smile": 0.25,
		"mouth.form": 0.28,
	}),
	smug: face({
		"brows.right": 0.25,
		"brows.left": -0.1,
		"eyes.right.open": 0.9,
		"eyes.left.open": 0.8,
		"eyes.left.smile": 0.2,
		"eyes.right.smile": 0.4,
		"mouth.form": 0.6,
	}),
	pout: face({
		"brows.left": -0.22,
		"brows.right": -0.22,
		"eyes.left.open": 0.92,
		"eyes.right.open": 0.92,
		"mouth.form": -0.55,
		"face.blush": 0.25,
	}),
	sparkle: face({
		"brows.left": 0.3,
		"brows.right": 0.3,
		"eyes.left.smile": 0.3,
		"eyes.right.smile": 0.3,
		"face.blush": 0.25,
		"mouth.form": 0.65,
	}),
	shocked: face({ "mouth.open": 0.5, "brows.left": 0.45, "brows.right": 0.45 }),
	tender_smile: face({
		"eyes.left.smile": 0.45,
		"eyes.right.smile": 0.45,
		"brows.left": 0.12,
		"brows.right": 0.12,
		"eyes.left.open": 0.92,
		"eyes.right.open": 0.92,
		"mouth.form": 0.5,
		"face.blush": 0.18,
	}),
	laugh: face({
		"brows.left": 0.2,
		"brows.right": 0.2,
		"eyes.left.open": 0.06,
		"eyes.right.open": 0.06,
		"eyes.left.smile": 0.85,
		"eyes.right.smile": 0.85,
		"mouth.open": 0.55,
		"mouth.form": 0.85,
		"face.blush": 0.3,
	}),
	winking: face({
		"eyes.right.open": 0.04,
		"eyes.right.smile": 0.7,
		"eyes.left.smile": 0.2,
		"mouth.form": 0.55,
		"face.blush": 0.2,
	}),
	smug_grin: face({
		"brows.right": 0.35,
		"brows.left": -0.12,
		"eyes.right.open": 0.9,
		"eyes.left.open": 0.78,
		"eyes.left.smile": 0.2,
		"eyes.right.smile": 0.45,
		"mouth.form": 0.72,
	}),
	sleepy_yawn: withSpeech(
		face({
			"brows.left": -0.15,
			"brows.right": -0.15,
			"eyes.left.open": 0.22,
			"eyes.right.open": 0.22,
			"mouth.open": 0.6,
		}),
		"exclusive",
	),
} satisfies Record<string, MotionDefinition>;
export const HEAD_POSES = Object.freeze(Object.keys(HEAD_MOTIONS));
export const GAZE_DIRECTIONS = Object.freeze(Object.keys(GAZE_MOTIONS));
export const FACE_EXPRESSIONS = Object.freeze(Object.keys(FACE_MOTIONS));
function lookup(table: Record<string, MotionDefinition>, name: string): MotionDefinition {
	if (!Object.hasOwn(table, name)) throw new Error(`Unknown motion: ${name}`);
	return table[name]!;
}
function fit(definition: MotionDefinition, durationMs: number): MotionDefinition {
	return transform(definition, { durationScale: durationMs / compileMotion(definition).durationMs });
}

/** Intent adapter: simple semantic choices expand through the same authoring compiler. */
export function defineExpression(params: ExpressParams): MotionDefinition {
	if (params.transition !== undefined && !["snappy", "smooth", "gentle"].includes(params.transition))
		throw new Error("Unknown motion transition: " + params.transition);
	if (params.speech !== undefined && params.speech !== "blend" && params.speech !== "exclusive")
		throw new Error("Unknown speech policy: " + params.speech);
	if (
		params.intensity !== undefined &&
		(!Number.isFinite(params.intensity) || params.intensity < 0 || params.intensity > 1)
	)
		throw new Error("intensity must be finite and within [0,1]");
	if (params.motion) {
		if (params.beats?.length || params.head || params.face || params.gaze)
			throw new Error("Choose a named motion or an improvised expression");
		if (!supportsMotion(params.motion)) throw new Error(`Unknown motion: ${params.motion}`);
		return transform(MOTION_LIBRARY[params.motion as keyof typeof MOTION_LIBRARY].definition, {
			intensity: params.intensity,
		});
	}
	const beats = params.beats?.length
		? params.beats
		: [{ head: params.head, gaze: params.gaze, face: params.face, hold_ms: 1000 }];
	return sequence(...beats.map((beat) => defineBeat(beat, params.intensity ?? 1)));
}
function defineBeat(beat: ExpressBeat, defaultIntensity: number): MotionDefinition {
	const duration = beat.hold_ms ?? 1000;
	if (!Number.isFinite(duration) || duration <= 0) throw new Error("hold_ms must be finite and positive");
	const intensity = beat.intensity ?? defaultIntensity;
	if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1)
		throw new Error("intensity must be finite and within [0,1]");
	const parts: MotionDefinition[] = [];
	if (beat.head) parts.push(fit(lookup(HEAD_MOTIONS, beat.head), duration));
	if (beat.gaze) parts.push(fit(lookup(GAZE_MOTIONS, beat.gaze), duration));
	if (beat.face) parts.push(fit(lookup(FACE_MOTIONS, beat.face), duration));
	if (!parts.length) throw new Error("Empty expression: supply motion, head, gaze or face");
	return transform(parallel(...parts), { intensity });
}
export const compileExpression = (params: ExpressParams) => compileMotion(defineExpression(params));

const smile = FACE_MOTIONS.tender_smile;
const nodWithSmile = parallel(HEAD_MOTIONS.nod, fit(smile, 760), fit(GAZE_MOTIONS.user, 760));
export const MOTION_LIBRARY = {
	smile: { description: "温柔微笑并看向用户", definition: parallel(smile, GAZE_MOTIONS.user) },
	nod: { description: "微笑着完整点头一次", definition: nodWithSmile },
	double_nod: {
		description: "微笑着轻点头，再认真点头回应",
		definition: parallel(
			sequence(transform(HEAD_MOTIONS.nod, { intensity: 0.8 }), fit(HEAD_MOTIONS.nod, 840)),
			fit(smile, 1600),
			fit(GAZE_MOTIONS.user, 1600),
		),
	},
	shake: {
		description: "微笑着轻轻左右摇头，再回位",
		definition: parallel(fit(transform(HEAD_MOTIONS.shake, { intensity: 0.7 }), 1250), fit(smile, 1250)),
	},
	curious: {
		description: "轻歪头、微笑并注视用户",
		definition: parallel(transform(HEAD_MOTIONS.tilt_right, { intensity: 0.5 }), smile, GAZE_MOTIONS.user),
	},
	laugh: {
		description: "抬头笑后自然回落",
		definition: sequence(parallel(HEAD_MOTIONS.lifted, FACE_MOTIONS.laugh), parallel(HEAD_MOTIONS.neutral, smile)),
	},
	shy: {
		description: "害羞低头避开视线",
		definition: parallel(HEAD_MOTIONS.lowered, FACE_MOTIONS.shy, GAZE_MOTIONS.away_left),
	},
	peek_back: {
		description: "先看向旁边，再回看用户",
		definition: sequence(
			parallel(HEAD_MOTIONS.turn_right, FACE_MOTIONS.shy, GAZE_MOTIONS.away_right),
			parallel(HEAD_MOTIONS.tilt_left, smile, GAZE_MOTIONS.user),
		),
	},
	wink: {
		description: "轻歪头、微笑眨右眼，再自然睁开",
		definition: parallel(
			motion(
				1200,
				track(
					"head.roll",
					[
						[0, 0],
						[420, 3],
						[1200, 0],
					],
					"baseline-offset",
				),
				track("eyes.right.open", [
					[0, 1],
					[260, 1],
					[380, 0.04],
					[520, 0.04],
					[820, 1],
					[1200, 1],
				]),
				track("eyes.right.smile", [
					[0, 0],
					[380, 0.7],
					[820, 0.2],
					[1200, 0.2],
				]),
				track("eyes.left.smile", [
					[0, 0],
					[420, 0.2],
					[1200, 0.2],
				]),
				track("mouth.form", [
					[0, 0],
					[420, 0.55],
					[1200, 0.35],
				]),
			),
			fit(GAZE_MOTIONS.user, 1200),
		),
	},
	pout: {
		description: "轻偏头、嘟嘴，表达一点小不满",
		definition: parallel(transform(HEAD_MOTIONS.tilt_right, { intensity: 0.6 }), FACE_MOTIONS.pout),
	},
	surprise: { description: "抬头、抬眉、惊讶张嘴", definition: parallel(HEAD_MOTIONS.lifted, FACE_MOTIONS.shocked) },
	shrug: {
		description: "轻抬下巴、微后仰，偏头叹气后微笑，表示无奈（无肩部动作）",
		definition: parallel(
			motion(
				2000,
				track(
					"head.pitch",
					[
						[0, 0],
						[480, 3.5],
						[1000, 2.5],
						[1450, -1.5],
						[2000, 0],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[650, -4.5],
						[1200, -3],
						[2000, 0],
					],
					"baseline-offset",
				),
				{
					...track(
						"torso.pitch",
						[
							[0, 0],
							[650, -2],
							[2000, 0],
						],
						"baseline-offset",
					),
					optional: true,
				},
				track("gaze.x", [
					[0, 0],
					[500, -0.5],
					[1100, -0.4],
					[1800, 0],
					[2000, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[650, 0.12],
					[1800, 0],
					[2000, 0],
				]),
			),
			sequence(
				fit(transform(FACE_MOTIONS.smug, { intensity: 0.55 }), 900),
				fit(transform(smile, { intensity: 0.65 }), 1100),
			),
		),
	},
	head_bop: {
		description: "微笑着轻快左右点晃头，第二次更轻，再柔和收住",
		definition: parallel(
			motion(
				2600,
				track(
					"head.roll",
					[
						[0, 0],
						[400, 4.5],
						[1050, -4],
						[1700, 2],
						[2400, 0],
						[2600, 0],
					],
					"baseline-offset",
				),
				track(
					"head.pitch",
					[
						[0, 0],
						[420, -2],
						[800, 0],
						[1220, -1.6],
						[1700, 0],
						[2600, 0],
					],
					"baseline-offset",
				),
				track(
					"head.yaw",
					[
						[0, 0],
						[400, -1],
						[1050, 1.2],
						[2200, 0],
						[2600, 0],
					],
					"baseline-offset",
				),
				{
					...track(
						"torso.roll",
						[
							[0, 0],
							[400, -1],
							[1050, 1],
							[2600, 0],
						],
						"baseline-offset",
					),
					optional: true,
				},
			),
			fit(transform(smile, { intensity: 0.8 }), 2600),
			fit(GAZE_MOTIONS.user, 2600),
		),
	},
	look_away: {
		description: "视线先躲开，头部随后轻转，害羞地望向旁边",
		definition: parallel(
			motion(
				2100,
				track(
					"head.yaw",
					[
						[0, 0],
						[650, 10],
						[1350, 10],
						[2100, 7],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[850, -3],
						[2100, -1.5],
					],
					"baseline-offset",
				),
				track(
					"head.pitch",
					[
						[0, 0],
						[850, -2],
						[2100, -1.5],
					],
					"baseline-offset",
				),
				track("gaze.x", [
					[0, 0],
					[300, 0.85],
					[1350, 0.85],
					[2100, 0.6],
				]),
				track("gaze.y", [
					[0, 0],
					[500, -0.12],
					[2100, -0.16],
				]),
			),
			fit(transform(FACE_MOTIONS.shy, { intensity: 0.55 }), 2100),
		),
	},
	thinking_deep: {
		description: "慢慢歪头思索，视线轻移，想明白后抬头微笑看回来",
		definition: parallel(
			motion(
				3400,
				track(
					"head.roll",
					[
						[0, 0],
						[800, -5],
						[1500, -6],
						[2400, -3],
						[3400, 0],
					],
					"baseline-offset",
				),
				track(
					"head.pitch",
					[
						[0, 0],
						[900, -2],
						[2200, -2],
						[2850, 2],
						[3400, 0],
					],
					"baseline-offset",
				),
				track("gaze.x", [
					[0, 0],
					[650, -0.5],
					[1500, -0.25],
					[2100, -0.4],
					[2850, 0],
					[3400, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[800, 0.25],
					[1600, 0.15],
					[2100, 0.35],
					[2850, 0],
					[3400, 0],
				]),
			),
			sequence(
				fit(transform(FACE_MOTIONS.smug, { intensity: 0.45 }), 2200),
				fit(transform(smile, { intensity: 0.75 }), 1200),
			),
		),
	},
	smug_grin: {
		description: "微抬下巴、侧目酝酿一丝坏笑，再歪头看回来",
		definition: parallel(
			motion(
				2300,
				track(
					"head.pitch",
					[
						[0, 0],
						[650, 3.5],
						[1200, 3.5],
						[1750, 1],
						[2300, 0],
					],
					"baseline-offset",
				),
				track(
					"head.yaw",
					[
						[0, 0],
						[700, -4],
						[1400, -3],
						[2300, 0],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[900, 4],
						[1450, 4],
						[2300, 0],
					],
					"baseline-offset",
				),
				track("gaze.x", [
					[0, 0],
					[650, -0.3],
					[1550, 0],
					[2300, 0],
				]),
				track("gaze.y", [
					[0, 0],
					[650, -0.1],
					[1550, 0],
					[2300, 0],
				]),
			),
			sequence(
				fit(transform(smile, { intensity: 0.7 }), 450),
				fit(FACE_MOTIONS.smug_grin, 1300),
				fit(transform(smile, { intensity: 0.7 }), 550),
			),
		),
	},
	sleepy_yawn: {
		description: "困倦眯眼、仰头慢慢打哈欠，合嘴后低头回神",
		definition: withSpeech(
			motion(
				3400,
				track(
					"head.pitch",
					[
						[0, 0],
						[1450, 4],
						[1900, 4],
						[2600, -3],
						[3400, 0],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[1600, -2],
						[2600, 2],
						[3400, 0],
					],
					"baseline-offset",
				),
				track("eyes.left.open", [
					[0, 1],
					[600, 0.75],
					[1200, 0.28],
					[2000, 0.22],
					[2500, 0.5],
					[3200, 1],
					[3400, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[600, 0.75],
					[1200, 0.28],
					[2000, 0.22],
					[2500, 0.5],
					[3200, 1],
					[3400, 1],
				]),
				track("mouth.open", [
					[0, 0],
					[650, 0.08],
					[1500, 0.62],
					[1850, 0.62],
					[2400, 0.28],
					[2850, 0],
					[3400, 0],
				]),
				track("mouth.form", [
					[0, 0.12],
					[800, 0],
					[1900, 0.04],
					[3100, 0.24],
					[3400, 0.24],
				]),
				{
					...track("brows.left", [
						[0, 0],
						[1200, -0.16],
						[2200, -0.1],
						[3000, 0],
						[3400, 0],
					]),
					optional: true,
				},
				{
					...track("brows.right", [
						[0, 0],
						[1200, -0.16],
						[2200, -0.1],
						[3000, 0],
						[3400, 0],
					]),
					optional: true,
				},
				{
					...track("jaw.open", [
						[0, 0],
						[1500, 0.2],
						[1900, 0.2],
						[2850, 0],
						[3400, 0],
					]),
					optional: true,
				},
			),
			"exclusive",
		),
	},
	sparkle: {
		description: "先轻轻蓄势，再抬眉展露明亮笑容，开心地偏头收势",
		definition: parallel(
			motion(
				2200,
				track(
					"head.pitch",
					[
						[0, 0],
						[320, -2],
						[1050, 4],
						[1600, 2],
						[2200, 0],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[450, -2.5],
						[1200, 3],
						[2200, 0],
					],
					"baseline-offset",
				),
				track("eyes.left.open", [
					[0, 1],
					[320, 0.92],
					[1000, 1],
					[1600, 0.94],
					[2200, 1],
				]),
				track("eyes.right.open", [
					[0, 1],
					[320, 0.92],
					[1000, 1],
					[1600, 0.94],
					[2200, 1],
				]),
				track("eyes.left.smile", [
					[0, 0],
					[950, 0.3],
					[1450, 0.45],
					[2200, 0.18],
				]),
				track("eyes.right.smile", [
					[0, 0],
					[950, 0.3],
					[1450, 0.45],
					[2200, 0.18],
				]),
				track("brows.left", [
					[0, 0],
					[850, 0.35],
					[1300, 0.25],
					[2200, 0.1],
				]),
				track("brows.right", [
					[0, 0],
					[850, 0.35],
					[1300, 0.25],
					[2200, 0.1],
				]),
				track("mouth.form", [
					[0, 0],
					[1000, 0.62],
					[1450, 0.7],
					[2200, 0.35],
				]),
				{
					...track("face.blush", [
						[0, 0],
						[1000, 0.28],
						[1500, 0.28],
						[2200, 0.1],
					]),
					optional: true,
				},
				{
					...track(
						"torso.pitch",
						[
							[0, 0],
							[1050, 1.5],
							[2200, 0],
						],
						"baseline-offset",
					),
					optional: true,
				},
			),
			fit(GAZE_MOTIONS.user, 2200),
		),
	},
	celebrate: {
		description: "先蓄势，再抬头欢喜，歪头微笑收势",
		definition: sequence(
			fit(parallel(HEAD_MOTIONS.lowered, FACE_MOTIONS.smug), 400),
			parallel(
				fit(HEAD_MOTIONS.lifted, 900),
				fit(FACE_MOTIONS.sparkle, 900),
				delay(
					150,
					motion(
						750,
						track(
							"torso.pitch",
							[
								[0, 0],
								[250, 2],
								[750, 0],
							],
							"baseline-offset",
						),
					),
				),
			),
			fit(parallel(HEAD_MOTIONS.tilt_left, smile), 700),
		),
	},
} satisfies Record<string, { description: string; definition: MotionDefinition }>;
export const MOTION_NAMES = Object.freeze(Object.keys(MOTION_LIBRARY));
export function namedMotion(name: string) {
	if (!Object.hasOwn(MOTION_LIBRARY, name)) throw new Error(`Unknown motion: ${name}`);
	return compileMotion(MOTION_LIBRARY[name as keyof typeof MOTION_LIBRARY].definition);
}
export function supportsMotion(name: string): boolean {
	return Object.hasOwn(MOTION_LIBRARY, name);
}

/** Named performances keep their choreography together; improvised fragments remain composable. */
export function expressionPolicy(params: ExpressParams): { atomic: boolean; speech?: SpeechPolicy } {
	return { atomic: params.atomic ?? Boolean(params.motion), speech: params.speech };
}

/** Channel timing is authored content. Retargeting binds the current pose, never a device parameter. */
type PoseTiming = Readonly<Record<Live2DChannel, readonly [number, number]>>;
const POSE_TIMING: PoseTiming = {
	gaze: [0, 0.55],
	eyes: [0.04, 0.7],
	mouth: [0.04, 0.7],
	head: [0.1, 0.86],
	torso: [0.2, 1],
};
const POSE_ENTRY_TIMING: Partial<Record<BasePoseName, PoseTiming>> = {
	relaxed: { ...POSE_TIMING, torso: [0.04, 0.9], head: [0.04, 0.9] },
	focused: { ...POSE_TIMING, gaze: [0, 0.4], head: [0.02, 0.78] },
	confident: { ...POSE_TIMING, torso: [0, 0.78], head: [0.04, 0.85], mouth: [0.12, 1] },
	streamer_hype: { ...POSE_TIMING, torso: [0, 0.75], head: [0, 0.8], eyes: [0.1, 0.9], mouth: [0.12, 1] },
};

export function compilePoseTransition(
	from: AxisValues,
	to: AxisValues,
	durationMs: number,
	name?: BasePoseName,
): CompiledMotion {
	const timing = (name && POSE_ENTRY_TIMING[name]) || POSE_TIMING;
	return compileMotion(
		motion(
			durationMs,
			...AXIS_NAMES.map((axis) => {
				const [start, end] = timing[AXES[axis].channel];
				const source = from[axis] ?? NEUTRAL_AXES[axis];
				const destination = to[axis] ?? NEUTRAL_AXES[axis];
				const keys: [number, number][] = [[0, source]];
				if (start > 0) keys.push([start * durationMs, source]);
				keys.push([end * durationMs, destination]);
				if (end < 1) keys.push([durationMs, destination]);
				return track(axis, keys);
			}),
		),
	);
}

export const BASE_POSES: Readonly<Record<BasePoseName, AxisValues>> = Object.freeze({
	relaxed: { "head.pitch": -2, "head.roll": -2, "head.yaw": 1, "torso.pitch": -1, "mouth.form": 0.18 },
	focused: { "head.pitch": 2, "torso.pitch": 1.5, "brows.left": -0.06, "brows.right": -0.06, "mouth.form": 0.12 },
	playful: {
		"head.roll": 7,
		"head.yaw": -2,
		"torso.yaw": 2,
		"gaze.x": 0.08,
		"mouth.form": 0.48,
		"face.blush": 0.18,
		"brows.left": 0.1,
		"brows.right": 0.1,
	},
	shy_side: {
		"head.roll": 5,
		"head.yaw": -4,
		"head.pitch": -3,
		"torso.yaw": -2.5,
		"gaze.x": 0.28,
		"gaze.y": -0.12,
		"eyes.left.open": 0.9,
		"eyes.right.open": 0.9,
		"face.blush": 0.5,
		"mouth.form": 0.24,
		"eyes.left.smile": 0.2,
		"eyes.right.smile": 0.2,
		"brows.left": -0.12,
		"brows.right": -0.12,
	},
	confident: {
		"head.pitch": 4,
		"head.roll": -2,
		"head.yaw": 1,
		"torso.pitch": 2,
		"mouth.form": 0.52,
		"eyes.left.smile": 0.2,
		"eyes.right.smile": 0.2,
		"brows.left": 0.12,
		"brows.right": 0.12,
	},
	listening: {
		"head.roll": -6,
		"head.pitch": 1,
		"head.yaw": 2,
		"torso.yaw": 1,
		"mouth.form": 0.28,
		"brows.left": 0.08,
		"brows.right": 0.08,
	},
	smug_gremlin: {
		"head.pitch": 3,
		"head.roll": -5,
		"head.yaw": 2,
		"torso.pitch": 1,
		"eyes.left.open": 0.82,
		"eyes.right.open": 0.9,
		"mouth.form": 0.65,
		"eyes.left.smile": 0.25,
		"eyes.right.smile": 0.4,
		"brows.left": -0.08,
		"brows.right": 0.22,
	},
	meek_shy: { "head.pitch": -4, "head.roll": 4, "head.yaw": -2, "gaze.y": 0.18, "mouth.form": 0.2, "face.blush": 0.35 },
	streamer_hype: {
		"head.pitch": 3,
		"head.roll": 3,
		"torso.pitch": 2.5,
		"mouth.form": 0.68,
		"brows.left": 0.25,
		"brows.right": 0.25,
		"face.blush": 0.2,
	},
});
export const STATE_MOTIONS = {
	thinking: {
		entry: compileMotion(
			motion(
				700,
				track(
					"gaze.x",
					[
						[0, 0],
						[400, -0.18],
						[700, -0.18],
					],
					"baseline-offset",
				),
				track(
					"gaze.y",
					[
						[0, 0],
						[400, 0.18],
						[700, 0.18],
					],
					"baseline-offset",
				),
				track(
					"head.roll",
					[
						[0, 0],
						[120, 0],
						[700, 5],
					],
					"baseline-offset",
				),
				track(
					"head.pitch",
					[
						[0, 0],
						[120, 0],
						[700, -2],
					],
					"baseline-offset",
				),
			),
		),
		exitMs: 420,
	},
};
export type ReflexStateKey = keyof typeof STATE_MOTIONS;

function eyelidMotion(keys: readonly (readonly [number, number])[]): CompiledMotion {
	return compileMotion(motion(keys.at(-1)![0], track("eyes.left.open", keys), track("eyes.right.open", keys)));
}

/** Ambient content uses the same tracks, curves and sampler as authored performances. */
export const AMBIENT = Object.freeze({
	attention: compileMotion(
		motion(
			650,
			track(
				"head.pitch",
				[
					[0, 0],
					[260, 1.6],
					[650, 0],
				],
				"baseline-offset",
			),
		),
	),
	blink: eyelidMotion([
		[0, 1],
		[60, 0],
		[160, 1],
	]),
	doubleBlink: eyelidMotion([
		[0, 1],
		[60, 0],
		[160, 1],
		[210, 1],
		[260, 0],
		[340, 1],
	]),
	noise: compileMotion(
		parallel(
			motion(
				3600,
				track("torso.breath", [
					[0, 0.5],
					[900, 1],
					[1800, 0.5],
					[2700, 0],
					[3600, 0.5],
				]),
				track(
					"head.pitch",
					[
						[0, 0],
						[900, 0.6],
						[1800, 0],
						[2700, -0.6],
						[3600, 0],
					],
					"baseline-offset",
				),
			),
			motion(
				14000,
				track(
					"head.roll",
					[
						[0, 0],
						[3500, 0.85],
						[7000, 0],
						[10500, -0.85],
						[14000, 0],
					],
					"baseline-offset",
				),
				track(
					"head.yaw",
					[
						[0, 0],
						[3500, 0.5],
						[7000, 0],
						[10500, -0.5],
						[14000, 0],
					],
					"baseline-offset",
				),
			),
			motion(
				7000,
				track(
					"torso.yaw",
					[
						[0, 0],
						[1750, 0.45],
						[3500, 0],
						[5250, -0.45],
						[7000, 0],
					],
					"baseline-offset",
				),
			),
			motion(
				20000,
				track(
					"gaze.x",
					[
						[0, 0],
						[5000, 0.018],
						[10000, 0],
						[15000, -0.018],
						[20000, 0],
					],
					"baseline-offset",
				),
				track(
					"gaze.y",
					[
						[0, 0],
						[5000, 0.012],
						[10000, 0],
						[15000, -0.012],
						[20000, 0],
					],
					"baseline-offset",
				),
			),
		),
	),
	speech: compileMotion(
		motion(
			1650,
			track(
				"torso.yaw",
				[
					[0, 0],
					[410, 1.6],
					[825, 0],
					[1240, -1.6],
					[1650, 0],
				],
				"baseline-offset",
			),
			track(
				"torso.pitch",
				[
					[0, 0],
					[410, 0.8],
					[825, 0],
					[1240, -0.8],
					[1650, 0],
				],
				"baseline-offset",
			),
			track(
				"torso.roll",
				[
					[0, 0.7],
					[410, 0],
					[825, -0.7],
					[1240, 0],
					[1650, 0.7],
				],
				"baseline-offset",
			),
			track(
				"head.roll",
				[
					[0, 0],
					[410, 0.65],
					[825, 0],
					[1240, -0.65],
					[1650, 0],
				],
				"baseline-offset",
			),
			track(
				"head.yaw",
				[
					[0, 0],
					[410, 0.5],
					[825, 0],
					[1240, -0.5],
					[1650, 0],
				],
				"baseline-offset",
			),
		),
	),
	accent: compileMotion(
		motion(
			260,
			track(
				"head.pitch",
				[
					[0, 0],
					[80, -1.1],
					[260, 0],
				],
				"baseline-offset",
			),
			track(
				"brows.left",
				[
					[0, 0],
					[80, 0.04],
					[260, 0],
				],
				"baseline-offset",
			),
			track(
				"brows.right",
				[
					[0, 0],
					[80, 0.04],
					[260, 0],
				],
				"baseline-offset",
			),
		),
	),
	idle: ["head.roll", "torso.yaw"].map((axis) =>
		compileMotion(
			motion(
				4400,
				track(
					axis as MotionAxis,
					[
						[0, 0],
						[1100, 5],
						[3100, 5],
						[4400, 0],
					],
					"baseline-offset",
				),
			),
		),
	),
	idleReleaseMs: 650,
	gazeThinking: compileMotion(
		motion(
			5000,
			track(
				"gaze.x",
				[
					[0, 0],
					[1250, 0.12],
					[2500, 0],
					[3750, -0.12],
					[5000, 0],
				],
				"baseline-offset",
			),
			track(
				"gaze.y",
				[
					[0, 0],
					[1250, 0.08],
					[2500, 0],
					[3750, -0.08],
					[5000, 0],
				],
				"baseline-offset",
			),
		),
	),
});
