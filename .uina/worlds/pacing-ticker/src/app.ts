import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldDef, ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { writeJsonAtomic } from "../../../../src/extensions/world-framework/json-file.js";
import { worldFailed, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import { TickerEngine } from "./ticker-engine.js";
import type { TickerDurableState, TickerGuardrails } from "./types.js";


function installDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * World 输入 ID 会直接进入持久化会话记录，必须跨进程重启与扩展重载保持唯一。
 */
export function createPacingOpportunityId(): string {
  return `pacing-opportunity:${randomUUID()}`;
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
  return { baseIntervalMs: state.baseIntervalMs as number, pausedUntilEpochMs: state.pausedUntilEpochMs as number | null, dailyAttempts: { date: attempts.date, count: attempts.count as number } };
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

export function createPacingTickerWorld(): WorldDef {
  let engine: TickerEngine | null = null;
  let unbind: (() => void) | null = null;

  const teardown = () => {
    unbind?.();
    unbind = null;
    engine?.stop();
    engine = null;
  };
  const world: WorldDef = {
    name: "ticker",
    description: "低频自主唤醒调度；主体无需每轮调用。status 查询节拍，set_interval/pause/resume 只在调整自主策略时使用。",
    defaultState: { enabled: false,  },
    async onStart(ctx: ServiceCompanionContext) {
      teardown();
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
        saveDurableState: (next: TickerDurableState) => saveState(stateFile, next),
      };
      engine = new TickerEngine(host, initial, guardrails);
      engine.start();
      unbind = ctx.onActivity?.((event) => engine?.notifyActivity(event)) ?? null;
    },
    async onStop() { teardown(); },
    actions: {
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
      status: { description: "查询自主节拍器状态；只读，返回暂停、周期、空闲时间和日配额。", parameters: { type: "object", properties: {}, additionalProperties: false }, run() { if (!engine) return worldSucceeded(JSON.stringify({ status: "stopped" })); const s = engine.getStatus(); return worldSucceeded(JSON.stringify({ status: s.isPaused ? "paused" : "running", baseIntervalMinutes: s.baseIntervalMinutes, effectiveIntervalMinutes: s.effectiveIntervalMinutes, idleMinutes: s.idleMinutes, remainingSeconds: s.remainingSeconds, dailyAttempts: s.dailyAttemptsUsed, dailyAttemptsLimit: s.dailyAttemptsLimit })); } },
    },
  };
  return world;
}

export const pacingTickerWorld = createPacingTickerWorld();
export default pacingTickerWorld;
