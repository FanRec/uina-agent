import type { DeliverySnapshot, InterruptResult, PlaybackBreakpoint, VoiceOutputDriver } from "../voice/driver.js";
import { TtsSpeakError, type TtsBridgeClient } from "./client.js";
import { summarizeProgress } from "./delivery.js";
import { stripParentheticals } from "./stream-parser.js";

/** 快照里去掉意志与连接态：那两个事实的拥有者是 `_muted` / `_isOnline` 本身，不存副本。 */
type DeliveryFacts = Omit<DeliverySnapshot, "online" | "muted">;

const EMPTY_FACTS: DeliveryFacts = {
	submittedSegments: 0,
	spokenSegments: 0,
	pendingSegments: 0,
	currentSegmentIndex: null,
};

/**
 * TTS 侧发声驱动。
 *
 * 两条账各归其主：`submitted` 与 `segmentTexts` 是作者侧记账（谁提交谁记），
 * 桥侧只回答"播到哪了"。快照是两者的合并结果，`probe()` 是唯一的 IO 读点。
 *
 * 轮次交接不是"清零"，而是"开新账期"：上一轮的音频可能还在响，
 * 新轮第一次提交时才切换账期，这样新一轮开头仍能读到上一轮的真实交付状态。
 */
export class TtsVoiceOutputDriver implements VoiceOutputDriver {
	private readonly client: TtsBridgeClient;
	private _muted = false;
	private _isOnline = true;
	private activeTrace: string | null = null;
	/** 尚有音频在路上的 trace（跨轮次存活，直到被本轮提交顶替） */
	private deliveryTrace: string | null = null;
	private deliveryRevision = 0;
	private probeInFlight: Promise<void> | null = null;
	private epochDirty = false;
	private epoch: string | undefined;
	private submitted = 0;
	private readonly segmentTexts = new Map<number, string>();
	/** 桥侧物理事实（不含意志与连接态） */
	private facts: DeliveryFacts = EMPTY_FACTS;
	/** 桥侧说它正在出声 —— 队列算术说不出的"在途尾巴" */
	private speaking = false;
	private readonly invocationResults = new Map<string, { status: string; task_id?: string }>();
	private manualTraceSeq = 0;
	private restartBridge?: () => Promise<Record<string, unknown>>;
	private bridgeOwnership: "owned" | "external" | "unknown" = "unknown";
	/** 确定性失败的来源封闭：只拒绝同一 trace 的后续句子，不扩大到新来源（§8.4）。 */
	private poisonedTrace: string | null = null;
	/** 未确认缺口的全局屏障：只有 interrupt 确认停止、epoch reset 或受管重启能解除（§10.2）。 */
	private deliveryBarrier = false;

	constructor(client: TtsBridgeClient) {
		this.client = client;
	}

	setRestartBridge(handler: () => Promise<Record<string, unknown>>): void {
		this.restartBridge = handler;
	}

	setBridgeOwnership(ownership: "owned" | "external" | "unknown"): void {
		this.bridgeOwnership = ownership;
	}

	get isMuted(): boolean {
		return this._muted;
	}

	get isOnline(): boolean {
		return this._isOnline;
	}

	get currentTraceId(): string | null {
		return this.activeTrace;
	}

	get currentSubmittedSegments(): number {
		return this.activeTrace === this.deliveryTrace ? this.submitted : 0;
	}

	get deliveryTraceId(): string | null {
		return this.deliveryTrace;
	}

	/** 是否还有交付未收束 —— 进度探测的存续条件。 */
	get isDelivering(): boolean {
		return this.speaking || this.facts.pendingSegments > 0;
	}

	setOnline(online: boolean): void {
		this._isOnline = online;
	}

	startTurn(turnNumber: number): string {
		this.activeTrace = `turn_${turnNumber}_${Date.now()}`;
		this.deliveryRevision++;
		// 刻意不清账：上一轮可能还在念。账期切换推迟到本轮首次提交。
		this.epochDirty = true;
		return this.activeTrace;
	}

	/**
	 * 提交一句并落账。调用方负责把投递失败翻译成静音降级。
	 */
	async submitSegment(
		text: string,
		invocationId?: string,
		metadata?: Record<string, unknown>,
	): Promise<{ status: string; task_id?: string; reason?: string }> {
		const traceId = this.activeTrace;
		if (this.deliveryBarrier)
			return {
				status: "unknown",
				task_id: `${traceId ?? "none"}:barrier`,
				reason: "存在未确认的交付缺口，新来源不能越过屏障播放",
			};
		if (traceId !== null && this.poisonedTrace === traceId)
			return { status: "rejected", task_id: `${traceId}:poisoned`, reason: "当前来源已被失败封闭，后续句子不再朗读" };
		if (invocationId) {
			const previous = this.invocationResults.get(invocationId);
			if (previous) return previous;
		}
		if (!traceId) {
			return { status: "skipped", task_id: undefined };
		}

		this.rotateEpochIfDirty(traceId);
		const index = ++this.submitted;
		this.segmentTexts.set(index, text);

		// 提交即视为"在途"：桥侧还没回话之前，队列里已经有它了。
		this.facts = {
			...this.facts,
			submittedSegments: this.submitted,
			pendingSegments: this.facts.pendingSegments + 1,
		};

		const rollbackRejected = (): { status: string; task_id: string } => {
			// A late response belongs to its captured trace, never to a newer delivery ledger.
			if (this.deliveryTrace !== traceId) return { status: "rejected", task_id: `${traceId}:${index}` };
			// 明确 HTTP/业务拒绝：回滚作者侧 pending 与文本账，避免状态栏永久卡在“待播”。
			this.segmentTexts.delete(index);
			this.submitted = Math.max(0, this.submitted - 1);
			this.facts = {
				...this.facts,
				submittedSegments: this.submitted,
				pendingSegments: Math.max(0, this.facts.pendingSegments - 1),
				currentSegmentIndex: null,
				currentSegmentText: undefined,
			};
			this.deliveryRevision++;
			return { status: "rejected", task_id: `${traceId}:${index}` };
		};

		try {
			const result = await this.client.speak({
				trace_id: traceId,
				segment_id: `${traceId}:${index}`,
				index,
				text,
				invocation_id: invocationId,
				metadata,
				source_id: traceId,
				epoch: this.epoch,
			});
			if (["failed", "rejected"].includes(result.status)) {
				// 确定性失败：只 poison 本来源，后续独立来源可按顺序继续（§8.4）。
				if (this.activeTrace === traceId) this.poisonedTrace = traceId;
				const rejected = rollbackRejected();
				if (invocationId) this.invocationResults.set(invocationId, rejected);
				return rejected;
			}
			if (invocationId) this.invocationResults.set(invocationId, result);
			return result;
		} catch (error) {
			if (!(error instanceof TtsSpeakError) || error.kind === "unknown") {
				// 网络结果未知：保留 pending，在后续 probe 中等待物理事实；
				// 全局屏障直到 interrupt 确认停止、epoch reset 或受管重启才解除（§10.2）。
				this.deliveryBarrier = true;
				const uncertain = {
					status: "uncertain",
					task_id: `${traceId}:${index}`,
					reason: "提交结果未知，新来源不能越过缺口",
				};
				if (invocationId) this.invocationResults.set(invocationId, uncertain);
				return uncertain;
			}
			if (this.activeTrace === traceId) this.poisonedTrace = traceId;
			return rollbackRejected();
		}
	}

	/**
	 * 唯一 IO 读点：把桥侧物理事实收回快照。
	 * 探测失败时保留上一份已观测事实（陈旧但真实），不臆造"已停"或"已播完"。
	 */
	async probe(): Promise<void> {
		if (this.probeInFlight) return this.probeInFlight;
		const task = this.probeOnce();
		this.probeInFlight = task;
		try {
			await task;
		} finally {
			if (this.probeInFlight === task) this.probeInFlight = null;
		}
	}

	private async probeOnce(): Promise<void> {
		const trace = this.deliveryTrace;
		if (!this._isOnline || !trace) return;
		const revision = this.deliveryRevision;

		const state = await this.client.getSubtitleState(trace);
		if (!state) return;
		if (revision !== this.deliveryRevision || trace !== this.deliveryTrace) return;

		// 归纳结果是**完整**的事实集（含作者侧句数），直接替换；
		// 片段式合并才是那个让人漏字段的写法。
		const { speaking, ...facts } = summarizeProgress(state, this.submitted, this.segmentTexts);
		this.speaking = speaking;
		this.facts = facts;
	}

	snapshot(): DeliverySnapshot {
		return { online: this._isOnline, muted: this._muted, ...this.facts };
	}

	async setMuted(muted: boolean): Promise<{ success: boolean; isOnline?: boolean; reason?: string }> {
		if (!muted) {
			// unmute 顺带探活：不可用是连接事实，不能写进静音意志（§4.3）。
			const readiness = await this.client.compatibility();
			if (!readiness.compatible) {
				this._isOnline = false;
				return {
					success: false,
					isOnline: false,
					reason: readiness.reachable
						? `伴生服务协议不兼容：${readiness.reason ?? "能力握手失败"}`
						: "伴生服务未连接（端口 8102 无响应）",
				};
			}
			this._isOnline = true;
			this._muted = false;
			return { success: true, isOnline: true };
		}

		this._muted = true;
		return { success: true, isOnline: this._isOnline };
	}

	async interrupt(expectedTraceId?: string): Promise<InterruptResult> {
		// expectedTraceId 的语义是物理播放身份，不是当前正在生成文本的 activeTrace。
		const currentPlaybackTarget = this.deliveryTrace ?? this.activeTrace;
		if (expectedTraceId && currentPlaybackTarget !== expectedTraceId) {
			return { outcome: "no_op", breakpoint: null, reason: "目标播放轮次已不是当前交付轮次" };
		}

		const traceToCancel = expectedTraceId ?? this.deliveryTrace ?? this.activeTrace;
		if (!traceToCancel) {
			return { outcome: "no_op", breakpoint: null, reason: "当前没有可打断的语音" };
		}
		this.deliveryRevision++;

		try {
			const cancellation = await this.client.cancelTrace(traceToCancel, "immediate");
			if (cancellation.status !== "cancelled") {
				return { outcome: "failed", breakpoint: null, reason: `Bridge 拒绝打断: ${cancellation.status}` };
			}
			if (cancellation.playback_stopped === false) {
				if (cancellation.cancelled_task_count === 0) {
					return { outcome: "no_op", breakpoint: null, reason: "当前没有可打断的语音" };
				}
				// 任务已取消但声卡停止未确认：不能把受理当作停止（§10.1）。
				return { outcome: "unknown", breakpoint: null, reason: "任务已取消，但声卡停止未获确认" };
			}
			const state = await this.client.getSubtitleState(traceToCancel);
			if (!state && cancellation.playback_stopped) {
				return { outcome: "unknown", breakpoint: null, reason: "声卡停止已请求，但无法读取播放断点" };
			}

			const interrupted = this.resolveBreakpoint(traceToCancel, state);
			// 掐断即清空在途：队列事实归零，但要如实标明这次是"被打断"而不是"播完"。
			// 桥确认了停止：本来源封闭、屏障解除，新来源可以从干净状态开始（§10.2 路径1）。
			this.speaking = false;
			this.poisonedTrace = null;
			this.deliveryBarrier = false;
			this.facts = {
				...this.facts,
				pendingSegments: 0,
				currentSegmentIndex: null,
				currentSegmentText: undefined,
				committedCharEnd: interrupted?.committedCharEnd,
			};
			return { outcome: "interrupted", breakpoint: interrupted };
		} catch (error) {
			return {
				outcome: "unknown",
				breakpoint: null,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async speak(
		text: string,
		invocationId?: string,
		replace = false,
	): Promise<{ status: string; task_id?: string; reason?: string }> {
		// 直发路径不经 StreamParser 状态机，全角括注在此剥离（与流式路径同一裁定）
		const normalized = stripParentheticals(text).trim();
		if (!normalized) return { status: "rejected", reason: "台词为空" };
		// 幂等性必须包住 replace：同一调用的重试不得先打断已经存在的声音。
		if (invocationId) {
			const previous = this.invocationResults.get(invocationId);
			if (previous) return previous;
		}
		if (this._muted) return { status: "rejected", reason: "当前已静音" };
		if (!this._isOnline) return { status: "unknown", reason: "发声驱动离线" };
		if (replace) {
			const interrupted = await this.interrupt();
			if (interrupted.outcome === "unknown") return { status: "unknown", reason: interrupted.reason };
			if (interrupted.outcome === "failed") return { status: "failed", reason: interrupted.reason };
		}
		if (!this.activeTrace) this.startTurn(++this.manualTraceSeq);
		return await this.submitSegment(normalized, invocationId);
	}

	/**
	 * 自动恢复探测（turn_start 触发，fire-and-forget）。
	 *
	 * 缺口：一次瞬时网络抖动会置 deliveryBarrier + offline，而全部自动路径
	 * （ensureProgressPolling / probeOnce）都被 offline 短路——没有人工干预 TTS 永久哑。
	 * 修复语义：桥可达 = 连接事实恢复（§4.3：online 是连接事实，不是用户偏好）；
	 * 存在交付缺口时以受管 reset 换新账期收束（§10.2 路径2）——旧 trace 的不确定性
	 * 由 epoch 屏障隔离，新账期从干净状态开始。与手动 recover 的差别只在触发时机。
	 */
	async attemptAutoRecovery(): Promise<void> {
		if (this._isOnline && !this.deliveryBarrier) return;
		try {
			const health = await this.client.health();
			if (!health) return; // 桥不可达：这一拍没有新事实，下回合再试
			if (this.deliveryBarrier) {
				await this.recover("reset");
			} else {
				this._isOnline = true;
			}
		} catch {
			// 探测失败即这一拍没有新事实
		}
	}

	async inspect(): Promise<Record<string, unknown>> {
		const [health, compatibility] = await Promise.all([this.client.health(), this.client.compatibility()]);
		if (!health) {
			return {
				status: "unknown",
				reachable: false,
				ownership: { bridge: this.bridgeOwnership, vendor: "unknown" },
				reason: "Bridge health 不可达",
			};
		}
		return {
			status: compatibility.compatible ? "observed" : "unknown",
			reachable: true,
			compatible: compatibility.compatible,
			missingPaths: compatibility.missingPaths,
			ownership: { bridge: this.bridgeOwnership, vendor: health.vendor_ownership ?? "unknown" },
			health,
			...(compatibility.compatible ? {} : { reason: compatibility.reason ?? "Bridge 协议不兼容" }),
		};
	}

	async recover(
		operation: "reconnect" | "reset" | "restart",
		invocationId?: string,
		target?: "bridge" | "vendor",
	): Promise<Record<string, unknown>> {
		const sessionId = this.deliveryTrace ?? this.activeTrace ?? "uina-default";
		try {
			if (operation === "reconnect") {
				const result = await this.client.reconnect(sessionId);
				if (typeof result.epoch === "string") this.epoch = result.epoch;
				// 重连成功即恢复连接事实：离线降级由此解除，无需用户重新 unmute（§7.3）。
				this._isOnline = true;
				return { operation, ...result };
			}
			if (operation === "restart") {
				if (target === "vendor") return { operation, target, ...(await this.client.restartVendor()) };
				if (!this.restartBridge) {
					const ownership = this.bridgeOwnership;
					return {
						operation,
						target,
						status: "not_started",
						ownership,
						reason:
							ownership === "external" ? "Bridge 不是当前扩展明确拥有的进程" : "Bridge 所有权未确认，不能尝试重启",
					};
				}
				const restarted = await this.restartBridge();
				if (restarted.status !== "succeeded") {
					this.epochDirty = true;
					return { operation, target, ...restarted };
				}
				// Bridge 进程重建后，旧 session/epoch 不能直接复用；先重新协商，
				// 再允许下一次提交跨过新 epoch 屏障。
				const reconnected = await this.client.reconnect(sessionId);
				if (reconnected.status !== "reconnected" || typeof reconnected.epoch !== "string") {
					this.epochDirty = true;
					return {
						operation,
						target,
						status: "unknown",
						restart: restarted,
						reconnect: reconnected,
						reason: "Bridge 已重启，但新 epoch 未确认",
					};
				}
				this.epoch = reconnected.epoch;
				this.epochDirty = true;
				this.poisonedTrace = null;
				this.deliveryBarrier = false;
				this._isOnline = true;
				return { operation, target, ...restarted, reconnect: reconnected };
			}
			const result = await this.client.reset(sessionId, this.epoch, undefined, invocationId);
			if (result.status === "unknown" || result.status === "failed") this.epochDirty = true;
			if (typeof result.epoch === "string" && result.status === "reset") {
				this.epoch = result.epoch;
				this.poisonedTrace = null;
				// epoch reset 是 unknown 屏障的解除路径之一（§10.2 路径2）。
				this.deliveryBarrier = false;
				this._isOnline = true;
			}
			return { operation, ...result };
		} catch (error) {
			if (operation === "restart") this.epochDirty = true;
			return { operation, status: "unknown", reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async test(scope: "synthesis" | "playback"): Promise<Record<string, unknown>> {
		if (scope === "playback" && this._muted)
			return { scope, status: "not_started", reason: "当前已静音；不会自动解除静音执行播放测试" };
		try {
			return { scope, ...(await this.client.test(scope, this.deliveryTrace ?? this.activeTrace ?? "uina-default")) };
		} catch (error) {
			return { scope, status: "unknown", reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 从字幕状态里认出"停在哪一句的哪个字"，并把作者侧文本补回去。 */
	private resolveBreakpoint(
		traceId: string,
		state: Awaited<ReturnType<TtsBridgeClient["getSubtitleState"]>>,
	): PlaybackBreakpoint | null {
		const segments = state?.segments ?? [];
		if (segments.length === 0) return null;

		const activeSeg =
			segments.find((s) => s.playback_started === true && s.playback_completed !== true) ??
			[...segments].reverse().find((s) => (s.revealed_text?.length ?? 0) > 0);

		if (!activeSeg) return null;

		const index = activeSeg.segment_index ?? 0;
		const committed = activeSeg.revealed_count ?? activeSeg.revealed_text?.length ?? 0;
		const segmentText = this.segmentTexts.get(index);

		return {
			traceId,
			segmentIndex: index,
			committedCharEnd: committed,
			...(segmentText !== undefined ? { segmentText } : {}),
		};
	}

	/** 新账期：把作者侧计数与在途队列交给本轮。 */
	private rotateEpochIfDirty(traceId: string): void {
		if (!this.epochDirty) {
			this.deliveryTrace = traceId;
			return;
		}
		this.epochDirty = false;
		this.submitted = 0;
		this.segmentTexts.clear();
		this.deliveryTrace = traceId;
		this.speaking = false;
		this.facts = EMPTY_FACTS;
	}
}
