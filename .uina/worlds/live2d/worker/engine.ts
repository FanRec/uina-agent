import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { createLive2DRuntime } from "../assembly.js";
import type { Live2DRuntime } from "../runtime.js";
import {
	serializeError,
	type EngineCalls,
	type EngineCall,
	type EngineFires,
	type EngineFire,
	type EngineFireOp,
	type EngineOp,
	type EngineToMain,
	type MainToEngine,
} from "./protocol.js";
export interface EngineOptions {
	runtimeFactory?: (onStatusChange: () => void) => Live2DRuntime | Promise<Live2DRuntime>;
}
type Calls = {
	[K in EngineOp]: (args: EngineCalls[K]["args"], signal?: AbortSignal) => Promise<EngineCalls[K]["result"]>;
};
type Fires = { [K in EngineFireOp]: (args: EngineFires[K]) => void };
/** 引擎持有 runtime 与取消域；World 关闭仍等待在途结构化结算。 */
export function attachEngine(
	post: (message: EngineToMain) => void,
	options: EngineOptions = {},
): { onMessage(message: MainToEngine): void } {
	let runtime: Live2DRuntime | undefined;
	let phase: "new" | "starting" | "running" | "closing" | "dead" = "new";
	let onHostEvent: ((event: { type: string; channel?: string }) => void) | undefined;
	const lifecycle = new AbortController();
	const signals = new Map<string, AbortController>();
	const pending = new Map<number, { op: EngineOp; task: Promise<void>; settled: boolean }>();
	let startPromise: Promise<null> | undefined, stopPromise: Promise<null> | undefined;
	const sync = () => {
		if (runtime && phase !== "dead")
			post({ t: "sync", state: runtime.endpoint.state(), affordance: runtime.endpoint.affordance() });
	};
	const context = {
		signal: lifecycle.signal,
		expose: (name: string) => {
			post({ t: "exposed", name });
			return () => post({ t: "unexposed", name });
		},
		onHostEvent: (listener: typeof onHostEvent) => {
			onHostEvent = listener;
			return () => {
				onHostEvent = undefined;
			};
		},
	} as unknown as ServiceCompanionContext;
	const requireRuntime = () => {
		if (!runtime) throw new Error("Live2D 引擎尚未启动");
		return runtime;
	};
	const actionUnavailable = (): ToolExecutionResult => ({
		result: "Live2D 引擎已关闭受理，未执行。",
		status: "not_started",
		details: { reason: "not_started", effectStatus: "not_started" },
	});
	const beginClosing = (reason: string) => {
		if (phase === "dead") return;
		phase = "closing";
		if (!lifecycle.signal.aborted) lifecycle.abort(new Error(reason));
	};
	const calls: Calls = {
		start: () => {
			if (startPromise) return startPromise;
			if (phase !== "new") return Promise.reject(new Error("Live2D 引擎已关闭受理"));
			phase = "starting";
			return (startPromise = (async () => {
				runtime = options.runtimeFactory
					? await options.runtimeFactory(sync)
					: await createLive2DRuntime({ onStatusChange: sync });
				await runtime.start(context);
				if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
				phase = "running";
				sync();
				return null;
			})());
		},
		stop: () =>
			(stopPromise ??= (async () => {
				beginClosing("Live2D World 停用");
				const errors: unknown[] = [];
				if (startPromise) {
					try {
						await startPromise;
					} catch {
						/* start 的应答保存启动原因；只等待其回滚，不当作 stop 清理错误。 */
					}
				}
				try {
					await runtime?.stop();
				} catch (error) {
					errors.push(error);
				}
				// runtime 的现有清理预算耗尽时，剩余调用明确 unknown；不额外无期限等待。
				if (errors.length) {
					for (const [id, entry] of pending)
						if (entry.op !== "stop" && !entry.settled) {
							entry.settled = true;
							if (["express", "state", "costume", "reload", "prepareBody"].includes(entry.op)) {
								post({
									t: "result",
									id,
									op: entry.op,
									ok: true,
									value: {
										result: "停用清理未确认，执行结果未知。",
										status: "unknown",
										details: { reason: "cleanup_unconfirmed", effectStatus: "unknown" },
									},
								} as EngineToMain);
							} else post({ t: "result", id, op: entry.op, ok: false, error: serializeError(errors[0]) });
						}
				} else {
					await Promise.allSettled(
						[...pending.values()].filter((entry) => entry.op !== "stop").map((entry) => entry.task),
					);
				}
				onHostEvent = undefined;
				runtime = undefined;
				phase = "dead";
				if (errors.length) throw new AggregateError(errors, "Live2D 引擎停用清理未确认");
				return null;
			})()),
		express: async (args, signal) =>
			phase === "running" ? requireRuntime().express(args, { signal }) : actionUnavailable(),
		state: async (args, signal) =>
			phase === "running" ? requireRuntime().state(args, { signal }) : actionUnavailable(),
		costume: async (args, signal) =>
			phase === "running" ? requireRuntime().costume(args, { signal }) : actionUnavailable(),
		reload: async (_args, signal) => (phase === "running" ? requireRuntime().reload({ signal }) : actionUnavailable()),
		prepareBody: async (_args, signal) =>
			phase === "running" ? requireRuntime().prepareBody({ signal }) : actionUnavailable(),
		formatStatus: async () => requireRuntime().formatStatus(),
		diagnose: async () => requireRuntime().diagnose(),
		"endpoint.safeStop": async () => {
			try {
				await requireRuntime().safeStop();
				return null;
			} finally {
				sync();
			}
		},
		"endpoint.resume": async () => {
			await requireRuntime().resume();
			sync();
			return null;
		},
	};
	const fires: Fires = {
		"endpoint.emitCue": ({ cueId }) => requireRuntime().endpoint.emitCue(cueId),
		"endpoint.interrupt": () => requireRuntime().interrupt(),
		"endpoint.onFocus": ({ focused }) => requireRuntime().setFocused(focused),
		"level.process": (level) => requireRuntime().levelSink?.processLevel(level),
		"level.reset": () => requireRuntime().levelSink?.reset(),
	};
	function dispatch<K extends EngineOp>(message: EngineCall<K>, signal?: AbortSignal) {
		return calls[message.op](message.args, signal);
	}
	function fire<K extends EngineFireOp>(message: EngineFire<K>) {
		fires[message.op](message.args);
	}
	return {
		onMessage(message) {
			if (message.t === "call") {
				if (!(message.op in calls)) {
					post({
						t: "result",
						id: message.id,
						op: message.op,
						ok: false,
						error: serializeError(new Error("未知引擎操作")),
					});
					return;
				}
				const controller = message.signalId ? new AbortController() : undefined;
				if (controller) signals.set(message.signalId!, controller);
				const entry = { op: message.op, task: Promise.resolve(), settled: false };
				pending.set(message.id, entry);
				entry.task = Promise.resolve()
					.then(() =>
						dispatch(message, controller ? AbortSignal.any([controller.signal, lifecycle.signal]) : lifecycle.signal),
					)
					.then(
						(value) => {
							if (!entry.settled) {
								entry.settled = true;
								post({ t: "result", id: message.id, op: message.op, ok: true, value } as EngineToMain);
							}
						},
						(error) => {
							if (!entry.settled) {
								entry.settled = true;
								post({ t: "result", id: message.id, op: message.op, ok: false, error: serializeError(error) });
							}
						},
					)
					.finally(() => {
						pending.delete(message.id);
						if (message.signalId) signals.delete(message.signalId);
					});
			} else if (message.t === "abort") signals.get(message.signalId)?.abort();
			else if (message.t === "worldAbort") beginClosing(message.reason);
			else if (message.t === "hostEvent") {
				if (phase === "running") onHostEvent?.(message.event);
			} else if (
				message.t === "fire" &&
				(phase === "running" || (phase === "starting" && message.op === "endpoint.onFocus" && runtime))
			)
				fire(message);
		},
	};
}
