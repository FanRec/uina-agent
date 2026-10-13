import type { ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { VOICE_LEVEL_SINK_EXPOSED_PREFIX, type VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import { inspectBodyMapping, prepareBodyInputs } from "./adapter/body-inputs.js";
import { encodeFrame, validateRig, type ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import {
	emptyCatalog,
	type CatalogAmbientEntry,
	type CatalogMotionEntry,
	type CatalogSnapshot,
	type CatalogResolved,
	type CatalogKind,
} from "./authoring/catalog.js";
import {
	compileMotion,
	withSpeech,
	type CompiledMotion,
	type MotionAuthoring,
	type SpeechPolicy,
} from "./authoring/motion.js";
import { MotionDirector, SupersededError, type MotionHandle, type PlayOptions } from "./director/director.js";
import { buildLive2DEndpoint, type Live2DEndpoint } from "./endpoint.js";
import { settleMotion, withCancellation, toolRejected, toolSucceeded, toolUnknown } from "./results.js";
import { ExternalActions } from "./external-actions.js";
import { SpeechInput, type SpeechConfig } from "./speech-level.js";

/**
 * World 拥有生命周期、目录代次、持续意图与合成时钟。
 * director 独占合成/仲裁，external-actions 独占外部请求与清理；endpoint 仅适配。
 * 断线/身份不符零输出；暂停不合成，继续注入中性口型保持帧；实测 dt 最大 250ms。
 */
export interface Live2DRuntimeOptions {
	/** 注入点（测试用）：替换真实 VTS 连接。默认装配由 assembly 负责；直接运行时不猜测设备。 */
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

/** 省略或 0 表示持续；非法时长返回工具拒绝结果。 */
function parseHoldMs(value: unknown): number | undefined | ToolExecutionResult {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return toolRejected("invalid_duration", "hold_ms 必须是非负有限数值。");
	return value > 0 ? value : undefined;
}

/** 非空字符串参数校验；不合格返回工具拒绝结果。 */
const requireWord = (value: unknown, label: string): string | ToolExecutionResult =>
	typeof value === "string" && value.length > 0 ? value : toolRejected("invalid_params", `缺少 ${label} 参数。`);

/** 格式化目录条目名称与别名列表。 */
const formatCatalogEntries = (records: readonly CatalogResolved<CatalogKind>[]): string[] =>
	records.map(({ name, aliases }) => (aliases.length ? `${name}(${aliases.join("/")})` : name));
const formatMotionEntries = (records: readonly CatalogResolved<"motion">[]): string[] =>
	records.map(({ name, aliases, entry }) => {
		const base = aliases.length ? `${name}(${aliases.join("/")})` : name;
		return entry.variants?.length ? `${base}[${entry.variants.length + 1}变体]` : base;
	});

/**
 * 变体轮换择一（纯函数，随机源注入）：池 N 取 N-1 均匀随机，越过 lastPick 偏移——
 * 排除上次选中，保证连播不重样；N ≤ 1 恒 0。
 */
export const pickVariantIndex = (poolSize: number, lastPick: number | undefined, random: () => number): number => {
	if (poolSize <= 1) return 0;
	let index = Math.floor(random() * (poolSize - 1));
	if (lastPick !== undefined && index >= lastPick) index += 1;
	return index;
};

export class Live2DRuntime {
	private started = false;
	private phase: "new" | "starting" | "running" | "closing" | "dead" = "new";
	private stopPromise?: Promise<void>;
	private executionController = new AbortController();
	private lifecycleFault?: string;
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
	/** 变体轮换状态：按条目对象身份存 WeakMap——目录快照换代产生新条目对象，轮换自然归零。 */
	private readonly lastVariantPick = new WeakMap<CatalogMotionEntry, number>();
	/** Ambient phrase rotation is keyed by immutable catalog entry, so catalog replacement resets it. */
	private readonly lastAmbientPhrasePick = new WeakMap<CatalogAmbientEntry, number>();
	/** 变体轮换随机源（A9 注入点）：缺省 Math.random。 */
	private readonly pickRandom: () => number;
	private readonly externalActions?: ExternalActions;
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
						if (this.paused || !this.isStarted) return;
						input.processLevel(level);
					},
					reset: () => input.reset(),
				};
			}
		}
		this.tickIntervalMs = options.tickIntervalMs ?? 1000 / 60;

		this.pickRandom = options.rng ?? Math.random;
		this.onStatusChange = options.onStatusChange;
		this.endpoint = buildLive2DEndpoint(this);
		if (this.client && this.rig && this.director)
			this.externalActions = new ExternalActions({
				client: this.client,
				rig: this.rig,
				director: this.director,
				getCatalogGeneration: () => this.generation,
				isFocused: () => this.focused,
				cleanupTimeoutMs: options.cleanupTimeoutMs ?? 5000,
			});
	}

	get isStarted(): boolean {
		return this.started && this.phase === "running";
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
		return this.lifecycleFault ?? this.client?.getFault();
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
		if (!focused) this.externalActions?.cancelSpatial();
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
		this.externalActions?.cancelAll();
		this.director?.invalidateAll("catalog changed");
		this.restHandle = undefined;
		this.ambientName = undefined;
		this.thinkingHandle = undefined;
		this.thinking = false;
		this.syncSwaySuppression();
		this.onStatusChange?.();
	}

	// ---------- P4-1：gate 链与工具面 ----------

	/**
	 * 工具 gate 链（边界规范 §2.1）：中止 → 暂停 → 连接 → 适配。
	 * 返回 undefined 表示通过。发布验收门（§7）已按操作员裁决拆除。
	 */
	private gate(ctx: { signal?: AbortSignal }): ToolExecutionResult | undefined {
		if (ctx.signal?.aborted) return toolRejected("cancelled", "调用已中止，未执行。");
		if (!this.isStarted)
			return {
				result: "Live2D 世界未启动或正在停用，未执行。",
				status: "not_started",
				details: { reason: "not_started", effectStatus: "not_started" },
			};
		if (this.paused) return toolRejected("paused", "身体处于 safeStop 暂停，操作被拒绝（resume 后恢复）。");
		if (!this.client || !this.client.isConnected())
			return toolRejected("model_not_ready", "VTS 未连接（连接建立前所有具身操作不可用）。");
		const profile = this.client.getModelProfile();
		if (!this.rig || !profile || profile.modelID !== this.rig.modelID)
			return toolRejected("unadapted", "当前模型没有可用的本地适配（rig/目录缺失或绑定核验失败）。");
		return undefined;
	}

	/**
	 * per-play bake：目录不持有编译产物，runtime 是唯一 bake 点；rng 注入闭包，
	 * 随机量在播放受理时结清（A9 可 seek/确定性）。非法曲线在此失败，不进入播放。
	 */
	private bake(definition: MotionAuthoring, speech?: SpeechPolicy): CompiledMotion {
		return compileMotion(
			speech === undefined ? definition : withSpeech(definition, speech),
			this.rig!.controls,
			this.pickRandom,
		);
	}

	/**
	 * 动作 clip 择一（变体轮换机制的唯一咽喉）+ per-play bake。
	 * 变体轮换：主定义 + variants 构成池，均匀随机排除上次选中（连播不重样）；
	 * speech 覆写按选中定义经 withSpeech 重编译——外层策略覆盖作者内层策略。
	 */
	private pickMotionClip(entry: CatalogMotionEntry, speech: SpeechPolicy | undefined): CompiledMotion {
		const variants = entry.variants;
		if (!variants?.length) return this.bake(entry.definition, speech);
		const index = pickVariantIndex(variants.length + 1, this.lastVariantPick.get(entry), this.pickRandom);
		this.lastVariantPick.set(entry, index);
		return this.bake(index === 0 ? entry.definition : variants[index - 1]!, speech);
	}

	private pickAmbientPhrase(entry: CatalogAmbientEntry): CompiledMotion {
		const pool = [entry.motion, ...(entry.variants ?? [])];
		const index = pickVariantIndex(pool.length, this.lastAmbientPhrasePick.get(entry), this.pickRandom);
		this.lastAmbientPhrasePick.set(entry, index);
		return compileMotion(pool[index]!, this.rig!.controls, this.pickRandom);
	}

	/**
	 * 统一执行手势/动作条目（供 express 工具与 endpoint.emitCue 复用）。
	 * 纯骨骼手势直接委托 director.play；若含 spatial，声明 model:transform 并在前台推进去程、停留与自动归位。
	 * 分段可携带 effects（染色/后处理），与位姿同段顺序派发（先等效果落地再发移动）；归位守护覆盖位姿、染色与后处理三项。
	 */
	private async playMotion(
		entry: CatalogMotionEntry,
		options: {
			speech?: SpeechPolicy;
			atomic?: boolean;
			signal?: AbortSignal;
			callName?: string;
			onStarted?: () => void;
		} = {},
	): Promise<ToolExecutionResult> {
		const denied = this.gate(options);
		if (denied) return denied;
		options = {
			...options,
			signal: options.signal
				? AbortSignal.any([options.signal, this.executionController.signal])
				: this.executionController.signal,
		};
		const director = this.director!;
		const clip = this.pickMotionClip(entry, options.speech);
		const playOptions: PlayOptions = {
			...entry.playback,
			category: "voluntary",
			atomic: options.atomic ?? entry.atomic,
			signal: options.signal,
		};
		const label = `动作 "${entry.description}"`;
		if (!entry.spatial) {
			const handle = director.play(clip, playOptions);
			options.onStarted?.();
			return settleMotion(this.client!, this.rig!, handle, clip, label, options.callName);
		}
		if (!this.focused) return toolRejected("unfocused", `${label} 未执行：身体当前失焦。`);

		return this.externalActions!.runSpatial(entry, clip, {
			...playOptions,
			callName: options.callName,
			onStarted: options.onStarted,
		});
	}

	/** express（§2）：播放目录中的命名动作，Voluntary 类别；await 终态结算。 */
	async express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const name = requireWord(args.motion, "motion");
		if (typeof name === "object") return name;
		const entry = this.catalog.resolve("motion", name)?.entry;
		if (!entry) {
			const available = formatMotionEntries(this.catalog.list("motion")).join(", ") || "无";
			return toolRejected("unknown_motion", `动作不在当前模型目录: "${name}"。当前可用动作: ${available}。`);
		}
		const { atomic, speech } = args;
		if (atomic !== undefined && typeof atomic !== "boolean")
			return toolRejected("invalid_params", "atomic 必须是布尔值。");
		if (speech !== undefined && speech !== "allow" && speech !== "exclusive")
			return toolRejected("invalid_params", 'speech 只接受 "allow" | "exclusive"。');

		return this.playMotion(entry, {
			speech,
			atomic,
			signal: ctx.signal,
			callName: name,
		});
	}

	/** 工具与 cue 共享已经解析的持续意图执行；只在真实施加时通知 started。 */
	async executeCue(id: string, onStarted: () => void): Promise<ToolExecutionResult> {
		const denied = this.gate({});
		if (denied) return denied;
		const cue = this.catalog.resolveCue(id);
		if (!cue) return toolRejected("unknown_cue", `未知 cue: "${id}"。`);
		if (cue.kind === "posture") return this.applyState({ posture: id }, {}, onStarted);
		return this.playMotion(cue.entry, { callName: id, onStarted });
	}
	async state(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.applyState(args, ctx);
	}
	private async applyState(
		args: Record<string, unknown>,
		ctx: { signal?: AbortSignal },
		onStarted?: () => void,
	): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		ctx = {
			signal: ctx.signal
				? AbortSignal.any([ctx.signal, this.executionController.signal])
				: this.executionController.signal,
		};
		const catalog = this.catalog,
			generation = this.generation,
			director = this.director!;
		const holdMs = parseHoldMs(args.hold_ms);
		if (typeof holdMs === "object") return holdMs;
		const changes: { label: string; run: () => void | Promise<void> }[] = [];
		for (const kind of ["posture", "expression"] as const) {
			if (args[kind] === undefined) continue;
			const name = requireWord(args[kind], kind);
			if (typeof name === "object") return name;
			const slot = catalog.resolve(kind, name);
			if (!slot)
				return toolRejected(
					kind === "posture" ? "unknown_pose" : "unknown_expression",
					`${kind === "posture" ? "姿态" : "表情"}不在当前模型目录: "${name}"。当前可用: ${formatCatalogEntries(catalog.list(kind)).join(", ") || "无"}。`,
				);
			changes.push({
				label: name,
				run: () =>
					kind === "posture"
						? director.setPosture(slot.entry.values, { holdMs, durationMs: slot.entry.transitionMs })
						: director.setExpression(slot.entry.values, { holdMs, durationMs: slot.entry.transitionMs }),
			});
		}
		if (args.attention !== undefined) {
			const name = requireWord(args.attention, "attention");
			if (typeof name === "object") return name;
			const attention = catalog.resolve("attention", name);
			if (!attention)
				return toolRejected(
					"unknown_attention",
					`注视目标不在词表: "${name}"。可用注视: ${formatCatalogEntries(catalog.list("attention")).join(", ")}。`,
				);
			changes.push({ label: name, run: () => director.setAttention(attention.entry.target, { holdMs }) });
		}
		if (args.ambient !== undefined) {
			const raw = args.ambient;
			if (raw !== null && (typeof raw !== "string" || !raw.length))
				return toolRejected("invalid_params", "ambient 必须是非空字符串或 null（null 即清除）。");
			const clear = raw === null || raw === "none" || raw === "stop" || raw === "clear";
			const ambient = clear ? undefined : catalog.resolve("ambient", raw as string);
			if (!clear && !ambient)
				return toolRejected(
					"unknown_ambient",
					`环境循环不在当前模型目录: "${raw}"。当前可用: ${formatCatalogEntries(catalog.list("ambient")).join(", ") || "无"}。`,
				);
			changes.push({
				label: clear ? "cleared" : (raw as string),
				run: () => {
					const next = ambient?.name;
					if (next === this.ambientName) return;
					this.ambientName = next;
					this.restHandle?.stop("release");
					this.restHandle = undefined;
					this.syncSwaySuppression();
					this.syncBackgrounds();
				},
			});
		}
		if (!changes.length)
			return toolSucceeded("未指定任何槽位，状态未变。", { effectStatus: "accepted", verification: "local_intent" });
		const applied: string[] = [];
		try {
			for (const change of changes) {
				if (generation !== this.generation)
					return {
						result: `目录已更换（此前已生效: ${applied.join("、") || "无"}）。`,
						status: "cancelled",
						details: { reason: "stale_catalog", effectStatus: applied.length ? "accepted" : "not_started", applied },
					};
				const rejected = this.gate(ctx);
				if (rejected)
					return {
						...rejected,
						result: `${rejected.result}（此前已生效: ${applied.join("、") || "无"}）`,
						details: {
							...(rejected.details as object),
							...(applied.length ? { effectStatus: "accepted", verification: "local_intent" } : {}),
							applied,
						},
					};
				const waiting = Promise.resolve(change.run());
				if (!applied.length) onStarted?.();
				applied.push(change.label);
				await (ctx.signal ? withCancellation(waiting, ctx.signal) : waiting);
				ctx.signal?.throwIfAborted();
				if (generation !== this.generation) throw new Error("目录已更换");
			}
		} catch (error) {
			const cancelled = ctx.signal?.aborted || error instanceof SupersededError || generation !== this.generation;
			return {
				result: `${cancelled ? "状态设置已取消或被取代" : "状态设置失败"}（此前已生效: ${applied.join("、") || "无"}）。`,
				status: cancelled ? "cancelled" : "failed",
				details: {
					reason:
						generation !== this.generation
							? "stale_catalog"
							: ctx.signal?.aborted
								? "cancelled"
								: error instanceof SupersededError
									? "superseded"
									: "execution_failed",
					effectStatus: applied.length ? "accepted" : "not_started",
					verification: "local_intent",
					applied,
				},
			};
		}
		return toolSucceeded(`${applied.join(", ")} OK`, { effectStatus: "accepted", verification: "local_intent" });
	}

	/** costume（§2）：执行模型包登记的外观热键；独占声明（effect:*）+ VTS 热键触发。 */
	async costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const item = requireWord(args.item, "item");
		if (typeof item === "object") return item;
		const entry = this.catalog.resolve("costume", item)?.entry;
		if (!entry) {
			const available =
				this.catalog
					.list("costume")
					.map((c) => c.name)
					.join(", ") || "无";
			return toolRejected("unknown_costume", `外观不在当前模型目录: "${item}"。当前可用外观: ${available}。`);
		}
		return this.externalActions!.runCostume(entry, ctx.signal);
	}

	/** Explicit setup: create the rig-declared Uina inputs, then return the matching model outputs. */
	async prepareBody(ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const modelName = this.client!.getModelProfile()?.modelName ?? "当前模型";
		let preparation: Awaited<ReturnType<typeof prepareBodyInputs>>;
		try {
			preparation = await prepareBodyInputs(this.rig!, this.client!, ctx.signal);
		} catch (error) {
			this.onStatusChange?.();
			return toolUnknown(`VTS 身体输入准备未能完整确认：${error instanceof Error ? error.message : String(error)}`);
		}
		this.onStatusChange?.();
		if (preparation.status !== "prepared") {
			const details = {
				reason: preparation.reason,
				effectStatus: preparation.inputs.length ? "applied" : "not_started",
				confirmedInputs: preparation.inputs,
			};
			if (preparation.status === "cancelled") return { result: preparation.message, status: "cancelled", details };
			if (preparation.status === "failed") return { result: preparation.message, status: "failed", details };
			return toolUnknown(`${preparation.message}；可重试准备剩余输入。`, {
				reason: preparation.reason,
				confirmedInputs: preparation.inputs,
				expectedInputs: preparation.expectedInputs,
			});
		}
		const mapping = preparation.inputs.map(({ input, output }) => `${input} → ${output}`).join("；");
		return toolSucceeded(
			`三项 VTS 自定义输入已准备。请在 VTube Studio 的 ${modelName} 模型设置中手动映射：${mapping}。完成后执行 Live2D reload，再用 status(detail=true) 核对。`,
			{ effectStatus: "applied", inputs: preparation.inputs },
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
		return toolSucceeded("OK", { effectStatus: "accepted", verification: "local_intent" });
	}

	// ---------- 生命周期 ----------

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.phase === "running") return;
		if (this.phase !== "new") throw new Error("Live2D 生命周期已结束；请创建新实例。");
		ctx.signal?.throwIfAborted();
		this.phase = "starting";
		this.started = true;
		try {
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
						if (this.phase !== "running") return;
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
			const onAbort = () => {
				if (this.phase !== "running") return;
				this.phase = "closing";
				void this.safeStop()
					.catch((error) => {
						this.lifecycleFault = error instanceof Error ? error.message : String(error);
					})
					.finally(() => this.onStatusChange?.());
				this.onStatusChange?.();
			};
			this.phase = "running";
			if (ctx.signal) {
				ctx.signal.addEventListener("abort", onAbort, { once: true });
				this.cleanups.push(() => ctx.signal.removeEventListener("abort", onAbort));
			}
			if (ctx.signal?.aborted) onAbort();
			this.onStatusChange?.();
		} catch (cause) {
			const errors: unknown[] = [cause];
			try {
				await this.stop();
			} catch (error) {
				errors.push(error);
			}
			throw new AggregateError(errors, `Live2D 启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	/** 全局暂停：保留持续意图，取消等待与播放，保持中性口型注入，等待分项外部结算。 */
	async safeStop(): Promise<void> {
		if (this.paused) {
			if (!((await this.externalActions?.settlePending())?.complete ?? true))
				throw Object.assign(new Error("Uina 已暂停，外部效果或归位清理尚未确认。"), {
					reason: "cleanup_unconfirmed",
					cleanup: this.externalActions?.snapshot(),
				});
			return;
		}
		this.paused = true;
		this.executionController.abort(new Error("safestop"));
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
		// 外部声明在清理结算前持锁；必要项未知或预算耗尽使暂停返回失败。
		this.externalActions?.cancelAll();
		if (!((await this.externalActions?.settlePending())?.complete ?? true))
			throw Object.assign(new Error("Uina 已暂停，外部效果或归位清理尚未确认。"), {
				reason: "cleanup_unconfirmed",
				cleanup: this.externalActions?.snapshot(),
			});
	}

	/** resume（§6）：解除暂停、清保持帧、口型包络归零、眨眼与限时状态倒计时恢复剩余。 */
	async resume(): Promise<void> {
		if (!this.isStarted) throw Object.assign(new Error("Live2D 生命周期已关闭，不能恢复。"), { reason: "not_started" });
		if (!this.paused) return;
		this.paused = false;
		this.executionController = new AbortController();
		this.externalActions?.acknowledgeUnconfirmed();
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
		const { idle, thinking } = this.catalog.background;
		// 选中项不在当前快照（目录更替残留）：诚实回落 idle。
		if (this.ambientName !== undefined && !this.catalog.resolve("ambient", this.ambientName))
			this.ambientName = undefined;
		const ambient =
			this.ambientName !== undefined ? this.catalog.resolve("ambient", this.ambientName)?.entry : undefined;
		const restLoop = ambient?.motion ?? idle;
		if (ambient?.variants?.length) {
			// Phrase pools are finite: let the outgoing clip hand off while the next, nonrepeating phrase enters.
			if (!this.restHandle || ["cancelling", "finished"].includes(this.restHandle.status)) {
				this.restHandle = this.director.play(this.pickAmbientPhrase(ambient), {
					category: "autonomic",
					background: true,
					atomic: false,
					fadeInMs: 180,
					fadeOutMs: 220,
				});
			}
		} else if (restLoop && (!this.restHandle || this.restHandle.status === "finished")) {
			this.restHandle = this.director.play(compileMotion(restLoop, this.rig!.controls, this.pickRandom), {
				category: "autonomic",
				loop: true,
				background: true,
				atomic: false,
				fadeInMs: 450,
				fadeOutMs: 450,
			});
		}
		if (thinking && this.thinking && !this.thinkingHandle) {
			this.thinkingHandle = this.director.play(compileMotion(thinking, this.rig!.controls, this.pickRandom), {
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
		this.director?.setAuthoredIdle(this.catalog.background.idle !== undefined || this.ambientName !== undefined);
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
		this.externalActions?.cancelSpatial();
		this.director?.interruptTransient("turn_aborted");
		this.speechInput?.reset();
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.phase = "closing";
		this.stopPromise = this.closeResources();
		return this.stopPromise;
	}
	private async closeResources(): Promise<void> {
		const errors: unknown[] = [];
		this.stopClock();
		try {
			if (this.started) await this.safeStop();
		} catch (error) {
			errors.push(error);
		}
		this.started = false;
		this.stopClock();
		try {
			this.director?.invalidateAll("world stopped");
		} catch (error) {
			errors.push(error);
		}
		for (const cleanup of this.cleanups.splice(0).reverse()) {
			try {
				cleanup();
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			this.client?.disconnect();
		} catch (error) {
			errors.push(error);
		}
		this.phase = "dead";
		if (errors.length) this.lifecycleFault = "Live2D 停用清理失败";
		try {
			this.onStatusChange?.();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) throw new AggregateError(errors, "Live2D 停用失败：资源已释放，清理或归位尚未确认。");
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
		if (!this.started || !this.client || !this.director || !this.rig) return;
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
				focused: this.focused,
				catalog: {
					motions: formatMotionEntries(this.catalog.list("motion")),
					postures: formatCatalogEntries(this.catalog.list("posture")),
					expressions: formatCatalogEntries(this.catalog.list("expression")),
					attentions: this.catalog.list("attention").map((record) => record.name),
					costumes: this.catalog.list("costume").map((c) => c.name),
					ambient: {
						available: this.catalog.list("ambient").map(({ name: id, entry, aliases }) => ({
							aliases,
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
		const bodyMapping = inspectBodyMapping(this.rig, this.client?.getModelProfile());
		return JSON.stringify(
			{
				phase: this.phase,
				tickIntervalMs: this.tickIntervalMs,
				clockRunning: this.clock !== null,
				identityMatched: this.identityMatched(),
				paused: this.paused,
				focused: this.focused,
				generation: this.generation,
				lastCue: this.endpoint.lastCue(),
				externalActions: this.externalActions?.snapshot() ?? null,
				bodyMapping,
				director: this.director
					? {
							attention: this.director.getAttention() ?? null,
							blinkFactor: this.director.blinkFactor,
							frameAxes: Object.keys(this.director.currentFrame).length,
						}
					: null,
				catalog: {
					modelID: this.catalog.modelID,
					motions: this.catalog.list("motion").length,
					postures: this.catalog.list("posture").length,
					expressions: this.catalog.list("expression").length,
					attentions: this.catalog.list("attention").length,
					costumes: this.catalog.list("costume").length,
				},
			},
			null,
			2,
		);
	}
}
