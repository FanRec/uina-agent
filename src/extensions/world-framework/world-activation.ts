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
			this.registerEnvironmentGuide();
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
	 * 静态环境指引：世界提供短正文，框架在回合边界把它追加到本轮 systemPrompt。
	 *
	 * 每个回合一次的环境认知（不变的原则），当前世界细节不由这里提供。getter 由世界
	 * 决定此刻是否适用；这里只做同步纯读，不读世界事实、不写 Session、不落历史。
	 *
	 * turn.prepare 的合并规则是"后写覆盖先写"，且 host 会把上一份 systemPrompt 作为
	 * 本 handler 的入参；因此这里**只追加**，多个启用世界（以及 MCP 等扩展）可以依次
	 * 组合，不会互相擦掉。停用由 track 绑定的 scope 自动摘除 handler。
	 */
	private registerEnvironmentGuide(): void {
		const provide = this.definition.environmentGuide;
		if (!provide) return;
		const { pi } = this.host;
		const name = this.definition.name;
		this.track(
			pi.onHook("turn.prepare", ({ systemPrompt }) => {
				if (!this.scope.active) return;
				let guide: string | null;
				try {
					guide = provide();
				} catch {
					// 静态 getter 抛错不能把整个回合准备链打断；本轮不注入即可。
					return;
				}
				const text = guide?.trim();
				if (!text) return;
				return { systemPrompt: `${systemPrompt}\n\n[world:${name}:environment]\n${text}` };
			}),
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
