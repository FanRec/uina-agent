import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "../../core/errors.js";
import type { ExtensionAPI } from "../runner.js";
import { ContextViewport } from "./context-viewport.js";
import { appendTailFrame } from "../event-frames/projection.js";
import { createFacadeTool } from "./facade-tool.js";
import {
	APP_HOST_EVENT_TYPES,
	type AppDef,
	type AppExposedRegistry,
	type AppRuntime,
	type SurfaceTier,
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

interface AppInstance extends AppRuntime {
	toolDisposer?: () => void;
	readonly exposed: Map<string, unknown>;
	readonly subscriptions: Array<() => void>;
}

export class AppRegistry {
	private readonly apps = new Map<string, AppInstance>();
	private readonly abortController = new AbortController();
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
					all.push(...app.exposed.keys());
				}
				return all;
			},
			get: (name) => {
				for (const app of this.apps.values()) {
					if (app.exposed.has(name)) return app.exposed.get(name);
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
	private exposeFor(appName: string, name: string, value: unknown): () => void {
		const app = this.apps.get(appName);
		if (!app) throw new Error(`未找到应用: "${appName}"`);
		const wasPresent = app.exposed.has(name);
		app.exposed.set(name, value);
		if (!wasPresent) this.notifyExposed();

		return () => {
			if (app.exposed.get(name) !== value) return;
			app.exposed.delete(name);
			this.notifyExposed();
		};
	}

	private clearExposedFor(appName: string): void {
		const app = this.apps.get(appName);
		if (!app || app.exposed.size === 0) return;
		app.exposed.clear();
		this.notifyExposed();
	}

	/** Track an app subscription with an idempotent disposer. */
	private trackSubscription(appName: string, dispose: () => void): () => void {
		let done = false;
		const once = () => {
			if (done) return;
			done = true;
			dispose();
		};
		const app = this.apps.get(appName);
		if (!app) throw new Error(`未找到应用: "${appName}"`);
		app.subscriptions.push(once);
		return once;
	}

	private clearSubscriptionsFor(appName: string): void {
		const app = this.apps.get(appName);
		if (!app || app.subscriptions.length === 0) return;
		const subscriptions = app.subscriptions.splice(0);
		for (const dispose of subscriptions) {
			try {
				dispose();
			} catch {
				// 单个退订失败不阻断其余回收
			}
		}
	}

	/**
	 * 注册一个 App 定义
	 */
	async register(def: AppDef): Promise<() => Promise<void>> {
		if (this.apps.has(def.name)) {
			throw new Error(`应用 "${def.name}" 已被注册，不允许重复注册。`);
		}

		if (this.persistedState === null) {
			this.persistedState = await loadAppsState(this.stateFilePath);
		}

		const defaultTier: SurfaceTier = def.defaultState?.tier ?? "hidden";
		const defaultEnabled = def.defaultState?.enabled ?? true;
		const isEnabled = this.persistedState[def.name] ?? defaultEnabled;

		const runtime: AppInstance = {
			definition: def,
			enabled: false,
			surfaceTier: defaultTier,
			lastActiveTurn: 0,
			exposed: new Map(),
			subscriptions: [],
		};

		this.apps.set(def.name, runtime);

		// 如果默认启用，则挂载工具并触发 onStart（初始加载不写盘）
		if (isEnabled) {
			await this.enable(def.name, false);
		}

		return async () => {
			await this.unregister(def.name);
		};
	}

	/**
	 * 启用一个应用（上桌面，向大模型暴露 Facade Tool）。
	 *
	 * 同一应用的启停操作串行执行：内部在多个 await 之后才提交 enabled，
	 * 并发交错会重复执行 onStart 或遗漏 onStop。
	 */
	async enable(name: string, persist = true): Promise<void> {
		return this.withLifecycleLock(name, () => this.enableInner(name, persist));
	}

	/** 每应用串行锁：无论前一个操作成功还是失败，后续操作按提交顺序逐个结算。 */
	private withLifecycleLock(name: string, op: () => Promise<void>): Promise<void> {
		const previous = this.lifecycleLocks.get(name) ?? Promise.resolve();
		const next = previous.then(op, op);
		this.lifecycleLocks.set(name, next);
		// 清理链自身必须吞错：finally 产生的新 Promise 若随 next 一起拒绝，
		// 会成为调用方之外的第二条未处理拒绝路径。
		void next.catch(() => {}).then(() => {
			if (this.lifecycleLocks.get(name) === next) this.lifecycleLocks.delete(name);
		});
		return next;
	}

	private async enableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime) {
			throw new Error(`未找到应用: "${name}"`);
		}

		if (runtime.enabled) return;

		// 1. 触发外部伴生服务 onStart 钩子
		if (runtime.definition.onStart) {
			await runtime.definition.onStart({
				signal: this.abortController.signal,
				submitInput: this.pi.submitInput ? async (input) => this.pi.submitInput(input) : undefined,
				isBusy: this.pi.isBusy ? () => this.pi.isBusy() : undefined,
				appDataDir: this.pi.subject
					? join(this.pi.subject.stateRoot, "app-data", runtime.definition.name)
					: this.pi.cwd ? join(this.pi.cwd, ".uina/apps", runtime.definition.name) : undefined,
				onActivity: this.pi.on
					? (listener) => {
							// 来源直接取自 input_accepted 的权威 InputSource，不再把 turn_start 一律
							// 当作 human：那会误分类运行时输入，且排队输入要等回合开始才可见。
							const unbindAccepted = this.pi.on("input_accepted", (event) => {
								listener({ origin: activityOriginOf(event.source) });
							});
							return this.trackSubscription(runtime.definition.name, () => {
								unbindAccepted();
							});
					  }
					: undefined,
				// 宿主事件流视图：保留 type 与 channel，供需要区分思考/输出/回合边界的应用使用。
				onHostEvent: this.pi.on
					? (listener) => {
							const disposers = APP_HOST_EVENT_TYPES.map((type) =>
								this.pi.on(type, (event) => {
									listener(event as never);
								}),
							);
							return this.trackSubscription(runtime.definition.name, () => {
								for (const dispose of disposers) dispose();
							});
					  }
					: undefined,
				// 同进程活引用出口：应用只写。消费侧是 pi.shared(APP_EXPOSED_SHARED_NAME)。
				expose: (exposedName, value) => this.exposeFor(runtime.definition.name, exposedName, value),
				callService: this.pi.callService
					? (name, input) => this.pi.callService(name, input)
					: undefined,
				hasService: this.pi.hasService
					? (name) => this.pi.hasService(name)
					: undefined,
			});
		}

		// 2+3. 装配 Facade Tool 并注册：失败必须回滚已启动的伴生服务（补偿语义，
		// 避免"App 的资源在跑但工具未注册"。"enabled" 只在资源操作成功后提交。
		let unregisterTool: () => void;
		try {
			const tool = createFacadeTool(runtime.definition, {
				getRuntime: () => runtime,
				setTier: (tier) => this.viewport.setTier(runtime, tier),
			});
			unregisterTool = this.pi.registerTool(tool);
		} catch (error) {
			// 补偿与 disable 收口一致：工具装配失败不仅要回滚伴生服务，还要撤下
			// 应用在 onStart 里可能已登记的暴露活引用与宿主订阅，避免"资源停在半途
			// 仍可达/仍收事件"的悬垂。enabled 未提交，走完回滚后异常上抛。
			this.clearExposedFor(name);
			this.clearSubscriptionsFor(name);
			await this.stopCompanion(name, runtime.definition);
			throw error;
		}
		runtime.toolDisposer = unregisterTool;

		runtime.enabled = true;

		if (persist) {
			this.persistedState = this.persistedState ?? {};
			this.persistedState[name] = true;
			const outcome = await this.persistState();
			if (!outcome.ok) {
				// 运行时启停已生效，落盘失败如实可见：期望状态与本进程实际状态暂时不一致。
				this.pi.reportError?.(new Error(`[App Framework] 应用 "${name}" 启用成功但期望状态落盘失败: ${String(outcome.error)}`));
			}
		}
	}

	/**
	 * 触发伴生服务 onStop（杀子进程、释放端口）。onStop 失败不吞并主流程：
	 * 以诊断形式上报但继续——工具装配失败需要保留原始 error，停用路径也要走完。
	 */
	private async stopCompanion(name: string, definition: AppDef): Promise<void> {
		if (!definition.onStop) return;
		try {
			await definition.onStop({ signal: this.abortController.signal });
		} catch (error) {
			this.pi.reportError(new Error(`[${name}] onStop 执行失败: ${String(error)}`));
		}
	}

	/**
	 * 停用一个应用（收进抽屉，从大模型视野拔除 Facade Tool，触发 onStop）。
	 * 与 enable 共用每应用串行锁，见 enable 注释。
	 */
	async disable(name: string, persist = true): Promise<void> {
		return this.withLifecycleLock(name, () => this.disableInner(name, persist));
	}

	private async disableInner(name: string, persist: boolean): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime || !runtime.enabled) return;

		// 1. 拔除 Facade Tool
		const unregisterTool = runtime.toolDisposer;
		if (unregisterTool) {
			unregisterTool();
			runtime.toolDisposer = undefined;
		}

		// 2. 触发外部伴生服务 onStop 钩子
		await this.stopCompanion(name, runtime.definition);

		runtime.enabled = false;
		runtime.surfaceTier = "hidden";
		// 应用已停止：回收它暴露的全部活引用与持有的宿主订阅，避免"应用已停但仍可达/仍收事件"的悬垂。
		this.clearExposedFor(name);
		this.clearSubscriptionsFor(name);

		if (persist) {
			this.persistedState = this.persistedState ?? {};
			this.persistedState[name] = false;
			const outcome = await this.persistState();
			if (!outcome.ok) {
				// 运行时停用已生效，落盘失败如实可见：期望状态与本进程实际状态暂时不一致。
				this.pi.reportError?.(new Error(`[App Framework] 应用 "${name}" 停用成功但期望状态落盘失败: ${String(outcome.error)}`));
			}
		}
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
	 * 注销并完全移除一个应用
	 */
	async unregister(name: string): Promise<void> {
		await this.disable(name, false);
		this.apps.delete(name);
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
		this.abortController.abort();
		for (const name of [...this.apps.keys()]) {
			await this.disable(name, false);
		}
		// 关闭前等待全部已提交的期望状态写入结算：不等待就是"可能丢最后一次启停记录"。
		// 若最后一笔写失败，以诊断形式上报后仍完成关闭（运行时资源已回收是另一回事实）。
		const last = await this.saveTail;
		if (!last.ok && last.error) {
			this.pi.reportError?.(new Error(`[App Framework] 关闭前应用期望状态落盘失败: ${String(last.error)}`));
		}
	}
}
