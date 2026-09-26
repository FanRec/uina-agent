/**
 * Live2D 应用领域类型与参数定义
 */

export type Live2DChannel = "mouth" | "eyes" | "gaze" | "head" | "torso";

export const ALL_CHANNELS: readonly Live2DChannel[] = [
	"mouth",
	"eyes",
	"gaze",
	"head",
	"torso",
] as const;

export const PARAM_CHANNEL_MAP: Readonly<Record<string, Live2DChannel>> = Object.freeze({
	ParamAngleX: "head",
	ParamAngleY: "head",
	ParamAngleZ: "head",
	ParamBodyAngleX: "torso",
	ParamBodyAngleY: "torso",
	ParamBodyAngleZ: "torso",
	ParamBreath: "torso",
	ParamEyeBallX: "gaze",
	ParamEyeBallY: "gaze",
	ParamEyeLOpen: "eyes",
	ParamEyeROpen: "eyes",
	ParamEyeLSmile: "eyes",
	ParamEyeRSmile: "eyes",
	ParamBrowLY: "eyes",
	ParamBrowRY: "eyes",
	ParamMouthOpenY: "mouth",
	ParamMouthForm: "mouth",
	ParamCheek: "eyes",
});

export const CHANNEL_PRIORITY = {
	IDLE: 10,
	REFLEX: 20,
	CUE: 30,
	ACTION: 50,
	EMERGENCY: 100,
} as const;

export interface ChannelLease {
	readonly id: string;
	readonly channels: readonly Live2DChannel[];
	readonly priority: number;
	readonly reason?: string;
	readonly signal?: AbortSignal;
	readonly atomic?: boolean;
	release(): void;
}

export interface ChannelClaimOptions {
	priority?: number;
	reason?: string;
	signal?: AbortSignal;
	allowDegrade?: boolean;
	preemptSameReason?: boolean;
	preemptSamePriority?: boolean;
	atomic?: boolean;
}

export interface Live2DParamTarget {
	name: string;
	value: number;
	weight?: number;
	additive?: boolean;
}

export type HeadPose = "tilt_left" | "tilt_right" | "nod" | "shake" | "lowered" | "lifted";
export type GazeDirection = "user" | "away_left" | "away_right" | "down" | "side_peek";
export type FaceExpression =
	| "shy"
	| "smug"
	| "pout"
	| "sparkle"
	| "shocked"
	| "tender_smile"
	| "laugh"
	| "winking"
	| "smug_grin"
	| "sleepy_yawn";

export interface ExpressBeat {
	head?: HeadPose | string;
	gaze?: GazeDirection | string;
	face?: FaceExpression | string;
	hold_ms?: number;
}

export interface ExpressParams {
	head?: HeadPose | string;
	gaze?: GazeDirection | string;
	face?: FaceExpression | string;
	intensity?: number;
	beats?: ExpressBeat[];
}

export type BasePoseName =
	| "relaxed"
	| "focused"
	| "playful"
	| "shy_side"
	| "confident"
	| "listening";

/**
 * 统一规范的 Live2D 硬件参数安全阈值钳位 (Clamp)
 */
export function clampLive2DParam(name: string, val: number): number {
	if (name.startsWith("ParamAngle")) {
		return Math.max(-30, Math.min(30, val));
	}
	if (name.startsWith("ParamBodyAngle")) {
		return Math.max(-15, Math.min(15, val));
	}
	if (name.includes("Eye") && name.includes("Open")) {
		return Math.max(0, Math.min(2, val));
	}
	if (name.startsWith("ParamEyeBall")) {
		return Math.max(-1, Math.min(1, val));
	}
	if (
		name.includes("Smile") ||
		name === "ParamCheek" ||
		name === "ParamBreath" ||
		name === "ParamMouthOpenY"
	) {
		return Math.max(0, Math.min(1, val));
	}
	if (name === "ParamMouthForm" || name.startsWith("ParamBrow")) {
		return Math.max(-1, Math.min(1, val));
	}
	return val;
}

