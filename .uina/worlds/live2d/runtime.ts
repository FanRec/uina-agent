import type { ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { VOICE_LEVEL_SINK_EXPOSED_PREFIX, type VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import { encodeFrame, validateRig, type ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import { MotionDirector } from "./director/director.js";
import { buildLive2DEndpoint, type Live2DEndpoint } from "./endpoint.js";
import { SpeechInput, type SpeechConfig } from "./speech-level.js";

/**
 * Live2D 世界运行时。
 *
 * P2-3 范围：生命周期 + VTS 连接 + 保活注入时钟 + director 合成接入。
 * P3-2 增量：voice.levelSink 声学电平接缝（失联守卫 + 作者映射 → 引擎口型包络）。
 * tick 合约（边界规范 §6）：每帧实测 dt 驱动 director.step → adapter.encode → client.inject；
 * 断线/身份不匹配/未发布时既不合成也不注入（保持零输出），重连后从当前状态续合成。
 * - 时钟只在连接就绪且模型身份匹配时运转，断线即停、重连即恢复；
 * - dt 用单调时钟实测（REVIEW 教训：不信任定时器间隔），钳制 250ms 防休眠/节流大跳；
 * - faceFound 与单未确认帧背压由 vts-client 承担，时钟不重复实现；
 * - 发布门的真值来源（acceptance.json + 作者会话）在 P4-6 接入；本阶段恒开放。
 */
export interface Live2DRuntimeOptions {
	/** 注入点（测试用）：替换真实 VTS 连接。缺省按世界默认构造（token 存世界根）。 */
	client?: VTSClient;
	/** 模型 rig；缺省时无注入（诚实零输出）。 */
	rig?: ModelRig;
	/** 注入时钟步长（缺省 1000/60）。 */
	tickIntervalMs?: number;
	/** 注入点（测试用）：director 随机源。缺省 Math.random。 */
	rng?: () => number;
	/** 注入点（测试用）：发布门。缺省 true（P4-6 改由验收门驱动）。 */
	published?: boolean;
	/** 模型作者标定的口型映射；与 rig 同时存在时暴露 voice.levelSink（P3-2）。 */
	speech?: SpeechConfig;
}

/** 单帧合成到注入之间允许的最大时间步（毫秒）：后台节流/休眠恢复时防止动作瞬移。 */
const MAX_TICK_DT_MS = 250;

export class Live2DRuntime {
	private started = false;
	private readonly cleanups: Array<() => void> = [];
	private readonly client?: VTSClient;
	private readonly rig?: ModelRig;
	private readonly tickIntervalMs: number;
	private readonly published: boolean;
	private clock: NodeJS.Timeout | null = null;
	private lastTickAt = 0;
	/** 引擎句柄：P4 工具面（express/state）在此之上操作；无 rig 时不存在。 */
	readonly director?: MotionDirector;
	/** 声学电平接收端：rig + speech 配置同时存在时可用，start 时经 expose 登记给 voice 扩展。 */
	readonly levelSink?: VoiceLevelSink;
	private readonly speechInput?: SpeechInput;
	readonly endpoint: Live2DEndpoint;

	constructor(options: Live2DRuntimeOptions = {}) {
		this.client = options.client;
		this.rig = options.rig;
		this.published = options.published ?? true;
		if (this.rig) {
			validateRig(this.rig);
			this.director = new MotionDirector(this.rig.controls, { external: this.rig.external, rng: options.rng });
			if (options.speech) {
				const input = new SpeechInput(options.speech, this.director);
				this.speechInput = input;
				// 未发布/暂停期间电平一律丢弃（边界规范 §4）；paused 标志随 P4-6/safeStop 接入。
				this.levelSink = {
					processLevel: (level) => {
						if (!this.published) return;
						input.processLevel(level);
					},
					reset: () => input.reset(),
				};
			}
		}
		this.tickIntervalMs = options.tickIntervalMs ?? 1000 / 60;
		this.endpoint = buildLive2DEndpoint(this);
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** 引擎未接入前的统一受理语义：诚实声明未开始，不伪装失败原因。 */
	notStarted(action: string): ToolExecutionResult {
		return {
			result: `Live2D 骨架已就绪，但引擎尚未接入，"${action}" 未执行（施工阶段 P4）。`,
			status: "not_started",
		};
	}

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (ctx.expose) {
			this.cleanups.push(ctx.expose("body.endpoint:live2d", this.endpoint));
			if (this.levelSink) {
				this.cleanups.push(ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX + this.endpoint.bodyId, this.levelSink));
			}
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
		this.lastTickAt = performance.now();
		this.clock = setInterval(() => this.tick(), this.tickIntervalMs);
	}

	private stopClock(): void {
		if (!this.clock) return;
		clearInterval(this.clock);
		this.clock = null;
	}

	private tick(): void {
		const now = performance.now();
		const dt = Math.min(Math.max(now - this.lastTickAt, 0), MAX_TICK_DT_MS);
		this.lastTickAt = now;
		this.composeTick(dt);
	}

	/** 合约入口：合成一步并注入。注入时钟与测试共用（合成推进纯函数化，无真实定时器等待）。 */
	composeTick(dtMs: number): void {
		if (!this.client || !this.director || !this.rig || !this.published) return;
		if (!this.client.isConnected()) return;
		// 身份门：rig 只属于其标定的模型，VTS 当前模型不匹配即零输出，杜绝跨模型误注入。
		const profile = this.client.getModelProfile();
		if (!profile || profile.modelID !== this.rig.modelID) return;
		// 声学电平推进（失联守卫 + 作者映射）→ 引擎包络目标，先于本帧合成。
		this.speechInput?.tick(dtMs);
		const frame = this.director.step(dtMs);
		this.client.injectParameters(encodeFrame(this.rig, frame));
	}

	formatStatus(): string {
		const connection = this.client?.getConnectionStatus();
		return JSON.stringify(
			{
				world: "live2d",
				build: "P2 engine",
				started: this.started,
				engine: this.director ? "director_wired (P2-3)" : "not_wired",
				speech: this.levelSink ? "levelSink_wired (P3-2)" : "not_wired",
				published: this.published,
				rig: this.rig ? { modelID: this.rig.modelID, axes: Object.keys(this.rig.controls).length } : null,
				connection: connection ?? null,
				endpoint: { bodyId: this.endpoint.bodyId, bodyType: this.endpoint.bodyType },
			},
			null,
			2,
		);
	}
}
