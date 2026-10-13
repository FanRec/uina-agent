import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldDef, ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { writeJsonAtomic } from "../../../../src/extensions/world-framework/json-file.js";
import { worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import { TickerEngine } from "./ticker-engine.js";
import type { TickerDurableState, TickerGuardrails, TickerReminder } from "./types.js";


function installDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * World 输入 ID 会直接进入持久化会话记录，必须跨进程重启与扩展重载保持唯一。
 */
export function createPacingOpportunityId(): string {
  return `pacing-opportunity:${randomUUID()}`;
}

export function createReminderDueId(): string {
  return `reminder-due:${randomUUID()}`;
}

function reminderSequence(reminderRef: string): number {
  const match = /^r([1-9]\d*)$/.exec(reminderRef);
  const sequence = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(sequence)) throw new Error("Ticker 提醒引用无效");
  return sequence;
}

function parseReminders(value: unknown): TickerReminder[] {
  if (!Array.isArray(value)) throw new Error("Ticker 提醒状态无效");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Ticker 提醒状态无效");
    const reminder = item as Record<string, unknown>;
    if (
      typeof reminder.reminderRef !== "string" ||
      typeof reminder.message !== "string" || reminder.message.trim().length === 0 ||
      !Number.isSafeInteger(reminder.dueAtEpochMs) || new Date(reminder.dueAtEpochMs as number).getTime() !== reminder.dueAtEpochMs
    ) throw new Error("Ticker 提醒状态无效");
    reminderSequence(reminder.reminderRef);
    if (seen.has(reminder.reminderRef)) throw new Error("Ticker 提醒引用重复");
    seen.add(reminder.reminderRef);
    return {
      reminderRef: reminder.reminderRef,
      message: reminder.message,
      dueAtEpochMs: reminder.dueAtEpochMs as number,
    };
  });
}

async function loadState(filePath: string): Promise<TickerDurableState | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Ticker 状态格式无效");
  const state = data as Record<string, unknown>;
  const usage = state.dailyAttempts;
  if (!Number.isFinite(state.baseIntervalMs) || (state.baseIntervalMs as number) < 60_000 || (state.baseIntervalMs as number) > 120 * 60_000) throw new Error("Ticker 周期状态无效");
  if (state.pausedUntilEpochMs !== null && (!Number.isSafeInteger(state.pausedUntilEpochMs) || (state.pausedUntilEpochMs as number) < 0)) throw new Error("Ticker 暂停截止时间无效");
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Ticker 用量状态无效");
  const attempts = usage as Record<string, unknown>;
  if (typeof attempts.date !== "string" || new Date(attempts.date).toDateString() !== attempts.date || !Number.isSafeInteger(attempts.count) || (attempts.count as number) < 0) throw new Error("Ticker 用量状态无效");
  const reminders = state.reminders === undefined ? [] : parseReminders(state.reminders);
  const minimumSequence = reminders.reduce((max, reminder) => Math.max(max, reminderSequence(reminder.reminderRef)), 0) + 1;
  const nextReminderSequence = state.nextReminderSequence === undefined ? minimumSequence : state.nextReminderSequence;
  if (!Number.isSafeInteger(nextReminderSequence) || (nextReminderSequence as number) < minimumSequence || (nextReminderSequence as number) < 1) throw new Error("Ticker 下一个提醒引用序号无效");
  return {
    baseIntervalMs: state.baseIntervalMs as number,
    pausedUntilEpochMs: state.pausedUntilEpochMs as number | null,
    dailyAttempts: { date: attempts.date, count: attempts.count as number },
    reminders,
    nextReminderSequence: nextReminderSequence as number,
  };
}

async function saveState(filePath: string, state: TickerDurableState): Promise<void> {
  await writeJsonAtomic(filePath, state);
}

async function loadGuardrails(filePath: string): Promise<TickerGuardrails> {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8")) as { maxDailyAttempts?: unknown };
    return { maxDailyAttempts: typeof data.maxDailyAttempts === "number" && Number.isFinite(data.maxDailyAttempts) && data.maxDailyAttempts > 0 ? data.maxDailyAttempts : null };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /ENOENT/.test(error.message))) return { maxDailyAttempts: null };
    throw error;
  }
}

function formatDueAt(epochMs: number): { dueAt: string; dueAtLocal: string; timeZone: "Asia/Shanghai" } {
  return {
    dueAt: new Date(epochMs).toISOString(),
    dueAtLocal: new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(epochMs)),
    timeZone: "Asia/Shanghai",
  };
}

function formatDelay(afterSeconds: number): string {
  let remaining = afterSeconds;
  const parts: string[] = [];
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分钟`);
  if (seconds || parts.length === 0) parts.push(`${seconds} 秒`);
  return `${parts.join("")}后到期`;
}

function hasRepresentableDeadline(afterSeconds: number): boolean {
  const dueAtEpochMs = Date.now() + afterSeconds * 1000;
  return Number.isSafeInteger(dueAtEpochMs) && new Date(dueAtEpochMs).getTime() === dueAtEpochMs;
}

function formatReminderLine(reminder: TickerReminder): string {
  const due = formatDueAt(reminder.dueAtEpochMs);
  return `${reminder.reminderRef} · ${due.dueAt} · ${due.dueAtLocal}（${due.timeZone}） · ${reminder.message}`;
}

export function createPacingTickerWorld(): WorldDef {
  let engine: TickerEngine | null = null;
  let unbind: (() => void) | null = null;

  const teardown = async () => {
    unbind?.();
    unbind = null;
    const previousEngine = engine;
    engine = null;
    await previousEngine?.stop();
  };
  const world: WorldDef = {
    name: "ticker",
    description: "自主节拍与一次性提醒；到期时再次呈现提醒内容，由你决定如何处理。",
    defaultState: { enabled: false,  },
    async onStart(ctx: ServiceCompanionContext) {
      await teardown();
      // 状态是持久数据，必须落在宿主数据目录；缺失时明确失败而不是写进源码安装目录。
      if (!ctx.worldDataDir) throw new Error("[ticker] 缺少 worldDataDir，无法持久化节拍状态");
      const stateFile = join(ctx.worldDataDir, "state.json");
      const configFile = join(installDir(), "config.json");
      const [initial, guardrails] = await Promise.all([loadState(stateFile), loadGuardrails(configFile)]);
      const host = {
        isBusy: () => ctx.isBusy?.() ?? false,
        submitOpportunity: async (text: string) => {
          if (!ctx.emitEvent) throw new Error("宿主未提供 emitEvent");
          await ctx.emitEvent({
            id: createPacingOpportunityId(),
            type: "pacing-opportunity",
            channel: "world",
            delivery: "queued",
            origin: "internal",
            text,
          });
        },
        submitReminder: async (reminder: TickerReminder) => {
          if (ctx.signal.aborted) throw new Error("Ticker 世界已停用，提醒仍待投递");
          if (!ctx.emitEvent) throw new Error("宿主未提供 emitEvent");
          await ctx.emitEvent({
            id: createReminderDueId(),
            type: "reminder-due",
            channel: "world",
            delivery: "queued",
            origin: "internal",
            text: `[提醒到期 ${reminder.reminderRef}]\n${reminder.message}`,
            data: { reminderRef: reminder.reminderRef, dueAtEpochMs: reminder.dueAtEpochMs },
          });
        },
        saveDurableState: (next: TickerDurableState) => saveState(stateFile, next),
      };
      engine = new TickerEngine(host, initial, guardrails);
      engine.start();
      unbind = ctx.onActivity?.((event) => engine?.notifyActivity(event)) ?? null;
    },
    async onStop() { await teardown(); },
    actions: {
      set_reminder: {
        description: "设置一次性提醒；到期时再次呈现提醒内容，由你决定如何处理。",
        parameters: {
          type: "object",
          properties: {
            afterSeconds: { type: "integer", minimum: 1 },
            message: { type: "string", minLength: 1 },
          },
          required: ["afterSeconds", "message"],
          additionalProperties: false,
        },
        async run(args: Record<string, unknown>) {
          if (!engine) return worldFailed("执行失败：自主节拍器未启动。", { reason: "ticker_not_started" });
          if (!Number.isSafeInteger(args.afterSeconds) || (args.afterSeconds as number) < 1 || !hasRepresentableDeadline(args.afterSeconds as number) || typeof args.message !== "string" || args.message.trim().length === 0) {
            return worldFailed("参数错误：afterSeconds 必须是至少 1 秒的正整数，message 不能为空。", { reason: "invalid_reminder" });
          }
          try {
            const afterSeconds = args.afterSeconds as number;
            const reminder = await engine.setReminder(afterSeconds, args.message as string);
            const due = formatDueAt(reminder.dueAtEpochMs);
            return worldSucceeded(`已设提醒 ${reminder.reminderRef}：${formatDelay(afterSeconds)}。`, {
              reminderRef: reminder.reminderRef,
              afterSeconds,
              ...due,
            }, "applied");
          } catch (error) {
            return worldFailed("保存提醒失败。", { reason: "reminder_save_failed", error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      list_reminders: {
        description: "查看尚未触发的提醒及到期时间。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        run() {
          if (!engine) return worldFailed("执行失败：自主节拍器未启动。", { reason: "ticker_not_started" });
          const reminders = engine.listReminders();
          if (reminders.length === 0) return worldSucceeded("没有待触发的提醒。", { reminders: [] });
          return worldSucceeded(reminders.map(formatReminderLine).join("\n"), {
            reminders: reminders.map((reminder) => ({ ...reminder, ...formatDueAt(reminder.dueAtEpochMs) })),
          });
        },
      },
      cancel_reminder: {
        description: "取消尚未触发的提醒；已入队的提醒不能撤回。",
        parameters: {
          type: "object",
          properties: { reminderRef: { type: "string", pattern: "^r[1-9]\\d*$" } },
          required: ["reminderRef"],
          additionalProperties: false,
        },
        async run(args: Record<string, unknown>) {
          if (!engine) return worldFailed("执行失败：自主节拍器未启动。", { reason: "ticker_not_started" });
          if (typeof args.reminderRef !== "string" || !/^r[1-9]\d*$/.test(args.reminderRef)) {
            return worldFailed("参数错误：reminderRef 必须是有效的提醒引用。", { reason: "invalid_reminder_ref" });
          }
          try {
            const status = await engine.cancelReminder(args.reminderRef);
            if (status === "cancelled") return worldSucceeded(`已取消提醒 ${args.reminderRef}。`, { reminderRef: args.reminderRef }, "applied");
            if (status === "already_due") return worldFailed(`提醒 ${args.reminderRef} 已到期，无法取消。`, { reason: "reminder_already_due", reminderRef: args.reminderRef });
            return worldFailed(`找不到待触发的提醒 ${args.reminderRef}。`, { reason: "reminder_not_found", reminderRef: args.reminderRef });
          } catch (error) {
            return worldFailed("取消提醒失败，提醒仍保留。", { reason: "reminder_save_failed", reminderRef: args.reminderRef, error: error instanceof Error ? error.message : String(error) });
          }
        },
      },
      set_interval: { description: "仅在调整自主唤醒策略时设置周期（1~120 分钟）；返回持久化后的周期。", parameters: { type: "object", properties: { minutes: { type: "number", minimum: 1, maximum: 120 } }, required: ["minutes"], additionalProperties: false }, async run(args: Record<string, unknown>) {
        if (!engine) return worldFailed("执行失败：自主节拍器未启动。", { reason: "ticker_not_started" });
        const minutes = typeof args.minutes === "number" ? args.minutes : Number(args.interval ?? args.min ?? args.m);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) return worldFailed("参数错误：节拍基准周期必须是 1 到 120 之间的有限数字。", { reason: "invalid_interval" });
        await engine.setInterval(minutes); return worldSucceeded(`已将自主节拍基准周期调整为 ${minutes} 分钟。`, undefined, "applied");
      } },
      pause: { description: "临时挂起自主唤醒；仅在需要让主体暂时不产生机会时使用，返回持久化结果。", parameters: { type: "object", properties: { minutes: { type: "number", minimum: 1 } }, required: ["minutes"], additionalProperties: false }, async run(args: Record<string, unknown>) {
        if (!engine) return worldFailed("执行失败：自主节拍器未启动。", { reason: "ticker_not_started" });
        const minutes = typeof args.minutes === "number" ? args.minutes : Number(args.duration ?? args.m);
        if (!Number.isFinite(minutes) || minutes < 1) return worldFailed("参数错误：挂起时长必须是有限的正数。", { reason: "invalid_pause" });
        await engine.pause(minutes); return worldSucceeded(`自主节拍已挂起 ${minutes} 分钟。`, undefined, "applied");
      } },
      resume: { description: "提前解除自主唤醒挂起；不在暂停状态时返回无需操作。", parameters: { type: "object", properties: {}, additionalProperties: false }, async run(_args: Record<string, unknown>) {
        if (!engine) return worldFailed("执行失败：自主节拍器未启动。", { reason: "ticker_not_started" });
        if (!engine.getStatus().isPaused) return worldSucceeded("自主节拍当前处于运行状态，无需恢复。", undefined, "applied");
        await engine.resume(); return worldSucceeded("自主节拍已提前解除挂起。", undefined, "applied");
      } },
      status: { description: "查询自主节拍状态；暂停只影响周期，remainingSeconds 表示周期与提醒中的下一次唤醒。", parameters: { type: "object", properties: {}, additionalProperties: false }, run() { if (!engine) return worldSucceeded(JSON.stringify({ status: "stopped" })); const s = engine.getStatus(); return worldSucceeded(JSON.stringify({ status: s.isPaused ? "paused" : "running", baseIntervalMinutes: s.baseIntervalMinutes, effectiveIntervalMinutes: s.effectiveIntervalMinutes, idleMinutes: s.idleMinutes, remainingSeconds: s.remainingSeconds, dailyAttempts: s.dailyAttemptsUsed, dailyAttemptsLimit: s.dailyAttemptsLimit })); } },
    },
  };
  return world;
}

export const pacingTickerWorld = createPacingTickerWorld();
export default pacingTickerWorld;
