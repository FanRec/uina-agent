import type { BodyEndpoint, BodyState } from "../../../src/extensions/world-framework/seams.js";
import type { Live2DRuntime } from "./runtime.js";

/** 世界对外的端点类型别名：Live2D 身体固定为 2D 虚拟形象。 */
export type Live2DEndpoint = BodyEndpoint;

/**
 * 构造 Live2D 具身端点（P0 骨架）。
 *
 * 目录为空是**诚实状态**：引擎未接入，模型目录不存在，任何 cue 都不可达——
 * supportsCue 与 affordance 同源于空目录，绝不虚报能力。
 * P1+ 随引擎接入填充 state() 的 online 事实与目录驱动的能力声明。
 */
export function buildLive2DEndpoint(runtime: Live2DRuntime): Live2DEndpoint {
	const state = (): BodyState => ({ online: false, paused: false });
	return {
		bodyId: "live2d",
		bodyType: "avatar_2d",
		affordance: () => ({
			bodyId: "live2d",
			bodyType: "avatar_2d",
			description: "Live2D 具身身体（引擎接入前目录为空）。",
			cues: [],
		}),
		state,
		emitCue: (cueId) => {
			void cueId; // 空目录下路由器不会派发到本端点；此路径为防御性占位。
		},
		safeStop: async () => {},
		resume: async () => {},
		formatStatus: () => runtime.formatStatus(),
	};
}
