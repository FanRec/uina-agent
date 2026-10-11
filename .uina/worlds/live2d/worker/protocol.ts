import type { BodyAffordance, BodyState } from "../../../../src/extensions/world-framework/seams.js";

/**
 * 引擎线程消息协议（Live2D 世界线程隔离接缝）。
 *
 * 为何隔离：合成时钟 setInterval(1000/60) 与注入 ws 刷写都依赖事件循环空闲；
 * world 由宿主 jiti 进程内加载，主循环与 agent/LLM/TTS 共享，阻塞即 tick 合并、
 * 注入塌缩成稀疏帧（VTS set 模式无帧间插值 → 关键帧观感）。worker 线程提供
 * 独立事件循环，时钟与刷写不再受主循环负载影响。
 *
 * 约束：全部载荷 structuredClone 可序列化；行为契约（BodyEndpoint / VoiceLevelSink）
 * 的活引用由主线程 facade 承载（proxy.ts），本协议只承载纯数据。
 * 引擎侧合成/注入语义一行不改——Live2DRuntime 整体作为 worker 内核。
 */

/** 世界状态事件的跨线程载荷：render 闭包不可克隆，渲染文本在引擎侧求值后传输。 */
export interface EngineEventPayload {
	id: string;
	type: string;
	channel: "world";
	delivery?: "queued" | "urgent";
	text?: string;
	renderText?: string;
}

/** 需要结算的调用（result 应答）；fire 为单向投递无需应答。 */
export type EngineOp =
	| "start"
	| "stop"
	| "express"
	| "posture"
	| "expression"
	| "attention"
	| "costume"
	| "reload"
	| "formatStatus"
	| "diagnose"
	| "endpoint.safeStop"
	| "endpoint.resume";

export type EngineFireOp =
	| "endpoint.emitCue"
	| "endpoint.interrupt"
	| "endpoint.onFocus"
	| "level.process"
	| "level.reset";

/** 主线程 → 引擎。signalId 对应一次携带取消信号的调用，abort 单独投递（AbortSignal 不可克隆）。 */
export type MainToEngine =
	| { t: "call"; id: number; op: EngineOp; args?: unknown; signalId?: string }
	| { t: "fire"; op: EngineFireOp; args?: unknown }
	| { t: "hostEvent"; event: { type: string; channel?: string } }
	| { t: "abort"; signalId: string };

/** 引擎 → 主线程。sync 为 state/affordance 缓存推送（主线程 facade 同步应答的事实源）。 */
export type EngineToMain =
	| { t: "result"; id: number; ok: true; value: unknown }
	| { t: "result"; id: number; ok: false; error: string }
	| { t: "exposed"; name: string }
	| { t: "unexposed"; name: string }
	| { t: "event"; event: EngineEventPayload }
	| { t: "sync"; state: BodyState; affordance: BodyAffordance };
