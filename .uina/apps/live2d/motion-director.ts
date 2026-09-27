import { ChannelArbiter } from "./channel-arbiter.js";
import { MotionComposer } from "./motion-composer.js";

/** Live2D 的唯一动作聚合入口；外部模块不再自行装配仲裁器和合成器。 */
export class MotionDirector {
	readonly arbiter: ChannelArbiter;
	readonly composer: MotionComposer;

	constructor() {
		this.arbiter = new ChannelArbiter();
		this.composer = new MotionComposer(this.arbiter);
	}

	compose(deltaMs: number, options?: { speechEnergy?: number }): Record<string, number> {
		return this.composer.compose(deltaMs, options);
	}

	abortAllMotions(): void {
		this.composer.abortAllMotions();
		this.arbiter.releaseAll();
	}
}
