import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import { CUE_DISPATCH_SHARED } from "../embodiment/playback-cues.js";
import type { PlaybackFact } from "../tts/delivery-facts.js";
import { SpeechSegmenter, hasPronounceableContent, normalizeSpokenText } from "./segmenter.js";
import type { AdmissionResult, SpeechDeliveryPort, StopResult } from "./delivery-port.js";
import { loadSpeechPreferences, saveSpeechPreferences, type SpeechPreferences } from "./preferences.js";

/** 表达内的 Marker（时间锚点，不是工具调用）。执行身份 = Utterance 内序号。 */
export interface SpeechCue {
	readonly id: string;
	readonly target?: string;
	readonly seq: number;
}

export type UtteranceOrigin =
	| { readonly kind: "model_output"; readonly streamId: string; readonly blockId: string }
	| { readonly kind: "tool"; readonly callId: string; readonly invocationId?: string };

/** 一次独立语言表达：来源是一个 <speech> Block 或一次 speech.say；不等于 Turn、Stream 或播放器 Task。 */
export interface Utterance {
	readonly id: string;
	readonly origin: UtteranceOrigin;
	/** 已受理的源表达文本（发音规范化前的原文累计）。 */
	text: string;
	inputClosed: boolean;
	state: "created" | "queued" | "playing" | "settled";
	settlement?: "completed" | "stopped" | "failed" | "unknown" | "not_played";
}

/** 内部 Runtime Input 的四种事件（§7.3.3）；identity 用于宿主按稳定身份去重。 */
export interface SpeechRuntimeNotice {
	readonly type: "speech.interrupted" | "speech.delivery_failed" | "speech.delivery_unknown" | "speech.unavailable";
	/** 真实原因身份 + 事件类型的稳定派生；重复回调不得换 ID 绕过去重。 */
	readonly identity: string;
	/** 带事实时间的过去式正文；自足且准确（重启后延迟回调不会恢复）。 */
	readonly text: string;
}

interface UtteranceRecord {
	readonly utterance: Utterance;
	readonly segmenter: SpeechSegmenter;
	/** 该 Utterance 的同一顺序执行链：segment 提交、seal、停止全部串行。 */
	chain: Promise<unknown>;
	/** 本地提交代次：停止/中断/替换同步递增，旧队列任务醒来必须检查，不得继续提交。 */
	generation: number;
	cancelled: boolean;
	/** Driver Source 身份；首个片段受理后回填。 */
	traceId?: string;
	/** 已受理片段的最大 index（1 起）。 */
	segmentSeq: number;
	segmentTexts: Map<number, string>;
	/** 已收到播放终局 completed 的片段 index。 */
	completedSegments: Set<number>;
	/** 远端封口已确认（turn-end 回执或来源已取消/无受理段）。 */
	sealed: boolean;
	cueSeq: number;
	/** 等待下一段起始边界的 Cue（Marker 强制左侧封段后进入这里）。 */
	pendingCues: SpeechCue[];
	/** 表达结尾且没有后续可发音片段的 Cue（前段 playback_completed 后执行）。 */
	trailingCues: SpeechCue[];
	/** 片段起始 Cue：index → cues（playback_started 边界执行）。 */
	segmentCues: Map<number, SpeechCue[]>;
	/** 任一音频片段已受理或结果未知（音频事实驱动的依据）。 */
	audioAccepted: boolean;
	/** 已执行身份（同一身份至多执行一次）。 */
	triggeredCues: Set<number>;
	/** 文本降级路径已启动（启动后不再转回音频路径，也不重新提交旧台词）。 */
	textPathStarted: boolean;
	/** 最近一次可信的 playback_started 播放事实。 */
	lastStarted: { index: number; at: number } | null;
	/** 已通知的事件类型（每个 Utterance 每类最多一个终局）。 */
	notifiedTerminal: Set<string>;
	/** 表达链上停止任务记账的结果（stop 工具与 replace 的返回事实）。 */
	stopOutcome?: StopOutcome;
}

export interface SayOutcome {
	accepted: boolean;
	utteranceId?: string;
	/** 音频事实：queued = 已受理待交付；not_played = 无音频进入交付路径；unknown = 存在未确认。 */
	audio: "queued" | "not_played" | "unknown";
	reason?: string;
}

export interface StopOutcome {
	outcome: StopResult["outcome"];
	reason?: string;
	segmentIndex?: number;
	segmentText?: string;
}

const PLAYBACK_FRESH_MS = 2500; // 两次预期探测间隔（约 1s）的保守过期判据

/**
 * Speech 业务运行时：Utterance 受理、语义分句、停止/静音代次屏障、Cue 对齐与
 * 交付结算。三个阶段不可混称：表达受理（本类记下意图）、音频受理（Driver 回执）、
 * 播放完成（本地播放回执）。公共 expression 观察处理器只同步推进本地状态并入队，
 * 不等待 Bridge、文件或网络。
 */
export class SpeechSession {
	private muted = false;
	private preferences: SpeechPreferences = { muted: false };
	private readonly preferencesReady: Promise<void>;
	private readonly records = new Map<string, UtteranceRecord>();
	/** 同一调用重入只产生一个 Utterance，不能重复排音频（§5.1）。 */
	private readonly byInvocation = new Map<string, UtteranceRecord>();
	/** 跨 Utterance 控制操作（stop 全量/replace/静音）按 Speech 接纳顺序串行。 */
	private controlTail: Promise<unknown> = Promise.resolve();
	/** 声音可用性阶段账：false 表示当前处于已通知的不可用阶段；恢复后清零。 */
	private available: boolean | undefined = true;
	private unavailableStageId: string | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly delivery: SpeechDeliveryPort,
		private readonly notify: (notice: SpeechRuntimeNotice) => void,
	) {
		this.preferencesReady = loadSpeechPreferences(pi).then((value) => {
			this.preferences = value;
			this.muted = value.muted;
		});
	}

	get isMuted(): boolean {
		return this.muted;
	}

	get hasDriver(): boolean {
		return typeof this.pi.hasService === "function" && this.pi.hasService("tts_delivery:submit");
	}

	// ── 表达受理（expression 观察的同步入口） ────────────────────────────

	/** block_start：创建 Utterance。 */
	acceptBlockStart(streamId: string, blockId: string): void {
		this.ensureRecord({ kind: "model_output", streamId, blockId });
	}

	/** text（scope.name === "speech"）：追加文本并按分句结果同步入队提交任务。 */
	acceptSpeechText(streamId: string, blockId: string, text: string): void {
		const record = this.ensureRecord({ kind: "model_output", streamId, blockId });
		if (record.utterance.inputClosed) return;
		record.utterance.text += text;
		for (const raw of record.segmenter.feed(text)) this.emitSegment(record, raw);
	}

	/** marker（Block 内）：Marker 强制左侧封段，自身等待右侧下一段的起始边界。 */
	acceptMarker(streamId: string, blockId: string, attributes: Readonly<Record<string, string>>): void {
		const record = this.ensureRecord({ kind: "model_output", streamId, blockId });
		if (record.utterance.inputClosed) return;
		// 先将左侧已累积的可发音文本封成片段（普通标点尚未触发也按此规则分段）。
		const flushed = record.segmenter.forceBoundary();
		if (flushed !== undefined) this.emitSegment(record, flushed);
		const id = attributes.id;
		if (!id) return;
		const cue: SpeechCue = { id, ...(attributes.target ? { target: attributes.target } : {}), seq: ++record.cueSeq };
		record.pendingCues.push(cue);
	}

	/** block_end(closed/ended)：关闭输入；待播片段正常收束，已受理的音频继续。 */
	acceptBlockEnd(streamId: string, blockId: string): void {
		const record = this.records.get(this.recordKeyOf({ kind: "model_output", streamId, blockId }));
		if (!record || record.utterance.inputClosed) return;
		record.utterance.inputClosed = true;
		// 残余文本同步入队（链内串行；不在任务里等待自身链）。
		const tail = record.segmenter.flushBoundary();
		if (tail !== undefined) this.emitSegment(record, tail);
		const generation = record.generation;
		record.chain = record.chain
			.then(async () => {
				if (record.generation !== generation) return;
				await this.finalizeUtterance(record);
			})
			.catch(() => undefined);
	}

	/** block_end(interrupted)：关闭输入并取消未提交音频/Cue；已受理音频按该来源停止。 */
	interruptUtterance(streamId: string, blockId: string): void {
		const record = this.records.get(this.recordKeyOf({ kind: "model_output", streamId, blockId }));
		if (record) this.cancelRecords([record], "output_interrupted");
	}

	/** turn_aborted：与来源中断相同；不全局停止既有声音（冻结目标集合）。 */
	abortOpenUtterances(): void {
		const targets = [...this.records.values()].filter((record) => !record.utterance.inputClosed);
		this.cancelRecords(targets, "turn_aborted");
	}

	// ── 交付事实（TTS 播放事实回推） ─────────────────────────────────────

	/** Driver 的播放事实：Cue 边界、"正在说"与交付结算的唯一物理来源。 */
	acceptPlaybackFact(utteranceId: string, fact: PlaybackFact): void {
		const record = this.findByUtteranceId(utteranceId);
		if (!record || record.cancelled) return;
		record.chain = record.chain
			.then(() => {
				if (record.cancelled) return;
				if (fact.kind === "started") {
					// 播放恢复证据：故障阶段账清零（恢复后再发生才开启新阶段）。
					this.available = true;
					this.unavailableStageId = undefined;
					record.lastStarted = { index: fact.segmentIndex, at: Date.now() };
					record.utterance.state = "playing";
					for (const cue of record.segmentCues.get(fact.segmentIndex) ?? []) this.executeCue(record, cue);
					return;
				}
				if (fact.kind === "completed") {
					// 片段事实先落账；整次表达只有在输入封口且封口确认后才结算，
					// 模型仍在输出时后续句段还会到来，不得提前 settled。
					record.completedSegments.add(fact.segmentIndex);
					this.settleIfDelivered(record);
					return;
				}
				// failed：整段表达未完成；剩余 Cue 不补执行。
				this.settle(record, "failed");
				const failedLine = record.segmentTexts.get(fact.segmentIndex);
				this.notifyOnce(record, "speech.delivery_failed", () => ({
					identity: `speech:${record.utterance.id}:delivery_failed`,
					text: `一次已受理的发言在「${failedLine ?? record.utterance.text.slice(-40)}」处未能播完；这段发声的音频交付已失败。`,
				}));
			})
			.catch(() => undefined);
	}

	/** 可用性阶段检查（turn_start 时调用）：未静音的声音能力从可用进入不可用时，
	 * 每个故障阶段最多一次内部事件；恢复（播放事实或快照在线）后再发生才开启新阶段。
	 * 无人时也可唤醒自主维护。普通 Probe 失败不在此列（没有快照就没有阶段变化）。 */
	async refreshAvailability(): Promise<void> {
		if (this.muted) return;
		const view = await this.delivery.snapshot().catch(() => undefined);
		if (!view) return; // 驱动未挂载不是新的故障阶段：Capability 已表达限制
		if (view.online) {
			this.available = true;
			this.unavailableStageId = undefined;
			return;
		}
		if (this.available === false) return; // 当前阶段已通知，恢复后再发生才开启新阶段
		this.available = false;
		this.unavailableStageId = randomUUID(); // 故障阶段身份不跨 Reload 重用
		this.notify({
			type: "speech.unavailable",
			identity: `speech:unavailable:${this.unavailableStageId}`,
			text: "声音能力从可用进入了不可用（发声服务未连接）；恢复前新内容只会显示文字。",
		});
	}

	// ── speech 工具入口 ──────────────────────────────────────────────────

	/** speech.say：表达受理与实际交付分离（§5.1/§6.3）；同 invocationId 重入幂等。 */
	async say(
		text: string,
		replace: boolean,
		identity: { callId: string; invocationId?: string },
	): Promise<SayOutcome> {
		await this.preferencesReady;
		const normalized = normalizeSpokenText(text).trim();
		if (!normalized || !hasPronounceableContent(normalized)) {
			return { accepted: false, audio: "not_played", reason: "台词没有可朗读内容" };
		}
		if (identity.invocationId) {
			const existing = this.byInvocation.get(identity.invocationId);
			if (existing) {
				return {
					accepted: true,
					utteranceId: existing.utterance.id,
					audio: existing.audioAccepted ? "queued" : "not_played",
				};
			}
		}
		// replace：新文本已校验；先冻结旧集合并停止，未能确认安全停止时不受理新表达。
		if (replace) {
			const stopped = await this.stopAllAndStop();
			if (stopped.outcome === "unknown" || stopped.outcome === "failed") {
				return {
					accepted: false,
					audio: stopped.outcome === "unknown" ? "unknown" : "not_played",
					reason: `旧声音停止${stopped.outcome === "unknown" ? "结果未知" : "失败"}：${stopped.reason ?? "未取得停止确认"}；未受理新台词`,
				};
			}
		}
		let record = this.ensureRecord({
			kind: "tool",
			callId: identity.callId,
			...(identity.invocationId ? { invocationId: identity.invocationId } : {}),
		});
		if (record.cancelled || record.utterance.inputClosed) {
			// 被取消/已封闭的旧记录不可复用：同一 callId 的再次受理是一次新表达。
			this.records.delete(this.recordKeyOf(record.utterance.origin));
			record = this.ensureRecord({
				kind: "tool",
				callId: identity.callId,
				...(identity.invocationId ? { invocationId: identity.invocationId } : {}),
			});
		}
		record.utterance.text = normalized;
		// say 是一次性表达：受理即封口输入（提交后链内 seal），可参与完成结算。
		record.utterance.inputClosed = true;
		if (identity.invocationId) this.byInvocation.set(identity.invocationId, record);
		const generation = record.generation;
		let admission: AdmissionResult | undefined;
		record.chain = record.chain
			.then(async () => {
				if (record.generation !== generation) return;
				if (this.muted) {
					// 静音：文字仍受理，音频不进入交付路径。
					record.audioAccepted = false;
					return;
				}
				admission = await this.delivery.submitSegment(record.utterance.id, normalized);
				// 异步提交晚到即使返回 accepted，也不能绕过本地代次屏障继续记账；
				// 物理残留由链上随后的停止任务收束，受理事实保持未定。
				if (record.generation !== generation || record.cancelled) {
					admission = undefined;
					return;
				}
				if (admission.status === "accepted" || admission.status === "unknown") {
					record.audioAccepted = true;
					if (admission.traceId) record.traceId = admission.traceId;
					record.segmentSeq = 1;
					record.segmentTexts.set(1, normalized);
					record.utterance.state = "queued";
					const seal = await this.delivery.sealSource(record.utterance.id);
					if (seal.status === "unknown") {
						admission = { status: "unknown", reason: seal.reason ?? "提交已受理，但来源结束未确认" };
					}
				} else {
					record.audioAccepted = false;
				}
			})
			.catch(() => undefined);
		await record.chain;
		if (admission?.status === "unknown") {
			this.notifyOnce(record, "speech.delivery_unknown", () => ({
				identity: `speech:${record.utterance.id}:delivery_unknown`,
				text: `一次主动发言的音频交付结果未知：${admission?.reason ?? "未取得受理或停止确认"}。`,
			}));
			return { accepted: true, utteranceId: record.utterance.id, audio: "unknown" };
		}
		if (admission && admission.status !== "accepted") {
			if (identity.invocationId) this.byInvocation.delete(identity.invocationId);
			this.settle(record, admission.status === "cancelled" ? "stopped" : "not_played");
			return { accepted: false, audio: "not_played", reason: admission.reason ?? `音频未受理（${admission.status}）` };
		}
		if (admission === undefined && !this.muted) {
			// 提交前被代次屏障拦截（如同时收到停止）：受理事实保持诚实未知；
			// 幂等登记一并撤销（下次同身份调用按新表达受理，不冒充已受理）。
			if (identity.invocationId) this.byInvocation.delete(identity.invocationId);
			return { accepted: false, audio: "unknown", reason: "台词在提交前被取消" };
		}
		return {
			accepted: true,
			utteranceId: record.utterance.id,
			audio: this.muted || !record.audioAccepted ? "not_played" : "queued",
		};
	}

	/** speech.stop：冻结目标集合，取消本地待播并停止对应来源；不触碰无关音频。
	 * 对同一 Source 串行处理在途提交与停止：停止任务排在表达链上，天然等待
	 * 在途提交的有界结算（提交自带请求超时）之后再请求 Driver 停止。 */
	async stop(target?: string): Promise<StopOutcome> {
		await this.preferencesReady;
		const targets = this.resolveTargets(target);
		this.cancelRecords(targets, "speech.stop");
		await Promise.all(targets.map((record) => record.chain));
		return this.aggregateStopOutcomes(targets);
	}

	/** speech.set_muted：静音立即禁止后续提交并请求停止当前声音；偏好与物理停止分别报告。 */
	async setMuted(
		muted: boolean,
	): Promise<{ persisted: boolean; physical: StopResult["outcome"]; reason?: string; isOnline?: boolean }> {
		await this.preferencesReady;
		this.muted = muted;
		this.preferences = { muted };
		let persisted = true;
		try {
			await saveSpeechPreferences(this.pi, this.preferences);
		} catch {
			persisted = false; // 偏好落盘失败时工具不得声称"已持久化"
		}
		if (muted) {
			// 冻结目标集合：调用时已存在的 Speech 来源。
			const targets = [...this.records.values()];
			this.cancelRecords(targets, "set_muted");
			const physical = await this.enqueueControl(async () => {
				const result = await this.delivery.setMuted(true);
				return {
					physical: (result.status === "unknown" ? "unknown" : result.status === "failed" ? "failed" : "interrupted") as StopResult["outcome"],
					...(result.reason ? { reason: result.reason } : {}),
					...(result.isOnline !== undefined ? { isOnline: result.isOnline } : {}),
				};
			});
			return { persisted, ...physical };
		}
		const physical = await this.enqueueControl(async () => {
			const result = await this.delivery.setMuted(false);
			return {
				physical: "no_op" as const,
				...(result.reason ? { reason: result.reason } : {}),
				...(result.isOnline !== undefined ? { isOnline: result.isOnline } : {}),
			};
		});
		return { persisted, ...physical };
	}

	// ── 状态读取（纯读） ─────────────────────────────────────────────────

	/** 当前实际正在播放的分句文本；无可信当前播放句时返回 null。 */
	currentSpeakingLine(): string | null {
		for (const record of this.records.values()) {
			const started = record.lastStarted;
			if (!started) continue;
			if (record.cancelled || record.utterance.state === "settled") continue;
			if (Date.now() - started.at > PLAYBACK_FRESH_MS) continue;
			const line = record.segmentTexts.get(started.index);
			if (!line) continue;
			return line;
		}
		return null;
	}

	/** 当前输出可用性、静音与交付未知事实（status 工具的正文来源）。 */
	async status(): Promise<{
		muted: boolean;
		hasDriver: boolean;
		online?: boolean;
		stopUnconfirmed?: boolean;
		pendingSegments?: number;
		currentLine: string | null;
		activeUtterances: number;
	}> {
		await this.preferencesReady;
		const view = await this.delivery.snapshot().catch(() => undefined);
		return {
			muted: this.muted,
			hasDriver: this.hasDriver,
			...(view ? { online: view.online, ...(view.stopUnconfirmed ? { stopUnconfirmed: true } : {}) } : {}),
			...(view && view.pendingSegments > 0 ? { pendingSegments: view.pendingSegments } : {}),
			currentLine: this.currentSpeakingLine(),
			activeUtterances: [...this.records.values()].filter(
				(record) => !record.utterance.inputClosed || record.utterance.state !== "settled",
			).length,
		};
	}

	/** Capability Source 的只读事实：静音/离线/降级时的短句；正常可用返回 null。 */
	async capabilityLine(): Promise<string | null> {
		await this.preferencesReady;
		if (this.muted) return "声音已按用户偏好静音；Speech 文字仍会显示，解除静音前不会播出新内容。";
		const view = await this.delivery.snapshot().catch(() => undefined);
		if (!view || !view.online) return "语音暂不可播放（发声服务未连接）；Speech 文字仍会显示。";
		if (view.stopUnconfirmed || (view.unknownSegments ?? 0) > 0) {
			return "上一次发声的停止或播放结果尚未确认；确认前新的语音提交会被阻断。";
		}
		return null;
	}

	// ── 内部机制 ─────────────────────────────────────────────────────────

	private findByUtteranceId(utteranceId: string): UtteranceRecord | undefined {
		for (const record of this.records.values()) {
			if (record.utterance.id === utteranceId) return record;
		}
		return undefined;
	}

	private recordKeyOf(origin: UtteranceOrigin): string {
		return origin.kind === "model_output" ? `model:${origin.streamId}:${origin.blockId}` : `tool:${origin.callId}`;
	}

	private ensureRecord(origin: UtteranceOrigin): UtteranceRecord {
		const key = this.recordKeyOf(origin);
		const existing = this.records.get(key);
		if (existing) return existing;
		this.pruneSettled();
		const record: UtteranceRecord = {
			utterance: {
				id: randomUUID(),
				origin,
				text: "",
				inputClosed: false,
				state: "created",
			},
			segmenter: new SpeechSegmenter(),
			chain: Promise.resolve(),
			generation: 0,
			cancelled: false,
			segmentSeq: 0,
			segmentTexts: new Map(),
			completedSegments: new Set(),
			sealed: false,
			cueSeq: 0,
			pendingCues: [],
			trailingCues: [],
			segmentCues: new Map(),
			audioAccepted: false,
			triggeredCues: new Set(),
			textPathStarted: false,
			lastStarted: null,
			notifiedTerminal: new Set(),
		};
		this.records.set(key, record);
		return record;
	}

	private pruneSettled(): void {
		for (const [key, record] of this.records) {
			if (
				record.utterance.state === "settled" &&
				record.utterance.settlement !== "unknown" &&
				record.pendingCues.length === 0 &&
				record.trailingCues.length === 0
			) {
				this.records.delete(key);
			}
		}
	}

	/** 分句结果 → 同步入队提交任务（不等待网络）。片段序号在链内按提交顺序确定，
	 * 不受入队时序影响。静音时不摘 Cue（它们顺延到下一段或表达结尾）。 */
	private emitSegment(record: UtteranceRecord, raw: string): void {
		const spoken = normalizeSpokenText(raw);
		if (!spoken || !hasPronounceableContent(spoken)) return; // 不可发音片段不提交；起始 Cue 顺延
		if (this.muted) return; // 静音：文字仍受理，音频不进入交付路径；Cue 留给文本降级
		const cues = record.pendingCues.splice(0);
		const generation = record.generation;
		record.chain = record.chain
			.then(async () => {
				// 代次屏障：醒来发现已取消/换代即放弃，不得继续提交。
				if (record.generation !== generation || record.cancelled) return;
				if (this.muted) {
					// 提交在途时被静音：已摘的起始 Cue 还回队首，交给下一段或文本降级。
					record.pendingCues.unshift(...cues);
					return;
				}
				const index = record.segmentSeq + 1;
				const admission = await this.delivery.submitSegment(record.utterance.id, spoken);
				// 异步提交晚到即使返回 accepted，也不能绕过本地代次屏障继续记账旧队列；
				// 物理残留由链上随后的停止任务收束。
				if (record.generation !== generation || record.cancelled) return;
				if (admission.status === "accepted" || admission.status === "unknown") {
					record.audioAccepted = true;
					if (admission.traceId) record.traceId = admission.traceId;
					record.segmentSeq = Math.max(record.segmentSeq, index);
					record.segmentTexts.set(index, spoken);
					if (cues.length > 0) record.segmentCues.set(index, cues);
					record.utterance.state = "queued";
				}
			})
			.catch(() => undefined);
	}

	/** 封口：Cue 归置、来源封口与文本降级判定（在链内执行）。 */
	private async finalizeUtterance(record: UtteranceRecord): Promise<void> {
		// 剩余 pendingCue：没有后续可发音片段 → trailing（前段播完后执行）。
		record.trailingCues.push(...record.pendingCues.splice(0));
		if (record.traceId !== undefined && record.audioAccepted) {
			const seal = await this.delivery.sealSource(record.utterance.id);
			if (seal.status === "sealed") {
				record.sealed = true;
			} else if (seal.status === "unknown") {
				this.notifyOnce(record, "speech.delivery_unknown", () => ({
					identity: `speech:${record.utterance.id}:seal_unknown`,
					text: `一次发言的结束确认未返回：${seal.reason ?? "来源封口结果未知"}；这段音频是否完整播放暂无法确认。`,
				}));
				// 封口未确认 = 无法宣称完成；按事实落未知终局。
				this.settle(record, "unknown");
				return;
			}
			// not_started：远端没有该来源或驱动未挂载，无可封口的远端事实。
			this.settleIfDelivered(record);
		}
		// 文本降级判定：确认整次表达没有音频进入播放路径（静音、离线、全部明确拒绝、纯 Cue），
		// 且 Block 正常闭合，才按原文顺序执行未触发 Cue。
		if (!record.audioAccepted && !record.textPathStarted && !record.cancelled) {
			this.startTextPath(record);
			// 无音频进入交付路径的表达在 Cue 执行后即为终局（not_played）。
			this.settle(record, "not_played");
		}
	}

	/** 交付完成的结算条件（全部满足才 settle completed）：
	 * 输入已封口、封口已被远端确认、所有已受理片段都收到播放终局 completed。 */
	private settleIfDelivered(record: UtteranceRecord): void {
		if (record.utterance.state === "settled") return;
		if (!record.utterance.inputClosed || !record.audioAccepted) return;
		if (!record.sealed) return;
		if (record.segmentSeq === 0) return;
		for (let index = 1; index <= record.segmentSeq; index++) {
			if (!record.completedSegments.has(index)) return;
		}
		for (const cue of record.trailingCues) this.executeCue(record, cue);
		this.settle(record, "completed");
	}

	/** 同步取消纪律（§5.3 执行纪律 1）：标记、递增代次、清除尚未交给 Driver 的内容；
	 * 此后旧队列任务即使醒来也必须检查代次。上述动作不等待 Bridge。停止任务排在
	 * 该来源的表达链上：先等在途提交结算，再请求 Driver 停止并如实记账。 */
	private cancelRecords(
		targets: readonly UtteranceRecord[],
		cause: "output_interrupted" | "turn_aborted" | "speech.stop" | "speech.say replace" | "set_muted",
	): void {
		for (const record of targets) {
			record.cancelled = true;
			record.generation++;
			record.utterance.inputClosed = true;
			record.segmenter.reset();
			record.pendingCues = []; // 取消未提交 Cue（中断路径不补执行）
			const hadAudio = record.audioAccepted || record.traceId !== undefined;
			record.chain = record.chain
				.then(async () => {
					if (record.traceId === undefined) {
						record.stopOutcome = { outcome: "no_op" };
						if (!hadAudio) this.settle(record, "not_played");
						return;
					}
					const stopped = await this.delivery.stopSource(record.utterance.id);
					record.stopOutcome = {
						outcome: stopped.outcome,
						...(stopped.reason ? { reason: stopped.reason } : {}),
						...(stopped.segmentIndex !== undefined ? { segmentIndex: stopped.segmentIndex } : {}),
						...(stopped.segmentText ? { segmentText: stopped.segmentText } : {}),
					};
					if (stopped.outcome === "interrupted" || stopped.outcome === "no_op") {
						this.settle(record, "stopped");
					} else {
						this.settle(record, stopped.outcome === "failed" ? "failed" : "unknown");
						if (stopped.outcome === "unknown") {
							this.notifyOnce(record, "speech.delivery_unknown", () => ({
								identity: `speech:${record.utterance.id}:stop_unknown`,
								text: `一次进行中的发言被请求停止，但停止结果未知：${stopped.reason ?? "未取得确认"}；Driver 的交付屏障会阻止后续提交。`,
							}));
						}
					}
				})
				.catch(() => undefined);
			// 非预期中断且音频已受理：一次事实通知（§7.3.3）；主动工具调用的结果由回执说明。
			if (cause === "output_interrupted" || cause === "turn_aborted") {
				const tail = record.utterance.text.slice(-40);
				this.notifyOnce(record, "speech.interrupted", () => ({
					identity: `speech:${record.utterance.id}:interrupted`,
					text: `上一段发言在生成被打断时未能完整交付；结尾停在「…${tail}」，未提交的部分已确认取消。`,
				}));
			}
		}
	}

	private resolveTargets(target?: string): UtteranceRecord[] {
		if (target === undefined) return [...this.records.values()];
		const byId = this.findByUtteranceId(target);
		return byId ? [byId] : [];
	}

	private enqueueControl<T>(task: () => Promise<T>): Promise<T> {
		const next = this.controlTail.then(task, task);
		this.controlTail = next.catch(() => undefined);
		return next;
	}

	/** 聚合各来源的停止事实：unknown/failed 优先，其次 confirmed 断点。 */
	private aggregateStopOutcomes(targets: readonly UtteranceRecord[]): StopOutcome {
		let outcome: StopResult["outcome"] = "no_op";
		let reason: string | undefined;
		let segmentIndex: number | undefined;
		let segmentText: string | undefined;
		for (const record of targets) {
			const stopped = record.stopOutcome;
			if (!stopped) continue;
			if (stopped.outcome === "unknown" || stopped.outcome === "failed") {
				outcome = stopped.outcome;
				reason = stopped.reason;
				continue;
			}
			if (outcome === "no_op" || (outcome === "interrupted" && stopped.outcome === "interrupted")) {
				if (stopped.outcome === "interrupted") outcome = "interrupted";
				if (stopped.segmentIndex !== undefined && segmentIndex === undefined) {
					segmentIndex = stopped.segmentIndex;
					segmentText = stopped.segmentText;
				}
			}
		}
		return {
			outcome,
			...(reason ? { reason } : {}),
			...(segmentIndex !== undefined ? { segmentIndex } : {}),
			...(segmentText ? { segmentText } : {}),
		};
	}

	/** replace 的旧集合停止：先同步取消，再等表达链上的停止结算。 */
	private async stopAllAndStop(): Promise<StopOutcome> {
		const targets = [...this.records.values()];
		this.cancelRecords(targets, "speech.say replace");
		await Promise.all(targets.map((record) => record.chain));
		return this.aggregateStopOutcomes(targets);
	}

	/** 文本降级路径：按原文顺序执行未触发 Cue；启动后不再转回音频路径、不重新提交旧台词。 */
	private startTextPath(record: UtteranceRecord): void {
		record.textPathStarted = true;
		for (const cue of [...record.pendingCues.splice(0), ...record.trailingCues.splice(0)]) {
			this.executeCue(record, cue);
		}
	}

	private executeCue(record: UtteranceRecord, cue: SpeechCue): void {
		if (record.triggeredCues.has(cue.seq)) return; // 同一身份至多执行一次
		record.triggeredCues.add(cue.seq);
		const dispatcher = this.cueDispatcher();
		if (!dispatcher) return;
		try {
			dispatcher.dispatch({ id: cue.id, ...(cue.target ? { target: cue.target } : {}) });
		} catch {
			// 派发失败按未送达处理；可见性由具身扩展的未处理线索报告负责。
		}
	}

	private cueDispatcher(): { dispatch: (cue: { id: string; target?: string }) => void } | undefined {
		if (typeof this.pi.shared !== "function") return undefined;
		return this.pi.shared(CUE_DISPATCH_SHARED) as { dispatch: (cue: { id: string; target?: string }) => void } | undefined;
	}

	private settle(record: UtteranceRecord, settlement: Utterance["settlement"]): void {
		if (record.utterance.state === "settled") return;
		record.utterance.state = "settled";
		record.utterance.settlement = settlement;
	}

	private notifyOnce(
		record: UtteranceRecord,
		type: SpeechRuntimeNotice["type"],
		build: () => { identity: string; text: string },
	): void {
		if (record.notifiedTerminal.has(type)) return;
		record.notifiedTerminal.add(type);
		const { identity, text } = build();
		this.notify({ type, identity, text });
	}
}
