import { join } from "node:path";
import type { ChatMsg } from "../../core/types.js";
import { appendTailFrame, buildEventFrameGroup, contentAddressedEventId } from "../event-frames/index.js";
import { ResourceScope } from "../lifecycle-scope.js";
import type { ExtensionAPI } from "../runner.js";
import {
	type ServiceCompanionContext,
	WORLD_HOST_EVENT_TYPES,
	type WorldDef,
	type WorldEvent,
	type WorldRuntime,
} from "./types.js";
import { createWorldTool } from "./world-tool.js";

/**
 * 请求前观察正文的取用上限。采样是本地内存读，正常在毫秒级；超过这个量级说明世界侧
 * 已经卡住，此时宁可不注入快照，也不能把模型请求一起挂住。
 */
const REQUEST_CONTEXT_TIMEOUT_MS = 250;

/** 请求前观察帧的通知文案：说清"是什么"（快照）、"不是什么"（输入/委托）。 */
function observationNotice(worldName: string): string {
	return `[${worldName} 观察] 你此刻所在世界的最新可用快照（环境感知信息，非用户输入，不是新的委托，无需专门回应）；正文在随后的 external_event_frame 回执中。`;
}

/**
 * 给正文取用套一层时间上限。超时只放弃等待，不取消底层调用：采样本身是只读的本地读取，
 * 强行中断省不下什么，却可能把世界侧留在半途。让它自然跑完、结果丢弃即可。
 */
function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("world deactivated"));
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`request context exceeded ${ms}ms`)), ms);
		const abort = () => reject(new Error("world deactivated"));
		signal.addEventListener("abort", abort, { once: true });
		void work.then(resolve, reject).finally(() => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		});
	});
}

export interface WorldActivationHost {
	readonly pi: ExtensionAPI;
	readonly runtime: WorldRuntime;
	readonly worldName: string;
	readonly notifyExposed: () => void;
}

export class WorldActivation {
	readonly scope: ResourceScope;
	readonly exposed = new Map<string, unknown>();
	private readonly context: ServiceCompanionContext;

	constructor(
		private readonly definition: WorldDef,
		private readonly host: WorldActivationHost,
	) {
		this.scope = new ResourceScope("world:" + definition.name);
		this.scope.onDispose(() => {
			if (this.exposed.size > 0) {
				this.exposed.clear();
				host.notifyExposed();
			}
		});
		this.context = this.createContext();
	}

	async start(): Promise<void> {
		try {
			await this.definition.onStart?.(this.context);
			this.registerRequestContext();
			const rawTool = createWorldTool(this.definition, {
				getRuntime: () => this.host.runtime,
			});
			const tool = {
				...rawTool,
				run: (
					args: Record<string, unknown>,
					signal: AbortSignal | undefined,
					toolContext: Parameters<typeof rawTool.run>[2],
				) => {
					if (!this.scope.active) return Promise.resolve({ result: "世界已停用", status: "not_started" as const });
					return this.scope.run((combined) => rawTool.run(args, combined, toolContext), signal);
				},
			};
			this.scope.onDispose(this.host.pi.registerTool(tool, { deliveryScope: `world:${this.definition.name}` }));
		} catch (cause) {
			await this.rollback(cause);
			throw cause;
		}
	}

	/**
	 * 请求前观察帧：世界提供正文，框架负责包成瞬态帧接进模型投影。
	 *
	 * 用 tail 相位：无论其他扩展先后注册，观察帧恒排在一切历史注入之后，作为"此刻"的
	 * 最后一段。帧的生命周期跟随 world activation（`track`），世界停用即摘除 handler。
	 */
	private registerRequestContext(): void {
		const provide = this.definition.requestContext;
		if (!provide) return;
		const { pi } = this.host;
		const name = this.definition.name;
		this.track(
			pi.onHook(
				"turn.transformContext",
				async (projection) => {
					if (!this.scope.active) return;
					let text: string | null;
					try {
						text = await withTimeout(provide(), REQUEST_CONTEXT_TIMEOUT_MS, this.scope.signal);
					} catch {
						// 取不到就不注入：缺一份快照是小事，挂住模型请求不是。
						return;
					}
					if (text == null || text.trim() === "") return;
					const appended = appendTailFrame(
						projection.messages,
						buildEventFrameGroup({
							eventId: contentAddressedEventId(`world:${name}:state`, text),
							text,
							notice: observationNotice(name),
							source: { kind: "runtime", type: "runtime.observation", origin: "internal" },
						}),
					);
					if (!appended) return;
					return { projection: { ...projection, messages: appended.messages as ChatMsg[] } };
				},
				{ tail: true },
			),
		);
	}

	async stop(): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.scope.close();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.definition.onStop?.(this.context);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "世界停用失败: " + this.definition.name);
	}

	private async rollback(cause: unknown): Promise<void> {
		const errors: unknown[] = [cause];
		try {
			await this.scope.close();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.definition.onStop?.(this.context);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 1) throw new AggregateError(errors, "世界启动回滚失败: " + this.definition.name);
	}

	private createContext(): ServiceCompanionContext {
		const { pi } = this.host;
		return {
			signal: this.scope.signal,
			delivery: pi.delivery?.(`world:${this.definition.name}`),
			submitInput: pi.submitInput
				? (input) =>
						pi.submitInput!(input, { deliveryScope: `world:${this.definition.name}`, signal: this.scope.signal })
				: undefined,
			isBusy: pi.isBusy ? () => pi.isBusy!() : undefined,
			worldDataDir: pi.subject
				? join(pi.subject.stateRoot, "world-data", this.definition.name)
				: pi.cwd
					? join(pi.cwd, ".uina/world-data", this.definition.name)
					: undefined,
			emitEvent: pi.submitInput
				? async (event: WorldEvent) => {
						if (!this.scope.active) return;
						if (event.channel !== "world") throw new Error("World 事件必须使用 channel: world");
						if (!event.text && !event.render) throw new Error("World 事件必须提供 text 或 render，拒绝静默丢弃");
						const render = event.render ? async () => (this.scope.active ? await event.render!() : null) : undefined;
						await pi.submitInput!(
							{
								id: event.id,
								mode: event.delivery === "urgent" ? "steer" : "followUp",
								source: {
									kind: "runtime",
									type: event.type,
									ref: this.definition.name,
									origin: event.origin,
									channel: event.channel,
								},
								...(event.text ? { text: event.text } : {}),
								...(render ? { render } : {}),
								data: event.data,
								receipt: event.receipt,
							},
							{ deliveryScope: `world:${this.definition.name}`, signal: this.scope.signal },
						);
					}
				: undefined,
			onActivity: pi.on
				? (listener) => {
						const unbind = pi.on!("input_accepted", (event) => listener({ origin: activityOriginOf(event.source) }));
						return this.track(unbind);
					}
				: undefined,
			onHostEvent: pi.on
				? (listener) => {
						const disposers = WORLD_HOST_EVENT_TYPES.map((type) => pi.on!(type, (event) => listener(event as never)));
						return this.track(() => disposers.forEach((dispose) => dispose()));
					}
				: undefined,
			expose: (name, value) => this.expose(name, value),
			callService: pi.callService ? (name, input) => pi.callService!(name, input) : undefined,
			hasService: pi.hasService ? (name) => pi.hasService!(name) : undefined,
		};
	}

	private expose(name: string, value: unknown): () => void {
		if (!this.scope.active) throw new Error("世界已停用: " + this.definition.name);
		const previous = this.exposed.get(name);
		this.exposed.set(name, value);
		if (previous !== value) this.host.notifyExposed();
		return () => {
			if (this.exposed.get(name) !== value) return;
			this.exposed.delete(name);
			this.host.notifyExposed();
		};
	}

	private track(dispose: () => void): () => void {
		let done = false;
		const once = () => {
			if (!done) {
				done = true;
				dispose();
			}
		};
		this.scope.onDispose(once);
		return once;
	}
}

function activityOriginOf(
	source: import("../../core/types.js").InputSource | undefined,
): "human" | "external" | "runtime" {
	if (source?.kind === "user") return "human";
	if (source?.origin === "external") return "external";
	return "runtime";
}
