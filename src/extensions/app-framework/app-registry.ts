import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "../runner.js";
import { ContextViewport } from "./context-viewport.js";
import { createFacadeTool } from "./facade-tool.js";
import {
	APP_HOST_EVENT_TYPES,
	type AppDef,
	type AppExposedRegistry,
	type AppRuntime,
	type SurfaceTier,
} from "./types.js";

async function loadAppsState(filePath?: string): Promise<Record<string, boolean>> {
	if (!filePath) return {};
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const result: Record<string, boolean> = {};
			for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof val === "boolean") result[key] = val;
			}
			return result;
		}
	} catch {
		// 文件不存在或损坏返回空对象
	}
	return {};
}

async function saveAppsState(filePath: string, state: Record<string, boolean>): Promise<void> {
	try {
		await mkdir(dirname(filePath), { recursive: true });
		const temp = `${filePath}.tmp`;
		await writeFile(temp, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
		await rename(temp, filePath);
	} catch {
		// 容错：落盘失败不阻断运行
	}
}

export class AppRegistry {
	private readonly apps = new Map<string, AppRuntime>();
	private readonly toolDisposers = new Map<string, () => void>();
	private readonly abortController = new AbortController();
	readonly viewport: ContextViewport;
	private readonly stateFilePath?: string;
	private persistedState: Record<string, boolean> | null = null;
	private saveTail: Promise<void> = Promise.resolve();

	/**
	 * 应用暴露的活引用：appName → (共享名 → 值)。
	 *
	 * 为何不直接依赖宿主共享表：宿主共享表的作用域是 app-framework 扩展本身，
	 * 应用被停用时不会自动清理。这里按应用分桶，使 disable() 能精确回收该应用
	 * 的全部暴露项，避免"应用已停止但活引用仍可达"的悬垂。
	 */
	private readonly exposedByApp = new Map<string, Map<string, unknown>>();
	private readonly exposedListeners = new Set<() => void>();

	/**
	 * 应用持有的宿主订阅（onActivity / onHostEvent）。
	 *
	 * 由框架按应用记账，而不是信任应用自觉退订：应用停用后仍在接收宿主事件，
	 * 是"停用的应用仍活着"这类悬垂的典型来源。应用提前自己退订也没问题——登记前
	 * 会套一层一次性保护，两条路径幂等。
	 */
	private readonly appSubscriptions = new Map<string, Array<() => void>>();

	constructor(private readonly pi: ExtensionAPI) {
		this.stateFilePath = this.pi.cwd ? join(this.pi.cwd, ".uina", "apps.json") : undefined;
		this.viewport = new ContextViewport({
			getRuntimes: () => this.apps.values(),
		});

		// 尾部相位（tail）：在 compaction 裁剪与项目扩展注入之后，把当前视口快照
		// 以 external_event_frame 三消息组追加到完整上下文的最末尾。
		// - 视口是瞬态上下文，不落 Session；每请求现做现用，上下文任意时刻只有一份“此刻”视口；
		// - systemPrompt 保持完全静态（可变内容不再进入系统提示，消除前缀缓存击穿）；
		// - 全 hidden ⇒ buildTailFrame 返回 undefined ⇒ 0 修改透传（0 token）。
		this.pi.onHook("turn.transformContext", async (messages) => {
			const frame = await this.viewport.buildTailFrame();
			if (!frame) return undefined;
			return { messages: [...messages, ...frame] };
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
				for (const bucket of this.exposedByApp.values()) {
					all.push(...bucket.keys());
				}
				return all;
			},
			get: (name) => {
				for (const bucket of this.exposedByApp.values()) {
					if (bucket.has(name)) return bucket.get(name);
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
		let bucket = this.exposedByApp.get(appName);
		if (!bucket) {
			bucket = new Map<string, unknown>();
			this.exposedByApp.set(appName, bucket);
		}
		const wasPresent = bucket.has(name);
		bucket.set(name, value);
		if (!wasPresent) this.notifyExposed();

		return () => {
			const current = this.exposedByApp.get(appName);
			if (!current || current.get(name) !== value) return;
			current.delete(name);
			if (current.size === 0) this.exposedByApp.delete(appName);
			this.notifyExposed();
		};
	}

	private clearExposedFor(appName: string): void {
		if (this.exposedByApp.delete(appName)) {
			this.notifyExposed();
		}
	}

	/** 记账一个应用订阅，返回幂等的退订函数（应用自行退订与框架回收两条路径都安全）。 */
	private trackSubscription(appName: string, dispose: () => void): () => void {
		let done = false;
		const once = () => {
			if (done) return;
			done = true;
			dispose();
		};
		const list = this.appSubscriptions.get(appName) ?? [];
		if (list.length === 0) this.appSubscriptions.set(appName, list);
		list.push(once);
		return once;
	}

	/** 应用停用：一次性撤下它持有的全部宿主订阅。 */
	private clearSubscriptionsFor(appName: string): void {
		const list = this.appSubscriptions.get(appName);
		if (!list) return;
		this.appSubscriptions.delete(appName);
		for (const dispose of list) {
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

		const runtime: AppRuntime = {
			definition: def,
			enabled: false,
			surfaceTier: defaultTier,
			lastActiveTurn: 0,
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
	 * 启用一个应用（上桌面，向大模型暴露 Facade Tool）
	 */
	async enable(name: string, persist = true): Promise<void> {
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
				appDataDir: this.pi.cwd ? join(this.pi.cwd, ".uina/apps", runtime.definition.name) : undefined,
				onActivity: this.pi.on
					? (listener) => {
							const unbindTurnStart = this.pi.on("turn_start", () => {
								listener({ origin: "human" });
							});
							return this.trackSubscription(runtime.definition.name, () => {
								unbindTurnStart();
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
		this.toolDisposers.set(name, unregisterTool);

		runtime.enabled = true;

		if (persist) {
			this.persistedState = this.persistedState ?? {};
			this.persistedState[name] = true;
			this.persistState();
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
	 * 停用一个应用（收进抽屉，从大模型视野拔除 Facade Tool，触发 onStop）
	 */
	async disable(name: string, persist = true): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime || !runtime.enabled) return;

		// 1. 拔除 Facade Tool
		const unregisterTool = this.toolDisposers.get(name);
		if (unregisterTool) {
			unregisterTool();
			this.toolDisposers.delete(name);
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
			this.persistState();
		}
	}

	private persistState(): void {
		if (!this.stateFilePath || !this.persistedState) return;
		const snapshot = { ...this.persistedState };
		const targetPath = this.stateFilePath;
		this.saveTail = this.saveTail.then(() => saveAppsState(targetPath, snapshot));
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
	 * 释放所有应用与伴生服务
	 */
	async disposeAll(): Promise<void> {
		this.abortController.abort();
		for (const name of [...this.apps.keys()]) {
			await this.disable(name, false);
		}
	}
}
