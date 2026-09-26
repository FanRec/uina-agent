import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type {
  SuperChatRecord,
  GuardRecord,
  GiftRecord,
  PendingEventRecord,
  StorageConfig,
} from "./types.js";

/**
 * 日志持久化条目联合类型
 */
export type JournalEntry =
  | { op: "sc"; record: SuperChatRecord }
  | { op: "guard"; record: GuardRecord }
  | { op: "gift"; record: GiftRecord }
  | { op: "handled"; id: string; handledAt: number }
  | {
      op: "meta";
      lastCounters: Record<string, number>;
      recentEventKeys?: string[];
    };

/**
 * 恢复后的待办数据与计数器快照
 */
export interface JournalSnapshot {
  pendingEvents: Map<string, PendingEventRecord>;
  knownEventKeys: Set<string>;
  counters: {
    sc: number;
    gd: number;
    gf: number;
    dm: number;
  };
  totalEntriesCount: number;
}

function updateCounter(
  id: string,
  prefix: "sc" | "gd" | "gf",
  counters: { sc: number; gd: number; gf: number; dm: number }
): void {
  const parts = id.split("_");
  if (parts.length === 2) {
    const num = parseInt(parts[1], 10);
    if (!Number.isNaN(num) && num > counters[prefix]) {
      counters[prefix] = num;
    }
  }
}

function applyMetaEntry(
  entry: Extract<JournalEntry, { op: "meta" }>,
  counters: { sc: number; gd: number; gf: number; dm: number },
  knownEventKeys: Set<string>
): void {
  if (entry.lastCounters) {
    if (typeof entry.lastCounters.sc === "number") counters.sc = Math.max(counters.sc, entry.lastCounters.sc);
    if (typeof entry.lastCounters.gd === "number") counters.gd = Math.max(counters.gd, entry.lastCounters.gd);
    if (typeof entry.lastCounters.gf === "number") counters.gf = Math.max(counters.gf, entry.lastCounters.gf);
    if (typeof entry.lastCounters.dm === "number") counters.dm = Math.max(counters.dm, entry.lastCounters.dm);
  }
  if (Array.isArray(entry.recentEventKeys)) {
    for (const key of entry.recentEventKeys) {
      if (key) knownEventKeys.add(key);
    }
  }
}

const PREFIX_MAP: Record<string, "sc" | "gd" | "gf"> = {
  sc: "sc",
  guard: "gd",
  gift: "gf",
};

function applyEventRecordEntry(
  entry: Extract<JournalEntry, { op: "sc" | "guard" | "gift" }>,
  pendingEvents: Map<string, PendingEventRecord>,
  counters: { sc: number; gd: number; gf: number; dm: number },
  knownEventKeys: Set<string>
): void {
  const record = { ...entry.record, kind: entry.op };
  const alias = record.alias;
  pendingEvents.set(alias, record as PendingEventRecord);
  if (record.sourceEventKey) {
    knownEventKeys.add(record.sourceEventKey);
  }
  const prefix = PREFIX_MAP[entry.op] ?? "sc";
  updateCounter(alias, prefix, counters);
}

/**
 * 单条日志应用逻辑（纯函数，低圈复杂度）
 */
export function applyJournalEntry(
  entry: JournalEntry,
  pendingEvents: Map<string, PendingEventRecord>,
  counters: { sc: number; gd: number; gf: number; dm: number },
  knownEventKeys: Set<string>
): void {
  if (entry.op === "sc" || entry.op === "guard" || entry.op === "gift") {
    applyEventRecordEntry(entry, pendingEvents, counters, knownEventKeys);
  } else if (entry.op === "handled") {
    const target = pendingEvents.get(entry.id);
    if (target) {
      target.handled = true;
      target.handledAt = entry.handledAt;
    }
  } else if (entry.op === "meta") {
    applyMetaEntry(entry, counters, knownEventKeys);
  }
}

/**
 * B站直播待办事件持久化日志（App Durable Journal）
 */
export class LiveEventJournal {
  private readonly filePath: string;
  private readonly dataDir: string;
  private readonly compactionThreshold: number;
  private readonly knownEventKeys = new Set<string>();
  private entriesCount = 0;

  constructor(storageConfig: StorageConfig) {
    this.dataDir = storageConfig.dataDir;
    this.compactionThreshold = storageConfig.journalCompactionThreshold;
    this.filePath = join(this.dataDir, "events.jsonl");
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * 启动时从 events.jsonl 重放恢复状态
   */
  recover(): JournalSnapshot {
    this.ensureDataDir();

    const pendingEvents = new Map<string, PendingEventRecord>();
    const counters = { sc: 0, gd: 0, gf: 0, dm: 0 };
    this.knownEventKeys.clear();

    if (!existsSync(this.filePath)) {
      return {
        pendingEvents,
        knownEventKeys: this.knownEventKeys,
        counters,
        totalEntriesCount: 0,
      };
    }

    const content = readFileSync(this.filePath, "utf-8");
    const lines = content.split("\n");
    let count = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      count++;

      try {
        const entry = JSON.parse(trimmed) as JournalEntry;
        applyJournalEntry(entry, pendingEvents, counters, this.knownEventKeys);
      } catch {
        // 容错忽略损坏行
      }
    }

    this.entriesCount = count;

    return {
      pendingEvents,
      knownEventKeys: this.knownEventKeys,
      counters,
      totalEntriesCount: count,
    };
  }

  /**
   * 检查事件是否已经记录（重连幂等性去重）
   */
  hasEventKey(sourceEventKey: string): boolean {
    return this.knownEventKeys.has(sourceEventKey);
  }

  /**
   * 追加一条日志记录
   */
  append(entry: JournalEntry): void {
    try {
      this.ensureDataDir();
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.filePath, line, "utf-8");
      this.entriesCount++;
    } catch (err) {
      console.error("[bilibili-live] 写入 events.jsonl 失败:", err);
    }
  }

  /**
   * 记录待办事件
   */
  recordEvent(record: PendingEventRecord): boolean {
    if (this.knownEventKeys.has(record.sourceEventKey)) {
      return false; // 重连幂等丢弃
    }
    this.knownEventKeys.add(record.sourceEventKey);
    this.append({ op: record.kind, record } as JournalEntry);
    return true;
  }

  recordSuperChat(record: SuperChatRecord): boolean {
    return this.recordEvent({ ...record, kind: "sc" });
  }

  recordGuard(record: GuardRecord): boolean {
    return this.recordEvent({ ...record, kind: "guard" });
  }

  recordGift(record: GiftRecord): boolean {
    return this.recordEvent({ ...record, kind: "gift" });
  }

  recordHandled(id: string, handledAt: number = Date.now()): void {
    this.append({ op: "handled", id, handledAt });
  }

  checkAndCompact(
    activeEvents: Iterable<PendingEventRecord>,
    currentCounters: Record<string, number>
  ): boolean {
    if (this.entriesCount < this.compactionThreshold) {
      return false;
    }
    this.compact(activeEvents, currentCounters);
    return true;
  }

  compact(
    activeEvents: Iterable<PendingEventRecord>,
    currentCounters: Record<string, number>
  ): void {
    this.ensureDataDir();
    const tmpPath = `${this.filePath}.tmp`;

    const lines: string[] = [];
    const recentKeys = Array.from(this.knownEventKeys).slice(-500);

    lines.push(
      JSON.stringify({
        op: "meta",
        lastCounters: { ...currentCounters },
        recentEventKeys: recentKeys,
      })
    );

    for (const event of activeEvents) {
      if (!event.handled) {
        lines.push(JSON.stringify({ op: event.kind, record: event }));
      }
    }

    writeFileSync(tmpPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
    renameSync(tmpPath, this.filePath);
    this.entriesCount = lines.length;
  }

  get totalEntries(): number {
    return this.entriesCount;
  }
}
