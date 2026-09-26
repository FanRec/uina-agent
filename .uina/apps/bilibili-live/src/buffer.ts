import type {
  DanmakuRecord,
  SuperChatRecord,
  GuardRecord,
  GiftRecord,
  PendingEventRecord,
  LiveAppState,
  ActionOutcome,
  VisibleSlot,
  EventTime,
} from "./types.js";
import { createEventTime } from "./types.js";
import type { ResolvedLiveAppConfig } from "./config.js";
import { LiveEventJournal } from "./journal.js";

/**
 * 转义不可信输入，防止 Prompt Injection 破坏 XML 结构
 */
export function sanitizeUntrustedText(text: string): string {
  if (!text) return "";
  return text
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

/**
 * 格式化时间戳为 HH:mm:ss
 */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderPendingSection(pendingEvents: Iterable<PendingEventRecord>): string[] {
  const lines: string[] = [];
  let hasHeading = false;

  for (const event of pendingEvents) {
    if (!event.handled) {
      if (!hasHeading) {
        lines.push("\n### 待办互动（请尽快感谢/回应并调用 mark_handled）:");
        hasHeading = true;
      }
      const user = sanitizeUntrustedText(event.uname);

      if (event.kind === "sc") {
        const msg = sanitizeUntrustedText(event.message);
        lines.push(`  * [${event.alias}] <data>${user} (醒目留言 ￥${event.price}): "${msg}"</data>`);
      } else if (event.kind === "guard") {
        const title = sanitizeUntrustedText(event.giftName);
        lines.push(`  * [${event.alias}] <data>${user} 开通/续费 ${title}</data>`);
      } else if (event.kind === "gift") {
        const giftName = sanitizeUntrustedText(event.giftName);
        lines.push(`  * [${event.alias}] <data>${user} 赠送大额礼物 ${giftName} x${event.count}</data>`);
      }
    }
  }
  return lines;
}

function renderDanmakuSection(
  slots: VisibleSlot[],
  maxChars: number,
  maxLen: number,
  showTs: boolean
): string[] {
  if (slots.length === 0) {
    return ["\n（暂无新弹幕）"];
  }

  const lines: string[] = ["\n### 近期弹幕:"];
  const danmakuLines: string[] = [];
  let currentChars = 0;

  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const tsPrefix = showTs ? `[${formatTime(slot.wallTimeMs)}] ` : "";
    const displayText = slot.fullText.length > maxLen ? slot.fullText.slice(0, maxLen) + "..." : slot.fullText;
    const user = sanitizeUntrustedText(slot.firstSender);
    const text = sanitizeUntrustedText(displayText);

    let body = "";
    if (slot.uniqueSendersCount > 1) {
      body = `<data>${user} 等 ${slot.uniqueSendersCount} 人: ${text} (x${slot.count})</data>`;
    } else if (slot.count > 1) {
      body = `<data>${user}: ${text} (连发x${slot.count})</data>`;
    } else {
      body = `<data>${user}: ${text}</data>`;
    }

    const line = `  * ${tsPrefix}${body}`;
    if (currentChars + line.length > maxChars && danmakuLines.length > 0) {
      break;
    }

    currentChars += line.length;
    danmakuLines.unshift(line);
  }

  lines.push(...danmakuLines);
  return lines;
}

/**
 * 校验弹幕是否应当被过滤（关键字、纯表情等）
 */
export function shouldFilterDanmaku(
  text: string,
  filtering: { filterKeywords: string[]; ignoreEmojiOnly: boolean }
): boolean {
  if (!text) return true;

  for (const kw of filtering.filterKeywords) {
    if (text.includes(kw)) return true;
  }

  if (filtering.ignoreEmojiOnly && /^\[[^\]]+\]$/.test(text)) {
    return true;
  }

  return false;
}

/**
 * B站直播事件缓冲池与纯投影视口管理器 (RC1-Pure)
 */
export class LiveEventBuffer {
  private readonly config: ResolvedLiveAppConfig;
  private readonly journal: LiveEventJournal;
  private readonly maxRingCapacity: number;

  private readonly danmakuRing: DanmakuRecord[] = [];
  private visibleSlots: VisibleSlot[] = [];
  private readonly pendingEvents = new Map<string, PendingEventRecord>();

  private counters = { sc: 0, gd: 0, gf: 0, dm: 0 };
  private advanceTimer: NodeJS.Timeout | null = null;

  constructor(config: ResolvedLiveAppConfig, journal?: LiveEventJournal) {
    this.config = config;
    this.journal = journal ?? new LiveEventJournal(config.storage);
    this.maxRingCapacity = config.viewport.maxItems * 3;

    this.recoverFromJournal();
    this.scheduleNextAdvance();
  }

  private scheduleNextAdvance(): void {
    this.advance(performance.now());
  }

  private recoverFromJournal(): void {
    const snapshot = this.journal.recover();
    for (const [id, record] of snapshot.pendingEvents) {
      this.pendingEvents.set(id, record);
    }
    this.counters = { ...snapshot.counters };
  }

  private nextId(prefix: "dm" | "sc" | "gd" | "gf"): string {
    this.counters[prefix]++;
    return `${prefix}_${this.counters[prefix]}`;
  }

  addDanmaku(
    uid: number,
    uname: string,
    rawText: string,
    eventTime?: EventTime
  ): DanmakuRecord | null {
    const text = rawText.trim();
    if (shouldFilterDanmaku(text, this.config.filtering)) {
      return null;
    }

    const time = eventTime ?? createEventTime();
    const windowMs = this.config.viewport.aggregationWindowMs;
    const matchIndex = this.findAggregatableDanmaku(text, time.monotonicTimeMs, windowMs);

    if (matchIndex !== -1) {
      const existing = this.danmakuRing[matchIndex];
      existing.count++;
      existing.uniqueSenders.add(uid);
      this.advance(time.monotonicTimeMs);
      return existing;
    }

    const record: DanmakuRecord = {
      id: this.nextId("dm"),
      uid,
      uname,
      text,
      time,
      count: 1,
      uniqueSenders: new Set([uid]),
      firstSender: uname,
    };

    this.danmakuRing.push(record);
    if (this.danmakuRing.length > this.maxRingCapacity) {
      this.danmakuRing.shift();
    }

    this.advance(time.monotonicTimeMs);
    return record;
  }

  private findAggregatableDanmaku(
    text: string,
    currentMonotonic: number,
    windowMs: number
  ): number {
    for (let i = this.danmakuRing.length - 1; i >= 0; i--) {
      const item = this.danmakuRing[i];
      if (currentMonotonic - item.time.monotonicTimeMs > windowMs) {
        break;
      }
      if (item.text === text) {
        return i;
      }
    }
    return -1;
  }

  advance(monotonicNow: number = performance.now()): void {
    const maxItems = this.config.viewport.maxItems;
    const minResidenceMs = this.config.viewport.minResidenceMs;

    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }

    const activeSlots: VisibleSlot[] = [];
    for (const slot of this.visibleSlots) {
      const residenceTime = monotonicNow - slot.visibleSinceMonotonic;
      if (residenceTime < minResidenceMs) {
        activeSlots.push(slot);
      }
    }

    const currentVisibleIds = new Set(activeSlots.map((s) => s.recordId));
    let nextCandidateIndex = 0;

    if (activeSlots.length > 0) {
      const lastVisibleId = activeSlots[activeSlots.length - 1].recordId;
      const lastIdx = this.danmakuRing.findIndex((d) => d.id === lastVisibleId);
      if (lastIdx !== -1) {
        nextCandidateIndex = lastIdx + 1;
      }
    }

    while (activeSlots.length < maxItems && nextCandidateIndex < this.danmakuRing.length) {
      const item = this.danmakuRing[nextCandidateIndex];
      nextCandidateIndex++;

      if (!currentVisibleIds.has(item.id)) {
        activeSlots.push({
          recordId: item.id,
          fullText: item.text,
          firstSender: item.firstSender,
          count: item.count,
          uniqueSendersCount: item.uniqueSenders.size,
          arrivalMonotonic: item.time.monotonicTimeMs,
          wallTimeMs: item.time.wallTimeMs,
          visibleSinceMonotonic: monotonicNow,
        });
        currentVisibleIds.add(item.id);
      }
    }

    this.visibleSlots = activeSlots;

    if (nextCandidateIndex < this.danmakuRing.length && this.visibleSlots.length >= maxItems) {
      let minRemaining = minResidenceMs;
      for (const slot of this.visibleSlots) {
        const remaining = minResidenceMs - (monotonicNow - slot.visibleSinceMonotonic);
        if (remaining > 0 && remaining < minRemaining) {
          minRemaining = remaining;
        }
      }

      const delay = Math.max(100, Math.ceil(minRemaining));
      this.advanceTimer = setTimeout(() => {
        this.advance(performance.now());
      }, delay);
    }
  }

  ingestSuperChat(msg: {
    id: number | string;
    uid: number;
    uname: string;
    price: number;
    message: number | string;
    timestamp?: number;
  }): { record: SuperChatRecord | null; shouldWake: boolean } {
    const time = createEventTime(msg.timestamp);
    const sourceEventKey = `bilibili:sc:${msg.id}`;

    if (this.journal.hasEventKey(sourceEventKey)) {
      return { record: null, shouldWake: false };
    }

    const alias = this.nextId("sc");
    const record: SuperChatRecord = {
      kind: "sc",
      durableId: sourceEventKey,
      sourceEventKey,
      alias,
      uid: msg.uid,
      uname: msg.uname,
      price: msg.price,
      message: String(msg.message),
      time,
      handled: false,
    };

    this.pendingEvents.set(alias, record);
    this.journal.recordEvent(record);

    const shouldWake =
      this.config.wakeup.wakeOnSuperChat &&
      msg.price >= this.config.wakeup.superChatMinPrice;

    return { record, shouldWake };
  }

  ingestGuard(msg: {
    uid: number;
    uname: string;
    guardLevel: number;
    giftName: string;
    timestamp?: number;
  }): { record: GuardRecord | null; shouldWake: boolean } {
    const timestamp = msg.timestamp ?? Date.now();
    const time = createEventTime(timestamp);
    const sourceEventKey = `bilibili:guard:${msg.uid}:${msg.guardLevel}:${timestamp}`;

    if (this.journal.hasEventKey(sourceEventKey)) {
      return { record: null, shouldWake: false };
    }

    const alias = this.nextId("gd");
    const record: GuardRecord = {
      kind: "guard",
      durableId: sourceEventKey,
      sourceEventKey,
      alias,
      uid: msg.uid,
      uname: msg.uname,
      guardLevel: msg.guardLevel,
      giftName: msg.giftName,
      time,
      handled: false,
    };

    this.pendingEvents.set(alias, record);
    this.journal.recordEvent(record);

    const shouldWake = this.config.wakeup.wakeOnGuard;
    return { record, shouldWake };
  }

  private readonly transientGifts = new Map<
    string,
    {
      uid: number;
      uname: string;
      giftId: number;
      giftName: string;
      price: number;
      count: number;
      time: EventTime;
    }
  >();

  private findAggregatableGift(
    uid: number,
    giftId: number,
    currentMonotonic: number,
    windowMs: number
  ): GiftRecord | undefined {
    for (const item of this.pendingEvents.values()) {
      if (
        item.kind === "gift" &&
        !item.handled &&
        item.uid === uid &&
        item.giftId === giftId &&
        currentMonotonic - item.time.monotonicTimeMs <= windowMs
      ) {
        return item;
      }
    }
    return undefined;
  }

  ingestGift(msg: {
    uid: number;
    uname: string;
    giftId: number;
    giftName: string;
    price: number;
    count: number;
    timestamp?: number;
  }): { record: GiftRecord | null; shouldWake: boolean } {
    const time = createEventTime(msg.timestamp);
    const windowMs = this.config.gifts.aggregationWindowMs;
    const key = `${msg.uid}:${msg.giftId}`;

    // 1. 检查是否可与已在待办中的礼物聚合
    const pendingItem = this.findAggregatableGift(
      msg.uid,
      msg.giftId,
      time.monotonicTimeMs,
      windowMs
    );

    if (pendingItem) {
      pendingItem.count += msg.count;
      this.journal.recordEvent(pendingItem);
      const shouldWake =
        pendingItem.price * pendingItem.count >= this.config.wakeup.wakeOnGiftThreshold;
      return { record: pendingItem, shouldWake };
    }

    // 2. 检查是否可与暂态小额礼物聚合
    const transient = this.transientGifts.get(key);
    let totalCount = msg.count;
    if (transient && time.monotonicTimeMs - transient.time.monotonicTimeMs <= windowMs) {
      totalCount += transient.count;
    }

    const totalBattery = msg.price * totalCount;

    // 3. 未达待办阈值：存入/更新暂态小额礼物池
    if (totalBattery < this.config.gifts.pendingThreshold) {
      this.transientGifts.set(key, {
        uid: msg.uid,
        uname: msg.uname,
        giftId: msg.giftId,
        giftName: msg.giftName,
        price: msg.price,
        count: totalCount,
        time,
      });
      return { record: null, shouldWake: false };
    }

    // 4. 达到或超过待办阈值：清理暂态缓存，转正为正式待办事件并落盘
    this.transientGifts.delete(key);

    const sourceEventKey = `bilibili:gift:${msg.uid}:${msg.giftId}:${time.wallTimeMs}`;
    if (this.journal.hasEventKey(sourceEventKey)) {
      return { record: null, shouldWake: false };
    }

    const alias = this.nextId("gf");
    const record: GiftRecord = {
      kind: "gift",
      durableId: sourceEventKey,
      sourceEventKey,
      alias,
      uid: msg.uid,
      uname: msg.uname,
      giftId: msg.giftId,
      giftName: msg.giftName,
      price: msg.price,
      count: totalCount,
      time,
      handled: false,
    };

    this.pendingEvents.set(alias, record);
    this.journal.recordEvent(record);

    const shouldWake = totalBattery >= this.config.wakeup.wakeOnGiftThreshold;
    return { record, shouldWake };
  }

  markHandled(eventId: string): ActionOutcome<{ eventId: string }> {
    const now = Date.now();
    const record = this.pendingEvents.get(eventId);

    if (!record) {
      return {
        status: "failed",
        message: `未找到 ID 为 "${sanitizeUntrustedText(eventId)}" 的待办事件（可能不存在或已被清理）。`,
      };
    }

    record.handled = true;
    record.handledAt = now;

    this.journal.recordHandled(eventId, now);
    this.journal.checkAndCompact(this.pendingEvents.values(), this.counters);

    return {
      status: "succeeded",
      message: `已将待办互动 [${eventId}] 标记为已处理。`,
      data: { eventId },
    };
  }

  getRecentDanmaku(count: number = 10): Array<{ id: string; text: string; sender: string; count: number; uniqueSenders: number }> {
    const limit = Math.max(1, Math.min(count, 50));
    const slice = this.danmakuRing.slice(-limit);

    return slice.map((item) => {
      const maxLen = this.config.filtering.maxDanmakuLength;
      const display = item.text.length > maxLen ? item.text.slice(0, maxLen) + "..." : item.text;
      return {
        id: item.id,
        text: sanitizeUntrustedText(display),
        sender: sanitizeUntrustedText(item.firstSender),
        count: item.count,
        uniqueSenders: item.uniqueSenders.size,
      };
    });
  }

  clearDanmaku(): void {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    this.danmakuRing.length = 0;
    this.visibleSlots.length = 0;
  }

  dispose(): void {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  getPendingCounts(): { superChats: number; guards: number; gifts: number } {
    let superChats = 0;
    let guards = 0;
    let gifts = 0;

    for (const event of this.pendingEvents.values()) {
      if (!event.handled) {
        if (event.kind === "sc") superChats++;
        else if (event.kind === "guard") guards++;
        else if (event.kind === "gift") gifts++;
      }
    }

    return { superChats, guards, gifts };
  }

  render(tier: "ambient" | "expanded", appState: LiveAppState): string {
    const { superChats, guards, gifts } = this.getPendingCounts();
    const isOnline = appState.roomStatus === "online";
    const statusIcon = isOnline ? "🟢 在线" : "⚪ 未开播";

    if (tier === "ambient") {
      const roomStr = appState.roomId ? `${appState.roomId}号房` : "未连接";
      return `[B站直播 ${roomStr} | ${statusIcon} | 弹幕: ${this.visibleSlots.length}条 | 待办: ${superChats}条SC, ${guards}条上舰, ${gifts}条大额礼物]`;
    }

    const titleStr = appState.roomTitle ? ` | 标题: ${sanitizeUntrustedText(appState.roomTitle)}` : "";
    // 视口协议：[bili] 开闭行对，内部裸行；工具用法指引只住在工具 description，不在视口复读。
    return [
      `[bili]`,
      `房间: ${appState.roomId ?? "未连接"} | ${statusIcon}${titleStr}`,
      ...renderPendingSection(this.pendingEvents.values()),
      ...renderDanmakuSection(
        this.visibleSlots,
        this.config.viewport.maxViewportChars,
        this.config.filtering.maxDanmakuLength,
        this.config.viewport.showTimestamps
      ),
    ].join("\n");
  }

  get bufferSize(): number {
    return this.danmakuRing.length;
  }

  get visibleSlotsCount(): number {
    return this.visibleSlots.length;
  }
}
