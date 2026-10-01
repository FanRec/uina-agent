import type { BasePoseName } from "./types.js";


import { CHANNEL_PRIORITY } from "./types.js";
import type { MotionDirector } from "./motion-director.js";

/**
 * Live2D 宿主生命周期反射策略器 (ReflexDirector)
 * 职责：
 * 1. 响应 turn_start (用户输入到达，抬眼注视，保持当前基准姿态)；
 * 2. 响应 thinking (大模型思考中，轻微歪头好奇，视线微偏)；
 * 3. 响应 turn_end (回合结束，体态回归平稳)；
 * 4. 响应 turn_aborted (打断中断，紧急急停)；
 * 5. 反射使用较低优先级 (REFLEX = 20) 与 allowDegrade，不抢占 LLM 显式动作。
 */
export class ReflexDirector {
	private isThinking = false;

	constructor(
		private readonly director: MotionDirector,
		private readonly getBasePose?: () => BasePoseName,
		hooks?: { isPoseParked?: () => boolean },
	) {
		this.isPoseParked = hooks?.isPoseParked;
	}

	private readonly isPoseParked?: () => boolean;

	/**
	 * 反射忙检查：head 与 gaze 均被 >= REFLEX 级租约占用时让位。
	 * 此前用 claim+立即 release 做该检查——异步绕一圈只为读状态，改为同步门控。
	 */
	private isReflexBlocked(): boolean {
		return (
			this.director.isChannelLocked("head", CHANNEL_PRIORITY.REFLEX) &&
			this.director.isChannelLocked("gaze", CHANNEL_PRIORITY.REFLEX)
		);
	}

	onTurnStart(): void {
		this.isThinking = false;
		// 失焦停靠中不唤醒姿态：parked 语义是"视觉呈现 relaxed"，用户姿态意图保持不变
		if (this.isPoseParked?.()) return;
		if (this.isReflexBlocked()) return;
		// 保持或唤醒至当前设定的基准姿态，绝不粗暴清零重置
		const pose = this.getBasePose?.() ?? "focused";
		this.director.bodyDirector.transitionToActivePose(pose);
	}

	onThinking(): void {
		if (this.isThinking) return;
		this.isThinking = true;
		if (this.isReflexBlocked()) return;

		// 思考时明显歪头 + 视线微偏上 (清晰可辨的思考姿态)
		this.director.bodyDirector.setTargets([
			{ name: "ParamAngleZ", value: 10.0 },
			{ name: "ParamEyeBallY", value: 0.6 },
			{ name: "ParamEyeBallX", value: -0.4 },
		]);
	}

	onSpeakingContent(): void {
		if (this.isThinking) {
			this.isThinking = false;
			this.director.bodyDirector.dampenParams(["ParamAngleZ", "ParamEyeBallX", "ParamEyeBallY"]);
		}
	}

	async onTurnEnd(): Promise<void> {
		this.isThinking = false;
		if (this.director.isPlayingExpressiveBeats?.()) {
			const activeParams = this.director.getActiveExpressiveParams?.() ?? [];
			this.director.bodyDirector.dampenToNeutral(activeParams);
		} else {
			this.director.bodyDirector.dampenToNeutral();
		}
	}

	onTurnAborted(): void {
		this.isThinking = false;
		this.director.abortAllMotions();
		this.director.releaseAll();
	}
}


