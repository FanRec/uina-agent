import { describeDelivery, type DeliverySnapshot, type PlaybackBreakpoint } from "../voice/driver.js";
import type { SubtitleStateResponse } from "./client.js";

/**
 * 交付感知的纯函数层：把桥侧物理事实归纳成事实，再把事实渲染成一行。
 * 这里不碰网络、不碰状态、不碰时钟 —— 所以每条规则都能被单测钉住。
 *
 * 措辞（"第几句、还有多少未播完"）不在这里：它归 voice 的 describeDelivery，
 * 人手一份措辞就会漂移。这里只负责"归纳"和"要不要出现在上下文里"。
 */

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

  const revealed = segments
    .map((s) => s.revealed_count)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

  return {
    submittedSegments: Math.max(0, submitted),
    speaking: speakingIndex !== null || state.is_speaking === true,
    spokenSegments: spoken,
    pendingSegments: Math.max(0, submitted - spoken),
    currentSegmentIndex: speakingIndex,
    currentSegmentText:
      speakingIndex === null ? undefined : segmentTexts.get(speakingIndex) ?? state.current_speaking?.text,
    committedCharEnd: revealed.length > 0 ? Math.max(...revealed) : undefined,
  };
}

/**
 * 开麦期间的说话纪律。
 *
 * 为什么要有它：“我自己会控制”已经被真机证伪了 —— 第一次试用就堆到 41 句。
 * 文字产出速度本来就远快于语速，所以不赌自觉，把事实摆在每轮都看得见的地方：
 * 我写下的每个字都会被念出去。
 */
const SPEAKING_REMINDER = "你写的每个字都会被念出来——注意句子长度与节奏";

/**
 * 一行交付视口。
 *
 * 静音或离线时返回 null —— 0 token 也是一种表达。
 * 开麦在线时即使本轮还没说话也给一行：这行要在“我开口之前”起作用，不能等事后补报。
 * 内容措辞直接取 describeDelivery（事实的单一说法），此处只加视口自己的前缀与纪律句。
 */
export function renderDeliveryLine(snapshot: DeliverySnapshot): string | null {
  if (!snapshot.online || snapshot.muted) return null;
  return `[voice] 开麦 | ${describeDelivery(snapshot)} | ${SPEAKING_REMINDER}`;
}

/**
 * 被打断的单轮提示。
 * 有了作者侧记账，"断在第 128 字符"就能升级成"断在哪一句的哪个字"。
 */
export function renderBreakpointNotice(bp: PlaybackBreakpoint): string {
  const where = bp.segmentText
    ? `第 ${bp.segmentIndex} 句「${clipText(bp.segmentText, 20)}」念到第 ${bp.committedCharEnd} 字`
    : `第 ${bp.segmentIndex} 句念到第 ${bp.committedCharEnd} 字`;
  return `[语音交付提示: 上一条回复在${where}处被打断，其后内容用户未听见。]`;
}

/** 截断长句用于提示：只给辨认用的开头，不把整句搬进上下文。 */
function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
