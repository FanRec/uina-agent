import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionContext, AppDef, ServiceCompanionContext } from "../../../../src/extensions/app-framework/types.js";
import { TickerEngine } from "./ticker-engine.js";
import type { TickerDurableState, TickerGuardrails } from "./types.js";

export interface TickerCompanionContext extends ServiceCompanionContext {
  appDataDir?: string;
}

let lastEngineForInspection: TickerEngine | null = null;
export function getTickerEngine(): TickerEngine | null { return lastEngineForInspection; }
export function setTickerEngineForTest(engine: TickerEngine | null): void { lastEngineForInspection = engine; }

function installDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function loadState(filePath: string): Promise<TickerDurableState | undefined> {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8")) as Partial<TickerDurableState>;
    if (!data || typeof data.baseIntervalMs !== "number" || !Number.isFinite(data.baseIntervalMs)) {
      throw new Error("Ticker 状态格式无效");
    }
    const paused = data.pausedUntilEpochMs;
    if (paused !== null && (typeof paused !== "number" || !Number.isFinite(paused))) {
      throw new Error("Ticker 暂停截止时间无效");
    }
    const usage = data.dailyWakeUsage;
    if (!usage || typeof usage.date !== "string" || typeof usage.count !== "number" || !Number.isFinite(usage.count)) {
      throw new Error("Ticker 用量状态无效");
    }
    return { baseIntervalMs: data.baseIntervalMs, pausedUntilEpochMs: paused ?? null, dailyWakeUsage: { ...usage } };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /ENOENT/.test(error.message))) return undefined;
    throw error;
  }
}

async function saveState(filePath: string, state: TickerDurableState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

async function loadGuardrails(filePath: string): Promise<TickerGuardrails> {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8")) as { maxDailyWakes?: unknown };
    return { maxDailyWakes: typeof data.maxDailyWakes === "number" && Number.isFinite(data.maxDailyWakes) && data.maxDailyWakes > 0 ? data.maxDailyWakes : null };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /ENOENT/.test(error.message))) return { maxDailyWakes: null };
    throw error;
  }
}

export function createPacingTickerApp(): AppDef {
  let engine: TickerEngine | null = null;
  let unbind: (() => void) | null = null;
  let currentTier: "hidden" | "ambient" | "expanded" = "ambient";

  const teardown = () => {
    unbind?.();
    unbind = null;
    engine?.stop();
    engine = null;
    lastEngineForInspection = null;
  };

  const render = (tier: "ambient" | "expanded"): string => {
    if (!engine) return "";
    const s = engine.getStatus();
    if (tier === "ambient") {
      const state = s.isPaused ? "暂停中" : `${s.baseIntervalMinutes}m`;
      return `[ticker] 节拍: ${state} | 静默: ${s.idleMinutes}m`;
    }
    const limit = s.dailyWakesLimit === null ? "无限制" : String(s.dailyWakesLimit);
    return `[ticker]\n状态: ${s.isPaused ? "暂停中" : "运行中"} | 下次机会: ${s.remainingSeconds}s\n节拍: 基准 ${s.baseIntervalMinutes}m / 实际退避 ${s.effectiveIntervalMinutes}m\n静默: ${s.idleMinutes}m | 今日尝试: ${s.dailyWakesUsed} / ${limit}\n[/ticker]`;
  };

  const app: AppDef = {
    name: "ticker",
    description: "自主节拍器：提供稀疏、可避让的自主认知机会，感知时间与外部活动",
    defaultState: { enabled: false, tier: "ambient" },
    async onStart(ctx: ServiceCompanionContext) {
      teardown();
      const c = ctx as TickerCompanionContext;
      const stateDir = c.appDataDir ?? join(installDir(), "data");
      const stateFile = join(stateDir, "state.json");
      const configFile = join(installDir(), "config.json");
      const [initial, guardrails] = await Promise.all([loadState(stateFile), loadGuardrails(configFile)]);
      const host = {
        isBusy: () => c.isBusy?.() ?? false,
        submitOpportunity: async (text: string) => {
          if (!c.submitInput) throw new Error("宿主未提供 submitInput");
          await c.submitInput({ id: `pacing-opportunity-${Date.now()}`, mode: "followUp", source: { kind: "runtime", type: "pacing-opportunity" }, text });
        },
        saveDurableState: (next: TickerDurableState) => saveState(stateFile, next),
      };
      engine = new TickerEngine(host, initial, guardrails);
      lastEngineForInspection = engine;
      engine.start();
      unbind = c.onActivity?.((event) => engine?.notifyActivity(event)) ?? null;
      ctx.signal.addEventListener("abort", teardown, { once: true });
    },
    async onStop() { teardown(); },
    render,
    actions: {
      set_interval: { description: "调整自主节拍基准周期（单位：分钟，范围 1~120）", parameters: { type: "object", properties: { minutes: { type: "number" } }, required: ["minutes"] }, async run(args: Record<string, unknown>, ctx: ActionContext) {
        if (!engine) return "执行失败：自主节拍器未启动。";
        const minutes = typeof args.minutes === "number" ? args.minutes : Number(args.interval ?? args.min ?? args.m);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) return "参数错误：节拍基准周期必须是 1 到 120 之间的有限数字。";
        await engine.setInterval(minutes); currentTier = "ambient"; ctx.setTier(currentTier); return `已将自主节拍基准周期调整为 ${minutes} 分钟。`;
      } },
      pause: { description: "临时挂起自主唤醒", parameters: { type: "object", properties: { minutes: { type: "number" } }, required: ["minutes"] }, async run(args: Record<string, unknown>, ctx: ActionContext) {
        if (!engine) return "执行失败：自主节拍器未启动。";
        const minutes = typeof args.minutes === "number" ? args.minutes : Number(args.duration ?? args.m);
        if (!Number.isFinite(minutes) || minutes < 1) return "参数错误：挂起时长必须是有限的正数。";
        await engine.pause(minutes); currentTier = "ambient"; ctx.setTier(currentTier); return `自主节拍已挂起 ${minutes} 分钟。`;
      } },
      resume: { description: "提前解除挂起", async run(_args: Record<string, unknown>, ctx: ActionContext) {
        if (!engine) return "执行失败：自主节拍器未启动。";
        if (!engine.getStatus().isPaused) return "自主节拍当前处于运行状态，无需恢复。";
        await engine.resume(); currentTier = "ambient"; ctx.setTier(currentTier); return "自主节拍已提前解除挂起。";
      } },
      status: { description: "查看当前自主节拍器状态", run() { if (!engine) return JSON.stringify({ status: "stopped" }); const s = engine.getStatus(); return JSON.stringify({ status: s.isPaused ? "paused" : "running", baseIntervalMinutes: s.baseIntervalMinutes, effectiveIntervalMinutes: s.effectiveIntervalMinutes, idleMinutes: s.idleMinutes, remainingSeconds: s.remainingSeconds, dailyAttempts: s.dailyWakesUsed, dailyAttemptsLimit: s.dailyWakesLimit }); } },
    },
  };
  return app;
}

export const pacingTickerApp = createPacingTickerApp();
export default pacingTickerApp;
