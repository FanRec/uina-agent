import { join } from "node:path";
import { errorMessage } from "../../core/errors.js";
import { ResourceScope } from "../lifecycle-scope.js";
import type { ExtensionAPI } from "../runner.js";
import {
	type EventSubmission,
	type ServiceCompanionContext,
	WORLD_HOST_EVENT_TYPES,
	type WorldDef,
	type WorldEvent,
	type WorldRuntime,
} from "./types.js";
import { createWorldTool } from "./world-tool.js";

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

	/**
	 * WorldEvent → AgentInput 的唯一转换。单条与批量必须产出同一形状，
	 * 否则"同一个事件走哪条路"会变成两种投递语义。
	 */
	private toAgentInput(event: WorldEvent): import("../../agent/loop.js").AgentInput {
		if (event.channel !== "world") throw new Error("World 事件必须使用 channel: world");
		if (!event.text && !event.render) throw new Error("World 事件必须提供 text 或 render，拒绝静默丢弃");
		const render = event.render ? async () => (this.scope.active ? await event.render!() : null) : undefined;
		return {
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
		};
	}

	private createContext(): ServiceCompanionContext {
		const { pi } = this.host;
		return {
			signal: this.scope.signal,
			delivery: pi.delivery?.(`world:${this.definition.name}`),
			// Context Source 薄转发端口：只加世界局部前缀并跟踪注销，不做第二层注册表。
			// 停用后注册明确失败；注销句柄随世界 ResourceScope 自动执行（含启动失败回滚）。
			provideContext: pi.provideContext
				? (source) => {
						if (!this.scope.active) throw new Error("世界已停用: " + this.definition.name);
						if (source.id.startsWith("world:"))
							throw new Error(`World Source id 不允许自带 "world:" 前缀（Framework 自动添加）: ${source.id}`);
						const dispose = pi.provideContext({ ...source, id: `world:${this.definition.name}/${source.id}` });
						return this.track(dispose);
					}
				: undefined,
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
				? async (event: WorldEvent): Promise<EventSubmission> => {
						// 停用不是"投递成功"：事件仍在世界手里，宿主不该以为已经交出去了。
						if (!this.scope.active) return { accepted: false, reason: "世界已停用", retryable: false };
						const input = this.toAgentInput(event);
						try {
							await pi.submitInput!(input, {
								deliveryScope: `world:${this.definition.name}`,
								signal: this.scope.signal,
							});
						} catch (error) {
							return { accepted: false, reason: errorMessage(error), retryable: true };
						}
						return { accepted: true };
					}
				: undefined,
			// 批量只做一件事：让每条各自入队、各自拿结果，然后由宿主调度一次消费。
			// 不宣称"会一起被模型看到"——那由宿主的有界领取预算决定。
			emitEvents: pi.submitInputs
				? async (events: readonly WorldEvent[]): Promise<EventSubmission[]> => {
						if (!this.scope.active)
							return events.map(() => ({ accepted: false, reason: "世界已停用", retryable: false }) as const);
						// 形状非法照旧抛：那是世界自己的 bug，不是投递状态。
						const inputs = events.map((event) => this.toAgentInput(event));
						const outcomes = await pi.submitInputs!(inputs, {
							deliveryScope: `world:${this.definition.name}`,
							signal: this.scope.signal,
						});
						return outcomes.map((outcome) =>
							outcome.accepted
								? ({ accepted: true } as const)
								: ({ accepted: false, reason: outcome.reason, retryable: outcome.retryable } as const),
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
