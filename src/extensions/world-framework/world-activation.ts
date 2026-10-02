import { join } from "node:path";
import type { ExtensionAPI } from "../runner.js";
import { ResourceScope } from "../lifecycle-scope.js";
import { createWorldTool } from "./world-tool.js";
import {
	WORLD_HOST_EVENT_TYPES,
	type WorldDef,
	type WorldRuntime,
	type ServiceCompanionContext,
	type WorldEvent,
} from "./types.js";

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
			this.scope.onDispose(this.host.pi.registerTool(tool));
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

	private createContext(): ServiceCompanionContext {
		const { pi } = this.host;
		return {
			signal: this.scope.signal,
			submitInput: pi.submitInput ? (input) => pi.submitInput!(input) : undefined,
			isBusy: pi.isBusy ? () => pi.isBusy!() : undefined,
			worldDataDir: pi.subject
				? join(pi.subject.stateRoot, "world-data", this.definition.name)
				: pi.cwd
					? join(pi.cwd, ".uina/worlds", this.definition.name)
					: undefined,
			emitEvent: pi.submitInput
				? async (event: WorldEvent) => {
						if (!this.scope.active) return;
						if (event.channel !== "world") throw new Error("World 事件必须使用 channel: world");
						if (!event.text && !event.render) return;
						const render = event.render ? async () => (this.scope.active ? await event.render!() : null) : undefined;
						await pi.submitInput!({
							id: event.id,
							mode: event.delivery === "urgent" ? "steer" : "followUp",
							source: {
								kind: "runtime",
								type: event.type,
								ref: this.definition.name,
								origin: event.origin ?? "external",
								channel: event.channel,
							},
							text: event.text ?? "[deferred world event]",
							...(render ? { render } : {}),
							data: event.data,
						});
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
