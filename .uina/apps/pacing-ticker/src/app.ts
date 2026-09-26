import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ActionContext,
	AppDef,
	ServiceCompanionContext,
} from "../../../../src/extensions/app-framework/types.js";
import { TickerEngine } from "./ticker-engine.js";
import type { TickerDurableState, TickerGuardrails } from "./types.js";

/**
 * 宿主扩展伴生上下文
 */
export interface TickerCompanionContext extends ServiceCompanionContext {
	submitInput?: (input: import("../../../../src/agent/loop.js").AgentInput) => Promise<void>;
	isBusy?: () => boolean;
	appDataDir?: string;
	onActivity?: (listener: (event: { origin: "human" | "external" | "runtime" }) => void) => () => void;
}

// 内部单例引用与活动监听解绑器 (生命周期由 onStart/onStop 管理)
let engineInstance: TickerEngine | null = null;
let unbindActivityListener: (() => void) | null = null;

export function getTickerEngine(): TickerEngine | null {
	return engineInstance;
}

export function setTickerEngineForTest(engine: TickerEngine | null): void {
	engineInstance = engine;
}

/**
 * 解析 App 状态存放目录 (优先尊重传入的 appDataDir，默认回退到本包真实物理根目录)
 */
function resolveAppDataDir(injectedDir?: string): string {
	if (injectedDir) return injectedDir;
	try {
		const currentFile = fileURLToPath(import.meta.url);
		return join(dirname(currentFile), "..");
	} catch {
		return join(process.cwd(), ".uina/apps/pacing-ticker");
	}
}

/**
 * 加载持久化状态 (带健壮的 clamp 防御)
 */
async function loadDurableState(filePath: string): Promise<TickerDurableState | undefined> {
	try {
		const raw = await readFile(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (typeof data !== "object" || data === null) return undefined;

		const rawInterval = typeof data.baseIntervalMs === "number" ? data.baseIntervalMs : 180_000;
		// 限制在 1 分钟到 120 分钟范围内
		const baseIntervalMs = Math.max(60_000, Math.min(120 * 60_000, rawInterval));
		const pausedUntilEpochMs = typeof data.pausedUntilEpochMs === "number" ? data.pausedUntilEpochMs : null;

		return {
			baseIntervalMs,
			pausedUntilEpochMs,
			dailyWakeUsage: {
				date: String(data.dailyWakeUsage?.date ?? new Date().toDateString()),
				count: typeof data.dailyWakeUsage?.count === "number" && data.dailyWakeUsage.count >= 0
					? data.dailyWakeUsage.count
					: 0,
			},
		};
	} catch {
		return undefined;
	}
}

/**
 * 保存持久化状态
 */
async function saveDurableState(filePath: string, state: TickerDurableState): Promise<void> {
	try {
		await mkdir(dirname(filePath), { recursive: true });
		const payload = JSON.stringify(state, null, 2);
		await writeFile(filePath, payload, "utf-8");
	} catch (error) {
		console.warn(`[pacing-ticker] 保存状态失败 (${filePath}):`, error);
	}
}

/**
 * 加载人类资源护栏配置 (config.json)
 */
async function loadGuardrailsConfig(filePath: string): Promise<TickerGuardrails> {
	try {
		const raw = await readFile(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (typeof data !== "object" || data === null) {
			return { maxDailyWakes: null };
		}
		const maxDailyWakes =
			typeof data.maxDailyWakes === "number" && data.maxDailyWakes > 0 ? data.maxDailyWakes : null;
		return { maxDailyWakes };
	} catch {
		return { maxDailyWakes: null };
	}
}

/**
 * 视口渲染实现 (~15 Tokens 紧凑感知 / 纯数据展开面板)
 *
 * 视口协议：ambient 单行短前缀；expanded 用 [ticker] 开闭行对，内部裸行字段。
 * 禁入：装饰线、## 标题、app 自报全名（框架已加 [App: name] 前缀）、当前时间
 * （每分钟漂移字段会击穿 eventId 内容寻址与前缀缓存——需要精确时间时模型自行查系统）。
 */
function renderTickerViewport(tier: "ambient" | "expanded"): string {
	if (!engineInstance) return "";

	const s = engineInstance.getStatus();

	if (tier === "ambient") {
		const now = new Date();
		const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
		const stateDesc = s.isPaused ? "暂停中" : `${s.baseIntervalMinutes}m`;
		return `[ticker] ${timeStr} (${weekday}) | 节拍: ${stateDesc} | 静默: ${s.idleMinutes}m`;
	}

	const limitStr = s.dailyWakesLimit === null ? "无限制" : `${s.dailyWakesLimit}`;
	return `[ticker]
状态: ${s.isPaused ? "暂停中" : "运行中"} | 下次机会: ${s.remainingSeconds}s
节拍: 基准 ${s.baseIntervalMinutes}m / 实际退避 ${s.effectiveIntervalMinutes}m
静默: ${s.idleMinutes}m | 今日唤醒: ${s.dailyWakesUsed} / ${limitStr}
[/ticker]`;
}

/**
 * 清理引擎与所有绑定的监听器 (杜绝内存泄漏)
 */
function teardownApp(): void {
	if (unbindActivityListener) {
		unbindActivityListener();
		unbindActivityListener = null;
	}
	if (engineInstance) {
		engineInstance.stop();
		engineInstance = null;
	}
}

export const pacingTickerApp: AppDef = {
	name: "ticker",
	description: "自主节拍器：提供稀疏、可避让的自主认知机会，感知时间与外部活动",

	defaultState: {
		enabled: false,
		tier: "ambient",
	},

	async onStart(ctx: ServiceCompanionContext): Promise<void> {
		// 启动前先确保旧资源彻底释放
		teardownApp();

		const companionCtx = ctx as TickerCompanionContext;
		const appDir = resolveAppDataDir(companionCtx.appDataDir);
		const dataFile = join(appDir, "data/state.json");
		const configFile = join(appDir, "config.json");

		const guardrails = await loadGuardrailsConfig(configFile);
		const initialDurable = await loadDurableState(dataFile);

		const hostPort = {
			isBusy: () => companionCtx.isBusy?.() ?? false,
			submitOpportunity: async (text: string) => {
				if (companionCtx.submitInput) {
					await companionCtx.submitInput({
						id: `pacing-opportunity-${Date.now()}`,
						mode: "followUp",
						source: {
							kind: "runtime",
							type: "pacing-opportunity",
						},
						text,
					});
				}
			},
			saveDurableState: async (state: TickerDurableState) => {
				await saveDurableState(dataFile, state);
			},
		};

		engineInstance = new TickerEngine(hostPort, initialDurable, guardrails);
		engineInstance.start();

		if (companionCtx.onActivity) {
			unbindActivityListener = companionCtx.onActivity((event) => {
				engineInstance?.notifyActivity(event);
			});
		}

		ctx.signal.addEventListener("abort", () => {
			teardownApp();
		});
	},

	async onStop(): Promise<void> {
		teardownApp();
	},

	render(tier: "ambient" | "expanded"): string {
		return renderTickerViewport(tier);
	},

	actions: {
		set_interval: {
			description: "调整自主节拍基准周期（单位：分钟，范围 1~120）",
			parameters: {
				type: "object",
				properties: {
					minutes: { type: "number", description: "节拍周期分钟数 (1~120)" },
				},
				required: ["minutes"],
			},
			async run(args: Record<string, unknown>, ctx: ActionContext) {
				if (!engineInstance) return "执行失败：自主节拍器未启动。";

				const rawMinutes = args.minutes ?? args.interval ?? args.min ?? args.m;
				const minutes = typeof rawMinutes === "number" ? rawMinutes : parseFloat(String(rawMinutes ?? ""));

				if (Number.isNaN(minutes) || minutes < 1 || minutes > 120) {
					return "参数错误：节拍基准周期必须是 1 到 120 之间的数字（单位：分钟）。例如 { minutes: 5 }。";
				}

				await engineInstance.setInterval(minutes);
				ctx.setTier("ambient");
				return `已将自主节拍基准周期调整为 ${minutes} 分钟。`;
			},
		},

		pause: {
			description: "临时挂起自主唤醒（单位：分钟），期间保持静默不发拍",
			parameters: {
				type: "object",
				properties: {
					minutes: { type: "number", description: "挂起分钟数 (大于等于 1)" },
				},
				required: ["minutes"],
			},
			async run(args: Record<string, unknown>, ctx: ActionContext) {
				if (!engineInstance) return "执行失败：自主节拍器未启动。";

				const rawMinutes = args.minutes ?? args.duration ?? args.duration_minutes ?? args.m;
				const minutes = typeof rawMinutes === "number" ? rawMinutes : parseFloat(String(rawMinutes ?? ""));

				if (Number.isNaN(minutes) || minutes < 1) {
					return "参数错误：挂起时长必须是大于或等于 1 的数字（单位：分钟）。例如 { minutes: 30 }。";
				}

				await engineInstance.pause(minutes);
				ctx.setTier("ambient");
				return `自主节拍已挂起 ${minutes} 分钟。期间将保持静默，除非手动调用 resume 或到期自动恢复。`;
			},
		},

		resume: {
			description: "提前解除挂起，立即恢复平稳节拍",
			async run(_args: Record<string, unknown>, ctx: ActionContext) {
				if (!engineInstance) return "执行失败：自主节拍器未启动。";

				const status = engineInstance.getStatus();
				if (!status.isPaused) {
					return "自主节拍当前处于运行状态，无需恢复。";
				}

				await engineInstance.resume();
				ctx.setTier("ambient");
				return "自主节拍已提前解除挂起，恢复平稳节拍。";
			},
		},

		status: {
			description: "查看当前自主节拍器的真实物理运行状态、倒计时与今日用量",
			run() {
				if (!engineInstance) {
					return JSON.stringify({ status: "stopped" }, null, 2);
				}
				const s = engineInstance.getStatus();
				return JSON.stringify(
					{
						status: s.isPaused ? "paused" : "running",
						baseIntervalMinutes: s.baseIntervalMinutes,
						effectiveIntervalMinutes: s.effectiveIntervalMinutes,
						idleMinutes: s.idleMinutes,
						remainingSeconds: s.remainingSeconds,
						dailyWakesUsed: s.dailyWakesUsed,
						dailyWakesLimit: s.dailyWakesLimit,
					},
					null,
					2,
				);
			},
		},
	},
};

export default pacingTickerApp;
