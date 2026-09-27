import type { DeliverySnapshot, InterruptResult, PlaybackBreakpoint, VoiceOutputDriver } from "../voice/driver.js";
import type { TtsBridgeClient } from "./client.js";
import { summarizeProgress } from "./delivery.js";

/** 作者侧记账上限：只服务"这一轮说了什么"，不需要无限历史。 */
const MAX_TRACKED_SEGMENTS = 32;

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
  private submitted = 0;
  private readonly segmentTexts = new Map<number, string>();
  /** 桥侧物理事实（不含意志与连接态） */
  private facts: DeliveryFacts = EMPTY_FACTS;
  /** 桥侧说它正在出声 —— 队列算术说不出的"在途尾巴" */
  private speaking = false;

  constructor(client: TtsBridgeClient) {
    this.client = client;
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
  async submitSegment(text: string): Promise<{ status: string; task_id?: string }> {
    const traceId = this.activeTrace;
    if (!traceId) {
      return { status: "skipped", task_id: undefined };
    }

    this.rotateEpochIfDirty(traceId);
    const index = ++this.submitted;
    this.segmentTexts.set(index, text);
    if (this.segmentTexts.size > MAX_TRACKED_SEGMENTS) {
      this.segmentTexts.delete(Math.min(...this.segmentTexts.keys()));
    }

    // 提交即视为"在途"：桥侧还没回话之前，队列里已经有它了。
    this.facts = {
      ...this.facts,
      submittedSegments: this.submitted,
      pendingSegments: this.facts.pendingSegments + 1,
    };

    return await this.client.speak({
      trace_id: traceId,
      segment_id: `${traceId}:${index}`,
      index,
      text,
    });
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
      const healthy = await this.client.isHealthy();
      if (!healthy) {
        this._isOnline = false;
        this._muted = true;
        return {
          success: false,
          isOnline: false,
          reason: "伴生服务未连接（端口 8102 无响应）",
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
      if (cancellation.playback_stopped === false && cancellation.cancelled_task_count === 0) {
        return { outcome: "no_op", breakpoint: null, reason: "当前没有可打断的语音" };
      }
      const state = await this.client.getSubtitleState(traceToCancel);
      if (!state && cancellation.playback_stopped) {
        return { outcome: "unknown", breakpoint: null, reason: "声卡停止已请求，但无法读取播放断点" };
      }

      const interrupted = this.resolveBreakpoint(traceToCancel, state);
      // 掐断即清空在途：队列事实归零，但要如实标明这次是"被打断"而不是"播完"
      this.speaking = false;
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
