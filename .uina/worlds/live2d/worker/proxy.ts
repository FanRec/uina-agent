import { BODY_ENDPOINT_EXPOSED_PREFIX, VOICE_LEVEL_SINK_EXPOSED_PREFIX, type BodyAffordance, type BodyEndpoint, type BodyState, type VoiceLevelSink } from "../../../../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import { deserializeError, type EngineCalls, type EngineFires, type EngineOp, type EngineFireOp, type EngineToMain, type MainToEngine } from "./protocol.js";
import { toolRejected, toolUnknown } from "../results.js";
export interface EnginePort {
 postMessage(message: MainToEngine): void;
 on(type: "message", listener: (message: EngineToMain) => void): void;
 on(type: "error", listener: (error: Error) => void): void;
 on(type: "exit", listener: (code: number) => void): void;
 off(type: "message", listener: (message: EngineToMain) => void): void;
 off(type: "error", listener: (error: Error) => void): void;
 off(type: "exit", listener: (code: number) => void): void;
 terminate?(): Promise<number> | number | void;
}
export interface Live2DWorldRuntime {
 start(ctx: ServiceCompanionContext): Promise<void>; stop(): Promise<void>;
 express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
 state(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
 costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
 reload(ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
 formatStatus(): string | Promise<string>; diagnose(): string | Promise<string>;
}
/** RPC、共享登记、缓存和订阅属于同一个线程生命周期。取消等待真实引擎结算。 */
export class Live2DRuntimeProxy implements Live2DWorldRuntime {
 private phase: "new" | "starting" | "running" | "closing" | "dead" = "new";
 private get dead(): boolean { return this.phase === "dead"; }
 private seq = 0;
 private readonly pending = new Map<number, { op: EngineOp; resolve: (value: unknown) => void; reject: (error: Error) => void; offAbort?: () => void }>();
 private ctx?: ServiceCompanionContext;
 private readonly unexpose = new Map<string, () => void>();
 private readonly cleanups: (() => void)[] = [];
 private readonly cleanupErrors: unknown[] = [];
 private cachedState: BodyState = { online: false, paused: false };
 private cachedAffordance?: BodyAffordance;
 private stopPromise?: Promise<void>; private terminationPromise?: Promise<void>; private terminalFailure?: Error;
 constructor(private readonly port: EnginePort) {
  port.on("message", this.onMessage); port.on("error", this.onError); port.on("exit", this.onExit);
 }
 private readonly onError = (error: Error) => this.died(error);
 private readonly onExit = (code: number) => this.died(new Error(`Worker exit ${code}`));
 private died(cause: Error): void {
  if (this.phase === "dead") return;
  const error = Object.assign(new Error(`Live2D 引擎线程已退出：${cause.message}`), { reason: "engine_exited" });
  this.terminalFailure = error; this.finalize(error);
  void this.terminate().catch((failure) => this.cleanupErrors.push(failure));
 }
 private readonly onMessage = (message: EngineToMain): void => {
  if (this.phase === "dead") return;
  if (message.t === "result") {
   const pending = this.pending.get(message.id); if (!pending) return;
   this.pending.delete(message.id); pending.offAbort?.();
   if (message.op !== pending.op) { pending.reject(Object.assign(new Error("Live2D 引擎应答操作不匹配"), { reason: "protocol_error" })); return; }
   if (message.ok) pending.resolve(message.value); else pending.reject(deserializeError(message.error));
   return;
  }
  if (message.t === "sync") {
   this.cachedState = this.phase === "closing" ? { ...message.state, online: false } : message.state;
   this.cachedAffordance = this.phase === "closing" ? undefined : message.affordance;
  } else if (message.t === "exposed") {
   if (this.phase === "closing" || !this.ctx?.expose) return;
   const facade = message.name.startsWith(BODY_ENDPOINT_EXPOSED_PREFIX) ? this.endpointFacade() : message.name.startsWith(VOICE_LEVEL_SINK_EXPOSED_PREFIX) ? this.sinkFacade() : undefined;
   if (!facade) return;
   try { this.unexpose.get(message.name)?.(); this.unexpose.set(message.name, this.ctx.expose(message.name, facade)); }
   catch (error) { this.died(error instanceof Error ? error : new Error(String(error))); }
  } else if (message.t === "unexposed") {
   const off = this.unexpose.get(message.name); this.unexpose.delete(message.name);
   try { off?.(); } catch (error) { this.cleanupErrors.push(error); }
  }
 };
 private finalize(reason: Error): void {
  if (this.phase === "dead") return;
  this.phase = "dead"; this.cachedState = { online: false, paused: this.cachedState.paused, fault: reason.message }; this.cachedAffordance = undefined;
  for (const pending of this.pending.values()) { pending.offAbort?.(); pending.reject(reason); }
  this.pending.clear();
  const cleanup = [...this.unexpose.values(), ...this.cleanups.splice(0), () => this.port.off("message", this.onMessage), () => this.port.off("exit", this.onExit)];
  this.unexpose.clear();
  for (const off of cleanup.reverse()) { try { off(); } catch (error) { this.cleanupErrors.push(error); } }
  this.ctx = undefined;
 }
 private terminate(): Promise<void> {
  return this.terminationPromise ??= Promise.resolve().then(() => this.port.terminate?.()).then(() => {}).finally(() => this.port.off("error", this.onError));
 }
 private call<K extends EngineOp>(op: K, args: EngineCalls[K]["args"], signal?: AbortSignal): Promise<EngineCalls[K]["result"]> {
  if (this.phase === "dead" || (this.phase === "closing" && op !== "stop")) return Promise.reject(Object.assign(new Error("Live2D 引擎未受理调用"), { reason: "not_started" }));
  const id = ++this.seq, signalId = signal ? `sig_${id}` : undefined;
  return new Promise((resolve, reject) => {
   const onAbort = () => { try { if (this.phase !== "dead") this.port.postMessage({ t: "abort", signalId: signalId! }); } catch (error) { this.died(error instanceof Error ? error : new Error(String(error))); } };
   const pending = { op, resolve: (value: unknown) => resolve(value as EngineCalls[K]["result"]), reject, ...(signal ? { offAbort: () => signal.removeEventListener("abort", onAbort) } : {}) };
   this.pending.set(id, pending);
   if (signal) signal.addEventListener("abort", onAbort, { once: true });
   try { this.port.postMessage({ t: "call", id, op, args, ...(signalId ? { signalId } : {}) } as MainToEngine); }
   catch (error) { this.pending.delete(id); pending.offAbort?.(); reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { reason: "dispatch_failed" })); }
  });
 }
 async start(ctx: ServiceCompanionContext): Promise<void> {
  if (this.phase === "running") return;
  if (this.phase !== "new") throw new Error("Live2D 引擎生命周期已结束，请创建新实例。");
  if (ctx.signal?.aborted) {
   const cause = ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Live2D 启动已取消");
   this.finalize(cause);
   try { await this.terminate(); } catch (error) { throw new AggregateError([cause, error], "Live2D 启动取消后线程回收失败"); }
   if (this.cleanupErrors.length) throw new AggregateError([cause, ...this.cleanupErrors], "Live2D 启动取消后资源回收失败");
   throw cause;
  }
  this.phase = "starting"; this.ctx = ctx;
  try {
   const off = ctx.onHostEvent?.((event) => {
    if (this.phase !== "running") return;
    try { this.port.postMessage({ t: "hostEvent", event: { type: event.type, ...(event.channel !== undefined ? { channel: event.channel } : {}) } }); }
    catch (error) { this.died(error instanceof Error ? error : new Error(String(error))); }
   });
   if (off) this.cleanups.push(off);
   const onAbort = () => {
    if (this.phase === "dead" || this.phase === "closing") return;
    this.phase = "closing"; this.cachedState = { ...this.cachedState, online: false }; this.cachedAffordance = undefined;
    try { this.port.postMessage({ t: "worldAbort", reason: ctx.signal.reason instanceof Error ? ctx.signal.reason.message : "World 已停用" }); }
    catch (error) { this.died(error instanceof Error ? error : new Error(String(error))); }
   };
   if (ctx.signal) { ctx.signal.addEventListener("abort", onAbort, { once: true }); this.cleanups.push(() => ctx.signal.removeEventListener("abort", onAbort)); }
   await this.call("start", undefined);
   if (ctx.signal?.aborted) { onAbort(); throw ctx.signal.reason ?? new Error("World 已停用"); }
   if (this.dead) throw this.terminalFailure ?? new Error("Live2D 引擎已停止");
 this.phase = "running";
  } catch (cause) {
   const errors = [cause]; try { await this.stop(); } catch (error) { errors.push(error); }
   throw errors.length === 1 ? cause : new AggregateError(errors, "Live2D 引擎启动失败，已完成回滚");
  }
 }
 stop(): Promise<void> { return this.stopPromise ??= this.close(); }
 private async close(): Promise<void> {
  const errors: unknown[] = [];
  if (this.phase !== "dead") {
   this.phase = "closing"; this.cachedState = { ...this.cachedState, online: false };
   try { await this.call("stop", undefined); } catch (error) { errors.push(error); }
   this.finalize(errors[0] instanceof Error ? errors[0] : Object.assign(new Error("Live2D 引擎线程已停止"), { reason: "not_started" }));
  } else if (this.terminalFailure) errors.push(this.terminalFailure);
  try { await this.terminate(); } catch (error) { errors.push(error); }
  errors.push(...this.cleanupErrors);
  if (errors.length) throw new AggregateError([...new Set(errors)], `Live2D 停用失败：${errors.map((error) => error instanceof Error ? error.message : String(error)).join("；")}`);
 }
 private async action<K extends "express" | "state" | "costume" | "reload">(op: K, args: EngineCalls[K]["args"], signal?: AbortSignal): Promise<ToolExecutionResult> {
  if (signal?.aborted) return toolRejected("cancelled", "调用已中止，未执行。");
  if (this.phase !== "running") return { result: "Live2D 引擎未运行，未执行。", status: "not_started", details: { reason: "not_started", effectStatus: "not_started" } };
  try { return await this.call(op, args, signal); }
  catch (error) {
   const reason = (error as { reason?: string }).reason ?? "engine_error";
   if (reason === "dispatch_failed") return { result: "调用未能投递，未执行。", status: "not_started", details: { reason, effectStatus: "not_started" } };
   return toolUnknown(`Live2D 执行结果未知：${error instanceof Error ? error.message : String(error)}`, { reason });
  }
 }
 express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }) { return this.action("express", args, ctx.signal); }
 state(args: Record<string, unknown>, ctx: { signal?: AbortSignal }) { return this.action("state", args, ctx.signal); }
 costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }) { return this.action("costume", args, ctx.signal); }
 reload(ctx: { signal?: AbortSignal }) { return this.action("reload", undefined, ctx.signal); }
 formatStatus() { return this.call("formatStatus", undefined); }
 diagnose() { return this.call("diagnose", undefined); }
 private fire<K extends EngineFireOp>(op: K, args: EngineFires[K]): void {
  if (this.phase !== "running" && !(this.phase === "starting" && op === "endpoint.onFocus")) return;
  try { this.port.postMessage({ t: "fire", op, args } as MainToEngine); } catch (error) { this.died(error instanceof Error ? error : new Error(String(error))); }
 }
 private endpointFacade(): BodyEndpoint {
  return { bodyId: "live2d", bodyType: "avatar_2d",
   affordance: () => structuredClone(this.cachedAffordance ?? { bodyId: "live2d", bodyType: "avatar_2d", description: "Live2D 引擎未就绪。", cues: [] }),
   state: () => ({ ...this.cachedState }), supportsCue: (id) => this.phase === "running" && (this.cachedAffordance?.cues ?? []).some((cue) => cue.id === id || cue.aliases?.includes(id) === true),
   emitCue: (cueId) => this.fire("endpoint.emitCue", { cueId }),
   safeStop: () => this.call("endpoint.safeStop", undefined).then(() => {}), resume: () => this.call("endpoint.resume", undefined).then(() => {}),
   interrupt: () => this.fire("endpoint.interrupt", undefined), onFocus: (focused) => this.fire("endpoint.onFocus", { focused }),
  };
 }
 private sinkFacade(): VoiceLevelSink { return { processLevel: (level) => this.fire("level.process", level), reset: () => this.fire("level.reset", undefined) }; }
}
