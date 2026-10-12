import type { ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { VOICE_LEVEL_SINK_EXPOSED_PREFIX, type VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import { encodeFrame, validateRig, type ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import {
	emptyCatalog,
	recompileWithSpeech,
	type CatalogMotionEntry,
	type CatalogSnapshot,
} from "./authoring/catalog.js";
import type { CompiledMotion, SpeechPolicy } from "./authoring/motion.js";
import {
	MotionDirector,
	SupersededError,
	type ExclusiveClaim,
	type MotionHandle,
	type PlayOptions,
} from "./director/director.js";
import { buildLive2DEndpoint, type Live2DEndpoint } from "./endpoint.js";
import { fromEngineResult, toolRejected, toolSucceeded, toolUnknown } from "./results.js";
import { SpeechInput, type SpeechConfig } from "./speech-level.js";

/**
 * Live2D 世界运行时。
 *
 * P2-3 范围：生命周期 + VTS 连接 + 保活注入时钟 + director 合成接入。
 * P3-2 增量：voice.levelSink 声学电平接缝（失联守卫 + 作者映射 → 引擎口型包络）。
 * P4-1 增量：工具 gate 链（边界规范 §2.1 词表）、目录快照词表解析、
 *           express/state 引擎映射、status/diagnose 真实事实。
 *
 * 发布验收门（§7，P4-6 曾实现）已按操作员裁决拆除（ Occam：单人本机场景下
 * author-session/digest 门防不住也拦不着任何真实威胁，纯属流程仪式）。
 *
 * tick 合约（边界规范 §6）：每帧实测 dt 驱动 director.step → adapter.encode → client.inject；
 * 断线/身份不匹配/暂停时既不合成也不注入（暂停注入保持帧），重连后从当前状态续合成。
 * - 时钟只在连接就绪且模型身份匹配时运转，断线即停、重连即恢复；
 * - dt 用单调时钟实测（REVIEW 教训：不信任定时器间隔），钳制 250ms 防休眠/节流大跳；
 * - faceFound 与单未确认帧背压由 vts-client 承担，时钟不重复实现；
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
	/** 模型作者标定的口型映射；与 rig 同时存在时暴露 voice.levelSink（P3-2）。 */
	speech?: SpeechConfig;
	/** 目录快照；缺省空目录（诚实状态：一切命名参数显式拒绝）。 */
	catalog?: CatalogSnapshot;
	/** 独占声明清理等待上限（§6.4 safeStop 抛错判定；注入点（测试用），缺省 5000ms）。 */
	cleanupTimeoutMs?: number;
	/** 状态事实变化通知（连接/适配/目录代次）。引擎线程以此推送 sync 缓存；状态变化不唤醒对话回合，即时真值由 status/body 查询保证。 */
	onStatusChange?: () => void;
}

/** 单帧合成到注入之间允许的最大时间步（毫秒）：后台节流/休眠恢复时防止动作瞬移。 */
const MAX_TICK_DT_MS = 250;

/** 空间变换常量（§2：回读前留出 VTS 动画结算余量；自动归位时间）。 */
const SETTLE_MARGIN_MS = 60;
const RESTORE_SECONDS = 0.25;

type ModelPose = { positionX: number; positionY: number; rotation: number; size: number };

const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** 取消立即结束调用方等待；已经发出的 VTS 请求仍由客户端结算。 */
function withCancellation<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		const cleanup = () => signal.removeEventListener("abort", abort);
		request.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

const wrapDeg = (d: number): number => (((d % 360) + 540) % 360) - 180;

const poseMatches = (now: ModelPose, base: ModelPose): boolean =>
	Math.abs(wrapDeg(now.rotation - base.rotation)) <= 0.5 &&
	Math.abs(now.positionX - base.positionX) <= 0.01 &&
	Math.abs(now.positionY - base.positionY) <= 0.01 &&
	Math.abs(now.size - base.size) <= 0.01;


/** 省略或 0 表示持续；非法时长返回工具拒绝结果。 */
function parseHoldMs(value: unknown): number | undefined | ToolExecutionResult {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return toolRejected("invalid_duration", "hold_ms 必须是非负有限数值。");
	return value > 0 ? value : undefined;
}

/** 格式化目录条目名称与别名列表。 */
const formatCatalogEntries = (map: ReadonlyMap<string, { aliases?: readonly string[] }>): string[] =>
	[...map.entries()].map(([k, v]) => (v.aliases?.length ? `${k}(${v.aliases.join("/")})` : k));

export class Live2DRuntime {
	private started = false;
	private readonly cleanups: Array<() => void> = [];
	private readonly client?: VTSClient;
	private readonly rig?: ModelRig;
	private readonly tickIntervalMs: number;
	private catalog: CatalogSnapshot;
	/** 目录代次：目录更新递增；cue 受理绑定受理时代次，执行时校验（§3 目录快照与执行竞态）。 */
	private generation = 0;
	/** safeStop 暂停标志：工具 gate、电平丢弃、tick 保持帧分支的统一事实。 */
	private paused = false;
	/** 焦点状态（BodyRouter onFocus 通知）；幂等去重在本方法内完成（边界 #5）。 */
	private focused = true;
	/** thinking 状态（§5 宿主事件）：状态驱动幂等，仅跳变时启/停 background.thinking。 */
	private thinking = false;
	private thinkingHandle?: MotionHandle;
	/** 环境循环选中名：uina 经 ambient 工具选择/清除，选中时替换 idle 成为静止态背景。 */
	private ambientName?: string;
	private restHandle?: MotionHandle;
	/** 独占声明 reason 序号：每次声明唯一 reason，重叠声明一律 resource_conflict（不做同 reason 幂等替换）。 */
	private claimSeq = 0;
	private spatialClaim?: ExclusiveClaim;
	/** 在途归位清理任务；safeStop 等待-结算的事实源。 */
	private readonly pendingCleanups = new Set<Promise<boolean>>();
	private cleanupUnconfirmed = false;
	private readonly cleanupTimeoutMs: number;
	/** safeStop 保持帧：暂停期间按 tick 节奏持续注入（口型通道已覆写中性值）。 */
	private keepFrame?: Record<string, number>;
	private clock: NodeJS.Timeout | null = null;
	private lastTickAt = 0;
	/** 引擎句柄：P4 工具面（express/state）在此之上操作；无 rig 时不存在。 */
	readonly director?: MotionDirector;
	/** 声学电平接收端：rig + speech 配置同时存在时可用，start 时经 expose 登记给 voice 扩展。 */
	readonly levelSink?: VoiceLevelSink;
	private readonly speechInput?: SpeechInput;
	readonly endpoint: Live2DEndpoint;
	private readonly onStatusChange?: () => void;

	constructor(options: Live2DRuntimeOptions = {}) {
		this.client = options.client;
		this.rig = options.rig;
		this.catalog = options.catalog ?? emptyCatalog(options.rig?.modelID ?? "unknown");
		if (this.rig && this.catalog.modelID !== this.rig.modelID)
			throw new Error(`目录与 rig 模型身份不符: 目录 ${this.catalog.modelID} vs rig ${this.rig.modelID}`);
		if (this.rig) {
			validateRig(this.rig);
			this.director = new MotionDirector(this.rig.controls, { external: this.rig.external, rng: options.rng });
			this.syncSwaySuppression();
			if (options.speech) {
				const input = new SpeechInput(options.speech, this.director);
				this.speechInput = input;
				// 暂停期间电平一律丢弃（边界规范 §4）。
				this.levelSink = {
					processLevel: (level) => {
						if (this.paused) return;
						input.processLevel(level);
					},
					reset: () => input.reset(),
				};
			}
		}
		this.tickIntervalMs = options.tickIntervalMs ?? 1000 / 60;
		this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000;
		this.onStatusChange = options.onStatusChange;
		this.endpoint = buildLive2DEndpoint(this);
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** 目录视图：直接暴露当前目录（命名参数可达性由词表决定）。 */
	get catalogView(): CatalogSnapshot {
		return this.catalog;
	}

	get currentGeneration(): number {
		return this.generation;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	/** 连接事实（endpoint state() 的 online 输入）。 */
	get connectionOnline(): boolean {
		return this.client?.isConnected() ?? false;
	}

	get fault(): string | undefined {
		return this.client?.getFault();
	}

	/** 身份事实：rig 存在且 VTS 当前模型与其标定身份一致。 */
	identityMatched(): boolean {
		const profile = this.client?.getModelProfile();
		return this.rig !== undefined && profile !== undefined && profile.modelID === this.rig.modelID;
	}

	/**
	 * 焦点通知（幂等）：相同值的重复通知直接忽略，不重置任何倒计时（边界 #5）。
	 * 参数倒计时与过渡失焦冻结；空间移动无法冻结，取消并归位，回焦不续播旧空间表演。
	 */
	setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		if (!focused) this.spatialClaim?.cancel();
		this.syncFrozen();
	}

	private syncFrozen(): void {
		this.director?.setFrozen(this.paused || !this.focused);
	}

	/**
	 * 目录更新（模型切换/重绑/发布状态变化）：新快照 + 递增代次 + 旧代次执行全部失效。
	 * 槽位/注视/播放按跨模型事实清理（invalidateAll），绝不把旧目录的解释结果施加到新目录。
	 */
	setCatalog(snapshot: CatalogSnapshot): void {
		if (this.rig && snapshot.modelID !== this.rig.modelID)
			throw new Error(`目录与 rig 模型身份不符: 目录 ${snapshot.modelID} vs rig ${this.rig.modelID}`);
		this.catalog = snapshot;
		this.generation++;
		this.director?.cancelClaims();
		this.director?.invalidateAll("catalog changed");
		this.restHandle = undefined;
		this.ambientName = undefined;
		this.thinkingHandle = undefined;
		this.thinking = false;
		this.syncSwaySuppression();
		if (this.connectionOnline) {
			this.onStatusChange?.();
		}
	}

	/** 引擎未接入前的统一受理语义：诚实声明未开始，不伪装失败原因。 */
	notStarted(action: string): ToolExecutionResult {
		return {
			result: `Live2D 骨架已就绪，但引擎尚未接入，"${action}" 未执行（施工阶段 P4）。`,
			status: "not_started",
		};
	}

	// ---------- P4-1：gate 链与工具面 ----------

	/**
	 * 工具 gate 链（边界规范 §2.1）：中止 → 暂停 → 连接 → 适配。
	 * 返回 undefined 表示通过。发布验收门（§7）已按操作员裁决拆除。
	 */
	private gate(ctx: { signal?: AbortSignal }): ToolExecutionResult | undefined {
		if (ctx.signal?.aborted) return toolRejected("cancelled", "调用已中止，未执行。");
		if (this.paused) return toolRejected("paused", "身体处于 safeStop 暂停，操作被拒绝（resume 后恢复）。");
		if (!this.client || !this.client.isConnected())
			return toolRejected("model_not_ready", "VTS 未连接（连接建立前所有具身操作不可用）。");
		const profile = this.client.getModelProfile();
		if (!this.rig || !profile || profile.modelID !== this.rig.modelID)
			return toolRejected("unadapted", "当前模型没有可用的本地适配（rig/目录缺失或绑定核验失败）。");
		return undefined;
	}

	/**
	 * 统一执行手势/动作条目（供 express 工具与 endpoint.emitCue 复用）。
	 * 纯骨骼手势直接委托 director.play；若含 spatial，声明 model:transform 并在前台推进去程、停留与自动归位。
	 * 分段可携带 effects（染色/后处理）与位姿并行分发；归位守护覆盖位姿、染色与后处理三项。
	 */
	async playMotion(
		entry: CatalogMotionEntry,
		options: { speech?: SpeechPolicy; atomic?: boolean; signal?: AbortSignal } = {},
	): Promise<ToolExecutionResult> {
		const denied = this.gate(options);
		if (denied) return denied;
		const director = this.director!;
		const client = this.client!;
		const clip =
			options.speech === undefined ? entry.motion : recompileWithSpeech(entry, options.speech, this.rig!.controls);
		const playOptions: PlayOptions = {
			...entry.playback,
			category: "voluntary",
			atomic: options.atomic ?? entry.atomic,
			signal: options.signal,
		};
		const label = `动作 "${entry.description}"`;
		if (!entry.spatial) {
			const handle = director.play(clip, playOptions);
			return this.settleMotion(handle, clip, label);
		}
		if (!this.focused) return toolRejected("unfocused", `${label} 未执行：身体当前失焦。`);

		const claim = this.acquireClaim(["model:transform"], "motion", options.signal, true);
		if ("status" in claim) return claim;
		this.spatialClaim = claim;
		const generation = this.generation;
		const modelGeneration = client.getModelGeneration();
		const connectionGeneration = client.getInjectionStats().generation;
		const sameModel = () =>
			generation === this.generation &&
			this.identityMatched() &&
			client.isConnected() &&
			client.getModelGeneration() === modelGeneration &&
			client.getInjectionStats().generation === connectionGeneration;
		let completeCleanup: (confirmed: boolean) => void = () => {};
		this.trackCleanup(
			new Promise<boolean>((resolve) => {
				completeCleanup = resolve;
			}),
		);
		let base: ModelPose | undefined;
		let handle: MotionHandle | undefined;
		let motionResult: Promise<ToolExecutionResult> | undefined;
		let moved = false;
		let restored = true;
		let restoreAttempted = false;
		/** 进入时捕获的后处理状态（读失败为 undefined → 归位目标按"关闭"）。tint 协议无读 API，按所有权模型恢复为白。 */
		let postBaseline: { active: boolean; activePreset: string | null } | undefined;
		/** 只有特技真的分发过效果才做效果归位——否则白/关复位会踩掉用户自己的染色与滤镜。 */
		let effectsSent = false;
		let effectsRestored: { tint: boolean; post: boolean } | undefined;
		const dispatchFailures: string[] = [];
		const ensureActive = () => {
			if (!this.focused || !sameModel() || handle?.status === "releasing" || handle?.status === "cancelled")
				claim.cancel();
			claim.signal.throwIfAborted();
		};
		const restore = async (): Promise<boolean> => {
			if (restoreAttempted) return restored;
			restoreAttempted = true;
			restored = !moved || (base !== undefined && (await this.restorePose(client, base, sameModel)));
			return restored;
		};
		/** 三位一体归位的效果侧：染色刷白 + 后处理恢复进入时状态（无捕获则关闭），逐项如实结算。 */
		const restoreEffects = async (): Promise<{ tint: boolean; post: boolean }> => {
			if (effectsRestored) return effectsRestored;
			if (!effectsSent) return { tint: true, post: true };
			const settled = await Promise.allSettled([
				client.tintModel({ r: 255, g: 255, b: 255, a: 255 }),
				(async () => {
					await client.updatePostProcessing({
						on: postBaseline?.active ?? false,
						...(postBaseline?.active && postBaseline.activePreset
							? { preset: postBaseline.activePreset }
							: {}),
						fadeTime: 0.25,
					});
					return client.readPostProcessing();
				})(),
			]);
			const postNow = settled[1].status === "fulfilled" ? await settled[1].value : undefined;
			effectsRestored = {
				tint: settled[0].status === "fulfilled",
				post: postNow !== undefined && postNow.active === (postBaseline?.active ?? false),
			};
			return effectsRestored;
		};
		try {
			ensureActive();
			base = await withCancellation(client.getModelPosition(this.rig!.modelID), claim.signal);
			ensureActive();
			try {
				postBaseline = await withCancellation(client.readPostProcessing(), claim.signal);
			} catch {
				// 捕获失败不阻断特技：归位目标按"关闭"回退，恢复结果仍逐项如实结算。
				postBaseline = undefined;
			}
			ensureActive();
			handle = director.play(clip, { ...playOptions, signal: claim.signal });
			void handle.finished.then((result) => {
				if (result.status === "cancelled") claim.cancel();
			});
			motionResult = this.settleMotion(handle, clip, label);
			for (const [index, segment] of entry.spatial.segments.entries()) {
				ensureActive();
				await withCancellation(client.getModelPosition(this.rig!.modelID), claim.signal);
				ensureActive();
				const startedAt = performance.now();
				moved = true; // 请求异常也可能已经到达 VTS，因此必须尝试归位。
				// 效果与位姿同段并行派发。位姿失败沿用既有语义：中止后续段并走归位守护；
				// 效果失败仅记录（后续段与归位继续），结算如实呈现。
				const effectDispatches: Promise<unknown>[] = [];
				if (segment.effects?.tint) {
					effectsSent = true;
					effectDispatches.push(client.tintModel(segment.effects.tint));
				}
				if (segment.effects?.postProcessing) {
					effectsSent = true;
					effectDispatches.push(client.updatePostProcessing(segment.effects.postProcessing));
				}
				const dispatched = await withCancellation(Promise.allSettled(effectDispatches), claim.signal);
				for (const [slot, outcome] of dispatched.entries())
					if (outcome.status === "rejected")
						dispatchFailures.push(
							`段[${index}]分发[${slot}]: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
						);
				if (segment.delta && Object.keys(segment.delta).length > 0)
					await withCancellation(
						client.moveModel({
							timeInSeconds: segment.durationMs / 1000,
							valuesAreRelativeToModel: false,
							positionX: base.positionX + (segment.delta.x ?? 0),
							positionY: base.positionY + (segment.delta.y ?? 0),
							rotation: base.rotation + (segment.delta.rotation ?? 0),
							size: base.size + (segment.delta.size ?? 0),
						}),
						claim.signal,
					);
				const remaining = Math.max(0, segment.durationMs - (performance.now() - startedAt));
				if (!(await sleep(remaining + (segment.holdMs ?? 0), claim.signal))) break;
			}
			ensureActive();
			// 末段不得携带 effects（编译期禁止）：效果复位由守护在此统一执行，作者不写重置值。
			const restoredEffects = await restoreEffects();
			await sleep(SETTLE_MARGIN_MS, claim.signal);
			ensureActive();
			const now = await withCancellation(client.getModelPosition(this.rig!.modelID), claim.signal);
			ensureActive();
			restored = sameModel() && poseMatches(now, base);
			if (!restored) {
				handle.stop("cut");
				await restore();
				return toolUnknown(`${label} 正常回位未确认。`, { restored, restoredEffects });
			}
			if (dispatchFailures.length > 0 || restoredEffects.tint === false || restoredEffects.post === false) {
				const problems = [...dispatchFailures];
				if (restoredEffects.tint === false) problems.push("染色归位未确认");
				if (restoredEffects.post === false) problems.push("滤镜归位未确认");
				return toolUnknown(`${label} 部分外部效果未完整：${problems.join("；")}`, {
					restored: true,
					restoredEffects,
				});
			}
			// 失联会停止合成时钟；空间表演不能永远等一个不再推进的句柄。
			let result: ToolExecutionResult | undefined;
			while (!result) {
				ensureActive();
				result = await Promise.race([motionResult, sleep(50).then(() => undefined)]);
			}
			ensureActive();
			return {
				...result,
				details: { ...(result.details as Record<string, unknown> | undefined), restored: true, restoredEffects },
			};
		} catch (error) {
			const cancelled = claim.signal.aborted || handle?.status === "releasing" || handle?.status === "cancelled";
			handle?.stop("cut");
			const confirmed = await restore();
			const restoredEffects = await restoreEffects();
			if (cancelled && !moved)
				return toolRejected("cancelled", `${label} 已取消，未发送空间移动。`, { effectStatus: "cancelled" });
			if (cancelled)
				return toolRejected("cancelled", confirmed ? `${label} 已取消并核实归位。` : `${label} 已取消，归位未确认。`, {
					effectStatus: confirmed ? "cancelled" : "unknown",
					restored: confirmed,
					restoredEffects,
				});
			return toolUnknown(`${label} 执行异常：${error instanceof Error ? error.message : String(error)}`, {
				...(moved ? { restored: confirmed } : {}),
				restoredEffects,
			});
		} finally {
			completeCleanup(restored);
			if (this.spatialClaim === claim) this.spatialClaim = undefined;
			claim.release();
		}
	}

	private async settleMotion(handle: MotionHandle, clip: CompiledMotion, label: string): Promise<ToolExecutionResult> {
		const observation = this.client!.observeMotionInjections(handle.id);
		try {
			const result = await handle.finished;
			const evidence = result.status === "completed" ? await observation.finish() : observation.snapshot();
			const inputs = [
				...new Set(clip.axes.flatMap((axis) => this.rig!.bindings[axis]!.map((binding) => binding.input))),
			];
			return fromEngineResult(result, label, evidence, inputs);
		} finally {
			observation.close();
		}
	}

	/** express（§2）：播放目录中的命名动作，Voluntary 类别；await 终态结算。 */
	async express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const name = args.motion;
		if (typeof name !== "string" || name.length === 0) return toolRejected("invalid_motion", "缺少 motion 参数。");
		const entry = this.catalog.findMotion(name);
		if (!entry) {
			const available = formatCatalogEntries(this.catalog.motions).join(", ") || "无";
			return toolRejected("unknown_motion", `动作不在当前模型目录: "${name}"。当前可用动作: ${available}。`);
		}
		const { atomic, speech } = args;
		if (atomic !== undefined && typeof atomic !== "boolean")
			return toolRejected("invalid_motion", "atomic 必须是布尔值。");
		if (speech !== undefined && speech !== "allow" && speech !== "exclusive")
			return toolRejected("invalid_motion", 'speech 只接受 "allow" | "exclusive"。');

		return this.playMotion(entry, {
			speech,
			atomic,
			signal: ctx.signal,
		});
	}

	/** posture（§2）：设置持续体态槽（整槽替换）；hold_ms 到期自动回 neutral。 */
	async posture(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.setNamedSlot("posture", args, ctx);
	}

	/** expression（§2）：设置持续神态槽（整槽替换）；hold_ms 到期自动回 neutral。 */
	async expression(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.setNamedSlot("expression", args, ctx);
	}

	private async setNamedSlot(
		kind: "posture" | "expression",
		args: Record<string, unknown>,
		ctx: { signal?: AbortSignal },
	): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const director = this.director;
		if (!director) return toolRejected("unadapted", "引擎未接入（无 rig）。");
		const label = kind === "posture" ? "姿态" : "表情";
		const reason = kind === "posture" ? "unknown_pose" : "unknown_expression";
		const name = args.name ?? args[kind];
		if (typeof name !== "string" || name.length === 0) return toolRejected(reason, "缺少 name 参数。");
		const holdMs = parseHoldMs(args.hold_ms);
		if (typeof holdMs === "object") return holdMs;
		const slot = this.catalog.findSlot(kind, name);
		if (!slot) {
			const entries = kind === "posture" ? this.catalog.postures : this.catalog.expressions;
			const available = formatCatalogEntries(entries).join(", ") || "无";
			return toolRejected(reason, `${label}不在当前模型目录: "${name}"。当前可用${label}: ${available}。`);
		}
		try {
			if (kind === "posture") await director.setPosture(slot.values, { holdMs, durationMs: slot.transitionMs });
			else await director.setExpression(slot.values, { holdMs, durationMs: slot.transitionMs });
		} catch (error) {
			if (error instanceof SupersededError) {
				return {
					result: `${label}设置 "${name}" 已被更新的调用取代。`,
					status: "cancelled",
					details: { effectStatus: "cancelled" as const, supersededAxes: error.axes },
				};
			}
			throw error;
		}
		return toolSucceeded(kind === "posture" ? `已切换姿势: ${name}。` : `已切换表情: ${name}。`, {
			effectStatus: "accepted",
			verification: "local_intent",
		});
	}

	/** attention（§2）：设置注视目标；内置 user/screen/avert_* 或目录命名；hold_ms 到期自动回 neutral。 */
	async attention(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const director = this.director;
		if (!director) return toolRejected("unadapted", "引擎未接入（无 rig）。");
		const targetVal = args.target ?? args.attention;
		if (typeof targetVal !== "string" || targetVal.length === 0)
			return toolRejected("unknown_attention", "缺少 target 参数。");
		const holdMs = parseHoldMs(args.hold_ms);
		if (typeof holdMs === "object") return holdMs;
		const target = this.catalog.resolveAttention(targetVal);
		if (target === undefined) {
			const custom = [...this.catalog.attentions.keys()];
			const available = [
				"看对方/user",
				"看屏幕/screen",
				"垂眸/看下方/avert_down",
				"看左侧/avert_left",
				"看右侧/avert_right",
				...custom,
			].join(", ");
			return toolRejected("unknown_attention", `注视目标不在词表: "${targetVal}"。可用注视: ${available}。`);
		}
		director.setAttention(target, { holdMs });
		return toolSucceeded(`视线已转向: ${targetVal}。`, {
			effectStatus: "accepted",
			verification: "local_intent",
		});
	}

	/** costume（§2）：执行模型包登记的外观热键；独占声明（effect:*）+ VTS 热键触发。 */
	async costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const item = args.item;
		if (typeof item !== "string" || item.length === 0) return toolRejected("unknown_costume", "缺少 item 参数。");
		const entry = this.catalog.costumes.find((c) => c.id === item);
		if (!entry) {
			const available = this.catalog.costumes.map((c) => c.id).join(", ") || "无";
			return toolRejected("unknown_costume", `外观不在当前模型目录: "${item}"。当前可用外观: ${available}。`);
		}
		const hotkey = this.client?.findHotkey(entry.hotkeyID);
		if (!hotkey)
			return toolRejected(
				"hotkey_missing",
				`热键未在当前 VTS 模型登记: "${entry.hotkeyID}"（模型配置已变更？reload 后重试）。`,
			);
		const claim = this.acquireClaim(["effect:*"], "costume", ctx.signal);
		if ("status" in claim) return claim;
		try {
			await this.client!.triggerHotkey(hotkey.hotkeyID);
			return toolSucceeded(`外观 "${entry.id}" 已触发（热键 ${hotkey.hotkeyID}）。`, { effectStatus: "accepted" });
		} catch (error) {
			return toolUnknown(`外观触发结果不明：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			claim.release();
		}
	}

	/**
	 * ambient（§2）：选择/清除持续环境循环（如摇摆）；不传 name 即清除并回落默认静止态。
	 * 选中项替换 idle 占据静止态背景槽（同一 director 播放参数），thinking 照旧叠加；
	 * 与姿态/表情同属持续性状态——不受回合打断影响。
	 */
	async ambient(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		if (!this.director) return toolRejected("unadapted", "引擎未接入（无 rig）。");
		const name = args.name;
		if (name !== undefined && (typeof name !== "string" || name.length === 0))
			return toolRejected("unknown_ambient", "name 必须是非空字符串（不传 name 即清除当前环境循环）。");
		const ambient = this.catalog.background.ambient;
		if (typeof name === "string" && !ambient?.has(name)) {
			const available = [...(ambient?.keys() ?? [])].join(", ");
			return toolRejected("unknown_ambient", `环境循环不在当前模型目录: "${name}"。当前可用: ${available || "无"}。`);
		}
		const next = typeof name === "string" ? name : undefined;
		if (next === this.ambientName)
			return toolSucceeded(next ? `环境循环 "${next}" 已在选择中。` : "当前无环境循环。", {
				effectStatus: "accepted",
				verification: "local_intent",
			});
		this.ambientName = next;
		// 静止态槽位换人：停旧实例（fade 收势），syncBackgrounds 以新选择续播（暂停期间由恢复后的 tick 补齐）。
		this.restHandle?.stop("release");
		this.restHandle = undefined;
		this.syncSwaySuppression();
		this.syncBackgrounds();
		return toolSucceeded(
			next ? `环境循环已选择: ${next}。` : "环境循环已清除，回到默认静止态。",
			{ effectStatus: "accepted", verification: "local_intent" },
		);
	}

	/** reload（§2）：显式重载当前 VTS 模型并重新核验绑定。 */
	async reload(ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		try {
			await this.client!.reloadCurrentModel();
		} catch (error) {
			return toolUnknown(`模型重载失败：${error instanceof Error ? error.message : String(error)}`);
		}
		// 重新核验绑定：重载后的模型身份必须与本地 rig 一致（tick 侧身份门独立逐帧生效）。
		const profile = this.client!.getModelProfile();
		if (!profile || profile.modelID !== this.rig!.modelID)
			return toolRejected("unadapted", "重载后的模型与本地 rig 不符，绑定核验失败。");
		return toolSucceeded("模型已重载，绑定核验通过。", { effectStatus: "accepted" });
	}

	// ---------- 生命周期 ----------

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (ctx.expose) {
			this.cleanups.push(ctx.expose("body.endpoint:live2d", this.endpoint));
			if (this.levelSink) {
				this.cleanups.push(ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX + this.endpoint.bodyId, this.levelSink));
			}
		}
		// 宿主事件订阅（§5 最小消费集）：thinking 状态驱动 / turn 边界 / turn_aborted → interrupt。
		// 无用途的事件（input_accepted 等）随监听器一并到达但被忽略——框架按类型批量订阅，无法只订子集。
		if (ctx.onHostEvent) {
			this.cleanups.push(
				ctx.onHostEvent((event) => {
					if (event.type === "output_update" && event.channel === "thinking") this.setThinking(true);
					else if (event.type === "turn_start" || event.type === "turn_end") this.setThinking(false);
					else if (event.type === "turn_aborted") this.interrupt();
				}),
			);
		}
		if (this.client) {
			// 监听必须先于 connect 注册：ready 回调在 connect 流程内同步链上触发。
			this.client.setConnectionChangeListener((connected) => {
				if (!this.started) return;
				if (connected) this.startClock();
				else this.stopClock();
				this.onStatusChange?.();
			});
			this.client.connect();
			// 注入的客户端可能已完成握手，connect() 不会再次发 ready 回调。
			if (this.client.isConnected()) {
				this.startClock();
				this.onStatusChange?.();
			}
		}
	}

	/**
	 * safeStop（§6 生命周期）：显式全局暂停。
	 * 1. paused=true，捕获当前合成帧为保持帧，口型开合通道（mouth.*）覆写中性值——
	 *    暂停瞬间的张嘴是声学瞬态，不是值得保持的姿态；
	 * 2. 全部活跃播放 cut 结算（冻结帧下 fade 永不推进，release 会悬挂 finished）；
	 * 3. 注入不停止：composeTick 暂停分支持续注入保持帧——控制权与口型归零优先于视觉静止；
	 * 4. 带清理独占声明的"等待清理完成才结算"依赖 P4-5 独占资源生产者，届时接入。
	 */
	async safeStop(): Promise<void> {
		if (this.paused) {
			if (!(await this.awaitCleanups())) throw new Error("Uina 已暂停，外部效果或归位清理尚未确认。");
			return;
		}
		this.paused = true;
		this.syncFrozen();
		const director = this.director;
		if (!director) return;
		const frame: Record<string, number> = { ...director.currentFrame };
		for (const axis of Object.keys(frame)) {
			if (axis.startsWith("mouth.")) frame[axis] = this.rig!.controls[axis]?.neutral ?? frame[axis]!;
		}
		this.keepFrame = frame;
		director.cancelAllPlaybacks("safestop");
		this.restHandle = undefined;
		this.thinkingHandle = undefined;
		// §6.2/§6.4：取消全部独占声明；带清理的声明等待归位清理完成，未确认则抛错（调用方得
		// unknown；拆除不被阻塞——BodyRouter.stopAll 以 allSettled 承接为 failed[]）。
		director.cancelClaims();
		if (!(await this.awaitCleanups())) throw new Error("Uina 已暂停，外部效果或归位清理尚未确认。");
	}

	/**
	 * 独占声明受理：reason 带调用序号——重叠的同类声明一律 resource_conflict，
	 * 不走同 reason 幂等替换（独占资源的并发重复触发不是"重触发"而是冲突）。
	 */
	private acquireClaim(
		resources: readonly string[],
		kind: string,
		signal?: AbortSignal,
		cleanup = false,
	): ExclusiveClaim | ToolExecutionResult {
		try {
			return this.director!.claimExclusive(resources, { reason: `${kind}#${++this.claimSeq}`, cleanup, signal });
		} catch {
			return signal?.aborted
				? toolRejected("cancelled", "调用已中止，未执行。")
				: toolRejected("resource_conflict", "独占资源被占用（空间手势/costume 正在进行或清理中）。");
		}
	}

	/** 归位清理任务入账（§6.2 safeStop 等待-结算的事实源）。返回原 Promise 供调用方等待。 */
	trackCleanup(p: Promise<boolean>): Promise<boolean> {
		const wrapped = p
			.then((confirmed) => {
				if (!confirmed) this.cleanupUnconfirmed = true;
				return confirmed;
			})
			.finally(() => this.pendingCleanups.delete(wrapped));
		this.pendingCleanups.add(wrapped);
		return wrapped;
	}

	/** §6.2：等待全部在途归位清理完成；超时返回 false（safeStop 据此抛错，§6.4）。 */
	private async awaitCleanups(): Promise<boolean> {
		const deadline = Date.now() + this.cleanupTimeoutMs;
		while (this.pendingCleanups.size > 0) {
			if (Date.now() > deadline) return false;
			await Promise.race([Promise.allSettled([...this.pendingCleanups]), sleep(50)]);
		}
		return !this.cleanupUnconfirmed;
	}

	/** 空间特技归位：绝对位姿回基线 → 回读核实。返回是否核实通过（失败也结算，不悬挂声明）。 */
	private async restorePose(client: VTSClient, base: ModelPose, sameModel: () => boolean): Promise<boolean> {
		try {
			if (!sameModel()) return false;
			await client.getModelPosition(this.rig!.modelID);
			if (!sameModel()) return false;
			await client.moveModel({
				...base,
				timeInSeconds: RESTORE_SECONDS,
				valuesAreRelativeToModel: false,
			});
			await sleep(RESTORE_SECONDS * 1000 + SETTLE_MARGIN_MS);
			if (!sameModel()) return false;
			const now = await client.getModelPosition(this.rig!.modelID);
			return sameModel() && poseMatches(now, base);
		} catch {
			return false;
		}
	}

	/** resume（§6）：解除暂停、清保持帧、口型包络归零、眨眼与限时状态倒计时恢复剩余。 */
	async resume(): Promise<void> {
		if (!this.paused) return;
		this.paused = false;
		this.cleanupUnconfirmed = false;
		this.keepFrame = undefined;
		this.speechInput?.reset();
		this.syncFrozen();
	}

	/**
	 * setThinking（§5 宿主事件）：状态驱动入口，幂等——仅在跳变时动作。
	 * 一个循环实例贯穿整个思考状态，false 时收势退出。
	 */
	setThinking(on: boolean): void {
		if (on === this.thinking) return;
		this.thinking = on;
		if (on) {
			this.syncBackgrounds();
		} else {
			this.thinkingHandle?.stop("release");
			this.thinkingHandle = undefined;
		}
	}

	private syncBackgrounds(): void {
		if (!this.director || this.paused) return;
		const { idle, thinking, ambient } = this.catalog.background;
		// 选中项不在当前快照（目录更替残留）：诚实回落 idle。
		if (this.ambientName !== undefined && !ambient?.has(this.ambientName)) this.ambientName = undefined;
		const restLoop =
			this.ambientName !== undefined ? ambient?.get(this.ambientName)!.motion : idle;
		if (restLoop && !this.restHandle) {
			this.restHandle = this.director.play(restLoop, {
				category: "autonomic",
				loop: true,
				background: true,
				atomic: false,
				fadeInMs: 450,
				fadeOutMs: 450,
			});
		}
		if (thinking && this.thinking && !this.thinkingHandle) {
			this.thinkingHandle = this.director.play(thinking, {
				category: "transition",
				loop: true,
				background: true,
				atomic: false,
				fadeInMs: 350,
				fadeOutMs: 450,
			});
		}
	}

	/**
	 * 内置微晃抑制事实：作者提供了 idle 或 uina 选中环境循环时禁用，
	 * 避免内置摆动与目录编排的背景循环叠加成双重晃动。
	 */
	private syncSwaySuppression(): void {
		this.director?.setAuthoredIdle(
			this.catalog.background.idle !== undefined || this.ambientName !== undefined,
		);
	}

	/**
	 * interrupt（§3 回合打断）：取消瞬时动作 + 停 thinking + 口型包络直清；
	 * 槽位与自律保持，**不进入 paused**（emitCue 仍可受理）。
	 * 口型直清不经 speech-level 守卫路径（§4 第三层）：envelope cut + 声学输入清零双保险。
	 */
	interrupt(): void {
		// thinking 状态同步归零：interruptTransient 已对 transition 类（含 thinking 播放）fade 收势。
		// 不归零会让下一次 thinking=true 被幂等门吞掉，本回合内再也无法点亮思考态。
		this.thinking = false;
		this.thinkingHandle = undefined;
		this.spatialClaim?.cancel();
		this.director?.interruptTransient("turn_aborted");
		this.speechInput?.reset();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.stopClock();
		try {
			await this.safeStop();
		} finally {
			this.started = false;
			for (const cleanup of this.cleanups.splice(0).reverse()) {
				try {
					cleanup();
				} catch {
					/* 继续拆除其它资源。 */
				}
			}
			this.client?.disconnect();
		}
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
		if (!this.client || !this.director || !this.rig) return;
		if (!this.client.isConnected()) return;
		// 身份门：rig 只属于其标定的模型，VTS 当前模型不匹配即零输出，杜绝跨模型误注入。
		const profile = this.client.getModelProfile();
		if (!profile || profile.modelID !== this.rig.modelID) return;
		// §6 暂停分支：不合成、不推进倒计时，按 tick 节奏持续注入保持帧。
		if (this.paused) {
			if (this.keepFrame) this.client.injectParameters(encodeFrame(this.rig, this.keepFrame));
			return;
		}
		// 声学电平推进（失联守卫 + 作者映射）→ 引擎包络目标，先于本帧合成。
		this.syncBackgrounds();
		this.speechInput?.tick(dtMs);
		const frame = this.director.step(dtMs);
		const contributions = [...this.director.frameContributions].map(([leaseID, axes]) => ({
			leaseID,
			inputs: [...new Set([...axes].flatMap((axis) => this.rig!.bindings[axis]!.map((binding) => binding.input)))],
		}));
		this.client.injectParameters(encodeFrame(this.rig, frame), contributions);
	}

	// ---------- 事实呈现 ----------

	formatStatus(): string {
		const connected = this.client?.isConnected() ?? false;
		return JSON.stringify(
			{
				world: "live2d",
				connected,
				modelID: this.rig?.modelID ?? null,
				paused: this.paused,
				catalog: {
					motions: formatCatalogEntries(this.catalog.motions),
					postures: formatCatalogEntries(this.catalog.postures),
					expressions: formatCatalogEntries(this.catalog.expressions),
					attentions: [...this.catalog.attentions.keys()],
					costumes: this.catalog.costumes.map((c) => c.id),
					ambient: {
						available: [...(this.catalog.background.ambient?.entries() ?? [])].map(([id, entry]) => ({
							id,
							description: entry.description,
						})),
						current: this.ambientName ?? null,
					},
				},
			},
			null,
			2,
		);
	}

	/** 作者诊断：运行时内部状态只读快照（三层遥测在 P6-1 接入）。 */
	diagnose(): string {
		return JSON.stringify(
			{
				tickIntervalMs: this.tickIntervalMs,
				clockRunning: this.clock !== null,
				identityMatched: this.identityMatched(),
				paused: this.paused,
				focused: this.focused,
				generation: this.generation,
				lastCue: this.endpoint.lastCue(),
				director: this.director
					? {
							attention: this.director.getAttention() ?? null,
							blinkFactor: this.director.blinkFactor,
							frameAxes: Object.keys(this.director.currentFrame).length,
						}
					: null,
				catalog: {
					modelID: this.catalog.modelID,
					motions: this.catalog.motions.size,
					postures: this.catalog.postures.size,
					expressions: this.catalog.expressions.size,
					attentions: this.catalog.attentions.size,
					costumes: this.catalog.costumes.length,
				},
			},
			null,
			2,
		);
	}
}
