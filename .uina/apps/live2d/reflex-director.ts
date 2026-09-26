import type { BasePoseName } from "./types.js";
import type { ChannelArbiter } from "./channel-arbiter.js";
import type { MotionComposer } from "./motion-composer.js";
import { CHANNEL_PRIORITY } from "./types.js";

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
		private readonly composer: MotionComposer,
		private readonly arbiter: ChannelArbiter,
		private readonly getBasePose?: () => BasePoseName,
	) {}

	async onTurnStart(): Promise<void> {
		this.isThinking = false;
		try {
			const lease = await this.arbiter.claim(["head", "gaze"], {
				priority: CHANNEL_PRIORITY.REFLEX,
				reason: "reflex:turn_start",
				allowDegrade: true,
			});
			// 保持或唤醒至当前设定的基准姿态，绝不粗暴清零重置
			const pose = this.getBasePose?.() ?? "focused";
			this.composer.bodyDirector.transitionToActivePose(pose);
			// 自动释放租约让弹簧继续自由运动
			this.arbiter.release(lease);
		} catch {
			// 被高优先级动作占用时忽略
		}
	}

	async onThinking(): Promise<void> {
		if (this.isThinking) return;
		this.isThinking = true;

		try {
			const lease = await this.arbiter.claim(["head", "gaze"], {
				priority: CHANNEL_PRIORITY.REFLEX,
				reason: "reflex:thinking",
				allowDegrade: true,
			});

			// 思考时明显歪头 + 视线微偏上 (清晰可辨的思考姿态)
			this.composer.bodyDirector.setTargets([
				{ name: "ParamAngleZ", value: 10.0 },
				{ name: "ParamEyeBallY", value: 0.6 },
				{ name: "ParamEyeBallX", value: -0.4 },
			]);

			this.arbiter.release(lease);
		} catch {
			// 忽略冲突
		}
	}

	async onTurnEnd(): Promise<void> {
		this.isThinking = false;
		if (this.composer.isPlayingExpressiveBeats?.()) {
			const activeParams = this.composer.getActiveExpressiveParams?.() ?? [];
			this.composer.bodyDirector.dampenToNeutral(activeParams);
		} else {
			this.composer.bodyDirector.dampenToNeutral();
		}
	}

	onTurnAborted(): void {
		this.isThinking = false;
		this.composer.abortAllMotions();
		this.arbiter.releaseAll();
	}
}
