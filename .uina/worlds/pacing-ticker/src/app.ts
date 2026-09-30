import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldDef, ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { TickerEngine } from "./ticker-engine.js";
import type { TickerDurableState, TickerGuardrails } from "./types.js";

export interface TickerCompanionContext extends ServiceCompanionContext {
  worldDataDir?: string;
}


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
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, filePath);
  } finally {
    await rm(temp, { force: true });
  }
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
    description: "自主节拍器：提供稀疏、可避让的自主认知机会，感知时间与外部活动",
    defaultState: { enabled: false,  },
    async onStart(ctx: ServiceCompanionContext) {
      teardown();
      const c = ctx as TickerCompanionContext;
      const stateDir = c.worldDataDir ?? join(installDir(), "data");
      const stateFile = join(stateDir, "state.json");
      const configFile = join(installDir(), "config.json");
      const [initial, guardrails] = await Promise.all([loadState(stateFile), loadGuardrails(configFile)]);
      const host = {
        isBusy: () => c.isBusy?.() ?? false,
        submitOpportunity: async (text: string) => {
          if (!c.emitEvent) throw new Error("宿主未提供 emitEvent");
          await c.emitEvent({
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
      unbind = c.onActivity?.((event) => engine?.notifyActivity(event)) ?? null;
    },
    async onStop() { teardown(); },
    actions: {
      set_interval: { description: "调整自主节拍基准周期（单位：分钟，范围 1~120）", parameters: { type: "object", properties: { minutes: { type: "number" } }, required: ["minutes"] }, async run(args: Record<string, unknown>) {
        if (!engine) return "执行失败：自主节拍器未启动。";
        const minutes = typeof args.minutes === "number" ? args.minutes : Number(args.interval ?? args.min ?? args.m);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) return "参数错误：节拍基准周期必须是 1 到 120 之间的有限数字。";
        await engine.setInterval(minutes); return `已将自主节拍基准周期调整为 ${minutes} 分钟。`;
      } },
      pause: { description: "临时挂起自主唤醒", parameters: { type: "object", properties: { minutes: { type: "number" } }, required: ["minutes"] }, async run(args: Record<string, unknown>) {
        if (!engine) return "执行失败：自主节拍器未启动。";
        const minutes = typeof args.minutes === "number" ? args.minutes : Number(args.duration ?? args.m);
        if (!Number.isFinite(minutes) || minutes < 1) return "参数错误：挂起时长必须是有限的正数。";
        await engine.pause(minutes); return `自主节拍已挂起 ${minutes} 分钟。`;
      } },
      resume: { description: "提前解除挂起", async run(_args: Record<string, unknown>) {
        if (!engine) return "执行失败：自主节拍器未启动。";
        if (!engine.getStatus().isPaused) return "自主节拍当前处于运行状态，无需恢复。";
        await engine.resume(); return "自主节拍已提前解除挂起。";
      } },
      status: { description: "查看当前自主节拍器状态", run() { if (!engine) return JSON.stringify({ status: "stopped" }); const s = engine.getStatus(); return JSON.stringify({ status: s.isPaused ? "paused" : "running", baseIntervalMinutes: s.baseIntervalMinutes, effectiveIntervalMinutes: s.effectiveIntervalMinutes, idleMinutes: s.idleMinutes, remainingSeconds: s.remainingSeconds, dailyAttempts: s.dailyAttemptsUsed, dailyAttemptsLimit: s.dailyAttemptsLimit }); } },
    },
  };
  return world;
}

export const pacingTickerWorld = createPacingTickerWorld();
export default pacingTickerWorld;
