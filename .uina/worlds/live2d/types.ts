/**
 * Live2D 应用领域类型与参数定义
 */

export type Live2DChannel = "mouth" | "eyes" | "gaze" | "head" | "torso";
export type SpeechPolicy = "blend" | "exclusive";

export const ALL_CHANNELS: readonly Live2DChannel[] = ["mouth", "eyes", "gaze", "head", "torso"] as const;

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
	readonly signal: AbortSignal;
	readonly atomic?: boolean;
	release(): void;
}

export interface ChannelClaimOptions {
	priority?: number;
	reason?: string;
	signal?: AbortSignal;
	preemptSameReason?: boolean;
	preemptSamePriority?: boolean;
	atomic?: boolean;
}

export interface ExpressBeat {
	head?: string;
	gaze?: string;
	face?: string;
	hold_ms?: number;
	latch?: boolean;
	intensity?: number;
}

export type MotionTransition = "snappy" | "smooth" | "gentle";

export interface ExpressParams {
	motion?: string;
	atomic?: boolean;
	head?: string;
	gaze?: string;
	face?: string;
	intensity?: number;
	beats?: readonly ExpressBeat[];
	latch_last?: boolean;
	transition?: MotionTransition;
	speech?: SpeechPolicy;
}

/**
 * 基准姿态名运行时清单（单一事实来源）：<cue id="姿态名"/>（零开销姿态切换）与 pose
 * 工具共用这一份。BasePoseName 类型由数组派生、motion-library 的 BASE_POSES 以
 * Record<BasePoseName,...> 强制齐名——名单、类型、姿态表三处编译期永不漂移。
 */
export const BASE_POSE_NAMES = Object.freeze([
	"relaxed",
	"focused",
	"playful",
	"shy_side",
	"confident",
	"listening",
	"smug_gremlin",
	"meek_shy",
	"streamer_hype",
] as const);

export type BasePoseName = (typeof BASE_POSE_NAMES)[number];

export const BASE_POSE_DESCRIPTIONS: Readonly<Record<BasePoseName, string>> = Object.freeze({
	relaxed: "微低头、轻偏头的放松待机",
	focused: "轻抬头的专注姿态",
	playful: "元气微笑、俏皮歪头",
	shy_side: "娇羞侧身偏头",
	confident: "自信微笑、轻抬下巴",
	listening: "轻歪头、注视用户地倾听",
	smug_gremlin: "小恶魔得意坏笑",
	meek_shy: "内向害羞上目线",
	streamer_hype: "抬眉微笑的兴奋姿态",
});

/** 类型守卫：cue id 是否为姿态名（派发端免断言，收敛唯一一处 readonly 放宽）。 */
export function isBasePoseName(value: string): value is BasePoseName {
	return (BASE_POSE_NAMES as readonly string[]).includes(value);
}

/**
 * 可中断的异步等待辅助函数
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener("abort", abortHandler);
			resolve();
		}, ms);

		const abortHandler = () => {
			clearTimeout(timer);
			resolve();
		};

		if (signal) signal.addEventListener("abort", abortHandler, { once: true });
	});
}
