export type BodyType = "avatar_2d" | "avatar_3d" | "robotic_arm" | "quadruped" | "humanoid" | "custom";
export interface ExpressiveCueDef { id: string; description: string; aliases?: readonly string[]; }
export interface BodyAffordance { bodyId: string; bodyType: BodyType; description: string; cues: ExpressiveCueDef[]; }
export interface BodyState { online: boolean; paused: boolean; fault?: string; }
export interface BodyEndpoint {
	readonly bodyId: string;
	readonly bodyType: BodyType;
	affordance(): BodyAffordance;
	state(): BodyState;
	emitCue(cueId: string): void;
	safeStop(): Promise<void>;
 resume(): Promise<void>;
	supportsCue?(cueId: string): boolean;
	onFocus?(isFocused: boolean): void | Promise<void>;
	formatStatus?(): string;
}
export const BODY_ENDPOINT_EXPOSED_PREFIX = "body.endpoint:";
export const VOICE_LEVEL_SINK_EXPOSED_PREFIX = "voice.levelSink:";

