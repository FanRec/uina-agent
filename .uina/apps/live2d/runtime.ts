import type {
	BodyAffordance,
	BodyEndpoint,
	BodyState,
} from "../../extensions/embodiment/types.js";
import { BODY_ENDPOINT_EXPOSED_PREFIX } from "../../extensions/embodiment/types.js";
import { VOICE_LEVEL_SINK_EXPOSED_PREFIX } from "../../extensions/voice/events.js";
import type { ActionContext, ServiceCompanionContext } from "../../../src/extensions/app-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { AudioObserver } from "./audio-observer.js";
import { ChannelArbiter } from "./channel-arbiter.js";
import { Live2DStateTracker, VTSCompanion } from "./companion.js";
import { MotionComposer } from "./motion-composer.js";
import {
	CANONICAL_CUE_IDS,
	DEFAULT_EXPRESSIVE_INTENSITY,
	getChannelsForBeats,
	getCueAliases,
	resolveCueToBeat,
} from "./parameter-mapper.js";
import { ReflexDirector } from "./reflex-director.js";
import { type BasePoseName, CHANNEL_PRIORITY, type ExpressParams } from "./types.js";
import { VTSClient } from "./vts-client.js";

/**
 * 规范 cue 的一行说明（注入提示词的 prose）。
 * id 集合与别名**不在这里定义**——它们由 parameter-mapper 的 CANONICAL_CUE_IDS /
 * CUE_ALIASES 派生，避免声明(id/别名)与解析端(CUE_BEAT_TABLE)两个来源漂移。
 * 这里只存放既含 id 又含别名之外的纯说明文本；规则：每个规范 id 必须有说明，
 * 每个说明对应的 id 必须是规范 id（由本文件底部的一致性测试守护）。
 */
const CUE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	warm_smile: "温暖友善的微笑",
	happy_laugh: "开心地眯眼大笑",
	curious_tilt: "好奇探寻地歪头",
	affirmative_nod: "肯定点头赞同",
	double_nod: "用力连续点头两次，强烈赞成",
	shake_head: "拨浪鼓式连连摇头",
	shrug: "无奈耸肩叹气",
	head_bop: "随说话节奏轻快点晃头",
	playful_pout: "傲娇嘟嘴偏头",
	surprised_gasp: "惊讶睁大眼睛倒吸气",
	shy: "害羞脸红偏头避开视线",
	look_away: "尴尬移开视线望向别处",
	peek_back: "移开视线后又悄悄偷看回用户",
	thinking_deep: "歪头托腮陷入深思",
	winking: "调皮单眼眨眼",
	smug_grin: "得意坏笑歪嘴",
	sleepy_yawn: "犯困打哈欠微仰头",
};

export const live2dAffordance: BodyAffordance = {
	bodyId: "live2d_mo",
	bodyType: "avatar_2d",
	description:
		"你当前在屏幕上呈现为 Live2D 虚拟二次元立绘形象（Mo）。可通过 pose 切换全身基准体态（持续循环生效：playful=元气调皮大歪头, focused=专注认真正坐, relaxed=闲适放松待机, shy_side=娇羞侧身偏头, confident=自信挺胸昂首, listening=侧耳前倾倾听），日常说话时优先在台词中嵌入 <cue id='...'/> 伴随丰富自然的微表情与肢体反应。",
	cues: CANONICAL_CUE_IDS.map((id) => ({
		id,
		description: CUE_DESCRIPTIONS[id] ?? "",
		// 别名统一取自 parameter-mapper 的 CUE_ALIASES；恒等别名已被过滤。
		aliases: getCueAliases(id),
	})),
};

export class Live2DEndpoint implements BodyEndpoint {
	readonly bodyId = "live2d_mo";
	readonly bodyType = "avatar_2d";

	constructor(
		readonly composer: MotionComposer,
		readonly arbiter: ChannelArbiter,
		readonly stateTracker: Live2DStateTracker,
	) {
		this.arbiter.setCueDispatcher(async (cueId) => {
			const beats = resolveCueToBeat(cueId);
			if (!beats || beats.length === 0) return;

			const channelsToClaim = getChannelsForBeats(beats);
			let lease: import("./types.js").ChannelLease | undefined;
			try {
				lease = await this.arbiter.claim(channelsToClaim, {
					priority: CHANNEL_PRIORITY.CUE,
					reason: `cue:${cueId}`,
					allowDegrade: true,
					preemptSamePriority: true,
				});
			} catch {
				// All channels locked by higher-priority Action (>= 50); gracefully ignore
				return;
			}

			try {
				await this.composer.playExpressiveBeats(
					{ beats, intensity: 1.0 },
					{ signal: lease.signal, allowedChannels: lease.channels },
				);
			} finally {
				this.arbiter.release(lease);
			}
		});
	}

	affordance(): BodyAffordance {
		return live2dAffordance;
	}

	state(): BodyState {
		return this.stateTracker.getState();
	}

	/** 最近一次到达本端点的线索（含时间）——给用户一个"cue 到底通没通"的可见凭据。 */
	lastCue?: { id: string; at: string };

	emitCue(cueId: string): void {
		this.lastCue = { id: cueId, at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) };
		this.arbiter.dispatchCue(cueId);
	}

	async safeStop(): Promise<void> {
		this.composer.abortAllMotions();
		this.arbiter.releaseAll();
	}

	onFocus(isFocused: boolean): void {
		if (isFocused) {
			this.composer.bodyDirector.transitionToActivePose();
		} else {
			this.composer.bodyDirector.transitionToParkedPose();
		}
	}
}

/**
 * Live2D 统一运行时聚合根 (Live2DRuntime)
 * 职责：
 * 1. 高内聚整合所有子模块（Composer, Arbiter, Companion, Client, Endpoint, Reflex, Audio）；
 * 2. 规范化管理外部服务接入、事件监听与注销清理（生命周期闭环）；
 * 3. 权威维护应用状态（currentCostume, currentBasePose），并与底层动力学回正双向同步；
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
	readonly arbiter: ChannelArbiter;
	readonly composer: MotionComposer;
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

	private readonly cleanupFns: Array<() => void> = [];
	private isStarted = false;

	constructor(options?: { vtsClient?: VTSClient }) {
		this.arbiter = new ChannelArbiter();
		this.composer = new MotionComposer(this.arbiter);
		this.audioObserver = new AudioObserver();
		this.audioObserver.setComposer(this.composer);

		this.vtsClient = options?.vtsClient ?? new VTSClient();
		this.companion = new VTSCompanion(this.composer, this.arbiter, this.vtsClient, this.audioObserver);
		this.endpoint = new Live2DEndpoint(this.composer, this.arbiter, this.companion.stateTracker);
		this.reflexDirector = new ReflexDirector(this.composer, this.arbiter, () => this.currentBasePose);

		// 状态双向同步：当底层限时基准姿态倒计时结束自动回正时，同步更新 currentBasePose
		this.composer.bodyDirector.setOnBasePoseExpired(() => {
			this.currentBasePose = "relaxed";
		});
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
			this.cleanupFns.push(
				ctx.expose(BODY_ENDPOINT_EXPOSED_PREFIX + this.endpoint.bodyId, this.endpoint),
			);
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
			// 宿主未提供同进程出口（非 app-framework 嵌入场景）：端点无法成为具身身体。
			// 不阻断运行（VTS 直控仍可用），但必须可见——render 会标出该状态。
			console.warn(
				"[Live2D] 宿主未提供 expose 通道，端点未注册为具身身体：<cue> 与 body 工具将不可用。",
			);
		}

		// 3. 订阅宿主事实事件流，驱动回合级反射。
		//    必须保留 type/channel：反射要区分"思考中"(output_update + thinking 通道)
		//    与"正说话"(content 通道)，极简 onActivity 抽象给不了这个区分。
		if (ctx.onHostEvent) {
			const unbindHost = ctx.onHostEvent((event) => {
				switch (event.type) {
					case "turn_start":
						void this.reflexDirector.onTurnStart();
						break;
					case "output_update":
						if (event.channel === "thinking") void this.reflexDirector.onThinking();
						break;
					case "turn_end":
						void this.reflexDirector.onTurnEnd();
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
					void this.reflexDirector.onTurnStart();
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

		this.composer.abortAllMotions();
		this.arbiter.releaseAll();
	}

	render(tier: "ambient" | "expanded"): string {
		const isOnline = this.companion.stateTracker.getState().online;
		const statusStr = isOnline ? "在线(VTS)" : "离线(VTS)";
		const bodyStr = this.bodyRegistered ? "已注册" : "未注册";
		const levelStr = this.levelSinkExposed ? "已接线" : "未接线";
		const cueStr = this.endpoint.lastCue
			? `${this.endpoint.lastCue.id}（${this.endpoint.lastCue.at}）`
			: "无";
		const hotkeys = this.companion.getAvailableHotkeys();
		const hotkeyNames = hotkeys.length > 0 ? hotkeys.map((h) => h.name).join(", ") : "无";

		if (tier === "ambient") {
			return `[live2d] Mo: ${statusStr} | 姿态: ${this.currentBasePose} | 服装: ${this.currentCostume}`;
		}

		return `[live2d]
物理状态: ${statusStr}
具身注册: ${bodyStr}
口型通道: ${levelStr}
最近线索: ${cueStr}
姿态: ${this.currentBasePose}
服装: ${this.currentCostume}
热键: ${hotkeyNames}
[/live2d]`;
	}

	/**
	 * 执行大模型编排的微表情与即兴肢体动作 (express 动作)
	 */
	async executeExpress(args: ExpressParams, ctx: ActionContext): Promise<string> {
		const beats = args.beats && args.beats.length > 0
			? args.beats
			: [{ head: args.head, gaze: args.gaze, face: args.face, hold_ms: 1000 }];

		// 最小特权通道推导（复用通用推导，彻底消除手写判定）
		const channelsToClaim = getChannelsForBeats(beats);

		const lease = await this.arbiter.claim(channelsToClaim, {
			reason: "action:express",
			preemptSameReason: true,
			allowDegrade: true,
			signal: ctx.signal,
		});

		try {
			await this.composer.playExpressiveBeats(
				{ beats, intensity: args.intensity ?? DEFAULT_EXPRESSIVE_INTENSITY },
				{ signal: lease.signal, allowedChannels: lease.channels },
			);
			ctx.setTier("ambient");
			const isOnline = this.vtsClient.isConnected();
			const note = isOnline ? "" : "（VTS 离线，已在本地同步姿态）";
			return `即兴肢体表情已执行${note}。`;
		} finally {
			this.arbiter.release(lease);
		}
	}

	/**
	 * 切换全身基准姿态与心境氛围 (pose 动作)
	 */
	async executePose(name: BasePoseName, durationMs: number, ctx: ActionContext): Promise<string> {
		const lease = await this.arbiter.claim(["head", "torso"], {
			reason: "action:pose",
			preemptSameReason: true,
			signal: ctx.signal,
		});
		try {
			this.currentBasePose = name;
			this.composer.bodyDirector.applyBasePose(name, {
				transitionMs: 800,
				holdMs: durationMs > 0 ? durationMs : undefined,
			});
			ctx.setTier("ambient");
			const returnMsg = durationMs > 0 ? `（保持 ${durationMs}ms 后自然回正）` : "（持续生效）";
			return `基准体态已切换为: ${name} ${returnMsg}`;
		} finally {
			this.arbiter.release(lease);
		}
	}

	/**
	 * 触发 VTS 装扮/配饰热键 (costume 动作)
	 */
	async executeCostume(item: string, ctx: ActionContext): Promise<string | ToolExecutionResult> {
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
				return "当前加载的模型未检测到任何可用的装扮/道具热键。";
			}
			const listStr = hotkeys.map((h) => `${h.name} (${h.hotkeyID})`).join(", ");
			return `当前模型支持的装扮/道具热键: [${listStr}]`;
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

		const lease = await this.arbiter.claimAllChannels("costume", ctx.signal);
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
			ctx.setTier("ambient");
			return {
				result: `已成功触发装扮/道具热键: ${matched.name}`,
				status: "succeeded",
				details: { executionMode: "vts_hotkey", effectStatus: "confirmed", hotkeyID: matched.hotkeyID },
			};
		} finally {
			this.arbiter.release(lease);
		}
	}

	/**
	 * 单次 360° 腾空翻转特技的物理位移与旋转解算
	 */
	async executePhysicalFlip(signal?: AbortSignal): Promise<{ aborted: boolean }> {
		await this.vtsClient.moveModel({
			positionY: -0.08,
			timeInSeconds: 0.15,
			valuesAreRelativeToModel: true,
		});
		await abortableDelay(150, signal);

		const steps = 25;
		const stepMs = 30;
		let currentY = -0.08;
		let aborted = false;

		try {
			for (let i = 0; i < steps; i++) {
				if (signal?.aborted) {
					aborted = true;
					break;
				}
				const phase = (i + 1) / steps;
				const targetY = Math.sin(phase * Math.PI) * 0.22;
				const deltaY = targetY - currentY;
				currentY = targetY;
				const deltaRot = 360 / steps;

				await this.vtsClient.moveModel({
					positionY: deltaY,
					rotation: deltaRot,
					timeInSeconds: (stepMs / 1000) * 1.2,
					valuesAreRelativeToModel: true,
				});
				await abortableDelay(stepMs, signal);
			}
		} finally {
			// 无论何种异常或打断取消，强制落地归位与旋转归零，保证模型绝不留存物理脏状态
			try {
				await this.vtsClient.moveModel({
					positionY: -currentY,
					timeInSeconds: 0.1,
					valuesAreRelativeToModel: true,
				});
				await new Promise((resolve) => setTimeout(resolve, 100));

				await this.vtsClient.moveModel({
					rotation: 0,
					timeInSeconds: 0.1,
					valuesAreRelativeToModel: false,
				});
				await new Promise((resolve) => setTimeout(resolve, 60));
			} catch {
				// ignore cleanup error
			}
		}

		return { aborted };
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
			lease = await this.arbiter.claimAllChannels("flip", ctx.signal);
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
				const res = await this.executePhysicalFlip(ctx.signal);
				aborted = res.aborted;
			} catch (error) {
				return {
					result: `VTS 翻转请求失败，物理状态未知：${error instanceof Error ? error.message : String(error)}`,
					status: "unknown",
					details: { executionMode: "vts_physical", effectStatus: "unknown" },
				};
			}

			if (aborted) {
				return {
					result: "360° 翻转已被取消，模型高度与旋转均已复位归正。",
					status: "cancelled",
					details: { executionMode: "vts_physical", effectStatus: "cancelled" },
				};
			}

			await this.composer.playExpressiveBeats(
				{
					beats: [
						{ head: "lowered", face: "smug", hold_ms: 200 },
						{ head: "lifted", face: "sparkle", hold_ms: 700 },
						{ head: "tilt_left", face: "tender_smile", hold_ms: 350 },
					],
				},
				{ signal: lease.signal, allowedChannels: lease.channels },
			);
			ctx.setTier("ambient");
			return {
				result: "VTS 物理翻转与本地表情动作已完成。",
				status: "succeeded",
				details: { executionMode: "vts_physical", effectStatus: "confirmed" },
			};
		} finally {
			this.arbiter.release(lease);
		}
	}
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener("abort", abortHandler);
			resolve();
		}, ms);

		const abortHandler = () => {
			clearTimeout(timer);
			resolve();
		};

		if (signal) signal.addEventListener("abort", abortHandler, { once: true });
	});
}
