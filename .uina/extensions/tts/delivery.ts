import type { SubtitleStateResponse } from "./client.js";

/** Bridge playback facts reduced for Voice status and physical delivery bookkeeping. */

export interface ProgressFacts {
  /** 本轮已提交句数（作者侧记账，与 DeliverySnapshot 同名字段同义） */
  readonly submittedSegments: number;
  /** 桥侧是否正在出声（决定"还有在途音频"这件事，不只是队列算术） */
  readonly speaking: boolean;
  readonly spokenSegments: number;
  /** 尚未播完的句数，含正在播的那句 */
  readonly pendingSegments: number;
  readonly currentSegmentIndex: number | null;
  readonly currentSegmentText?: string;
  readonly committedCharEnd?: number;
}

/**
 * 归纳桥侧字幕状态。
 *
 * 句数一律以作者侧 `submitted` 为基准做减法（提交方才知道交了几句），
 * 桥侧只负责"哪句在播、哪几句播完了"这类物理事实 —— 不用两套账互相校对。
 * 呈现用的文本优先取作者侧记账，桥侧文本只在缺记账时兜底（桥侧是渲染副本，可能被规范化）。
 */
export function summarizeProgress(
  state: SubtitleStateResponse,
  submitted: number,
  segmentTexts: ReadonlyMap<number, string>,
): ProgressFacts {
  const segments = state.segments ?? [];
  const completedFromFlags = segments.filter((s) => s.playback_completed === true).length;
  const spoken = Math.max(0, Math.min(submitted, state.completed_segments?.length ?? completedFromFlags));

  const speakingIndex =
    state.current_speaking?.index ??
    segments.find((s) => s.playback_started === true && s.playback_completed !== true)?.segment_index ??
    null;

  const currentSegment = speakingIndex === null
    ? undefined
    : segments.find((segment) => segment.segment_index === speakingIndex);
  const revealed = currentSegment?.revealed_count;

  return {
    submittedSegments: Math.max(0, submitted),
    speaking: speakingIndex !== null || state.is_speaking === true,
    spokenSegments: spoken,
    pendingSegments: Math.max(0, submitted - spoken),
    currentSegmentIndex: speakingIndex,
    currentSegmentText:
      speakingIndex === null ? undefined : segmentTexts.get(speakingIndex) ?? state.current_speaking?.text,
    committedCharEnd: typeof revealed === "number" && Number.isFinite(revealed) ? Math.max(0, revealed) : undefined,
  };
}
