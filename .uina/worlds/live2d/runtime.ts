import type { ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { buildLive2DEndpoint, type Live2DEndpoint } from "./endpoint.js";
import { encodeFrame, neutralFrame, validateRig, type ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";

/**
 * Live2D 世界运行时。
 *
 * P1-3 范围：生命周期 + VTS 连接 + 保活注入时钟。具身工具在引擎（P2+）接入前
 * 仍如实返回 not_started。保活契约（引擎规范 §3.4）：
 * - 时钟只在连接就绪时注入，断线即停、重连即恢复（基座流 = 当前合成帧）；
 * - P1 阶段无 director，合成帧恒为 rig 中性帧；发布门条件（未发布零输出）在 P2-3/P4-6 落地；
 * - faceFound 与单未确认帧背压由 vts-client 承担，时钟不重复实现。
 */
export interface Live2DRuntimeOptions {
	/** 注入点（测试用）：替换真实 VTS 连接。缺省按世界默认构造（token 存世界根）。 */
	client?: VTSClient;
	/** 模型 rig；缺省时无注入（诚实零输出）。rig.json 装配在后续阶段接入。 */
	rig?: ModelRig;
	/** 注入时钟步长（缺省 1000/60）。 */
	tickIntervalMs?: number;
}

export class Live2DRuntime {
	private started = false;
	private readonly cleanups: Array<() => void> = [];
	private readonly client?: VTSClient;
	private readonly rig?: ModelRig;
	private readonly tickIntervalMs: number;
	private clock: NodeJS.Timeout | null = null;
	readonly endpoint: Live2DEndpoint;

	constructor(options: Live2DRuntimeOptions = {}) {
		this.client = options.client;
		this.rig = options.rig;
		if (this.rig) validateRig(this.rig);
		this.tickIntervalMs = options.tickIntervalMs ?? 1000 / 60;
		this.endpoint = buildLive2DEndpoint(this);
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** 引擎未接入前的统一受理语义：诚实声明未开始，不伪装失败原因。 */
	notStarted(action: string): ToolExecutionResult {
		return {
			result: `Live2D 骨架已就绪，但引擎尚未接入，"${action}" 未执行（施工阶段 P2+）。`,
			status: "not_started",
		};
	}

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (ctx.expose) {
			this.cleanups.push(ctx.expose("body.endpoint:live2d", this.endpoint));
		}
		if (this.client) {
			// 监听必须先于 connect 注册：ready 回调在 connect 流程内同步链上触发。
			this.client.setConnectionChangeListener((connected) => {
				if (!this.started) return;
				if (connected) this.startClock();
				else this.stopClock();
			});
			this.client.connect();
		}
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.stopClock();
		for (const cleanup of this.cleanups.splice(0).reverse()) {
			try {
				cleanup();
			} catch {
				// 拆除路径不因单个清理失败而中断（世界层资源释放无条件执行）。
			}
		}
		this.client?.disconnect();
	}

	private startClock(): void {
		if (this.clock || !this.client) return;
		this.clock = setInterval(() => this.tick(), this.tickIntervalMs);
	}

	private stopClock(): void {
		if (!this.clock) return;
		clearInterval(this.clock);
		this.clock = null;
	}

	/** 每帧合成 → 编码 → 注入。断线、无 rig、无 client 时零输出。 */
	private tick(): void {
		if (!this.client || !this.rig || !this.client.isConnected()) return;
		// P1：无 director，合成帧恒为中性基座流；P2-3 接入后此行替换为 director.compose 输出。
		this.client.injectParameters(encodeFrame(this.rig, neutralFrame(this.rig)));
	}

	formatStatus(): string {
		const connection = this.client?.getConnectionStatus();
		return JSON.stringify(
			{
				world: "live2d",
				build: "P1 keepalive",
				started: this.started,
				engine: this.rig ? "keepalive_wired (P1-3)" : "not_wired (P2+)",
				rig: this.rig ? { modelID: this.rig.modelID, axes: Object.keys(this.rig.controls).length } : null,
				connection: connection ?? null,
				endpoint: { bodyId: this.endpoint.bodyId, bodyType: this.endpoint.bodyType },
			},
			null,
			2,
		);
	}
}
