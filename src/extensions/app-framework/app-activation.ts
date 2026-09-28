import { join } from "node:path";
import type { ExtensionAPI } from "../runner.js";
import { ResourceScope } from "../lifecycle-scope.js";
import { createFacadeTool } from "./facade-tool.js";
import { APP_HOST_EVENT_TYPES, type AppDef, type AppRuntime, type ServiceCompanionContext } from "./types.js";

export interface AppActivationHost {
	readonly pi: ExtensionAPI;
	readonly runtime: AppRuntime;
	readonly setTier: (tier: AppRuntime["surfaceTier"]) => void;
	readonly notifyExposed: () => void;
}

export class AppActivation {
	readonly scope: ResourceScope;
	readonly exposed = new Map<string, unknown>();
	private readonly context: ServiceCompanionContext;

	constructor(private readonly definition: AppDef, private readonly host: AppActivationHost) {
		this.scope = new ResourceScope("app:" + definition.name);
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
			const rawTool = createFacadeTool(this.definition, {
				getRuntime: () => this.host.runtime,
				setTier: (tier) => this.host.setTier(tier),
			});
			const tool = {
				...rawTool,
				run: (args: Record<string, unknown>, signal: AbortSignal | undefined, toolContext: Parameters<typeof rawTool.run>[2]) => {
					if (!this.scope.active) return Promise.resolve({ result: "应用已停用", status: "not_started" as const });
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
		try { await this.scope.close(); } catch (error) { errors.push(error); }
		try { await this.definition.onStop?.(this.context); } catch (error) { errors.push(error); }
		if (errors.length > 0) throw new AggregateError(errors, "应用停用失败: " + this.definition.name);
	}

	private async rollback(cause: unknown): Promise<void> {
		const errors: unknown[] = [cause];
		try { await this.scope.close(); } catch (error) { errors.push(error); }
		try { await this.definition.onStop?.(this.context); } catch (error) { errors.push(error); }
		if (errors.length > 1) throw new AggregateError(errors, "应用启动回滚失败: " + this.definition.name);
	}

	private createContext(): ServiceCompanionContext {
		const { pi } = this.host;
		return {
			signal: this.scope.signal,
			submitInput: pi.submitInput ? (input) => pi.submitInput!(input) : undefined,
			isBusy: pi.isBusy ? () => pi.isBusy!() : undefined,
			appDataDir: pi.subject ? join(pi.subject.stateRoot, "app-data", this.definition.name) : pi.cwd ? join(pi.cwd, ".uina/apps", this.definition.name) : undefined,
			onActivity: pi.on ? (listener) => {
				const unbind = pi.on!("input_accepted", (event) => listener({ origin: activityOriginOf(event.source) }));
				return this.track(unbind);
			} : undefined,
			onHostEvent: pi.on ? (listener) => {
				const disposers = APP_HOST_EVENT_TYPES.map((type) => pi.on!(type, (event) => listener(event as never)));
				return this.track(() => disposers.forEach((dispose) => dispose()));
			} : undefined,
			expose: (name, value) => this.expose(name, value),
			callService: pi.callService ? (name, input) => pi.callService!(name, input) : undefined,
			hasService: pi.hasService ? (name) => pi.hasService!(name) : undefined,
		};
	}

	private expose(name: string, value: unknown): () => void {
		if (!this.scope.active) throw new Error("应用已停用: " + this.definition.name);
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
		const once = () => { if (!done) { done = true; dispose(); } };
		this.scope.onDispose(once);
		return once;
	}
}

function activityOriginOf(source: import("../../core/types.js").InputSource | undefined): "human" | "external" | "runtime" {
	if (source?.kind === "user") return "human";
	if (source?.origin === "external") return "external";
	return "runtime";
}
