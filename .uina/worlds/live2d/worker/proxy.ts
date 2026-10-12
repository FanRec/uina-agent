import {
	BODY_ENDPOINT_EXPOSED_PREFIX,
	VOICE_LEVEL_SINK_EXPOSED_PREFIX,
	type BodyAffordance,
	type BodyEndpoint,
	type BodyState,
	type VoiceLevelSink,
} from "../../../../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { EngineOp, EngineToMain, MainToEngine } from "./protocol.js";

/**
 * 引擎线程主线程侧代理：与 Live2DRuntime 同表面的 RPC 实现（线程隔离接缝）。
 *
 * - 工具调用（express/posture/…）→ call RPC，AbortSignal 经 signalId 翻译；
 * - BodyEndpoint / VoiceLevelSink 消费方要求同步应答（BodyRouter 直调 state/supportsCue），
 *   facade 从 sync 推送缓存回答——引擎在连接/适配/目录代次/暂停变化时主动推送；
 * - 世界状态事件的 render 闭包在主线程重建（引擎侧已求值 renderText）；
 * - fire-and-forget（emitCue/interrupt/onFocus/电平）单向投递，不占结算表。
 */

export interface EnginePort {
	postMessage(msg: MainToEngine): void;
	on(type: "message", listener: (msg: EngineToMain) => void): void;
	/** 真实 Worker 才有：进程退出兜底（挂起 RPC 全部结算，工具层不悬挂）。 */
	once?(type: "exit", listener: () => void): void;
	terminate?(): void;
}

/** 与进程内 Live2DRuntime 等同的世界装配表面（index.ts 工具面消费）。 */
export interface Live2DWorldRuntime {
	start(ctx: ServiceCompanionContext): Promise<void>;
	stop(): Promise<void>;
	express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
	state(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
	costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
	reload(ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult>;
	formatStatus(): string | Promise<string>;
	diagnose(): string | Promise<string>;
}

const DEAD_ENGINE = "Live2D 引擎线程已退出";

export class Live2DRuntimeProxy implements Live2DWorldRuntime {
	private seq = 0;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly aborts = new Map<string, () => void>();
	private ctx?: ServiceCompanionContext;
	private readonly unexpose = new Map<string, () => void>();
	private cachedState: BodyState = { online: false, paused: false };
	private cachedAffordance?: BodyAffordance;
	private dead = false;

	constructor(
		private readonly port: EnginePort,
		onDead?: (cb: () => void) => void,
	) {
		port.on("message", (msg) => this.onMessage(msg));
		onDead?.(() => this.dispose());
	}

	private onMessage(msg: EngineToMain): void {
		if (msg.t === "result") {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			this.pending.delete(msg.id);
			if (msg.ok) entry.resolve(msg.value);
			else entry.reject(new Error(msg.error));
			return;
		}
		if (msg.t === "exposed") {
			if (!this.ctx?.expose) return;
			const facade = msg.name.startsWith(BODY_ENDPOINT_EXPOSED_PREFIX)
				? this.endpointFacade()
				: msg.name.startsWith(VOICE_LEVEL_SINK_EXPOSED_PREFIX)
					? this.sinkFacade()
					: undefined;
			if (!facade) return;
			this.unexpose.set(msg.name, this.ctx.expose(msg.name, facade));
			return;
		}
		if (msg.t === "unexposed") {
			const cleanup = this.unexpose.get(msg.name);
			this.unexpose.delete(msg.name);
			cleanup?.();
			return;
		}
		if (msg.t === "sync") {
			this.cachedState = msg.state;
			this.cachedAffordance = msg.affordance;
		}
	}

	/** 引擎线程退出兜底：在途 RPC 全部结算为失败，工具层不悬挂。 */
	private dispose(): void {
		if (this.dead) return;
		this.dead = true;
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(new Error(DEAD_ENGINE));
		for (const off of this.aborts.values()) off();
		this.aborts.clear();
	}

	/** call RPC + 取消翻译：本地 signal abort → abort 消息 + 以 signal.reason 拒绝（与进程内 withCancellation 同语义）。 */
	private call(op: EngineOp, args?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.dead) return Promise.reject(new Error(DEAD_ENGINE));
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			let settled = false;
			let offAbort: (() => void) | undefined;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				offAbort?.();
				this.pending.delete(id);
				fn();
			};
			const entry = {
				resolve: (v: unknown) => settle(() => resolve(v)),
				reject: (e: Error) => settle(() => reject(e)),
			};
			let signalId: string | undefined;
			const onAbort = () => {
				entry.reject(signal!.reason instanceof Error ? signal!.reason : new Error("已取消"));
				this.port.postMessage({ t: "abort", signalId: signalId! });
			};
			if (signal) {
				signalId = `sig_${id}`;
				signal.addEventListener("abort", onAbort, { once: true });
				offAbort = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, entry);
			this.port.postMessage({
				t: "call",
				id,
				op,
				...(args !== undefined ? { args } : {}),
				...(signalId ? { signalId } : {}),
			});
			if (signal?.aborted) onAbort();
		});
	}

	async start(ctx: ServiceCompanionContext): Promise<void> {
		this.ctx = ctx;
		ctx.onHostEvent?.((event) => {
			// 事件载荷可能带不可克隆字段，只转发消费方（runtime.start）读取的 type/channel。
			this.port.postMessage({
				t: "hostEvent",
				event: { type: event.type, ...(event.channel !== undefined ? { channel: event.channel } : {}) },
			});
		});
		await this.call("start");
	}

	async stop(): Promise<void> {
		try {
			await this.call("stop");
		} catch {
			// 引擎已死则无可停止；线程回收仍需执行。
		} finally {
			this.dispose();
			this.port.terminate?.();
		}
	}

	express(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.call("express", args, ctx?.signal) as Promise<ToolExecutionResult>;
	}
	state(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.call("state", args, ctx?.signal) as Promise<ToolExecutionResult>;
	}
	costume(args: Record<string, unknown>, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.call("costume", args, ctx?.signal) as Promise<ToolExecutionResult>;
	}
	reload(ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> {
		return this.call("reload", undefined, ctx?.signal) as Promise<ToolExecutionResult>;
	}
	async formatStatus(): Promise<string> {
		return (await this.call("formatStatus")) as string;
	}
	async diagnose(): Promise<string> {
		return (await this.call("diagnose")) as string;
	}

	/** BodyEndpoint 行为契约 facade：同步方法回答缓存事实，动作方法走 RPC。 */
	private endpointFacade(): BodyEndpoint {
		return {
			bodyId: "live2d",
			bodyType: "avatar_2d",
			affordance: () =>
				this.cachedAffordance ?? {
					bodyId: "live2d",
					bodyType: "avatar_2d",
					description: "Live2D 引擎尚未就绪。",
					cues: [],
				},
			state: (): BodyState => this.cachedState,
			supportsCue: (cueId) =>
				(this.cachedAffordance?.cues ?? []).some((c) => c.id === cueId || c.aliases?.includes(cueId) === true),
			emitCue: (cueId) => this.port.postMessage({ t: "fire", op: "endpoint.emitCue", args: { cueId } }),
			safeStop: () => this.call("endpoint.safeStop").then(() => undefined),
			resume: () => this.call("endpoint.resume").then(() => undefined),
			interrupt: () => this.port.postMessage({ t: "fire", op: "endpoint.interrupt" }),
			onFocus: (focused) => this.port.postMessage({ t: "fire", op: "endpoint.onFocus", args: { focused } }),
			// 契约中 formatStatus 为同步 string——跨线程无法同步取值；当前无消费方（status 走世界工具面），不实现。
		};
	}

	/** VoiceLevelSink facade：电平投递单向跨线程（生产者推、引擎侧负责平滑与衰减）。 */
	private sinkFacade(): VoiceLevelSink {
		return {
			processLevel: (level) => this.port.postMessage({ t: "fire", op: "level.process", args: level }),
			reset: () => this.port.postMessage({ t: "fire", op: "level.reset" }),
		};
	}
}
