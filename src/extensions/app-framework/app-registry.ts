import { join } from "node:path";
import type { ExtensionAPI } from "../runner.js";
import { ContextViewport } from "./context-viewport.js";
import { appendTailFrame } from "../event-frames/projection.js";
import { AppActivation } from "./app-activation.js";
import { createFileAppStateStore, type AppStateStore } from "./app-state-store.js";
import { type AppDef, type AppExposedRegistry, type AppRuntime, type SurfaceTier } from "./types.js";

interface SaveOutcome { readonly ok: boolean; readonly error?: Error; }
interface AppInstance extends AppRuntime { activation?: AppActivation; }

export class AppRegistry {
	private readonly apps = new Map<string, AppInstance>();
	private closing = false;
	private closePromise?: Promise<void>;
	readonly viewport: ContextViewport;
	private readonly stateStore: AppStateStore;
	private persistedState: Record<string, boolean> | null = null;
	private saveTail: Promise<SaveOutcome> = Promise.resolve({ ok: true });
	private readonly lifecycleLocks = new Map<string, Promise<void>>();
	private readonly exposedListeners = new Set<() => void>();

	constructor(private readonly pi: ExtensionAPI, stateStore?: AppStateStore) {
		const stateFilePath = this.pi.subject
			? join(this.pi.subject.stateRoot, "apps.json")
			: this.pi.cwd ? join(this.pi.cwd, ".uina", "apps.json") : undefined;
		this.stateStore = stateStore ?? createFileAppStateStore(stateFilePath, (error) => this.pi.reportError?.(error));
		this.viewport = new ContextViewport({ getRuntimes: () => this.apps.values() });
		this.pi.onHook("turn.transformContext", async (projection) => {
			const result = appendTailFrame(projection.messages, await this.viewport.buildTailFrame());
			return result ? { projection: { ...projection, messages: result.messages } } : undefined;
		}, { tail: true });
	}

	exposedRegistry(): AppExposedRegistry {
		return {
			names: () => [...this.apps.values()].flatMap((app) => [...(app.activation?.exposed.keys() ?? [])]),
			get: (name) => {
				for (const app of this.apps.values()) if (app.activation?.exposed.has(name)) return app.activation.exposed.get(name);
				return undefined;
			},
			subscribe: (listener) => { this.exposedListeners.add(listener); return () => this.exposedListeners.delete(listener); },
		};
	}

	private notifyExposed(): void {
		for (const listener of [...this.exposedListeners]) { try { listener(); } catch { /* observer errors do not block registry changes */ } }
	}

	async register(def: AppDef): Promise<() => Promise<void>> {
		this.assertOpen();
		if (this.apps.has(def.name)) throw new Error("应用 \"" + def.name + "\" 已被注册");
		if (this.persistedState === null) this.persistedState = await this.stateStore.load();
		const runtime: AppInstance = { definition: def, enabled: false, surfaceTier: def.defaultState?.tier ?? "hidden", lastActiveTurn: 0 };
		this.apps.set(def.name, runtime);
		try {
			if (this.persistedState[def.name] ?? def.defaultState?.enabled ?? true) await this.enable(def.name, false);
		} catch (error) { this.apps.delete(def.name); throw error; }
		return async () => this.unregister(def.name);
	}

	private assertOpen(): void { if (this.closing) throw new Error("App registry is closing"); }

	async enable(name: string, persist = true): Promise<void> {
		this.assertOpen();
		return this.withLifecycleLock(name, () => this.enableInner(name, persist));
	}

	private withLifecycleLock(name: string, op: () => Promise<void>): Promise<void> {
		const previous = this.lifecycleLocks.get(name) ?? Promise.resolve();
		const next = previous.then(op, op);
		this.lifecycleLocks.set(name, next);
		void next.then(() => this.releaseLifecycleLock(name, next), () => this.releaseLifecycleLock(name, next));
		return next;
	}

	private releaseLifecycleLock(name: string, operation: Promise<void>): void { if (this.lifecycleLocks.get(name) === operation) this.lifecycleLocks.delete(name); }

	private createActivation(runtime: AppInstance): AppActivation {
		const activation = new AppActivation(runtime.definition, {
			pi: this.pi,
			runtime,
			setTier: (tier: SurfaceTier) => this.viewport.setTier(runtime, tier),
			notifyExposed: () => this.notifyExposed(),
		});
		runtime.activation = activation;
		return activation;
	}

	private async enableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime) throw new Error("未找到应用: " + name);
		if (runtime.enabled) return;
		const activation = this.createActivation(runtime);
		try { await activation.start(); runtime.enabled = true; }
		catch (error) { runtime.activation = undefined; runtime.enabled = false; throw error; }
		if (persist) await this.persistDesiredState(name, true);
	}

	private async persistDesiredState(name: string, enabled: boolean): Promise<void> {
		this.persistedState = this.persistedState ?? {};
		this.persistedState[name] = enabled;
		const outcome = await this.persistState();
		if (!outcome.ok) this.pi.reportError?.(new Error("应用状态落盘失败: " + name + ": " + String(outcome.error)));
	}

	async disable(name: string, persist = true): Promise<void> { return this.withLifecycleLock(name, () => this.disableInner(name, persist)); }

	private async disableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime || !runtime.activation) return;
		const activation = runtime.activation;
		runtime.enabled = false;
		runtime.surfaceTier = "hidden";
		try { await activation.stop(); } finally { runtime.activation = undefined; }
		if (persist) await this.persistDesiredState(name, false);
	}

	async unregister(name: string): Promise<void> { this.assertOpen(); await this.disable(name, false); this.apps.delete(name); }

	private async persistState(): Promise<SaveOutcome> {
		if (!this.persistedState) return { ok: true };
		const snapshot = { ...this.persistedState };
		const run = this.saveTail.then(async (): Promise<SaveOutcome> => {
			try { await this.stateStore.save(snapshot); return { ok: true }; }
			catch (error) { return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }; }
		});
		this.saveTail = run.catch(() => ({ ok: false }));
		return run;
	}

	list(): readonly AppRuntime[] { return [...this.apps.values()]; }
	get(name: string): AppRuntime | undefined { return this.apps.get(name); }
	has(name: string): boolean { return this.apps.has(name); }
	get size(): number { return this.apps.size; }

	async disposeAll(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			const errors: unknown[] = [];
			for (const name of [...this.apps.keys()]) try { await this.disable(name, false); } catch (error) { errors.push(error); }
			const last = await this.saveTail;
			if (!last.ok && last.error) errors.push(last.error);
			if (errors.length > 0) throw new AggregateError(errors, "App registry cleanup failed");
		})();
		return this.closePromise;
	}
}
