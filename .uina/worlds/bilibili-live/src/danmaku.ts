import { randomUUID } from "node:crypto";
import type { InputSettledEvent } from "../../../../src/runtime/events.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ResolvedLiveWorldConfig } from "./config.js";
import type { CanonicalLiveDanmaku } from "./normalize.js";

type Observation = CanonicalLiveDanmaku & {
 readonly sequence: number;
 readonly roomId: number | null;
 readonly receivedAtMs: number;
};
type Delivery = {
 readonly id: string;
 readonly epoch: number;
 readonly roomId: number | null;
 accepted: boolean;
 body?: string;
};

function shouldFilterDanmaku(text: string, filtering: { filterKeywords: string[]; ignoreEmojiOnly: boolean }): boolean {
 if (!text) return true;
 if (filtering.filterKeywords.some((keyword) => text.includes(keyword))) return true;
 return filtering.ignoreEmojiOnly && /^\[[^\]]+\]$/.test(text);
}

// Quoting protects the line format, not the model from every form of prompt injection.
function quote(value: string): string {
 return JSON.stringify(value).replace(/[\u2028\u2029]/g, (char) => char === "\u2028" ? "\\u2028" : "\\u2029");
}
function formatMessages(records: readonly Observation[], config: ResolvedLiveWorldConfig): string {
 const groups: Array<{ record: Observation; count: number; lastTime: number }> = [];
 for (const record of records) {
  const previous = groups.at(-1);
  if (previous && previous.record.uid === record.uid && previous.record.uname === record.uname &&
      previous.record.text === record.text && record.receivedAtMs - previous.lastTime <= config.buffer.aggregationWindowMs) {
   previous.count++;
   previous.lastTime = record.receivedAtMs;
  } else groups.push({ record, count: 1, lastTime: record.receivedAtMs });
 }
 const users = new Map<string, { ref: string; identity: string }>();
 const direct: string[] = [], referenced: string[] = [];
 for (const { record, count } of groups) {
  const identity = quote(record.uname) + "(" + quote(String(record.uid)) + ")";
  let user = users.get(identity);
  if (!user) {
   user = { ref: "u" + (users.size + 1), identity };
   users.set(identity, user);
  }
  const max = config.filtering.maxDanmakuLength;
  const text = quote(record.text.length > max ? record.text.slice(0, max) + "…" : record.text);
  const content = text + (count > 1 ? " ×" + count : "");
  direct.push(identity + ": " + content);
  referenced.push(user.ref + ": " + content);
 }
 const plain = direct.join("\n");
 const compact = [...users.values()].map(user => user.ref + "=" + user.identity).join("\n") + "\n" + referenced.join("\n");
 return compact.length < plain.length ? compact : plain;
}

/** One raw observation window and one unsettled input. Important interactions remain in the journal. */
export class DanmakuWindow {
 private readonly records: Observation[] = [];
 private sequence = 0;
 private handedThrough = 0;
 private covered = 0;
 private epoch = 0;
 private roomId: number | null = null;
 private roomShown = false;
 private enabled = false;
 private active = false;
 private timer: NodeJS.Timeout | null = null;
 private pending: Delivery | null = null;
 private emitEvent: ServiceCompanionContext["emitEvent"];
 private unsubscribe: (() => void) | undefined;
 private activationId = "";
 private deliverySequence = 0;
 private lastError: string | null = null;
 private available = false;

 constructor(private readonly config: ResolvedLiveWorldConfig) {}

 start(ctx: ServiceCompanionContext): void {
  this.activationId = randomUUID();
  this.active = true;
  this.emitEvent = ctx.emitEvent;
  this.available = !!ctx.emitEvent && !!ctx.onHostEvent;
  if (!this.available) {
   this.lastError = "主动弹幕通知不可用：缺少事件出口或输入结算订阅。";
   console.warn("[bilibili-live] " + this.lastError);
  } else {
   this.lastError = null;
   this.unsubscribe = ctx.onHostEvent!((event) => {
    if (event.type === "input_accepted") {
     const pending = this.pending;
     if (pending !== null && pending.id === event.inputId) pending.accepted = true;
    }
    if (event.type === "input_settled") this.settle(event as InputSettledEvent);
   });
  }
 }

 stop(): void {
  this.active = false;
  this.reset(null);
  this.unsubscribe?.();
  this.unsubscribe = undefined;
  this.emitEvent = undefined;
  this.available = false;
  this.pending = null;
 }

 /** A new manual connection period, clear, or disconnect invalidates deferred bodies. */
 reset(roomId: number | null): void {
  this.invalidate();
  this.records.length = 0;
  this.roomId = roomId;
  this.roomShown = false;
 }

 /** roomInfo may resolve a short room id; it is still the same connection period. */
 resolveRoom(roomId: number): void { this.roomId = roomId; }

 setEnabled(enabled: boolean): void {
  if (this.enabled === enabled) return;
  this.invalidate();
  this.enabled = enabled;
 }

 private invalidate(): void {
  this.epoch++;
  if (this.timer) clearTimeout(this.timer);
  this.timer = null;
  this.handedThrough = this.sequence;
  this.covered = 0;
  // An accepted input still belongs to Subject until committed or retired.
 }

 add(event: CanonicalLiveDanmaku, receivedAtMs = performance.now()): void {
  const text = event.text.trim();
  if (shouldFilterDanmaku(text, this.config.filtering)) return;
  this.records.push({ ...event, text, sequence: ++this.sequence, roomId: this.roomId, receivedAtMs });
  if (this.records.length > this.config.buffer.maxItems) {
   const removed = this.records.shift()!;
   if (removed.sequence > this.handedThrough && this.enabled) this.covered++;
  }
  if (!this.enabled) this.handedThrough = this.sequence;
  this.schedule();
 }

 private notificationStatus(): "unavailable" | "off" | "unsettled" | "batching" | "idle" {
  if (!this.active || !this.available) return "unavailable";
  if (!this.enabled) return "off";
  if (this.pending) return "unsettled";
  if (this.timer) return "batching";
  return "idle";
 }

 private schedule(): void {
  if (!this.active || !this.available || !this.enabled || this.timer || this.pending || this.sequence <= this.handedThrough) return;
  this.timer = setTimeout(() => {
   this.timer = null;
   this.deliver();
  }, 2000);
 }

 private deliver(): void {
  const emitEvent = this.emitEvent;
  if (!this.active || !this.enabled || this.pending || !emitEvent) return;
  const delivery: Delivery = {
   id: "bilibili:chat:" + this.activationId + ":" + (++this.deliverySequence),
   epoch: this.epoch,
   roomId: this.roomId,
   accepted: false,
  };
  this.pending = delivery;
  try {
   void emitEvent({
    id: delivery.id, type: "chat-messages", channel: "world", delivery: "queued", origin: "external",
    data: { roomId: delivery.roomId, epoch: delivery.epoch },
    render: () => this.render(delivery),
   }).catch(error => this.reject(delivery, error));
  } catch (error) { this.reject(delivery, error); }
 }

 private reject(delivery: Delivery, error: unknown): void {
  if (this.pending !== delivery) return;
  if (!delivery.accepted) this.pending = null;
  if (delivery.epoch !== this.epoch || !this.active) { this.schedule(); return; }
  this.lastError = error instanceof Error ? error.message : String(error);
  console.error("[bilibili-live] 弹幕投递失败:", error);
  // No speculative retry: a rejected admission retries only on the next real arrival.
 }

 private render(delivery: Delivery): string | null {
  if (!this.active || !this.enabled || delivery.epoch !== this.epoch || this.pending !== delivery) return null;
  if (delivery.body !== undefined) return delivery.body;
  const records = this.records.filter(record => record.sequence > this.handedThrough);
  if (!records.length) return null;
  const labels = ["弹幕"];
  if (!this.roomShown && delivery.roomId !== null) labels.push("房间" + delivery.roomId);
  if (this.covered) labels.push("覆盖" + this.covered + "条");
  const lastRecord = records[records.length - 1]!;
  const age = Math.floor(Math.max(0, performance.now() - lastRecord.receivedAtMs) / 1000);
  if (age >= 10) labels.push("约" + age + "秒前");
  delivery.body = "[" + labels.join("｜") + "]\n" + formatMessages(records, this.config);
  this.handedThrough = lastRecord.sequence;
  this.covered = 0;
  return delivery.body;
 }

 private settle(event: InputSettledEvent): void {
  const delivery = this.pending;
  if (!delivery || event.inputId !== delivery.id) return;
  if (delivery.epoch === this.epoch) {
   if (event.outcome === "committed") {
    this.roomShown = true;
    this.lastError = null;
   } else if (delivery.body === undefined) {
    // Withdraw the entire observation accumulated behind an unopened input.
    this.handedThrough = this.sequence;
    this.covered = 0;
   }
  }
  this.pending = null;
  this.schedule();
 }

 recent(count = 10): string {
  const records = this.records.slice(-Math.max(1, Math.min(count, this.config.buffer.maxItems)));
  return records.length ? "[弹幕查询]\n" + formatMessages(records, this.config) : "当前窗口暂无弹幕。";
 }

 get size(): number { return this.records.length; }
 status(): Record<string, unknown> {
  return {
   capacity: this.config.buffer.maxItems,
   retained: this.records.length,
   unhanded: this.records.filter(record => record.sequence > this.handedThrough).length,
   covered: this.covered,
   notification: this.notificationStatus(),
   lastDeliveryError: this.lastError,
  };
 }
}
