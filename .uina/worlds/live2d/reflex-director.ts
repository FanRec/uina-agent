import type { BasePoseName } from "./types.js";
import { CHANNEL_PRIORITY } from "./types.js";
import type { MotionDirector } from "./motion-director.js";

/**
 * 宿主为反射层提供的姿态意图通道。
 * 权威姿态状态（当前基准姿态）的所有权在宿主：反射层不得直接改物理层绕过它，
 * 否则宿主对"姿态已被反射切换"毫不知情，权威状态与身体各说各话。
 */
export interface ReflexHostHooks {
	/** 读取当前权威基准姿态。 */
	getBasePose: () => BasePoseName;
	/** 当前是否处于失焦停靠（未提供即视为未停靠）。 */
	isPoseParked?: () => boolean;
	/**
	 * 唤醒到指定基准姿态。宿主实现为走自己的权威写入口（如 runtime.setBasePose）。
	 * 反射层没有"直接改物理层"的退路：那条路会让宿主对姿态已被反射切换毫不知情。
	 */
	activateBasePose: (pose: BasePoseName) => void;
}

/**
 * Live2D 宿主生命周期反射策略器 (ReflexDirector)
 * 职责：
 * 1. 响应 turn_start (用户输入到达，让当前基准姿态重新落下)；
 * 2. 响应 thinking (大模型思考中，轻微歪头好奇，视线微偏)；
 * 3. 响应 turn_end (回合结束，体态回归平稳)；
 * 4. 响应 turn_aborted (打断中断，紧急急停)；
 * 5. 反射不申请租约：只做同步门控与状态参数直写，被更高优先级动作占用时让位。
 *
 * 本层不接触物理层参数：持续状态姿态按声明式表键应用，基准姿态唤醒经宿主权威入口。
 */
export class ReflexDirector {
	private isThinking = false;

	constructor(
		private readonly director: MotionDirector,
		private readonly hooks: ReflexHostHooks,
	) {}

	/**
	 * 早退门控：head 与 gaze 均被 >= REFLEX 级租约占用时，反射无事可做。
	 * 它只是优化，不承担正确性——"别覆盖别人正在用的通道"由写入侧的逐参数门控保证。
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
		if (this.hooks.isPoseParked?.()) return;
		if (this.isReflexBlocked()) return;

		// 经宿主权威入口唤醒；反射不改姿态选择，只让当前姿态重新落下
		this.hooks.activateBasePose(this.hooks.getBasePose());
	}

	onThinking(): void {
		if (this.isThinking) return;
		if (this.isReflexBlocked()) return;
		// 仅在真正施加状态后才记账：否则"什么都没做"的反射稍后仍会去执行一次复位
		this.isThinking = true;

		// 思考时明显歪头 + 视线微偏（参数取自声明式状态表，不再内联魔法数）
		this.director.showStatePose("thinking");
	}

	onSpeakingContent(): void {
		if (this.isThinking) {
			this.isThinking = false;
			this.director.clearStatePose();
		}
	}

	onTurnEnd(): void {
		this.isThinking = false;
		// 回正到基准姿态；若仍有表情节拍在播放，保留其活跃参数不被覆盖。
		// "保留哪些参数"的策略下沉到 director，反射层不再窥探合成层状态。
		this.director.dampenToNeutralPreservingActiveBeats();
	}

	onTurnAborted(): void {
		this.isThinking = false;
		this.director.abortAllMotions();
		this.director.releaseAll();
	}
}