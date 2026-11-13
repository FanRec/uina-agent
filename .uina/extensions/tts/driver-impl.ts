import { randomUUID } from "node:crypto";
import type { DeliverySnapshot, InterruptResult, PlaybackBreakpoint, PlaybackFact } from "./delivery-facts.js";
import { TtsSpeakError, type PlaybackEvent, type TtsBridgeClient } from "./client.js";

type Outcome = { status: string; task_id?: string; reason?: string };
type Segment = { text: string; state: string; revealed?: number; uncertain?: boolean };
type Source = {
	id: string;
	seq: number;
	nextIndex: number;
	closed: boolean;
	sealed: boolean;
	cancelled: boolean;
	stopUnconfirmed?: boolean;
	sealUnconfirmed?: boolean;
	generation?: number;
	segments: Map<number, Segment>;
};
const TERMINAL = new Set(["completed", "failed", "cancelled", "obsolete", "rejected"]);

/** Submission identities and receipts belong here; playback belongs to the Bridge. */
export class TtsVoiceOutputDriver {
	readonly sessionId = "voice-" + randomUUID();
	private _muted = false;
	private _isOnline = true;
	private activeTrace: string | null = null;
	private sourceSeq = 0;
	private epoch?: string;
	private readonly sources = new Map<string, Source>();
	private readonly invocationResults = new Map<string, Outcome>();
	private readonly barrierKinds = new Set<"admission" | "seal" | "stop">();
	private get deliveryBarrier(): boolean {
		return this.barrierKinds.size > 0;
	}
	private maintenance = false;
	private probeInFlight?: Promise<void>;
	private restartBridge?: (signal?: AbortSignal, timeoutMs?: number) => Promise<Record<string, unknown>>;
	private reconnectFeed?: (signal?: AbortSignal) => Promise<boolean>;
	private bridgeOwnership: "owned" | "external" | "unknown" = "unknown";
	private observedAt?: number;
	private lastError?: { stage: string; reason: string; observedAt: number };
	private admissionTail: Promise<void> = Promise.resolve();
	/** 播放事实观察者（Speech 交付簿记的唯一物理事实来源）。 */
	private onPlaybackFact?: (fact: PlaybackFact) => void;

	constructor(
		private readonly client: TtsBridgeClient,
		private readonly longTimeoutMs = 120_000,
	) {}
	setRestartBridge(handler: NonNullable<TtsVoiceOutputDriver["restartBridge"]>): void {
		this.restartBridge = handler;
	}
	setReconnectFeed(handler: (signal?: AbortSignal) => Promise<boolean>): void {
		this.reconnectFeed = handler;
	}
	setBridgeOwnership(value: "owned" | "external" | "unknown"): void {
		this.bridgeOwnership = value;
	}
	setPlaybackObserver(handler: (fact: PlaybackFact) => void): void {
		this.onPlaybackFact = handler;
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
	ownsSource(traceId: string): boolean {
		return this.sources.has(traceId);
	}
	/** 来源是否已终结且不再用于停止/对账（utteranceId↔trace 双向关联可回收）。 */
	isSourceRetired(traceId: string): boolean {
		const source = this.sources.get(traceId);
		if (!source) return true;
		return (
			source.closed &&
			!source.stopUnconfirmed &&
			!source.sealUnconfirmed &&
			[...source.segments.values()].every((segment) => TERMINAL.has(segment.state))
		);
	}
	acceptsSource(traceId: string): boolean {
		return this.sources.get(traceId)?.closed === false;
	}
	get currentSubmittedSegments(): number {
		return this.activeTrace ? (this.sources.get(this.activeTrace)?.segments.size ?? 0) : 0;
	}
	submittedSegments(traceId: string): number {
		return this.sources.get(traceId)?.segments.size ?? 0;
	}
	get deliveryTraceId(): string | null {
		return (
			[...this.sources.values()].find((s) => [...s.segments.values()].some((v) => !TERMINAL.has(v.state)))?.id ??
			this.activeTrace
		);
	}
	get isDelivering(): boolean {
		return this.snapshot().pendingSegments > 0 || this.deliveryBarrier;
	}
	setOnline(value: boolean): void {
		this._isOnline = value;
	}
	private newSource(): Source {
		this.pruneSources();
		const seq = ++this.sourceSeq;
		const source: Source = {
			id: this.sessionId + ":source-" + seq,
			seq,
			nextIndex: 1,
			closed: false,
			sealed: false,
			cancelled: false,
			segments: new Map(),
		};
		this.sources.set(source.id, source);
		return source;
	}
	private pruneSources(): void {
		const latest = [...this.sources.values()].filter((source) => source.segments.size).at(-1)?.id;
		for (const [id, source] of this.sources) {
			if (
				id !== latest &&
				id !== this.activeTrace &&
				!source.stopUnconfirmed &&
				!source.sealUnconfirmed &&
				source.closed &&
				[...source.segments.values()].every((segment) => TERMINAL.has(segment.state))
			)
				this.sources.delete(id);
		}
	}
	beginSource(_streamId?: string): string {
		this.activeTrace = this.newSource().id;
		return this.activeTrace;
	}
	/**
	 * 封口来源。返回值是动作事实：只有远端 turn-end 得到确认（或来源已被
	 * 远端取消/从未产生受理段）才是 "sealed"；本地 closed 不是封口证据。
	 */
	async endSource(traceId = this.activeTrace): Promise<"sealed" | "unknown"> {
		if (!traceId) return "unknown";
		const source = this.sources.get(traceId);
		if (!source || source.sealed) return "sealed";
		if (source.cancelled) {
			// 来源已被取消停止：远端不会再接收新句，封口事实由取消收据支撑。
			source.sealed = true;
			source.sealUnconfirmed = false;
			return "sealed";
		}
		source.closed = true;
		const submitted = [...source.segments.entries()]
			.filter(([, segment]) => segment.state !== "rejected")
			.map(([index]) => index);
		if (!submitted.length) {
			// 没有任何受理段：远端不存在需要封口的来源，本地关闭即可。
			source.sealed = true;
			source.sealUnconfirmed = false;
			return "sealed";
		}
		try {
			await this.client.turnEnd(source.id, source.generation, Math.max(...submitted), this.sessionId, this.epoch);
			source.sealed = true;
			source.sealUnconfirmed = false;
			return "sealed";
		} catch (error) {
			if (source.cancelled) {
				// 封口途中来源被停止：取消收据是远端封闭证据。
				source.sealed = true;
				source.sealUnconfirmed = false;
				return "sealed";
			}
			source.sealUnconfirmed = true;
			this.barrierKinds.add("seal");
			throw error;
		}
	}
	async submitSegment(
		text: string,
		invocationId?: string,
		metadata?: Record<string, unknown>,
		traceId = this.activeTrace,
	): Promise<Outcome> {
		const source = traceId ? this.sources.get(traceId) : undefined;
		if (!source) return { status: "not_started", reason: "当前没有正文来源" };
		return this.submit(source, text, invocationId, metadata);
	}
	private async submit(
		source: Source,
		text: string,
		invocationId?: string,
		metadata?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Outcome> {
		if (this.maintenance || this._muted)
			return {
				status: "not_started",
				reason: this.maintenance ? "正在恢复或测试声音，台词未提交" : "当前已静音，台词未提交",
			};
		const result = this.admissionTail.then(() => this.performSubmit(source, text, invocationId, metadata, signal));
		this.admissionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private async performSubmit(
		source: Source,
		text: string,
		invocationId?: string,
		metadata?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Outcome> {
		signal?.throwIfAborted();
		if (invocationId && this.invocationResults.has(invocationId)) return this.invocationResults.get(invocationId)!;
		if (this.maintenance || this._muted)
			return {
				status: "not_started",
				reason: this.maintenance ? "正在恢复或测试声音，台词未提交" : "当前已静音，台词未提交",
			};
		if (this.deliveryBarrier)
			return { status: "unknown", reason: "此前发声存在未确认缺口，台词未提交；可恢复声音或确认停止后改口" };
		if (source.closed) return { status: "rejected", reason: "这段发声已经结束，后续内容未提交" };
		if (!this.epoch) {
			let connected: Record<string, unknown>;
			try {
				connected = await this.client.reconnect(this.sessionId);
			} catch (error) {
				source.closed = true;
				this._isOnline = false;
				this.lastError = { stage: "连接", reason: String(error), observedAt: Date.now() };
				return { status: "not_started", reason: "连接发声服务失败，台词未提交：" + String(error) };
			}
			if (connected.status !== "reconnected" || typeof connected.epoch !== "string")
				return { status: "not_started", reason: "没有取得本次发声的执行身份" };
			signal?.throwIfAborted();
			if (source.closed || this.maintenance || this._muted)
				return { status: "not_started", reason: "台词在提交前已取消" };
			this.epoch ??= connected.epoch;
		}
		const index = source.nextIndex++;
		const taskId = source.id + ":" + index;
		const segment: Segment = { text, state: "pending" };
		source.segments.set(index, segment);
		let outcome: Outcome;
		try {
			const payload = {
				trace_id: source.id,
				source_id: source.id,
				source_seq: source.seq,
				session_id: this.sessionId,
				epoch: this.epoch,
				segment_id: taskId,
				index,
				text,
				invocation_id: invocationId,
				metadata,
				timeout_ms: this.longTimeoutMs,
			};
			const result = signal ? await this.client.speak(payload, signal) : await this.client.speak(payload);
			if (result.status === "accepted" || result.status === "in_progress" || result.status === "delivered") {
				// 幂等重放可能返回进行中/已完成的真实状态：按事实合并，不算新拒绝。
				if (result.status === "delivered") segment.state = "completed";
				else if (!TERMINAL.has(segment.state)) segment.state = "pending";
				if (result.generation_id && !source.cancelled) source.generation = result.generation_id;
				outcome = {
					status: segment.state === "cancelled" || segment.state === "obsolete" ? "cancelled" : "accepted",
					task_id: taskId,
				};
			} else if (result.status === "failed" || result.status === "cancelled" || result.status === "not_found") {
				// 重放命中已知终局：按事实收束，不重复合成。
				segment.state = result.status === "cancelled" ? "cancelled" : result.status === "failed" ? "failed" : "rejected";
				source.closed = true;
				outcome = { status: "rejected", task_id: taskId, reason: result.reason ?? "Bridge 返回 " + result.status };
			} else {
				segment.state = "rejected";
				source.closed = true;
				outcome = { status: "rejected", task_id: taskId, reason: result.reason ?? "Bridge 返回 " + result.status };
			}
		} catch (error) {
			if (TERMINAL.has(segment.state)) {
				const settled = { status: segment.state === "completed" ? "accepted" : "cancelled", task_id: taskId };
				if (invocationId) this.invocationResults.set(invocationId, settled);
				return settled;
			}
			const rejected = error instanceof TtsSpeakError && error.kind === "rejected";
			segment.state = rejected ? "rejected" : "unknown";
			segment.uncertain = !rejected;
			source.closed = true;
			if (!rejected) this.barrierKinds.add("admission");
			outcome = {
				status: rejected ? "rejected" : "uncertain",
				task_id: taskId,
				reason: error instanceof Error ? error.message : String(error),
			};
			this.lastError = { stage: "提交", reason: outcome.reason!, observedAt: Date.now() };
		}
		if (invocationId) this.invocationResults.set(invocationId, outcome);
		this.pruneSources();
		return outcome;
	}
	snapshot(): DeliverySnapshot {
		const entries = [...this.sources.values()].flatMap((s) =>
			[...s.segments.entries()].map(([index, segment]) => ({ index, segment })),
		);
		const playing = entries.find((v) => v.segment.state === "playing");
		return {
			online: this._isOnline,
			muted: this._muted,
			submittedSegments: entries.length,
			spokenSegments: entries.filter((v) => v.segment.state === "completed").length,
			pendingSegments: entries.filter((v) => !TERMINAL.has(v.segment.state) && v.segment.state !== "unknown").length,
			failedSegments: entries.filter((v) => v.segment.state === "failed" || v.segment.state === "rejected").length,
			cancelledSegments: entries.filter((v) => v.segment.state === "cancelled" || v.segment.state === "obsolete")
				.length,
			unknownSegments: entries.filter((v) => v.segment.state === "unknown").length,
			currentSegmentIndex: playing?.index ?? null,
			currentSegmentText: playing?.segment.text,
			committedCharEnd: playing?.segment.revealed,
			observedAt: this.observedAt,
			stopUnconfirmed: this.barrierKinds.has("stop"),
		};
	}
	receive(event: PlaybackEvent): void {
		const source = this.sources.get(event.trace_id);
		if (!source || (source.generation && event.generation_id && source.generation !== event.generation_id)) return;
		const segment = source.segments.get(event.segment_index ?? 0);
		if (!segment || TERMINAL.has(segment.state)) return;
		const detail = event.detail ?? {};
		if (detail.stop_outcome === "unknown") {
			source.stopUnconfirmed = true;
			this.barrierKinds.add("stop");
		}
		if (typeof detail.revealed_count === "number") segment.revealed = detail.revealed_count;
		const previous = segment.state;
		if (event.kind === "failed" || event.kind === "cancelled") {
			segment.state = event.kind === "failed" ? "failed" : "cancelled";
			source.closed = true;
			for (const other of source.segments.values())
				if (other !== segment && !TERMINAL.has(other.state)) other.state = "cancelled";
			if (event.kind === "failed") {
				this.lastError = { stage: "合成或播放", reason: String(detail.error ?? "失败"), observedAt: Date.now() };
			}
		} else if (detail.playback_completed === true || event.kind === "completed") segment.state = "completed";
		else if (detail.playback_started === true || event.kind === "playback_started") segment.state = "playing";
		else if (event.kind === "synthesizing") segment.state = "synthesizing";
		this.notifyTransition(source.id, event.segment_index ?? 0, previous, segment.state);
		this.observedAt = Date.now();
		if (TERMINAL.has(segment.state)) this.updateReceipt(source, event.segment_index ?? 0, segment);
	}

	private notifyTransition(traceId: string, segmentIndex: number, previous: string, current: string): void {
		if (previous === current) return;
		if (current === "playing") this.onPlaybackFact?.({ traceId, segmentIndex, kind: "started" });
		else if (current === "completed") this.onPlaybackFact?.({ traceId, segmentIndex, kind: "completed" });
		else if (current === "failed") this.onPlaybackFact?.({ traceId, segmentIndex, kind: "failed" });
	}
	private updateReceipt(source: Source, index: number, segment: Segment): void {
		const taskId = source.id + ":" + index;
		for (const [invocation, receipt] of this.invocationResults) {
			if (receipt.task_id !== taskId) continue;
			if (segment.state === "completed")
				this.invocationResults.set(invocation, { status: "completed", task_id: taskId });
			else if (segment.state === "failed")
				this.invocationResults.set(invocation, { status: "failed", task_id: taskId, reason: "这次调用的台词未能播完" });
			else if (segment.state === "cancelled" || segment.state === "obsolete")
				this.invocationResults.set(invocation, {
					status: "cancelled",
					task_id: taskId,
					reason: segment.uncertain ? "剩余发声已取消，此前是否完整播放未确认" : "剩余发声已取消",
				});
		}
	}
	async probe(signal?: AbortSignal): Promise<void> {
		if (signal) return this.probeOnce(signal);
		if (this.probeInFlight) return this.probeInFlight;
		this.probeInFlight = this.probeOnce();
		try {
			await this.probeInFlight;
		} finally {
			this.probeInFlight = undefined;
		}
	}
	private async probeOnce(signal?: AbortSignal): Promise<void> {
		for (const source of this.sources.values()) {
			if (![...source.segments.values()].some((s) => !TERMINAL.has(s.state))) continue;
			signal?.throwIfAborted();
			const state = await this.client.getSubtitleState(source.id, signal);
			signal?.throwIfAborted();
			if (!state || state.trace_id !== source.id) continue;
			for (const [index, segment] of source.segments) {
				if (TERMINAL.has(segment.state)) continue;
				const observed = state.segments.find((s) => s.segment_index === index);
				if (!observed) continue;
				if (observed.stop_outcome === "unknown") {
					source.stopUnconfirmed = true;
					this.barrierKinds.add("stop");
				}
				const previous = segment.state;
				if (observed.state && TERMINAL.has(observed.state)) {
					segment.state = observed.state;
					if (observed.state === "failed") {
						source.closed = true;
						this.lastError = { stage: "合成或播放", reason: observed.error ?? "失败", observedAt: Date.now() };
					}
				} else if (observed.playback_completed || state.completed_segments?.some((s) => s.index === index))
					segment.state = "completed";
				else if (observed.playback_started || state.current_speaking?.index === index) segment.state = "playing";
				segment.revealed = observed.revealed_count;
				this.notifyTransition(source.id, index, previous, segment.state);
				if (TERMINAL.has(segment.state)) this.updateReceipt(source, index, segment);
			}
			this.observedAt = Date.now();
		}
		if (![...this.sources.values()].some((s) => [...s.segments.values()].some((v) => v.state === "unknown")))
			this.barrierKinds.delete("admission");
	}
	async interrupt(expectedTraceId?: string): Promise<InterruptResult> {
		const targets = [...this.sources.values()].filter(
			(s) =>
				(!expectedTraceId || s.id === expectedTraceId) &&
				(!s.closed ||
					s.stopUnconfirmed ||
					s.sealUnconfirmed ||
					[...s.segments.values()].some((v) => !TERMINAL.has(v.state))),
		);
		if (!targets.length)
			return !expectedTraceId && this.barrierKinds.has("stop")
				? { outcome: "unknown", breakpoint: null, reason: "此前停止尚未确认，不能确认当前已经无声" }
				: { outcome: "no_op", breakpoint: null, reason: "当前没有属于这个来源的声音" };
		for (const source of targets) {
			source.closed = true;
			source.cancelled = true;
		}
		let breakpoint: PlaybackBreakpoint | null = null;
		const unknown: string[] = [];
		const failed: string[] = [];
		for (const source of targets) {
			if (!source.segments.size) continue;
			try {
				const result = await this.client.cancelTrace(source.id, "immediate", this.sessionId, this.epoch);
				if (result.stop_outcome !== "not_playing" && result.playback_stopped !== true) {
					source.stopUnconfirmed = true;
					this.barrierKinds.add("stop");
					unknown.push("取消已请求，但这段声音是否停止尚未确认");
					continue;
				}
				if (result.status !== "cancelled") {
					this.barrierKinds.add("stop");
					failed.push("停止请求被拒绝");
					continue;
				}
				const active = [...source.segments.entries()].find(([, s]) => s.state === "playing");
				source.stopUnconfirmed = false;
				source.sealUnconfirmed = false;
				if (active)
					breakpoint = {
						traceId: source.id,
						segmentIndex: active[0],
						committedCharEnd: active[1].revealed ?? 0,
						segmentText: active[1].text,
					};
				for (const [index, segment] of source.segments) {
					if (!TERMINAL.has(segment.state)) segment.state = "cancelled";
					this.updateReceipt(source, index, segment);
				}
			} catch (error) {
				source.stopUnconfirmed = true;
				this.barrierKinds.add("stop");
				unknown.push(String(error));
			}
		}
		if (unknown.length) return { outcome: "unknown", breakpoint: null, reason: unknown.join("；") };
		if (failed.length) return { outcome: "failed", breakpoint: null, reason: failed.join("；") };
		if (!expectedTraceId) this.barrierKinds.delete("stop");
		if (![...this.sources.values()].some((source) => source.sealUnconfirmed)) this.barrierKinds.delete("seal");
		if (![...this.sources.values()].some((s) => [...s.segments.values()].some((v) => v.state === "unknown")))
			this.barrierKinds.delete("admission");
		return targets.some((source) => source.segments.size > 0)
			? { outcome: "interrupted", breakpoint }
			: { outcome: "no_op", breakpoint: null, reason: "当前没有声音需要停止" };
	}
	async setMuted(muted: boolean): Promise<{ success: boolean; isOnline?: boolean; reason?: string; status?: string }> {
		this._muted = muted;
		if (muted) {
			const result = await this.interrupt();
			return {
				success: result.outcome !== "unknown" && result.outcome !== "failed",
				isOnline: this._isOnline,
				status: result.outcome === "unknown" || result.outcome === "failed" ? result.outcome : "succeeded",
				...(result.outcome === "unknown" || result.outcome === "failed" ? { reason: result.reason } : {}),
			};
		}
		const readiness = await this.client.compatibility();
		this._isOnline = readiness.compatible;
		return { success: readiness.compatible, isOnline: readiness.compatible, reason: readiness.reason };
	}
	async attemptAutoRecovery(): Promise<void> {
		if (this._isOnline) return;
		const readiness = await this.client.compatibility();
		this._isOnline = readiness.compatible;
		if (readiness.compatible) await this.probe();
	}
	async inspect(): Promise<Record<string, unknown>> {
		const [health, compatibility] = await Promise.all([this.client.health(), this.client.compatibility()]);
		return {
			status: health ? "observed" : "unknown",
			reachable: !!health,
			compatible: compatibility.compatible,
			ownership: { bridge: this.bridgeOwnership, vendor: health?.vendor_ownership ?? "unknown" },
			health,
			driver: {
				...this.snapshot(),
				barrier: this.deliveryBarrier,
				maintenance: this.maintenance,
				lastError: this.lastError,
			},
			availableActions: [
				...(compatibility.compatible ? [{ action: "recover" }] : []),
				...(compatibility.compatible
					? [
							{ action: "test", scope: "synthesis" },
							...(!this._muted && health?.player_ready === true ? [{ action: "test", scope: "playback" }] : []),
						]
					: []),
				...(this.bridgeOwnership === "owned" ? [{ action: "recover", operation: "restart", target: "bridge" }] : []),
				...(health?.vendor_ownership === "owned"
					? [{ action: "recover", operation: "restart", target: "vendor" }]
					: []),
			],
			reason: compatibility.reason,
		};
	}
	async recover(
		operation: "auto" | "reconnect" | "reset" | "restart" = "auto",
		invocationId?: string,
		target?: "bridge" | "vendor",
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		signal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(this.longTimeoutMs)])
			: AbortSignal.timeout(this.longTimeoutMs);
		signal?.throwIfAborted();
		if (this.maintenance) return { status: "not_started", reason: "已有声音维护正在执行" };
		this.maintenance = true;
		const deadline = Date.now() + this.longTimeoutMs;
		const remaining = () => {
			signal?.throwIfAborted();
			const budget = deadline - Date.now();
			if (budget <= 0) throw new Error("声音维护超时");
			return budget;
		};
		let stoppedOldWork = false;
		let controlAttempted = false;
		let ownedBridgeRestarted = false;
		try {
			if (operation === "restart") {
				controlAttempted = true;
				const result =
					target === "vendor"
						? await this.client.restartVendor(remaining(), signal)
						: this.restartBridge
							? await this.restartBridge(signal, remaining())
							: { status: "not_started", reason: "没有这项服务的进程管理句柄，请由启动它的程序重启" };
				if (result.status !== "succeeded" && result.status !== "restarted") {
					if (result.status === "unknown") this.barrierKinds.add("stop");
					return { operation, target, ...result };
				}
				ownedBridgeRestarted = target === "bridge";
			}
			const readiness = await this.client.compatibility(signal);
			signal?.throwIfAborted();
			if (!readiness.compatible) return { operation, status: "not_started", reason: readiness.reason };
			const connected = await this.client.reconnect(this.sessionId, signal);
			if (connected.status !== "reconnected" || typeof connected.epoch !== "string")
				return { operation, status: "unknown", reason: "重新连接后没有取得执行身份" };
			if (this.epoch && this.epoch !== connected.epoch && !ownedBridgeRestarted) {
				this.barrierKinds.add("stop");
				return {
					operation,
					status: "unknown",
					reason: "服务的执行身份发生变化；旧服务的停止和旧台词结果尚未确认，请由启动它的程序确认旧进程已退出",
				};
			}
			this._isOnline = true;
			this.epoch = connected.epoch;
			const subscribed = this.reconnectFeed ? await this.reconnectFeed(signal) : undefined;
			await this.probe(signal);
			// 封口未确认：turn-end 幂等，先按同身份重发核对（不重发语音），
			// 而不是直接 reset 杀掉可能完好播放中的声音；核对失败才走既有 reset。
			if (this.barrierKinds.has("seal")) {
				for (const source of [...this.sources.values()]) {
					if (!source.sealUnconfirmed) continue;
					signal?.throwIfAborted();
					try {
						if ((await this.endSource(source.id)) === "sealed") {
							source.sealUnconfirmed = false;
							this.barrierKinds.delete("seal");
						}
					} catch {
						/* 重发仍失败：保留屏障，走既有 reset/recover */
					}
				}
			}
			if (operation === "reset" || this.deliveryBarrier || operation === "restart") {
				controlAttempted = true;
				const reset = await this.client.reset(this.sessionId, this.epoch, undefined, invocationId, remaining(), signal);
				if (reset.status !== "reset" || typeof reset.epoch !== "string") {
					if (reset.status !== "failed" && reset.status !== "not_started") this.barrierKinds.add("stop");
					return { operation, ...reset };
				}
				this.epoch = reset.epoch;
				this.barrierKinds.clear();
				stoppedOldWork = true;
				for (const source of this.sources.values()) {
					source.closed = true;
					source.cancelled = true;
					source.stopUnconfirmed = false;
					source.sealUnconfirmed = false;
					for (const [index, segment] of source.segments) {
						if (!TERMINAL.has(segment.state)) segment.state = "cancelled";
						this.updateReceipt(source, index, segment);
					}
				}
			}
			return {
				operation,
				status: "succeeded",
				connection: "connected",
				stoppedOldWork,
				feedback: subscribed === false ? "polling" : subscribed === true ? "subscribed" : "not_attached",
				delivery: this.deliveryBarrier ? "unknown" : "reconciled",
				verification: "not_tested",
			};
		} catch (error) {
			if (controlAttempted) this.barrierKinds.add("stop");
			return { operation, status: "unknown", reason: String(error) };
		} finally {
			this.maintenance = false;
		}
	}
	async test(scope: "synthesis" | "playback", signal?: AbortSignal): Promise<Record<string, unknown>> {
		const callerSignal = signal;
		signal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(this.longTimeoutMs)])
			: AbortSignal.timeout(this.longTimeoutMs);
		if (this.maintenance || (scope === "playback" && this._muted))
			return {
				scope,
				status: "not_started",
				reason: this._muted ? "当前已静音，未播放测试音" : "已有声音维护正在执行",
			};
		this.maintenance = true;
		const deadline = Date.now() + this.longTimeoutMs;
		const source = scope === "playback" ? this.newSource() : undefined;
		try {
			const compatibility = await this.client.compatibility(signal);
			signal.throwIfAborted();
			if (!compatibility.compatible) return { scope, status: "not_started", reason: compatibility.reason };
			signal?.throwIfAborted();
			if (source?.cancelled || (scope === "playback" && this._muted))
				return { scope, status: "not_started", reason: "当前已静音或测试已取消，未播放测试音" };
			if (source && !this.epoch) {
				const connected = await this.client.reconnect(this.sessionId, signal);
				if (source.cancelled || this._muted) return { scope, status: "not_started", reason: "测试在提交前已取消" };
				if (typeof connected.epoch !== "string")
					return { scope, status: "not_started", reason: "未取得播放测试的执行身份" };
				this.epoch ??= connected.epoch;
			}
			const budget = deadline - Date.now();
			if (budget <= 0) return { scope, status: "failed", reason: "测试超时" };
			if (source) {
				source.segments.set(1, { text: "语音测试。", state: "pending" });
				source.nextIndex = 2;
				source.sealed = true;
			}
			const result = await this.client.test(scope, this.sessionId, budget, signal, this.epoch, source?.id);
			if (source) {
				source.closed = true;
				if (!source.cancelled)
					source.segments.get(1)!.state =
						result.status === "succeeded"
							? "completed"
							: result.status === "cancelled"
								? "cancelled"
								: result.status === "not_started"
									? "rejected"
									: result.status === "failed"
										? "failed"
										: "unknown";
				if (result.status === "unknown") {
					source.stopUnconfirmed = true;
					this.barrierKinds.add("stop");
				}
			}
			if (!["succeeded", "failed", "cancelled", "unknown", "not_started"].includes(String(result.status)))
				return { scope, status: "unknown", reason: "服务没有返回可识别的测试结论" };
			if (
				result.status === "succeeded" &&
				((scope === "playback" && result.playback_completed !== true) ||
					(scope === "synthesis" && !(typeof result.audio_bytes === "number" && result.audio_bytes > 0)))
			)
				return { scope, status: "unknown", reason: "服务返回了成功，但缺少这项测试的完成证据" };
			return { scope, ...result };
		} catch (error) {
			if (source?.segments.size) {
				const stopped = await this.interrupt(source.id);
				return {
					scope,
					status:
						stopped.outcome === "unknown" || stopped.outcome === "failed"
							? "unknown"
							: callerSignal?.aborted
								? "cancelled"
								: "failed",
					reason: String(error) + ("reason" in stopped && stopped.reason ? "；" + stopped.reason : ""),
				};
			}
			return { scope, status: callerSignal?.aborted ? "cancelled" : "unknown", reason: String(error) };
		} finally {
			if (source) source.closed = true;
			this.maintenance = false;
		}
	}
	async dispose(): Promise<void> {
		this._muted = true;
		const stopped = await this.interrupt();
		await this.admissionTail;
		if (stopped.outcome === "unknown" || stopped.outcome === "failed") throw new Error(stopped.reason);
	}
}
