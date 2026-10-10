import type { ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { buildLive2DEndpoint, type Live2DEndpoint } from "./endpoint.js";

/**
 * Live2D 世界运行时骨架（P0）。
 *
 * P0 只承载生命周期与工具受理语义：所有具身操作在引擎（P1+）接入前如实返回
 * not_started，不做任何未授权的伪装。状态字段是后续阶段复用的唯一事实位。
 */
export class Live2DRuntime {
	private started = false;
	private readonly cleanups: Array<() => void> = [];
	readonly endpoint: Live2DEndpoint;

	constructor() {
		this.endpoint = buildLive2DEndpoint(this);
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** 引擎未接入前的统一受理语义：诚实声明未开始，不伪装失败原因。 */
	notStarted(action: string): ToolExecutionResult {
		return {
			result: `Live2D 骨架已就绪，但引擎尚未接入，"${action}" 未执行（施工阶段 P1+）。`,
			status: "not_started",
		};
	}

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (ctx.expose) {
			this.cleanups.push(ctx.expose("body.endpoint:live2d", this.endpoint));
		}
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		for (const cleanup of this.cleanups.splice(0).reverse()) {
			try {
				cleanup();
			} catch {
				// 拆除路径不因单个清理失败而中断（世界层资源释放无条件执行）。
			}
		}
	}

	formatStatus(): string {
		return JSON.stringify(
			{
				world: "live2d",
				build: "P0 skeleton",
				started: this.started,
				engine: "not_wired (P1+)",
				endpoint: { bodyId: this.endpoint.bodyId, bodyType: this.endpoint.bodyType },
			},
			null,
			2,
		);
	}
}
