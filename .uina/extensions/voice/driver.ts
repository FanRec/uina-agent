/**
 * Uina VoiceOutputDriver 向下控制接缝定义 + 交付事实的单一说法
 *
 * 权威划分（只此一份，不设第二账本）：
 * - **文本归属提交方**：句子是 tts 扩展交给驱动的，所以断点能说出"是哪一句"。
 * - **进度归属 bridge**：播完几句、哪句在播、念到第几字，只有物理层知道；驱动只代理。
 *
 * 读取路径也收敛成一条：`snapshot()` —— 同步、零 IO。
 * 刷新由拥有 IO 的一方（tts 扩展的进度探测）在后台推进，渲染路径永远只读内存快照。
 */

export interface PlaybackBreakpoint {
  readonly traceId: string;
  readonly segmentIndex: number;
  readonly committedCharEnd: number; // 音频播放头已越过的文本物理字符边界
  /** 被打断那一句的文本（作者侧记账；无记账时缺席，不臆造） */
  readonly segmentText?: string;
}

/**
 * 交付快照：某一时刻"我说到哪了"的全部已知事实。
 * 每个字段都是已归零的观测；读取不触发任何 IO。
 */
export interface DeliverySnapshot {
  readonly online: boolean;
  readonly muted: boolean;
  /** 本轮已提交句数（作者侧记账） */
  readonly submittedSegments: number;
  /** 已播完句数（桥侧物理事实） */
  readonly spokenSegments: number;
  /** 尚未播完的句数，**含正在播的那句** */
  readonly pendingSegments: number;
  /** 正在播的那句序号（1 起）；无在播时为 null */
  readonly currentSegmentIndex: number | null;
  /** 正在播的那句文本（作者侧记账） */
  readonly currentSegmentText?: string;
  /** 播放头已越过的字符边界 */
  readonly committedCharEnd?: number;
}

export interface VoiceOutputDriver {
  /** 物理静音开闭（底层声卡静音或跳过发声投递）；开麦时顺手探活 */
  setMuted(muted: boolean): Promise<{ success: boolean; isOnline?: boolean; reason?: string }>;

  /**
   * 立即掐断物理声音并返回精确断点
   * @param expectedTraceId 可选。若指定，则仅当当前播放 trace 与之一致时才掐断（消除异步竞态误杀下一轮）
   */
  interrupt(expectedTraceId?: string): Promise<PlaybackBreakpoint | null>;

  /** 同步读交付快照。渲染路径唯一允许的读取方式。 */
  snapshot(): DeliverySnapshot;
}

/**
 * 交付事实的**单一说法**。
 *
 * 谁要"用一句话说清现在交付到哪了"（人的状态栏、模型的视口）都从这里取，
 * 各自再决定加不加自己的前缀、要不要干脆不说。措辞只有一份，
 * 才不会出现"两处各自描述同一状态、然后慢慢漂移"。
 *
 * 措辞上刻意不含糊：在播的那句还没念完，它算在"未播完"里，不写成"排队"。
 */
export function describeDelivery(snapshot: DeliverySnapshot): string {
  if (!snapshot.online) return "离线 (纯打字)";
  if (snapshot.muted) return "已静音";
  if (snapshot.submittedSegments === 0) return "空闲 (本轮还没说话)";

  const total = snapshot.submittedSegments;
  if (snapshot.currentSegmentIndex !== null) {
    return snapshot.pendingSegments > 1
      ? `播放 第 ${snapshot.currentSegmentIndex}/${total} 句（未播完 ${snapshot.pendingSegments} 句）`
      : `播放 第 ${snapshot.currentSegmentIndex}/${total} 句（最后一句）`;
  }
  if (snapshot.pendingSegments > 0) return `待播 ${snapshot.pendingSegments}/${total} 句`;
  return `已播完 ${total} 句`;
}
