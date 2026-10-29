import { join } from "node:path";
import type { ExtensionAPI } from "../runner.js";
import { type WorldDef, type WorldExposedRegistry, type WorldRuntime } from "./types.js";
import { WorldActivation } from "./world-activation.js";
import { createFileWorldStateStore, type WorldStateStore } from "./world-state-store.js";

interface SaveOutcome {
	readonly ok: boolean;
	readonly error?: Error;
}
interface WorldInstance extends WorldRuntime {
	activation?: WorldActivation;
}

export class WorldRegistry {
	private readonly worlds = new Map<string, WorldInstance>();
	private closing = false;
	private closePromise?: Promise<void>;
	private readonly stateStore: WorldStateStore;
	private persistedState: Record<string, boolean> | null = null;
	private saveTail: Promise<SaveOutcome> = Promise.resolve({ ok: true });
	private readonly lifecycleLocks = new Map<string, Promise<void>>();
	private readonly exposedListeners = new Set<() => void>();

	constructor(
		private readonly pi: ExtensionAPI,
		stateStore?: WorldStateStore,
	) {
		const stateFilePath = this.pi.subject
			? join(this.pi.subject.stateRoot, "worlds.json")
			: this.pi.cwd
				? join(this.pi.cwd, ".uina", "worlds.json")
				: undefined;
		this.stateStore = stateStore ?? createFileWorldStateStore(stateFilePath, (error) => this.pi.reportError?.(error));
	}

	exposedRegistry(): WorldExposedRegistry {
		return {
			names: () => [...this.worlds.values()].flatMap((world) => [...(world.activation?.exposed.keys() ?? [])]),
			get: (name) => {
				for (const world of this.worlds.values())
					if (world.activation?.exposed.has(name)) return world.activation.exposed.get(name);
				return undefined;
			},
			subscribe: (listener) => {
				this.exposedListeners.add(listener);
				return () => this.exposedListeners.delete(listener);
			},
		};
	}

	private notifyExposed(): void {
		for (const listener of [...this.exposedListeners]) {
			try {
				listener();
			} catch {
				/* observer errors do not block registry changes */
			}
		}
	}

	async register(def: WorldDef): Promise<() => Promise<void>> {
		this.assertOpen();
		if (this.worlds.has(def.name)) throw new Error('世界 "' + def.name + '" 已被注册');
		if (this.persistedState === null) this.persistedState = await this.stateStore.load();
		const runtime: WorldInstance = { definition: def, enabled: false };
		this.worlds.set(def.name, runtime);
		try {
			if (this.persistedState[def.name] ?? def.defaultState?.enabled ?? true) await this.enable(def.name, false);
		} catch (error) {
			this.worlds.delete(def.name);
			throw error;
		}
		return async () => this.unregister(def.name);
	}

	private assertOpen(): void {
		if (this.closing) throw new Error("World registry is closing");
	}

	async enable(name: string, persist = true): Promise<void> {
		this.assertOpen();
		return this.withLifecycleLock(name, () => this.enableInner(name, persist));
	}

	private withLifecycleLock(name: string, op: () => Promise<void>): Promise<void> {
		const previous = this.lifecycleLocks.get(name) ?? Promise.resolve();
		const next = previous.then(op, op);
		this.lifecycleLocks.set(name, next);
		void next.then(
			() => this.releaseLifecycleLock(name, next),
			() => this.releaseLifecycleLock(name, next),
		);
		return next;
	}

	private releaseLifecycleLock(name: string, operation: Promise<void>): void {
		if (this.lifecycleLocks.get(name) === operation) this.lifecycleLocks.delete(name);
	}

	private createActivation(runtime: WorldInstance): WorldActivation {
		const activation = new WorldActivation(runtime.definition, {
			pi: this.pi,
			runtime,
			worldName: runtime.definition.name,
			notifyExposed: () => this.notifyExposed(),
		});
		runtime.activation = activation;
		return activation;
	}

	private async enableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.worlds.get(name);
		if (!runtime) throw new Error("未找到世界: " + name);
		if (runtime.enabled) return;
		const activation = this.createActivation(runtime);
		try {
			await activation.start();
			runtime.enabled = true;
		} catch (error) {
			runtime.activation = undefined;
			runtime.enabled = false;
			throw error;
		}
		if (persist) await this.persistDesiredState(name, true);
	}

	private async persistDesiredState(name: string, enabled: boolean): Promise<void> {
		this.persistedState = this.persistedState ?? {};
		this.persistedState[name] = enabled;
		const outcome = await this.persistState();
		if (!outcome.ok) this.pi.reportError?.(new Error("世界状态落盘失败: " + name + ": " + String(outcome.error)));
	}

	async disable(name: string, persist = true): Promise<void> {
		return this.withLifecycleLock(name, () => this.disableInner(name, persist));
	}

	private async disableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.worlds.get(name);
		if (!runtime || !runtime.activation) return;
		const activation = runtime.activation;
		runtime.enabled = false;
		try {
			await activation.stop();
		} finally {
			runtime.activation = undefined;
		}
		if (persist) await this.persistDesiredState(name, false);
	}

	async unregister(name: string): Promise<void> {
		this.assertOpen();
		await this.disable(name, false);
		this.worlds.delete(name);
	}

	private async persistState(): Promise<SaveOutcome> {
		if (!this.persistedState) return { ok: true };
		const snapshot = { ...this.persistedState };
		const run = this.saveTail.then(async (): Promise<SaveOutcome> => {
			try {
				await this.stateStore.save(snapshot);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
			}
		});
		this.saveTail = run.catch(() => ({ ok: false }));
		return run;
	}

	list(): readonly WorldRuntime[] {
		return [...this.worlds.values()];
	}
	get(name: string): WorldRuntime | undefined {
		return this.worlds.get(name);
	}
	has(name: string): boolean {
		return this.worlds.has(name);
	}
	get size(): number {
		return this.worlds.size;
	}

	async disposeAll(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			const errors: unknown[] = [];
			for (const name of [...this.worlds.keys()])
				try {
					await this.disable(name, false);
				} catch (error) {
					errors.push(error);
				}
			const last = await this.saveTail;
			if (!last.ok && last.error) errors.push(last.error);
			if (errors.length > 0) throw new AggregateError(errors, "World registry cleanup failed");
		})();
		return this.closePromise;
	}
}
