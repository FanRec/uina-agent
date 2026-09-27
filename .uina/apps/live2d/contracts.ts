export type BodyType = "avatar_2d" | "avatar_3d" | "robotic_arm" | "quadruped" | "humanoid" | "custom";
export interface ExpressiveCueDef { id: string; description: string; aliases?: readonly string[]; }
export interface BodyAffordance { bodyId: string; bodyType: BodyType; description: string; cues: ExpressiveCueDef[]; }
export interface BodyState { online: boolean; fault?: string; }
export interface BodyEndpoint {
	readonly bodyId: string;
	readonly bodyType: BodyType;
	affordance(): BodyAffordance;
	state(): BodyState;
	emitCue(cueId: string): void;
	safeStop(): Promise<void>;
	onFocus?(isFocused: boolean): void | Promise<void>;
}
export interface VoiceLevelEvent { readonly traceId: string; readonly rms: number; readonly peak: number; readonly timestamp: number; }
export interface VoiceLevelSink { processLevel(level: { rms: number; peak?: number }): void; reset(): void; }
export const BODY_ENDPOINT_EXPOSED_PREFIX = "body.endpoint:";
export const VOICE_LEVEL_SINK_EXPOSED_PREFIX = "voice.levelSink:";
