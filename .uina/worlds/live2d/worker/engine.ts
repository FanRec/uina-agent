import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { VTSClient } from "../adapter/vts-client.js";
import { loadCatalog } from "../models/mo/catalog.js";
import { MO_SPEECH } from "../models/mo/speech.js";
import { loadRig, MO_MODEL_ID } from "../models/rig-loader.js";
import { Live2DRuntime } from "../runtime.js";
import type { EngineToMain, MainToEngine } from "./protocol.js";

/**
 * 引擎线程入口：持有 VTSClient + Live2DRuntime + 合成时钟，处理主线程 RPC。
 *
 * runtime.start 的 ServiceCompanionContext 在线程边界由 fakeCtx 适配：
 * - expose → 通知主线程登记 facade（端点/电平接缝是行为契约，活引用只存在于主线程侧）；
 * - onHostEvent → 主线程经 hostEvent 消息喂入（事件在主线程产生）；
 * - emitEvent → 世界状态事件跨线程转发，render 闭包在引擎侧求值为 renderText。
 * 主线程同步应答的事实（endpoint state/affordance）经 sync 消息推送缓存。
 */

/** 引擎装配注入点（测试用）：缺省按世界默认装配真实 rig + VTSClient。 */
export interface EngineOptions {
	runtimeFactory?: () => Live2DRuntime;
}

export function attachEngine(post: (msg: EngineToMain) => void, options: EngineOptions = {}): {
	onMessage: (msg: MainToEngine) => void;
} {
	let runtime: Live2DRuntime | undefined;
	let onHostEvent: ((event: { readonly type: string; readonly channel?: string }) => void) | undefined;
	const signals = new Map<string, AbortController>();

	/** 主线程同步应答事实的缓存推送：state/affordance 严格取自端点单一事实源。 */
	const sync = (): void => {
		if (!runtime) return;
		post({ t: "sync", state: runtime.endpoint.state(), affordance: runtime.endpoint.affordance() });
	};

	// 结构适配：只实现 runtime.start 实际消费的三个可选能力，signal 恒新置（worker 生命周期即信号域）。
	const fakeCtx = {
		signal: new AbortController().signal,
		expose: (name: string) => {
			post({ t: "exposed", name });
			return () => post({ t: "unexposed", name });
		},
		onHostEvent: (listener: (event: { readonly type: string; readonly channel?: string }) => void) => {
			onHostEvent = listener;
			return () => {
				onHostEvent = undefined;
			};
		},
		emitEvent: async (event: {
			id: string;
			type: string;
			channel: "world";
			delivery?: "queued" | "urgent";
			text?: string;
			render?: () => string | null | Promise<string | null>;
		}) => {
			const rendered = event.render ? await event.render() : undefined;
			post({
				t: "event",
				event: {
					id: event.id,
					type: event.type,
					channel: event.channel,
					...(event.delivery ? { delivery: event.delivery } : {}),
					...(event.text !== undefined ? { text: event.text } : {}),
					...(typeof rendered === "string" ? { renderText: rendered } : {}),
				},
			});
			// 状态事件与状态事实同源变化（连接/适配/目录代次），事件即缓存刷新点。
			sync();
		},
	} as unknown as ServiceCompanionContext;

	const settle = async (id: number, run: () => Promise<unknown>): Promise<void> => {
		try {
			post({ t: "result", id, ok: true, value: await run() });
		} catch (error) {
			post({ t: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	};

	const requireRuntime = (): Live2DRuntime => {
		if (!runtime) throw new Error("Live2D 引擎尚未启动");
		return runtime;
	};

	const calls: Record<string, (args: unknown, signal?: AbortSignal) => Promise<unknown>> = {
		start: async () => {
			if (runtime) return null;
			runtime =
				options.runtimeFactory?.() ??
				(await (async () => {
					// rig 装配失败不阻断引擎启动：诚实降级为零注入（与进程内装配同语义）。
					const rig = await loadRig(MO_MODEL_ID).catch(() => undefined);
					return new Live2DRuntime({
						client: new VTSClient(),
						rig,
						catalog: rig ? loadCatalog(rig.modelID, rig) : undefined,
						speech: MO_SPEECH,
					});
				})());
			await runtime.start(fakeCtx);
			sync();
			return null;
		},
		stop: async () => {
			const old = runtime;
			runtime = undefined;
			onHostEvent = undefined;
			await old?.stop();
			return null;
		},
		express: (args, signal) => requireRuntime().express(args as Record<string, unknown>, { signal }),
		posture: (args, signal) => requireRuntime().posture(args as Record<string, unknown>, { signal }),
		expression: (args, signal) => requireRuntime().expression(args as Record<string, unknown>, { signal }),
		attention: (args, signal) => requireRuntime().attention(args as Record<string, unknown>, { signal }),
		costume: (args, signal) => requireRuntime().costume(args as Record<string, unknown>, { signal }),
		reload: (_args, signal) => requireRuntime().reload({ signal }),
		formatStatus: async () => requireRuntime().formatStatus(),
		diagnose: async () => requireRuntime().diagnose(),
		"endpoint.safeStop": async () => {
			const value = await requireRuntime().safeStop();
			sync();
			return value;
		},
		"endpoint.resume": async () => {
			const value = await requireRuntime().resume();
			sync();
			return value;
		},
	};

	const fires: Record<string, (args: unknown) => void> = {
		"endpoint.emitCue": (args) => requireRuntime().endpoint.emitCue((args as { cueId: string }).cueId),
		"endpoint.interrupt": () => requireRuntime().interrupt(),
		"endpoint.onFocus": (args) => requireRuntime().setFocused((args as { focused: boolean }).focused),
		"level.process": (args) => requireRuntime().levelSink?.processLevel(args as { rms: number; peak?: number }),
		"level.reset": () => requireRuntime().levelSink?.reset(),
	};

	return {
		onMessage: (msg: MainToEngine): void => {
			if (msg.t === "call") {
				const run = calls[msg.op];
				if (!run) {
					void settle(msg.id, async () => {
						throw new Error(`未知引擎操作: ${msg.op}`);
					});
					return;
				}
				let controller: AbortController | undefined;
				if (msg.signalId) {
					controller = new AbortController();
					signals.set(msg.signalId, controller);
				}
				void settle(msg.id, () => run(msg.args, controller?.signal)).finally(() => {
					if (msg.signalId) signals.delete(msg.signalId);
				});
				return;
			}
			if (msg.t === "fire") {
				fires[msg.op]?.(msg.args);
				return;
			}
			if (msg.t === "hostEvent") {
				onHostEvent?.(msg.event);
				return;
			}
			if (msg.t === "abort") {
				signals.get(msg.signalId)?.abort();
				return;
			}
		},
	};
}

// 线程自举在 engine-entry.mjs（纯 JS）：tsx loader 线程局部，worker 内 .js→.ts 映射失效，
// 由入口以 jiti 加载本模块后调用 attachEngine 接线 parentPort。
