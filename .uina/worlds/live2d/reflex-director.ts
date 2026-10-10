import type { BasePoseName } from "./types.js";
import type { MotionDirector } from "./motion-director.js";

export interface ReflexHostHooks {
	getBasePose: () => BasePoseName;
	isPoseParked?: () => boolean;
	/** Runtime owns the user's base-pose choice and its remaining hold time. */
	activateBasePose: (pose: BasePoseName) => void;
}

/** Events update persistent intent. Rendering and masking belong to MotionDirector. */
export class ReflexDirector {
	constructor(
		private readonly director: MotionDirector,
		private readonly hooks: ReflexHostHooks,
	) {}

	onTurnStart(): void {
		this.director.clearStatePose();
		if (!this.hooks.isPoseParked?.()) {
			this.hooks.activateBasePose(this.hooks.getBasePose());
			this.director.triggerAttention();
		}
	}

	onThinking(): void {
		this.director.showStatePose("thinking");
	}

	onSpeakingContent(): void {
		this.director.clearStatePose();
	}

	onTurnEnd(): void {
		this.director.clearStatePose();
	}

	onTurnAborted(): void {
		this.director.abortAllMotions();
	}
}
