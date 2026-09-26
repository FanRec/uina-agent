export interface SpeakPayload {
  readonly trace_id: string;
  readonly segment_id: string;
  readonly index: number;
  readonly text: string;
  readonly kind?: string;
  readonly timeout_ms?: number;
  readonly generation_id?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface SubtitleSegmentState {
  readonly task_id?: string;
  readonly generation_id?: number;
  readonly segment_index?: number;
  readonly text?: string;
  readonly revealed_text?: string;
  readonly revealed_count?: number;
  readonly playback_started?: boolean;
  readonly playback_completed?: boolean;
  readonly duration_ms?: number;
}

export interface SpeakingSegmentInfo {
  readonly index: number;
  readonly text: string;
  readonly revealed_text?: string;
}

export interface SubtitleStateResponse {
  readonly trace_id: string;
  readonly is_speaking?: boolean;
  readonly current_speaking?: SpeakingSegmentInfo | null;
  readonly pending_segments?: readonly SpeakingSegmentInfo[];
  readonly completed_segments?: readonly SpeakingSegmentInfo[];
  readonly segments: readonly SubtitleSegmentState[];
}

/**
 * 桥侧实际会发出的播放事件种类（封闭集合，来自 `PlaybackEventHub.publish` 的调用点）。
 *
 * `subtitle` 是每个进度 tick 的常规事件，原先漏在联合体外。
 * 未知种类仍必须能被接收（桥可以增发新 kind），因此消费处用
 * `PlaybackKind | (string & {})` 而不是 `| string` —— 后者会让联合体形同虚设：
 * 写错 kind 不报错，switch 也无法做穷尽检查。
 */
export type PlaybackKind =
  | "submitted"
  | "synthesizing"
  | "playback_started"
  | "subtitle"
  | "completed"
  | "cancelled"
  | "failed";

export interface PlaybackEvent {
  readonly event_id: string;
  readonly kind: PlaybackKind | (string & {});
  readonly trace_id: string;
  readonly generation_id?: number;
  readonly segment_index?: number;
  readonly task_id?: string;
  readonly created_at: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * 从播放事件中读取声学电平。
 *
 * 电平随进度事件下发（见桥侧 `remember_snapshot`）。非电平事件或缺字段时返回 null ——
 * 明确返回"没有电平"而不是伪造 0，否则消费端无法区分"真静音"与"这一帧没测"。
 */
export function readPlaybackLevel(event: PlaybackEvent): { rms: number; peak: number } | null {
  const detail = event.detail;
  if (!detail) return null;
  const rms = detail["rms"];
  if (typeof rms !== "number" || !Number.isFinite(rms)) return null;
  const peak = detail["peak"];
  return { rms, peak: typeof peak === "number" && Number.isFinite(peak) ? peak : 0 };
}

export class TtsBridgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl = "http://127.0.0.1:8102", timeoutMs = 5000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 2000));
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async speak(payload: SpeakPayload): Promise<{ status: string; task_id?: string }> {
    if (!payload.text || !payload.text.trim()) {
      return { status: "skipped", task_id: payload.segment_id };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/tts/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "sentence",
          timeout_ms: 3000,
          ...payload,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TTS speak failed: HTTP ${res.status} ${errText}`);
      }
      return (await res.json()) as { status: string; task_id?: string };
    } finally {
      clearTimeout(timer);
    }
  }

  async cancelTrace(
    traceId: string,
    mode: "immediate" | "segment_boundary" = "immediate",
  ): Promise<{ status: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/tts/cancel-trace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trace_id: traceId, mode }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TTS cancel-trace failed: HTTP ${res.status} ${errText}`);
      }
      return (await res.json()) as { status: string };
    } finally {
      clearTimeout(timer);
    }
  }

  async turnEnd(
    traceId: string,
    generationId?: number,
    lastSegmentIndex?: number,
  ): Promise<{ status: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/tts/turn-end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trace_id: traceId,
          ...(generationId !== undefined ? { generation_id: generationId } : {}),
          ...(lastSegmentIndex !== undefined ? { last_segment_index: lastSegmentIndex } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TTS turn-end failed: HTTP ${res.status} ${errText}`);
      }
      return (await res.json()) as { status: string };
    } finally {
      clearTimeout(timer);
    }
  }

  async getSubtitleState(traceId: string): Promise<SubtitleStateResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(
        `${this.baseUrl}/v1/tts/subtitle-state?trace_id=${encodeURIComponent(traceId)}`,
        {
          method: "GET",
          signal: controller.signal,
        },
      );
      if (!res.ok) return null;
      return (await res.json()) as SubtitleStateResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async subscribeEvents(
    traceId: string,
    onEvent: (event: PlaybackEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseUrl}/v1/tts/events?trace_id=${encodeURIComponent(traceId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to subscribe to TTS events: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr) {
              try {
                const parsed = JSON.parse(jsonStr) as PlaybackEvent;
                onEvent(parsed);
              } catch {
                // Ignore parse errors on SSE line
              }
            }
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
  }
}
