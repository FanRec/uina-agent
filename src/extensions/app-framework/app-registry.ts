import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../../core/errors.js";
import type { ExtensionAPI } from "../runner.js";
import { ResourceScope } from "../lifecycle-scope.js";
import { ContextViewport } from "./context-viewport.js";
import { appendTailFrame } from "../event-frames/projection.js";
import { createFacadeTool } from "./facade-tool.js";
import {
	APP_HOST_EVENT_TYPES,
	type AppDef,
	type AppExposedRegistry,
	type AppRuntime,
} from "./types.js";

/**
 * 读应用期望状态。缺文件（ENOENT）是首次启动的正常缺省；
 * 其余失败与坏 JSON 都要上报并保留诊断，不得静默当成空配置——
 * "读不到"和"确实没有"是两种事实。
 */
async function loadAppsState(filePath?: string, reportError?: (error: unknown) => void): Promise<Record<string, boolean>> {
	if (!filePath) return {};
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
		reportError?.(new Error(`[App Framework] 读取应用状态 ${filePath} 失败: ${errorMessage(error)}。本次按缺省状态继续，但这不等价于"无保存状态"。`));
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const result: Record<string, boolean> = {};
			for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof val === "boolean") result[key] = val;
			}
			return result;
		}
		reportError?.(new Error(`[App Framework] 应用状态 ${filePath} 不是合法的对象形状，已忽略现有状态并按缺省继续。`));
	} catch (error) {
		reportError?.(new Error(`[App Framework] 应用状态 ${filePath} 不是合法 JSON，已忽略现有状态并按缺省继续: ${errorMessage(error)}`));
	}
	return {};
}

/** 原子写（同目录临时文件 + rename）。失败上抛，由调用链决定可见性。 */
async function saveAppsState(filePath: string, state: Record<string, boolean>): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temp = `${filePath}.tmp`;
	await writeFile(temp, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	await rename(temp, filePath);
}

/** 一次写盘尝试的结果：成功、失败（含诊断）。写队列持有它直到下一次写开始。 */
interface SaveOutcome { readonly ok: boolean; readonly error?: Error; }

/**
 * 把核心 InputSource 归类为应用可消费的粗粒度活动来源。
 *
 * 判定依据是接纳事实本身的声明字段，不做内容/时机推断：
 * - kind="user" → human：人/操作者通道（外界有人说话）；
 * - origin="external" → external：来自主体之外的运行时输入；
 * - 其余（runtime+internal、agent、无 source）→ runtime：主体自身的内部活动。
 */
function activityOriginOf(source: import("../../core/types.js").InputSource | undefined): "human" | "external" | "runtime" {
	if (source?.kind === "user") return "human";
	if (source?.origin === "external") return "external";
	return "runtime";
}

interface AppActivation {
	readonly scope: ResourceScope;
	readonly exposed: Map<string, unknown>;
}

interface AppInstance extends AppRuntime {
	activation?: AppActivation;
}

export class AppRegistry {
	private readonly apps = new Map<string, AppInstance>();
	private closing = false;
	private closePromise?: Promise<void>;
	readonly viewport: ContextViewport;
	private readonly stateFilePath?: string;
	private persistedState: Record<string, boolean> | null = null;
	private saveTail: Promise<SaveOutcome> = Promise.resolve({ ok: true });
	/** 每应用启停串行锁：enable/disable 在多 await 之间提交 enabled，并发交错会导致重复
	 * onStart 或遗漏 onStop。同应用的启停必须逐个结算。 */
	private readonly lifecycleLocks = new Map<string, Promise<void>>();

	/**
	 * 应用暴露的活引用：appName → (共享名 → 值)。
	 *
	 * 为何不直接依赖宿主共享表：宿主共享表的作用域是 app-framework 扩展本身，
	 * 应用被停用时不会自动清理。这里按应用分桶，使 disable() 能精确回收该应用
	 * 的全部暴露项，避免"应用已停止但活引用仍可达"的悬垂。
	 */
	private readonly exposedListeners = new Set<() => void>();


	constructor(private readonly pi: ExtensionAPI) {
		this.stateFilePath = this.pi.subject
			? join(this.pi.subject.stateRoot, "apps.json")
			: this.pi.cwd ? join(this.pi.cwd, ".uina", "apps.json") : undefined;
		this.viewport = new ContextViewport({
			getRuntimes: () => this.apps.values(),
		});

		// 尾部相位（tail）：在 compaction 裁剪与项目扩展注入之后，把当前视口快照
		// 以 external_event_frame 三消息组追加到完整上下文的最末尾。
		// - 视口是瞬态上下文，不落 Session；每请求现做现用，上下文任意时刻只有一份“此刻”视口；
		// - systemPrompt 保持完全静态（可变内容不再进入系统提示，消除前缀缓存击穿）；
		// - 全 hidden ⇒ buildTailFrame 返回 undefined ⇒ 0 修改透传（0 token）。
		this.pi.onHook("turn.transformContext", async (projection) => {
			const result = appendTailFrame(projection.messages, await this.viewport.buildTailFrame());
			return result ? { projection: { ...projection, messages: result.messages } } : undefined;
		}, { tail: true });
	}

	/**
	 * 构造"应用暴露表"快照视图。
	 *
	 * 由 activateAppFramework 以 APP_EXPOSED_SHARED_NAME 登记进宿主同进程共享表，
	 * 供系统扩展拉取应用暴露的活引用。应用侧只写、扩展侧只读。
	 */
	exposedRegistry(): AppExposedRegistry {
		return {
			names: () => {
				const all: string[] = [];
				for (const app of this.apps.values()) {
					all.push(...(app.activation?.exposed.keys() ?? []));
				}
				return all;
			},
			get: (name) => {
				for (const app of this.apps.values()) {
					if (app.activation?.exposed.has(name)) return app.activation.exposed.get(name);
				}
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
				// 观察者异常不阻断登记变更
			}
		}
	}

	/**
	 * 登记应用暴露的活引用。
	 *
	 * 同名重复登记**允许覆盖**：应用在 disable→enable 重启时会重新暴露同一端点，
	 * 而框架的职责是持有"该应用当前暴露的东西"。重名冲突的严格判定属于 pi.share
	 * 那一层（两个不同扩展争抢同一名字才是真冲突）。
	 */
	private exposeFor(appName: string, activation: AppActivation, name: string, value: unknown): () => void {
		const app = this.apps.get(appName);
		if (!app || app.activation !== activation || !activation.scope.active) throw new Error("应用已停用: " + appName);
		const previous = activation.exposed.get(name);
		activation.exposed.set(name, value);
		if (previous !== value) this.notifyExposed();

		return () => {
			if (app.activation !== activation || activation.exposed.get(name) !== value) return;
			activation.exposed.delete(name);
			this.notifyExposed();
		};
	}

	private clearExposedFor(appName: string, activation: AppActivation): void {
		const app = this.apps.get(appName);
		if (!app || app.activation !== activation || activation.exposed.size === 0) return;
		activation.exposed.clear();
		this.notifyExposed();
	}

	/** Track an app subscription in the activation scope. */
	private trackSubscription(appName: string, activation: AppActivation, dispose: () => void): () => void {
		let done = false;
		const once = () => {
			if (done) return;
			done = true;
			dispose();
		};
		const app = this.apps.get(appName);
		if (!app || app.activation !== activation) throw new Error("应用已停用: " + appName);
		activation.scope.onDispose(once);
		return once;
	}

	/**
	 * 注册一个 App 定义
	 */
	async register(def: AppDef): Promise<() => Promise<void>> {
		this.assertOpen();
		if (this.apps.has(def.name)) throw new Error("应用 \"" + def.name + "\" 已被注册");
		if (this.persistedState === null) this.persistedState = await loadAppsState(this.stateFilePath);

		const runtime: AppInstance = {
			definition: def,
			enabled: false,
			surfaceTier: def.defaultState?.tier ?? "hidden",
			lastActiveTurn: 0,
		};
		this.apps.set(def.name, runtime);
		try {
			if (this.persistedState[def.name] ?? def.defaultState?.enabled ?? true) await this.enable(def.name, false);
		} catch (error) {
			this.apps.delete(def.name);
			throw error;
		}
		return async () => this.unregister(def.name);
	}

	private assertOpen(): void {
		if (this.closing) throw new Error("App registry is closing");
	}

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

	private releaseLifecycleLock(name: string, operation: Promise<void>): void {
		if (this.lifecycleLocks.get(name) === operation) this.lifecycleLocks.delete(name);
	}

	private createActivation(runtime: AppInstance): AppActivation {
		const activation: AppActivation = {
			scope: new ResourceScope("app:" + runtime.definition.name),
			exposed: new Map(),
		};
		activation.scope.onDispose(() => this.clearExposedFor(runtime.definition.name, activation));
		runtime.activation = activation;
		return activation;
	}

	private companionContext(runtime: AppInstance, activation: AppActivation): import("./types.js").ServiceCompanionContext {
		return {
			signal: activation.scope.signal,
			submitInput: this.pi.submitInput ? (input) => this.pi.submitInput!(input) : undefined,
			isBusy: this.pi.isBusy ? () => this.pi.isBusy!() : undefined,
			appDataDir: this.pi.subject ? join(this.pi.subject.stateRoot, "app-data", runtime.definition.name) : this.pi.cwd ? join(this.pi.cwd, ".uina/apps", runtime.definition.name) : undefined,
			onActivity: this.pi.on ? (listener) => {
				const unbind = this.pi.on!("input_accepted", (event) => listener({ origin: activityOriginOf(event.source) }));
				return this.trackSubscription(runtime.definition.name, activation, unbind);
			} : undefined,
			onHostEvent: this.pi.on ? (listener) => {
				const disposers = APP_HOST_EVENT_TYPES.map((type) => this.pi.on!(type, (event) => listener(event as never)));
				return this.trackSubscription(runtime.definition.name, activation, () => disposers.forEach((dispose) => dispose()));
			} : undefined,
			expose: (exposedName, value) => this.exposeFor(runtime.definition.name, activation, exposedName, value),
			callService: this.pi.callService ? (serviceName, input) => this.pi.callService!(serviceName, input) : undefined,
			hasService: this.pi.hasService ? (serviceName) => this.pi.hasService!(serviceName) : undefined,
		};
	}

	private async enableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime) throw new Error("未找到应用: " + name);
		if (runtime.enabled) return;
		const activation = this.createActivation(runtime);
		const context = this.companionContext(runtime, activation);
		try {
			await runtime.definition.onStart?.(context);
			const rawTool = createFacadeTool(runtime.definition, { getRuntime: () => runtime, setTier: (tier) => this.viewport.setTier(runtime, tier) });
			const tool = {
				...rawTool,
				run: (args: Record<string, unknown>, signal: AbortSignal | undefined, toolContext: Parameters<typeof rawTool.run>[2]) => {
					if (!activation.scope.active) return Promise.resolve({ result: "应用已停用", status: "not_started" as const });
					return activation.scope.run((combined) => rawTool.run(args, combined, toolContext), signal);
				},
			};
			activation.scope.onDispose(this.pi.registerTool(tool));
			runtime.enabled = true;
		} catch (error) {
			await this.rollbackActivation(runtime, activation, context, error);
			throw error;
		}
		if (persist) await this.persistDesiredState(name, true);
	}

	private async rollbackActivation(runtime: AppInstance, activation: AppActivation, context: import("./types.js").ServiceCompanionContext, cause: unknown): Promise<void> {
		const errors: unknown[] = [cause];
		try { await activation.scope.close(); } catch (error) { errors.push(error); }
		try { await runtime.definition.onStop?.(context); } catch (error) { errors.push(error); }
		runtime.activation = undefined;
		runtime.enabled = false;
		if (errors.length > 1) throw new AggregateError(errors, "应用启动回滚失败: " + runtime.definition.name);
	}

	private async persistDesiredState(name: string, enabled: boolean): Promise<void> {
		this.persistedState = this.persistedState ?? {};
		this.persistedState[name] = enabled;
		const outcome = await this.persistState();
		if (!outcome.ok) this.pi.reportError?.(new Error("应用状态落盘失败: " + name + ": " + String(outcome.error)));
	}

	async disable(name: string, persist = true): Promise<void> {
		return this.withLifecycleLock(name, () => this.disableInner(name, persist));
	}

	private async disableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime || !runtime.activation) return;
		const activation = runtime.activation;
		const context = this.companionContext(runtime, activation);
		runtime.enabled = false;
		runtime.surfaceTier = "hidden";
		const errors: unknown[] = [];
		try { await activation.scope.close(); } catch (error) { errors.push(error); }
		try { await runtime.definition.onStop?.(context); } catch (error) { errors.push(error); }
		runtime.activation = undefined;
		if (persist) await this.persistDesiredState(name, false);
		if (errors.length > 0) throw new AggregateError(errors, "应用停用失败: " + name);
	}

	async unregister(name: string): Promise<void> {
		this.assertOpen();
		await this.disable(name, false);
		this.apps.delete(name);
	}

	/** 把当前期望状态快照串入写队列并等待其结算；失败不静默，返回诊断。 */
	private async persistState(): Promise<SaveOutcome> {
		if (!this.stateFilePath || !this.persistedState) return { ok: true };
		const snapshot = { ...this.persistedState };
		const targetPath = this.stateFilePath;
		const run = this.saveTail.then(async (): Promise<SaveOutcome> => {
			try {
				await saveAppsState(targetPath, snapshot);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
			}
		});
		// 写队列持有结算结果（而非吞错），下一次写在其后继续；调用方各自等待自己的 outcome。
		this.saveTail = run.catch(() => ({ ok: false }));
		return run;
	}

	/**
	 * 获取所有应用的只读运行时列表
	 */
	list(): readonly AppRuntime[] {
		return [...this.apps.values()];
	}

	/**
	 * 获取单个应用运行时
	 */
	get(name: string): AppRuntime | undefined {
		return this.apps.get(name);
	}

	/**
	 * 判断应用是否已注册
	 */
	has(name: string): boolean {
		return this.apps.has(name);
	}

	/**
	 * 获取当前已注册应用数量
	 */
	get size(): number {
		return this.apps.size;
	}

	/**
	 * 释放所有应用与伴生服务，并等待已提交的期望状态写入全部结算。
	 */
	async disposeAll(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			const errors: unknown[] = [];
			for (const name of [...this.apps.keys()]) {
				try { await this.disable(name, false); } catch (error) { errors.push(error); }
			}
			const last = await this.saveTail;
			if (!last.ok && last.error) errors.push(last.error);
			if (errors.length > 0) throw new AggregateError(errors, "App registry cleanup failed");
		})();
		return this.closePromise;
	}
}
