import type { ExtensionAPI } from "../runner.js";
import { ContextViewport } from "./context-viewport.js";
import { createFacadeTool } from "./facade-tool.js";
import type { AppDef, AppRuntime, SurfaceTier } from "./types.js";

export class AppRegistry {
	private readonly apps = new Map<string, AppRuntime>();
	private readonly toolDisposers = new Map<string, () => void>();
	private readonly abortController = new AbortController();
	readonly viewport: ContextViewport;

	constructor(private readonly pi: ExtensionAPI) {
		this.viewport = new ContextViewport({
			getRuntimes: () => this.apps.values(),
		});

		// 统一挂载 turn.transformContext 拦截器钩子
		this.pi.onHook("turn.transformContext", async (messages) => {
			const transformed = await this.viewport.transformContext(messages);
			return { messages: transformed };
		});


		// 监听扩展全局中止信号，关闭时自动执行所有已启动应用的 onStop
		this.pi.signal.addEventListener("abort", () => {
			void this.disposeAll();
		});
	}

	/**
	 * 注册一个 App 定义
	 */
	async register(def: AppDef): Promise<() => Promise<void>> {
		if (this.apps.has(def.name)) {
			throw new Error(`应用 "${def.name}" 已被注册，不允许重复注册。`);
		}

		const defaultTier: SurfaceTier = def.defaultState?.tier ?? "hidden";
		const defaultEnabled = def.defaultState?.enabled ?? true;

		const runtime: AppRuntime = {
			definition: def,
			enabled: false,
			surfaceTier: defaultTier,
			lastActiveTurn: 0,
		};

		this.apps.set(def.name, runtime);

		// 如果默认启用，则挂载工具并触发 onStart
		if (defaultEnabled) {
			await this.enable(def.name);
		}

		return async () => {
			await this.unregister(def.name);
		};
	}

	/**
	 * 启用一个应用（上桌面，向大模型暴露 Facade Tool）
	 */
	async enable(name: string): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime) {
			throw new Error(`未找到应用: "${name}"`);
		}

		if (runtime.enabled) return;

		// 1. 触发外部伴生服务 onStart 钩子
		if (runtime.definition.onStart) {
			await runtime.definition.onStart({ signal: this.abortController.signal });
		}

		// 2. 生成 Facade Tool 并向 ToolBroker 注册
		const tool = createFacadeTool(runtime.definition, {
			getRuntime: () => runtime,
			setTier: (tier) => this.viewport.setTier(runtime, tier),
		});

		const unregisterTool = this.pi.registerTool(tool);
		this.toolDisposers.set(name, unregisterTool);

		runtime.enabled = true;
	}

	/**
	 * 停用一个应用（收进抽屉，从大模型视野拔除 Facade Tool，触发 onStop）
	 */
	async disable(name: string): Promise<void> {
		const runtime = this.apps.get(name);
		if (!runtime || !runtime.enabled) return;

		// 1. 拔除 Facade Tool
		const unregisterTool = this.toolDisposers.get(name);
		if (unregisterTool) {
			unregisterTool();
			this.toolDisposers.delete(name);
		}

		// 2. 触发外部伴生服务 onStop 钩子（杀掉子进程、释放端口）
		if (runtime.definition.onStop) {
			try {
				await runtime.definition.onStop({ signal: this.abortController.signal });
			} catch (error) {
				this.pi.reportError(new Error(`[${name}] onStop 执行失败: ${String(error)}`));
			}
		}

		runtime.enabled = false;
		runtime.surfaceTier = "hidden";
	}

	/**
	 * 注销并完全移除一个应用
	 */
	async unregister(name: string): Promise<void> {
		await this.disable(name);
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
			await this.disable(name);
		}
	}
}
