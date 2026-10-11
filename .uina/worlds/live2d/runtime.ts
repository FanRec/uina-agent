import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { VOICE_LEVEL_SINK_EXPOSED_PREFIX, type VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import { encodeFrame, validateRig, type ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import { hashContent } from "./adapter/profile.js";
import { modelPackageDir } from "./models/rig-loader.js";
import { emptyCatalog, recompileWithSpeech, type AttentionTarget, type CatalogSnapshot } from "./authoring/catalog.js";
import type { SpeechPolicy } from "./authoring/motion.js";
import { MotionDirector, SupersededError, type ExclusiveClaim, type MotionHandle } from "./director/director.js";
import { buildLive2DEndpoint, type Live2DEndpoint } from "./endpoint.js";
import { fromEngineResult, toolRejected, toolSucceeded, toolUnknown } from "./results.js";
import { SpeechInput, type SpeechConfig } from "./speech-level.js";

/**
 * Live2D 世界运行时。
 *
 * P2-3 范围：生命周期 + VTS 连接 + 保活注入时钟 + director 合成接入。
 * P3-2 增量：voice.levelSink 声学电平接缝（失联守卫 + 作者映射 → 引擎口型包络）。
 * P4-1 增量：工具 gate 链（边界规范 §2.1 词表 + §7 顺序）、目录快照词表解析、
 *           express/state 引擎映射、作者会话标记门、status/diagnose 真实事实。
 *
 * tick 合约（边界规范 §6）：每帧实测 dt 驱动 director.step → adapter.encode → client.inject；
 * 断线/身份不匹配/未发布时既不合成也不注入（保持零输出），重连后从当前状态续合成。
 * - 时钟只在连接就绪且模型身份匹配时运转，断线即停、重连即恢复；
 * - dt 用单调时钟实测（REVIEW 教训：不信任定时器间隔），钳制 250ms 防休眠/节流大跳；
 * - faceFound 与单未确认帧背压由 vts-client 承担，时钟不重复实现；
 * - 发布门的真值来源（acceptance.json + 作者会话）在 P4-6 接入；本阶段由选项注入（缺省恒开放）。
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
	/** 注入点（测试用）：发布门。缺省由 acceptance.json sidecar 驱动（P4-6）。 */
	published?: boolean;
	/** 注入点（测试用）：模型包目录（acceptance.json sidecar 归属地）。缺省按 rig-loader 的 models/<folder> 解析。 */
	packageDir?: string;
	/** 模型作者标定的口型映射；与 rig 同时存在时暴露 voice.levelSink（P3-2）。 */
	speech?: SpeechConfig;
	/** 目录快照；缺省空目录（诚实状态：一切命名参数显式拒绝）。 */
	catalog?: CatalogSnapshot;
	/** 独占声明清理等待上限（§6.4 safeStop 抛错判定；注入点（测试用），缺省 5000ms）。 */
	cleanupTimeoutMs?: number;
}

/** 单帧合成到注入之间允许的最大时间步（毫秒）：后台节流/休眠恢复时防止动作瞬移。 */
const MAX_TICK_DT_MS = 250;

/** flip 空间变换常量（§2：整圈旋转，绝对轨迹；回读前留出 VTS 动画结算余量）。 */
const FLIP_MOVE_SECONDS = 0.8;
const RESTORE_SECONDS = 0.5;
const SETTLE_MARGIN_MS = 250;

/** VTS 模型位姿（getModelPosition 返回形态）。 */
type ModelPose = { positionX: number; positionY: number; rotation: number; size: number };

/** 等待或中止：resolve true=自然到期，false=signal 中止。 */
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

/** 角度差按 360° 环绕归一到 (-180, 180]——翻转整圈后回读值偏移 360°。 */
const wrapDeg = (d: number): number => (((d % 360) + 540) % 360) - 180;

/** 位姿回读核实：旋转按环绕差比较，位移/缩放线性容差。 */
const poseMatches = (now: ModelPose, base: ModelPose, tol = 0.5): boolean =>
	Math.abs(wrapDeg(now.rotation - base.rotation)) <= tol &&
	Math.abs(now.positionX - base.positionX) <= 0.01 &&
	Math.abs(now.positionY - base.positionY) <= 0.01 &&
	Math.abs(now.size - base.size) <= 0.01;

/** state 注视参数的引擎内置词表成员判定（目录命名优先级低于内置词表）。 */
const isBuiltinAttention = (value: string): value is Extract<AttentionTarget, string> =>
	["user", "screen", "avert_down", "avert_left", "avert_right"].includes(value);

export class Live2DRuntime {
	private started = false;
	private readonly cleanups: Array<() => void> = [];
	private readonly client?: VTSClient;
	private readonly rig?: ModelRig;
	private readonly tickIntervalMs: number;
	/**
	 * 发布状态（§7）。显式选项优先（测试注入）；缺省由 acceptance.json 驱动：
	 * acceptedDigest 存在且与当前内容摘要一致才发布——内容任何改动即回到草稿。
	 */
	private published: boolean;
	private readonly publishedOverride?: boolean;
	private acceptedDigest?: string;
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
	/** 独占声明 reason 序号：每次声明唯一 reason，重叠声明一律 resource_conflict（不做同 reason 幂等替换）。 */
	private claimSeq = 0;
	/** 在途归位清理任务（flip 取消路径注册；safeStop 等待-结算的事实源）。 */
	private readonly pendingCleanups = new Set<Promise<boolean>>();
	private readonly cleanupTimeoutMs: number;
	/** safeStop 保持帧：暂停期间按 tick 节奏持续注入（口型通道已覆写中性值）。 */
	private keepFrame?: Record<string, number>;
	private clock: NodeJS.Timeout | null = null;
	private lastTickAt = 0;
	/** 作者会话数据目录（start 时由 ctx.worldDataDir 注入；author-session 标记文件在其下）。 */
	private worldDataDir?: string;
	/** 引擎句柄：P4 工具面（express/state）在此之上操作；无 rig 时不存在。 */
	readonly director?: MotionDirector;
	/** 声学电平接收端：rig + speech 配置同时存在时可用，start 时经 expose 登记给 voice 扩展。 */
	readonly levelSink?: VoiceLevelSink;
	private readonly speechInput?: SpeechInput;
	private readonly speech?: SpeechConfig;
	private readonly packageDir?: string;
	readonly endpoint: Live2DEndpoint;

	constructor(options: Live2DRuntimeOptions = {}) {
		this.client = options.client;
		this.rig = options.rig;
		this.publishedOverride = options.published;
		this.published = this.publishedOverride ?? false; // 缺省草稿：start 时由 acceptance.json 判定
		this.packageDir = options.packageDir;
		this.speech = options.speech;
		this.catalog = options.catalog ?? emptyCatalog(options.rig?.modelID ?? "unknown");
		if (this.rig && this.catalog.modelID !== this.rig.modelID)
			throw new Error(`目录与 rig 模型身份不符: 目录 ${this.catalog.modelID} vs rig ${this.rig.modelID}`);
		if (this.rig) {
			validateRig(this.rig);
			this.director = new MotionDirector(this.rig.controls, { external: this.rig.external, rng: options.rng });
			if (options.speech) {
				const input = new SpeechInput(options.speech, this.director);
				this.speechInput = input;
				// 未发布/暂停期间电平一律丢弃（边界规范 §4）。
				this.levelSink = {
					processLevel: (level) => {
						if (!this.published || this.paused) return;
						input.processLevel(level);
					},
					reset: () => input.reset(),
				};
			}
		}
		this.tickIntervalMs = options.tickIntervalMs ?? 1000 / 60;
	this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000;
		this.endpoint = buildLive2DEndpoint(this);
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** 目录视图：未发布时目录按空处理（§7：catalog 为空 → cue 全部不可达、命名动作拒绝）。 */
	get catalogView(): CatalogSnapshot {
		return this.published ? this.catalog : emptyCatalog(this.catalog.modelID);
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
	 * A11 统一规则：任何非播放态（safeStop 暂停/失焦）冻结倒计时与过渡，回焦恢复剩余。
	 */
	setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
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
		this.director?.invalidateAll("catalog changed");
		this.refreshPublished(); // 内容任何改动即回到草稿（§7）：目录更新后按新摘要重判发布状态
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
	 * 作者会话标记门（边界规范 §2）：世界数据目录下存在 `author-session` 文件即开启。
	 * 执行时检查（不缓存），一个文件存在性检查，不引入身份框架。
	 */
	private authorSessionActive(): boolean {
		return this.worldDataDir !== undefined && existsSync(join(this.worldDataDir, "author-session"));
	}

	// ---------- 发布验收门（§7，P4-6） ----------

	/**
	 * 内容摘要（§7 normative）：只覆盖运行时内容——rig、动作/姿态/表情/注视/背景定义、
	 * speech 与外观配置，规范化序列化后 sha256。acceptance.json/acceptance.md、构建产物、
	 * 运行时缓存一律不参与（本摘要输入为纯内存运行时事实，文件系统不触及）。
	 */
	private computeContentDigest(): string {
		const sorted = (map: ReadonlyMap<string, unknown>): unknown =>
			[...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const content = {
			modelID: this.catalog.modelID,
			rig: this.rig ? { controls: this.rig.controls, bindings: this.rig.bindings, external: this.rig.external } : null,
			catalog: {
				motions: sorted(this.catalog.motions),
				postures: sorted(this.catalog.postures),
				expressions: sorted(this.catalog.expressions),
				attentions: sorted(this.catalog.attentions),
				costumes: this.catalog.costumes,
				background: {
					thinking: this.catalog.background.thinking ?? null,
					idle: this.catalog.background.idle ?? null,
				},
			},
			speech: this.speech ?? null,
		};
		return hashContent(JSON.stringify(content));
	}

	/** acceptance.json sidecar 路径（models/<model>/acceptance.json）；模型包不可解析时 undefined。 */
	private acceptanceFilePath(): string | undefined {
		const dir = this.packageDir ?? (this.rig ? modelPackageDir(this.rig.modelID) : undefined);
		return dir ? join(dir, "acceptance.json") : undefined;
	}

	/** 发布状态重判：显式选项优先；否则 acceptedDigest 存在且与当前内容摘要一致才发布。 */
	private refreshPublished(): void {
		this.published =
			this.publishedOverride ?? (this.acceptedDigest !== undefined && this.acceptedDigest === this.computeContentDigest());
	}

	/** accept（§2）：发布门唯一写入路径。作者会话门在此落实。 */
	async accept(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx, { authorOnly: true });
		if (denied) return denied;
		if (typeof args.evidence !== "string" || args.evidence.length === 0)
			return toolRejected("invalid_preview", "缺少 evidence（人工画面验收说明）。");
		const path = this.acceptanceFilePath();
		if (!path) return toolRejected("model_not_ready", "当前模型没有已登记的模型包目录，acceptance.json 无处写入。");
		const contentDigest = this.computeContentDigest();
		const record = {
			contentDigest,
			controlFingerprint: this.client?.getModelProfile()?.controlFingerprint,
			evidence: args.evidence,
			acceptedAt: new Date().toISOString(),
		};
		try {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		} catch (error) {
			return toolUnknown(`acceptance.json 写入失败：${error instanceof Error ? error.message : String(error)}`);
		}
		this.acceptedDigest = contentDigest;
		this.refreshPublished();
		return toolSucceeded("人工验收记录已写入，模型包发布。", { effectStatus: "applied" });
	}

	/**
	 * 工具 gate 链（边界规范 §2.1 + §7 gate 顺序：连接 → 适配 → 发布）。
	 * 返回 undefined 表示通过。authorOnly 工具（preview/accept）先于一切内容判定。
	 */
	private gate(ctx: { signal?: AbortSignal }, options: { authorOnly?: boolean } = {}): ToolExecutionResult | undefined {
		if (ctx.signal?.aborted) return toolRejected("cancelled", "调用已中止，未执行。");
		if (options.authorOnly && !this.authorSessionActive())
			return toolRejected("author_session_required", "此工具仅作者会话可用：需操作员在世界数据目录创建 author-session 标记。");
		if (this.paused)
			return toolRejected("paused", "身体处于 safeStop 暂停，操作被拒绝（resume 后恢复）。");
		if (!this.client || !this.client.isConnected())
			return toolRejected("model_not_ready", "VTS 未连接（连接建立前所有具身操作不可用）。");
		const profile = this.client.getModelProfile();
		if (!this.rig || !profile || profile.modelID !== this.rig.modelID)
			return toolRejected("unadapted", "当前模型没有可用的本地适配（rig/目录缺失或绑定核验失败）。");
		if (!this.published && !options.authorOnly)
			return toolRejected("draft", "模型包尚未完成当前内容版本的发布验收（作者预览可用）。");
		return undefined;
	}

	/** express（§2）：播放目录中的命名动作，Voluntary 类别；await 终态结算。 */
	async express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const director = this.director;
		if (!director) return toolRejected("unadapted", "引擎未接入（无 rig）。");
		const name = args.motion;
		if (typeof name !== "string" || name.length === 0) return toolRejected("invalid_motion", "缺少 motion 参数。");
		const entry = this.catalog.motions.get(name);
		if (!entry)
			return toolRejected("unknown_motion", `动作不在当前模型目录: "${name}"（可用名称见 status）。`);
		if (args.atomic !== undefined && typeof args.atomic !== "boolean")
			return toolRejected("invalid_motion", "atomic 必须是布尔值。");
		if (args.speech !== undefined && args.speech !== "allow" && args.speech !== "exclusive")
			return toolRejected("invalid_motion", 'speech 只接受 "allow" | "exclusive"。');
		// speech 覆写：外层 withSpeech 节点覆盖作者内层口型策略（含 sequence 时序）。
		const clip =
			args.speech === undefined
				? entry.motion
				: recompileWithSpeech(entry, args.speech satisfies SpeechPolicy, this.rig!.controls);
		const handle = director.play(clip, {
			category: "voluntary",
			atomic: args.atomic ?? entry.atomic,
			signal: ctx.signal,
		});
		return fromEngineResult(await handle.finished, `动作 "${name}"`);
	}

	/** state（§2）：三个槽相互独立；声明的槽整槽替换，未声明的槽保持不变；hold_ms 各槽独立计时。 */
	async state(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const director = this.director;
		if (!director) return toolRejected("unadapted", "引擎未接入（无 rig）。");
		if (args.hold_ms !== undefined) {
			const hold = args.hold_ms;
			if (typeof hold !== "number" || !Number.isFinite(hold) || hold < 0)
				return toolRejected("invalid_duration", "hold_ms 必须是非负有限数值。");
		}
		const holdMs = typeof args.hold_ms === "number" && args.hold_ms > 0 ? args.hold_ms : undefined;
		const pending: Promise<void>[] = [];
		if (args.posture !== undefined) {
			const slot = this.catalog.postures.get(String(args.posture));
			if (!slot) return toolRejected("unknown_pose", `姿态不在当前模型目录: "${args.posture}"（可用名称见 status）。`);
			pending.push(director.setPosture(slot.values, { holdMs }));
		}
		if (args.expression !== undefined) {
			const slot = this.catalog.expressions.get(String(args.expression));
			if (!slot) return toolRejected("unknown_expression", `表情不在当前模型目录: "${args.expression}"（可用名称见 status）。`);
			pending.push(director.setExpression(slot.values, { holdMs }));
		}
		if (args.attention !== undefined) {
			const name = String(args.attention);
			const target = isBuiltinAttention(name)
				? name
				: (this.catalog.attentions.get(name)?.target ??
					undefined);
			if (target === undefined)
				return toolRejected("unknown_attention", `注视目标不在词表: "${name}"（内置 user/screen/avert_* 或目录命名）。`);
			director.setAttention(target, { holdMs });
		}
		if (pending.length === 0 && args.attention === undefined)
			return toolSucceeded("未声明任何槽，状态保持不变。", { effectStatus: "not_started" });
		try {
			await Promise.all(pending);
		} catch (error) {
			// 整槽替换被更新的 state 调用取代：本调用如实结算 cancelled，运动归属新调用。
			if (error instanceof SupersededError) {
				return {
					result: "状态设置已被更新的调用取代。",
					status: "cancelled",
					details: { effectStatus: "cancelled" as const, supersededAxes: error.axes },
				};
			}
			throw error;
		}
		return toolSucceeded("状态已生效。", { effectStatus: "applied", verification: "input_accepted" });
	}

	/** costume（§2）：list 只列出登记项；执行走独占声明（effect:*）+ VTS 热键触发。 */
	async costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const item = args.item;
		if (typeof item !== "string" || item.length === 0) return toolRejected("unknown_costume", "缺少 item 参数。");
		if (item === "list") {
			const registered = this.catalog.costumes.map((c) => `${c.id}（${c.description}，热键 ${c.hotkeyID}）`);
			return toolSucceeded(registered.length ? `已登记外观:\n${registered.join("\n")}` : "当前模型没有登记任何外观。");
		}
		const entry = this.catalog.costumes.find((c) => c.id === item);
		if (!entry) return toolRejected("unknown_costume", `外观不在当前模型目录: "${item}"（可用 item="list" 查询）。`);
		const hotkey = this.client?.findHotkey(entry.hotkeyID);
		if (!hotkey) return toolRejected("hotkey_missing", `热键未在当前 VTS 模型登记: "${entry.hotkeyID}"（模型配置已变更？reload 后重试）。`);
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
	 * flip（§2）：整模型旋转一圈并回读核实归位（绝对轨迹）。独占 model:transform，
	 * 带清理声明——取消后等待归位清理完成才结算（§9 #9：清理完成前资源不释放）。
	 */
	async flip(_args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		const claim = this.acquireClaim(["model:transform"], "flip", ctx.signal, true);
		if ("status" in claim) return claim;
		const client = this.client!;
		try {
			const base = await client.getModelPosition();
			await client.moveModel({
				timeInSeconds: FLIP_MOVE_SECONDS,
				valuesAreRelativeToModel: false,
				positionX: base.positionX,
				positionY: base.positionY,
				rotation: base.rotation + 360,
				size: base.size,
			});
			if (!(await sleep(FLIP_MOVE_SECONDS * 1000 + SETTLE_MARGIN_MS, claim.signal))) {
				// 取消：归位清理是外部效果——等待清理完成才结算；清理任务入账供 safeStop 等待（§6.2/6.4）。
				const cleanup = this.trackCleanup(this.restorePose(client, base));
				const confirmed = await cleanup;
				return toolRejected(
					"cancelled",
					confirmed ? "翻转已取消，模型已归位并核实。" : "翻转已取消，但归位清理未核实（效果不明，资源已释放）。",
					{ effectStatus: confirmed ? ("cancelled" as const) : ("unknown" as const) },
				);
			}
			const now = await client.getModelPosition();
			if (!poseMatches(now, base)) return toolUnknown("翻转已执行但归位未核实（回读与基线不符）。");
			return toolSucceeded("模型已翻转一圈并核实归位。", { effectStatus: "applied" });
		} catch (error) {
			return toolUnknown(`flip 执行中断：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			claim.release();
		}
	}

	/** spatial（§2）：模型整体位移与缩放（绝对位姿，MoveModelRequest 0~2s 调度）+ 回读核实。 */
	async spatial(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx);
		if (denied) return denied;
		for (const key of ["x", "y", "size"] as const) {
			if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key])))
				return toolRejected("invalid_motion", `${key} 必须是有限数值。`);
		}
		const duration = args.duration;
		if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 2))
			return toolRejected("invalid_duration", "duration 必须在 0~2 秒之间。");
		const claim = this.acquireClaim(["model:transform"], "spatial", ctx.signal);
		if ("status" in claim) return claim;
		const client = this.client!;
		try {
			const base = await client.getModelPosition();
			const target = {
				positionX: (args.x as number | undefined) ?? base.positionX,
				positionY: (args.y as number | undefined) ?? base.positionY,
				rotation: base.rotation,
				size: (args.size as number | undefined) ?? base.size,
			};
			const moveSeconds = (duration as number | undefined) ?? 0.5;
			await client.moveModel({ timeInSeconds: moveSeconds, valuesAreRelativeToModel: false, ...target });
			if (!(await sleep(moveSeconds * 1000 + SETTLE_MARGIN_MS, claim.signal)))
				return toolRejected("cancelled", "位移已取消；VTS 侧动画可能继续至目标位姿（外部效果不回收）。");
			const now = await client.getModelPosition();
			if (!poseMatches(now, target)) return toolUnknown("位移已调度但结果未核实（回读与目标不符）。");
			return toolSucceeded("模型位姿已更新并核实。", { effectStatus: "applied" });
		} catch (error) {
			return toolUnknown(`spatial 执行中断：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			claim.release();
		}
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

	/**
	 * preview（§2）：作者预览与生产同链路。作者会话门在此落实；预览引擎
	 * （单控制关键帧 / 假 RMS / repeat）随创作层（P5-1）接入，本阶段如实声明。
	 */
	async preview(_args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		const denied = this.gate(ctx, { authorOnly: true });
		if (denied) return denied;
		return this.notStarted("preview");
	}

	// ---------- 生命周期 ----------

	async start(ctx: ServiceCompanionContext): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.worldDataDir = ctx.worldDataDir;
		// 发布门真值来源（§7）：无显式选项时读 acceptance.json sidecar，摘要一致才发布。
		if (this.publishedOverride === undefined) {
			const path = this.acceptanceFilePath();
			if (path && existsSync(path)) {
				try {
					const record = JSON.parse(await readFile(path, "utf8")) as { contentDigest?: string };
					this.acceptedDigest = typeof record.contentDigest === "string" ? record.contentDigest : undefined;
				} catch {
					this.acceptedDigest = undefined; // sidecar 损坏 = 未验收，诚实草稿
				}
			} else this.acceptedDigest = undefined;
			this.refreshPublished();
		}
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
			});
			this.client.connect();
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
		if (this.paused) return;
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
		// §6.2/§6.4：取消全部独占声明；带清理的声明等待归位清理完成，未确认则抛错（调用方得
		// unknown；拆除不被阻塞——BodyRouter.stopAll 以 allSettled 承接为 failed[]）。
		director.cancelClaims();
		await new Promise((r) => setTimeout(r, 0)); // 让 abort 监听器先产生清理任务
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
				: toolRejected("resource_conflict", "独占资源被占用（flip/spatial/costume 正在进行或清理中）。");
		}
	}

	/** 归位清理任务入账（§6.2 safeStop 等待-结算的事实源）。返回原 Promise 供调用方等待。 */
	private trackCleanup(p: Promise<boolean>): Promise<boolean> {
		const wrapped = p.finally(() => this.pendingCleanups.delete(wrapped));
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
		return true;
	}

	/** flip 取消路径：绝对位姿回基线 → 回读核实。返回是否核实通过（失败也结算，不悬挂声明）。 */
	private async restorePose(client: VTSClient, base: ModelPose): Promise<boolean> {
		try {
			await client.moveModel({
				timeInSeconds: RESTORE_SECONDS,
				valuesAreRelativeToModel: false,
				positionX: base.positionX,
				positionY: base.positionY,
				rotation: base.rotation,
				size: base.size,
			});
			await sleep(RESTORE_SECONDS * 1000 + SETTLE_MARGIN_MS);
			return poseMatches(await client.getModelPosition(), base);
		} catch {
			return false;
		}
	}

	/** resume（§6）：解除暂停、清保持帧、口型包络归零、眨眼与限时状态倒计时恢复剩余。 */
	async resume(): Promise<void> {
		if (!this.paused) return;
		this.paused = false;
		this.keepFrame = undefined;
		this.speechInput?.reset();
		this.syncFrozen();
	}

	/**
	 * setThinking（§5 宿主事件）：状态驱动入口，幂等——仅在跳变时动作。
	 * false→true：按目录 background.thinking 启动（Transition 类别）；目录缺失
	 * （未发布/无定义）即启动失败，不自动重试。true→false：fade 收势停止。
	 */
	setThinking(on: boolean): void {
		if (on === this.thinking) return;
		this.thinking = on;
		if (on) {
			const clip = this.catalogView.background.thinking;
			if (!clip) return;
			this.thinkingHandle = this.director?.play(clip, { category: "transition" });
		} else {
			this.thinkingHandle?.stop("release");
			this.thinkingHandle = undefined;
		}
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
		this.director?.interruptTransient("turn_aborted");
		this.speechInput?.reset();
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
		// §6 暂停分支：不合成、不推进倒计时，按 tick 节奏持续注入保持帧。
		if (this.paused) {
			if (this.keepFrame) this.client.injectParameters(encodeFrame(this.rig, this.keepFrame));
			return;
		}
		// 声学电平推进（失联守卫 + 作者映射）→ 引擎包络目标，先于本帧合成。
		this.speechInput?.tick(dtMs);
		const frame = this.director.step(dtMs);
		this.client.injectParameters(encodeFrame(this.rig, frame));
	}

	// ---------- 事实呈现 ----------

	formatStatus(): string {
		const connection = this.client?.getConnectionStatus();
		return JSON.stringify(
			{
				world: "live2d",
				build: "P4 tools",
				started: this.started,
				engine: this.director ? "director_wired (P2-3)" : "not_wired",
				speech: this.levelSink ? "levelSink_wired (P3-2)" : "not_wired",
				published: this.published,
				authorSession: this.authorSessionActive(),
				paused: this.paused,
				focused: this.focused,
				generation: this.generation,
				rig: this.rig ? { modelID: this.rig.modelID, axes: Object.keys(this.rig.controls).length } : null,
				identityMatched: this.identityMatched(),
				connection: connection ?? null,
				catalog: {
					motions: [...this.catalog.motions.keys()],
					postures: [...this.catalog.postures.keys()],
					expressions: [...this.catalog.expressions.keys()],
					attentions: [...this.catalog.attentions.keys()],
					costumes: this.catalog.costumes.map((c) => c.id),
				},
				lastCue: this.endpoint.lastCue(),
				endpoint: { bodyId: this.endpoint.bodyId, bodyType: this.endpoint.bodyType },
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
				published: this.published,
				authorSession: this.authorSessionActive(),
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
