import type { BodyAffordance, BodyEndpoint, BodyState } from "./contracts.js";
import { BODY_ENDPOINT_EXPOSED_PREFIX, VOICE_LEVEL_SINK_EXPOSED_PREFIX } from "./contracts.js";
import type { ActionContext, ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import { worldSucceeded } from "../../../src/extensions/world-framework/result.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { AudioObserver } from "./audio-observer.js";
import { VTSCompanion } from "./companion.js";
import { performModelFlip } from "./model-motion.js";
import { MotionDirector } from "./motion-director.js";
import {
	BASE_POSES,
	expressionPolicy,
	MOTION_LIBRARY,
	MOTION_NAMES,
	supportsMotion,
	namedMotion,
	compileExpression,
} from "./motion-library.js";
import { compileMotion, pose, type CompiledMotion } from "./motion.js";
import { AXIS_NAMES, NEUTRAL_AXES } from "./motion-axes.js";
import { ReflexDirector } from "./reflex-director.js";
import {
	BASE_POSE_DESCRIPTIONS,
	BASE_POSE_NAMES,
	type BasePoseName,
	CHANNEL_PRIORITY,
	type ChannelClaimOptions,
	type ExpressParams,
	type MotionTransition,
	type SpeechPolicy,
	isBasePoseName,
} from "./types.js";
import { VTSClient } from "./vts-client.js";

export const live2dAffordance: BodyAffordance = {
	bodyId: "live2d",
	bodyType: "avatar_2d",
	description:
		"屏幕上的 Live2D 形象。日常正文用 <cue id='动作名'/> 调用命名动作；复杂表演用 express 的 motion 或 head/gaze/face 和 beats 即兴组合。pose 设置持续基准姿态。动作能力受真实模型绑定与物理限制。",
	cues: [
		...MOTION_NAMES.map((id) => ({ id, description: MOTION_LIBRARY[id as keyof typeof MOTION_LIBRARY].description })),
		...BASE_POSE_NAMES.map((id) => ({ id, description: "切换持续基准姿态：" + BASE_POSE_DESCRIPTIONS[id] })),
	],
};

/**
 * 端点将焦点、状态与模型准入决策交还给运行时，只适配具身协议。
 * 焦点语义（停靠/恢复哪个姿态）依赖运行时持有的权威姿态状态，端点不该自己猜。
 */
interface Live2DEndpointHooks {
	onFocused: (isFocused: boolean) => void;
	formatStatus: () => string;
	supportsCue: (cueId: string) => boolean;
}

class Live2DEndpoint implements BodyEndpoint {
	readonly bodyId = live2dAffordance.bodyId;
	readonly bodyType = "avatar_2d";

	constructor(
		readonly director: MotionDirector,
		private readonly client: VTSClient,
		private readonly hooks: Live2DEndpointHooks,
	) {}

	affordance(): BodyAffordance {
		return { ...live2dAffordance, cues: live2dAffordance.cues.filter((c) => this.supportsCue(c.id)) };
	}

	state(): BodyState {
		return { online: this.client.isConnected(), fault: this.client.getFault() };
	}

	/** 最近一次收到的线索（不是物理呈现确认）（含时间）——给用户一个"cue 到底通没通"的可见凭据。 */
	lastCue?: { id: string; at: string };

	emitCue(cueId: string): void {
		// VTS 离线时瞬态 cue 无法呈现：既不写"已到达"的凭据（那会让凭据失真），也不做看不见的本地表演。
		// 姿态名例外：它是本地基准姿态意图，与 pose 工具离线同样生效的口径对齐。
		if ((!this.client.isConnected() && !isBasePoseName(cueId)) || !this.supportsCue(cueId)) return;
		this.lastCue = { id: cueId, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) };
		this.director.dispatchCue(cueId);
	}

	supportsCue(cueId: string): boolean {
		return this.hooks.supportsCue(cueId);
	}

	formatStatus(): string {
		return this.hooks.formatStatus();
	}

	async safeStop(): Promise<void> {
		this.director.abortAllMotions();
	}

	onFocus(isFocused: boolean): void {
		this.hooks.onFocused(isFocused);
	}
}

/**
 * Live2D 统一运行时聚合根 (Live2DRuntime)
 * 职责：
 * 1. 高内聚整合所有子模块（Composer, Arbiter, Companion, Client, Endpoint, Reflex, Audio）；
 * 2. 规范化管理外部服务接入、事件监听与注销清理（生命周期闭环）；
 * 3. 维护用户姿态意图和最近装扮热键；动作合成器拥有呈现与到期；
 * 4. 消除散落的模块级单例，提供清晰易测的统一上下文。
 *
 * 与宿主的两个接缝（均由 ServiceCompanionContext 提供，方向相反）：
 * - `expose`：把本端点作为活引用交给宿主同进程共享表，供 embodiment 扩展拉取并注册为身体；
 * - `onHostEvent`：接收宿主事实事件流，驱动 ReflexDirector 的回合级反射。
 *
 * 口型通道走**电平事件**而非 PCM：本端把声学接收端 expose 给宿主同进程共享表，
 * 声音生产者（tts）按前缀筛出后推电平，AudioObserver 在 60Hz tick 中做包络平滑。
 * 逐帧 PCM 旁路方案已否决并删除：口型只需要包络，不值得为此新建二进制通道。
 */
export class Live2DRuntime {
	readonly director: MotionDirector;
	readonly audioObserver: AudioObserver;
	readonly vtsClient: VTSClient;
	readonly companion: VTSCompanion;
	readonly endpoint: Live2DEndpoint;
	readonly reflexDirector: ReflexDirector;

	currentCostume = "default";
	currentBasePose: BasePoseName = "relaxed";
	/** 端点是否已作为具身身体暴露给宿主的同进程共享表（决定 cue 与 body 工具是否可达）。 */
	bodyRegistered = false;
	/** 声学电平接收端是否已暴露（决定口型是否有驱动来源）。 */
	levelSinkExposed = false;
	/** 端点当前是否失焦停靠中（物理上呈现 relaxed，但权威姿态仍是用户的选择）。 */
	private poseParked = false;
	/** 用户姿态的剩余限时（停靠时暂存），停靠期间冻结。 */
	private poseIntentRemainingMs?: number;

	private readonly cleanupFns: Array<() => void> = [];
	private isStarted = false;

	constructor(options?: { vtsClient?: VTSClient }) {
		this.director = new MotionDirector();
		this.director.applyBasePose("relaxed");
		this.audioObserver = new AudioObserver();
		this.audioObserver.setDirector(this.director);

		this.vtsClient = options?.vtsClient ?? new VTSClient();
		this.companion = new VTSCompanion(this.director, this.vtsClient, this.audioObserver);
		this.endpoint = new Live2DEndpoint(this.director, this.vtsClient, {
			onFocused: (focused) => this.handleFocus(focused),
			formatStatus: () => this.formatStatus(),
			supportsCue: (id) => {
				const program = this.companion.getAdapter();
				if (!program) return isBasePoseName(id);
				if (isBasePoseName(id)) return program.admit(this.poseMotion(id)).ok;
				return supportsMotion(id) && program.admit(namedMotion(id)).ok;
			},
		});
		this.reflexDirector = new ReflexDirector(this.director, {
			getBasePose: () => this.currentBasePose,
			isPoseParked: () => this.poseParked,
			// 经公开的唤醒语义唤醒。反射从不切换姿态（保持用户的选择），只把当前姿态重新落下，
			// 因此剩余限时恒保留——不保留就会在每次回合开始时静默清掉用户的限时姿态。
			activateBasePose: (pose) => this.wakeBasePose(pose),
		});

		// 合成器负责到期时的呈现切换；这里只同步用户姿态意图。
		this.director.setOnBasePoseExpired(() => {
			this.currentBasePose = "relaxed";
		});

		// cue 与 express 共用模型准入、申请、播放与释放路径。
		this.director.setCueDispatcher(async (cueId) => {
			// 姿态名 cue：与 pose 工具同一权威写入口（setBasePose），默认持续生效。
			// 瞬态节拍 cue 在 VTS 离线时已被 emitCue 早退拦下；姿态名是本地意图，离线也直达这里。
			if (isBasePoseName(cueId)) {
				this.setBasePose(cueId, { transitionMs: 800 });
				return;
			}
			if (!supportsMotion(cueId)) return;
			await this.playMotionWithLease(namedMotion(cueId), {
				...expressionPolicy({ motion: cueId }),
				priority: CHANNEL_PRIORITY.CUE,
				reason: `cue:${cueId}`,
				preemptSamePriority: true,
			});
		});
	}

	/**
	 * 姿态唯一写入口：权威状态与物理基准目标同源，杜绝两处各说各话。
	 * 停靠中只更新用户意图（权威姿态与剩余限时），物理继续呈现 relaxed——
	 * 否则合成器会带上倒计时，到期回调把权威姿态改写成 relaxed，从而吞掉用户姿态意图。
	 */
	private setBasePose(name: BasePoseName, options?: { transitionMs?: number; holdMs?: number }): void {
		this.currentBasePose = name;
		if (this.poseParked) {
			this.poseIntentRemainingMs = options?.holdMs;
			return;
		}
		this.director.applyBasePose(name, options);
	}

	/**
	 * 失焦停靠/回焦恢复：临时在 relaxed 待机与用户选择的姿态间切换。
	 * 不改变 currentBasePose（用户的姿态意图）。停靠期间剩余限时由运行时记账并冻结，
	 * 回焦后还剩多少就再展示多少——既不吞掉、也不被停靠姿态的倒计时污染。
	 */
	private handleFocus(focused: boolean): void {
		if (focused === !this.poseParked) return;
		this.poseParked = !focused;
		this.director.setReflexVisible(focused);
		if (focused) {
			const remaining = this.poseIntentRemainingMs;
			this.poseIntentRemainingMs = undefined;
			this.director.applyBasePose(this.currentBasePose, {
				transitionMs: 800,
				holdMs: remaining,
			});
		} else {
			this.poseIntentRemainingMs = this.director.getHoldRemainingMs();
			// 停靠姿态不携带限时：合成器无倒计时 => 不会触发到期回调污染权威状态
			this.director.applyBasePose("relaxed", { transitionMs: 800 });
		}
	}

	/**
	 * 唤醒当前基准姿态（不切换）：反射层（回合开始等）把用户选定的姿态重新落下。
	 * 与 setBasePose 的"切换"语义分离；停靠中早退，物理继续呈现停靠姿态。
	 * 保留剩余限时（clearLatch=false），避免反射唤醒静默清掉用户的限时姿态。
	 */
	wakeBasePose(pose: BasePoseName = this.currentBasePose): void {
		if (this.poseParked) return;
		this.director.applyBasePose(pose, { transitionMs: 800, holdMs: this.director.getHoldRemainingMs() }, false);
	}

	/**
	 * 统一节拍执行原语：申请通道 → 播放 → 释放。
	 * claim 失败以 { ok: false } 返回而非抛出，由调用方决定结果语义
	 * （cue 安静让位 / express 返回结构化失败）；播放中的异常仍然抛出。
	 */
	private async playMotionWithLease(
		motion: CompiledMotion,
		options: ChannelClaimOptions & {
			reason: string;
			latch_last?: boolean;
			transition?: MotionTransition;
			speech?: SpeechPolicy;
		},
	): Promise<
		| { ok: true; cancelled: boolean; omittedChannels: readonly string[]; omittedAxes: readonly string[] }
		| { ok: false; claimError: Error }
	> {
		if (!(await this.vtsClient.validateModelFiles()))
			return { ok: false, claimError: new Error("模型事实已失效或未就绪") };
		const program = this.companion.getAdapter();
		if (!program) return { ok: false, claimError: new Error("模型适配未就绪") };
		const admission = program.admit(motion);
		if (!admission.ok) return { ok: false, claimError: new Error(admission.reasons.join("；")) };
		motion = admission.motion;
		this.director.setControlGroups(program.controlGroups);
		const requestedChannels = motion.channels;
		let lease;
		try {
			lease = await this.director.claim(requestedChannels, options);
		} catch (error) {
			return { ok: false, claimError: error instanceof Error ? error : new Error(String(error)) };
		}

		try {
			const playback = await this.director.play(motion, {
				lease,
				latch: options.latch_last,
				transition: options.transition,
				speech: options.speech,
			});
			return {
				ok: true,
				cancelled: playback.status === "cancelled",
				omittedAxes: admission.omittedAxes,
				omittedChannels: requestedChannels.filter((ch) => !lease.channels.includes(ch)),
			};
		} finally {
			lease.release();
		}
	}

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.isStarted) return;
		this.isStarted = true;

		// 1. 启动伴生循环与 VTS 连接
		this.companion.start();
		this.cleanupFns.push(() => this.companion.stop());

		// 2. 以活引用暴露本端点（同进程共享表）。
		//    不走 callService：它对入参双向 structuredClone，而 BodyEndpoint 带原型方法
		//    与闭包（仲裁器的 cueDispatcher、生理底噪的 Math.random），克隆必然抛错。
		//    消费侧是 embodiment 扩展：它用 pi.shared(APP_EXPOSED_SHARED_NAME) 拉取。
		if (ctx.expose) {
			this.cleanupFns.push(ctx.expose(BODY_ENDPOINT_EXPOSED_PREFIX + this.endpoint.bodyId, this.endpoint));
			// 声学电平接收端：声音生产者（tts）按前缀筛出来推电平，本端只做接收，
			// 不去读生产者内部状态。口型包络的平滑在本端 tick 里完成。
			this.cleanupFns.push(
				ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX + this.endpoint.bodyId, {
					processLevel: (level: { rms: number; peak?: number }) => {
						this.audioObserver.processLevel(level);
					},
					reset: () => {
						this.audioObserver.reset();
					},
				}),
			);
			this.bodyRegistered = true;
			this.levelSinkExposed = true;
		} else {
			// 宿主未提供同进程出口（非 world-framework 嵌入场景）：端点无法成为具身身体。
			// 不阻断运行（VTS 直控仍可用），但必须可见——render 会标出该状态。
			console.warn("[Live2D] 宿主未提供 expose 通道，端点未注册为具身身体：<cue> 与 body 工具将不可用。");
		}

		// 3. 订阅宿主事实事件流，驱动回合级反射。
		//    必须保留 type/channel：反射要区分"思考中"(output_update + thinking 通道)
		//    与"正说话"(content 通道)，极简 onActivity 抽象给不了这个区分。
		if (ctx.onHostEvent) {
			const unbindHost = ctx.onHostEvent((event) => {
				switch (event.type) {
					case "turn_start":
						this.reflexDirector.onTurnStart();
						break;
					case "output_update":
						if (event.channel === "thinking") {
							this.reflexDirector.onThinking();
						} else if (event.channel === "content") {
							this.reflexDirector.onSpeakingContent();
						}
						break;
					case "turn_end":
						this.reflexDirector.onTurnEnd();
						break;
					case "turn_aborted":
						this.reflexDirector.onTurnAborted();
						break;
				}
			});
			this.cleanupFns.push(unbindHost);
		} else if (ctx.onActivity) {
			// 降级：只剩"有人说话"这一个信号，思考/回正/急停反射不可用。
			const unbindActivity = ctx.onActivity((event) => {
				if (event.origin === "human") {
					this.reflexDirector.onTurnStart();
				}
			});
			this.cleanupFns.push(unbindActivity);
		}
	}

	async stop(): Promise<void> {
		if (!this.isStarted) return;
		this.isStarted = false;
		this.bodyRegistered = false;
		this.levelSinkExposed = false;

		for (const cleanup of this.cleanupFns) {
			try {
				cleanup();
			} catch {
				// ignore
			}
		}
		this.cleanupFns.length = 0;

		this.director.abortAllMotions();
		// 停靠与限时意图随运行时一起复位。此时落回权威姿态的只是内存中的基准目标值——
		// ticker 已停、VTS 可能已断开，停机期间没有任何物理呈现；
		// 这一步只为复用 restart 时权威状态与合成起点保持连贯，不重启就不会有事件再纠正它。
		this.poseParked = false;
		this.director.setReflexVisible(true);
		this.poseIntentRemainingMs = undefined;
		this.director.applyBasePose(this.currentBasePose, { transitionMs: 800 });
	}

	formatStatus(): string {
		const isOnline = this.vtsClient.isConnected();
		const profile = this.vtsClient.getModelProfile();
		const program = this.companion.getAdapter();
		const limitations = program
			? Object.values(program.capabilities)
					.filter((c) => !c.available)
					.map((c) => `${c.axis}: ${c.reasons.join("、")}`)
					.join("；")
			: "模型绑定未就绪";
		const connection = this.vtsClient.getConnectionStatus();
		const statusStr = isOnline
			? program && Object.values(program.capabilities).some((c) => c.available)
				? "可控制(VTS)"
				: "API 与模型已核验，暂无可用动作轴"
			: connection.apiConnected
				? "API 已连接，控制未就绪"
				: `${connection.stage}（API 未连接，不代表 VTS 软件未启动）`;
		const bodyStr = this.bodyRegistered ? "已注册" : "未注册";
		const levelStr = this.levelSinkExposed ? "已接线" : "未接线";
		const cueStr = this.endpoint.lastCue ? `${this.endpoint.lastCue.id}（${this.endpoint.lastCue.at}）` : "无";
		const hotkeys = this.vtsClient.getAvailableHotkeys();
		const hotkeyNames = hotkeys.length > 0 ? hotkeys.map((h) => h.name).join(", ") : "无";

		const poseStr = this.poseParked ? `${this.currentBasePose}（失焦停靠中，物理呈现 relaxed）` : this.currentBasePose;

		return `[live2d]
物理状态: ${statusStr}
VTS API: ${connection.endpoint} · ${connection.stage} · ${connection.authenticated ? "已鉴权" : "未鉴权"}
具身注册: ${bodyStr}
口型通道: ${levelStr}
最近接收线索: ${cueStr}
姿态: ${poseStr}
呈现层: ${JSON.stringify(this.director.getPresentationState())}
最近装扮热键: ${this.currentCostume}
热键: ${hotkeyNames}
模型: ${profile?.modelName ?? "未知"} · ${profile?.fingerprint?.slice(0, 12) ?? "无指纹"}
模型控制限制: ${limitations}
最近校准饱和: ${this.companion.lastSaturation.join("、") || "无"}
适配可用轴: ${
			program
				? Object.values(program.capabilities)
						.filter((c) => c.available)
						.map((c) => `${c.axis}(${c.mode}/${c.calibration})`)
						.join(", ")
				: "无"
		}
传输证据: ${JSON.stringify(this.vtsClient.getInjectionStats())}
连接故障: ${this.vtsClient.getFault() ?? "无"}
[/live2d]`;
	}

	/**
	 * 执行大模型编排的微表情与即兴肢体动作 (express 动作)
	 */
	async executeExpress(args: ExpressParams, ctx: ActionContext): Promise<ToolExecutionResult> {
		let motion: CompiledMotion;
		try {
			motion = compileExpression(args);
		} catch (error) {
			return {
				result: "未执行动作：" + (error instanceof Error ? error.message : String(error)),
				status: "failed",
				details: { reason: "invalid_motion", effectStatus: "not_started" },
			};
		}

		// 瞬态节拍在 VTS 离线时无法呈现：与 costume/flip 一致，诚实返回 not_started，
		// 而不是"本地同步姿态"的半真话——节拍是 200ms~3s 的瞬态，重连时早已演完。
		if (!this.vtsClient.isConnected()) {
			return {
				result: "未执行即兴肢体表演：VTube Studio 离线，瞬态动作无法呈现。",
				status: "failed",
				details: { reason: "vts_offline", effectStatus: "not_started" },
			};
		}

		const before = this.vtsClient.getInjectionStats();
		const outcome = await this.playMotionWithLease(motion, {
			reason: "action:express",
			preemptSameReason: true,
			signal: ctx.signal,
			...expressionPolicy(args),
			latch_last: args.latch_last ?? args.beats?.at(-1)?.latch,
			transition: args.transition,
		});
		if (!outcome.ok) {
			return {
				result: `未执行即兴表演：身体通道申请失败（${outcome.claimError.message}）。`,
				status: ctx.signal.aborted ? "cancelled" : "failed",
				details: {
					reason: ctx.signal.aborted ? "cancelled" : "motion_not_admitted",
					effectStatus: "not_started",
				},
			};
		}
		const after = this.vtsClient.getInjectionStats();
		if (after.generation !== before.generation)
			return {
				result: "播放期间设备或模型变化，呈现状态未知。",
				status: "unknown",
				details: { effectStatus: "unknown" },
			};
		if (outcome.cancelled)
			return { result: "即兴表演已被取消或抢占。", status: "cancelled", details: { effectStatus: "cancelled" } };
		const transmission = {
			sent: after.sent - before.sent,
			accepted: after.accepted - before.accepted,
			failed: after.failed - before.failed,
			dropped: after.dropped - before.dropped,
			filtered: after.filtered - before.filtered,
		};
		if (
			transmission.failed ||
			transmission.filtered ||
			!transmission.sent ||
			!transmission.accepted ||
			after.lastAcceptedAt < Date.now() - 1000
		)
			return {
				result: "动作时间线结束，但设备接受证据不足，呈现未知。",
				status: "unknown",
				details: { effectStatus: "unknown", transmission, omittedAxes: outcome.omittedAxes },
			};
		const partial =
			outcome.omittedChannels.length > 0 ? ` 通道 ${outcome.omittedChannels.join("、")} 被占用，相关动作未执行。` : "";
		return worldSucceeded(
			`动作时间线完成，VTS 已接受期间的输入请求；未确认视觉效果。${partial}${outcome.omittedAxes.length ? ` 可选轴未执行: ${outcome.omittedAxes.join("、")}` : ""}`,
			{
				omittedChannels: outcome.omittedChannels,
				omittedAxes: outcome.omittedAxes,
				partial: outcome.omittedAxes.length > 0,
				transmission,
				verification: "input_accepted",
			},
			"accepted",
		);
	}

	/**
	 * 切换全身基准姿态与心境氛围 (pose 动作)
	 */
	private poseMotion(name: BasePoseName): CompiledMotion {
		return compileMotion(
			pose(
				1000,
				{ ...NEUTRAL_AXES, ...BASE_POSES[name] },
				"absolute",
				AXIS_NAMES.filter((a) => (BASE_POSES[name][a] ?? NEUTRAL_AXES[a]) === NEUTRAL_AXES[a]),
			),
		);
	}
	async executePose(name: BasePoseName, durationMs: number, _ctx: ActionContext): Promise<ToolExecutionResult> {
		if (this.vtsClient.isConnected()) {
			const admission = this.companion.getAdapter()?.admit(this.poseMotion(name));
			if (!admission?.ok)
				return {
					result: "未设置姿态：" + (admission?.reasons.join("；") ?? "适配未就绪"),
					status: "failed",
					details: { effectStatus: "not_started" },
				};
		}
		// 基准姿态不占用动作租约；呈现由合成器按当前所有权应用。
		this.setBasePose(name, {
			transitionMs: 800,
			holdMs: durationMs > 0 ? durationMs : undefined,
		});
		const returnMsg = durationMs > 0 ? `（保持 ${durationMs}ms 后自然回归 relaxed 待机）` : "（持续生效）";
		return worldSucceeded(
			`本地基准姿态意图已设置为: ${name} ${returnMsg}；呈现受 VTS 在线状态与模型绑定影响。`,
			undefined,
			"applied",
		);
	}

	/**
	 * 触发 VTS 装扮/配饰热键 (costume 动作)
	 */
	async executeCostume(item: string, ctx: ActionContext): Promise<ToolExecutionResult> {
		const query = item.trim();
		if (!this.vtsClient.isConnected()) {
			return {
				result: `未执行装扮热键 ${query}：VTube Studio 离线，无法与模型通信。`,
				status: "failed",
				details: { reason: "vts_offline", effectStatus: "not_started" },
			};
		}

		const hotkeys = this.vtsClient.getAvailableHotkeys();
		if (!query || query.toLowerCase() === "list") {
			if (hotkeys.length === 0) {
				return worldSucceeded("当前加载的模型未检测到任何可用的装扮/道具热键。");
			}
			const listStr = hotkeys.map((h) => `${h.name} (${h.hotkeyID})`).join(", ");
			return worldSucceeded(`当前模型支持的装扮/道具热键: [${listStr}]`);
		}

		const matched = this.vtsClient.findHotkey(query);
		if (!matched) {
			const availableNames = hotkeys.map((h) => h.name).join(", ");
			const hint = availableNames ? `当前模型可用的热键为: [${availableNames}]` : "当前模型未配置任何热键";
			return {
				result: `未找到名为 "${query}" 的装扮热键。${hint}。请从中选择。`,
				status: "failed",
				details: { reason: "hotkey_not_found", effectStatus: "not_started", availableHotkeys: hotkeys },
			};
		}

		let lease;
		try {
			lease = await this.director.claimAllChannels("costume", ctx.signal);
		} catch (error) {
			return {
				result: `未触发装扮热键：${error instanceof Error ? error.message : String(error)}`,
				status: ctx.signal.aborted ? "cancelled" : "failed",
				details: { effectStatus: "not_started" },
			};
		}
		try {
			try {
				await this.vtsClient.triggerHotkey(matched.hotkeyID);
			} catch (error) {
				return {
					result: `装扮热键 "${matched.name}" 请求失败，物理状态未知：${error instanceof Error ? error.message : String(error)}`,
					status: "unknown",
					details: { reason: "vts_hotkey_failed", effectStatus: "unknown" },
				};
			}

			this.currentCostume = matched.name;
			return {
				result: `VTS 已接受装扮/道具热键: ${matched.name}；实际装扮状态需观察模型。`,
				status: "succeeded",
				details: { executionMode: "vts_hotkey", effectStatus: "accepted", hotkeyID: matched.hotkeyID },
			};
		} finally {
			lease.release();
		}
	}

	/**
	 * 执行 360° 腾空翻转特技与庆祝微表情 (flip 动作)
	 */
	async executeFlip(ctx: ActionContext): Promise<ToolExecutionResult> {
		if (!this.vtsClient.isConnected()) {
			return {
				result: "未执行 360° 翻转特技：VTube Studio 离线，无法进行物理位移与旋转控制。",
				status: "failed",
				details: { executionMode: "vts_physical", effectStatus: "not_started", reason: "vts_offline" },
			};
		}

		let lease;
		try {
			lease = await this.director.claimAllChannels("flip", ctx.signal);
		} catch (error) {
			return {
				result: `未执行 360° 翻转：身体通道申请失败（${error instanceof Error ? error.message : String(error)}）。`,
				status: ctx.signal.aborted ? "cancelled" : "failed",
				details: {
					executionMode: "vts_physical",
					effectStatus: "not_started",
					reason: ctx.signal.aborted ? "cancelled" : "channel_conflict",
				},
			};
		}

		try {
			let aborted = false;
			try {
				const res = await performModelFlip(this.vtsClient, lease.signal);
				aborted = res.aborted;
				if (res.cleanupFailed) {
					return {
						result: "VTS 翻转清理失败，模型物理状态未知。",
						status: "unknown",
						details: { executionMode: "vts_physical", effectStatus: "unknown", reason: "cleanup_failed" },
					};
				}
			} catch (error) {
				return {
					result: `VTS 翻转请求失败，物理状态未知：${error instanceof Error ? error.message : String(error)}`,
					status: "unknown",
					details: { executionMode: "vts_physical", effectStatus: "unknown" },
				};
			}

			if (aborted) {
				return {
					result: "360° 翻转已被取消，模型原位置、角度与大小已核实恢复。",
					status: "cancelled",
					details: { executionMode: "vts_physical", effectStatus: "cancelled" },
				};
			}

			const celebrationAdmission = this.companion.getAdapter()?.admit(namedMotion("celebrate"));
			if (!celebrationAdmission?.ok)
				return {
					result: "翻转已归位；当前模型不支持后续庆祝表情，未执行表情。",
					status: "succeeded",
					details: { effectStatus: "accepted", restoration: "confirmed", omitted: "celebrate" },
				};
			const celebration = await this.director.play(celebrationAdmission.motion, { lease });
			return {
				result:
					celebration.status === "cancelled"
						? "翻转已归位，后续表情被取消。"
						: "翻转时间线完成，原位置已核实恢复；表情参数已交给 VTS。",
				status: celebration.status === "cancelled" ? "cancelled" : "succeeded",
				details: { executionMode: "vts_physical", effectStatus: "accepted", restoration: "confirmed" },
			};
		} finally {
			lease.release();
		}
	}
}
