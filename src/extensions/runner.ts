/** Project-local, trusted extension runtime. It deliberately mirrors Pi's
 * lifecycle model: registrations are owned by an activation and become stale
 * on reload/dispose instead of leaking into the next runtime. */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentInput } from "../agent/loop.js";
import type { ModelProvider } from "../core/types.js";
import type { ToolBroker, Tool } from "../tools/broker.js";
import type { ExtensionUIContext, CustomEntry, CustomMessage, EntryRenderer, LocalCommand, MessageRenderer } from "./ui-contract.js";
import { ExtensionRegistry } from "./renderer-registry.js";
import { ExtensionHost, type ExtensionEvent, type ExtensionEventHandler } from "./host.js";
import { createRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeHooks } from "../runtime/hooks.js";

export interface ExtensionAPI {
	readonly id: string;
	readonly path: string;
	readonly ui: ExtensionUIContext;
	submitInput(input: AgentInput): Promise<void>;
	reportError(error: unknown): void;
	on<T extends ExtensionEvent["type"]>(type: T, handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>): () => void;
	registerTool(tool: Tool): void;
	registerCommand(command: LocalCommand): void;
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
	registerProvider(name: string, provider: ModelProvider): void;
	sendMessage(message: CustomMessage): Promise<void>;
	appendEntry(entry: CustomEntry): Promise<void>;
}

export type ExtensionTeardown = () => void | Promise<void>;
export type ExtensionActivation = (pi: ExtensionAPI) => void | ExtensionTeardown | Promise<void | ExtensionTeardown>;
export type ExtensionModule = { default?: ExtensionActivation };

export interface ExtensionRunnerOptions {
	cwd: string;
	tools: ToolBroker;
	onError?: (text: string) => void;
	/** Informational/warning notifications from the fallback UI before a real UI attaches. */
	onNotice?: (text: string) => void;
	onProvider?: (name: string, provider: ModelProvider) => ExtensionTeardown;
	onCustomMessage?: (message: CustomMessage) => Promise<void>;
	onCustomEntry?: (entry: CustomEntry) => Promise<void>;
	onInput?: (input: AgentInput) => Promise<void>;
}

/** One activation owns every registration it creates. This is the small part
 * of Pi's extension loader/runner lifecycle that Uina needs today. */
class ActivationScope {
	active = true;
	private readonly cleanup: ExtensionTeardown[] = [];
	private readonly keyed = new Map<string, ExtensionTeardown>();
	private dispose?: ExtensionTeardown;

	constructor(readonly id: string, readonly path: string) {}

	own(teardown: ExtensionTeardown): void {
		this.cleanup.push(teardown);
	}

	/** One cleanup per slot, run only when the activation is disposed.
	 * Updating a slot must not clear the content that was just installed. */
	ownKeyed(key: string, teardown: ExtensionTeardown): void {
		if (!this.keyed.has(key)) this.keyed.set(key, teardown);
	}

	setDispose(dispose: ExtensionTeardown): void {
		this.dispose = dispose;
	}

	async deactivate(report: (event: string, error: unknown) => void): Promise<void> {
		if (!this.active) return;
		this.active = false;
		const errors: unknown[] = [];
		const failed = (event: string, error: unknown): void => { errors.push(error); report(event, error); };
		if (this.dispose) {
			try { await this.dispose(); } catch (error) { failed("dispose", error); }
		}
		for (const teardown of this.keyed.values()) {
			try { await teardown(); } catch (error) { failed("cleanup", error); }
		}
		this.keyed.clear();
		for (const cleanup of this.cleanup.splice(0).reverse()) {
			try { await cleanup(); } catch (error) { failed("cleanup", error); }
		}
		if (errors.length) throw new AggregateError(errors, "Extension cleanup failed: " + this.id);
	}
}

export class ExtensionRunner extends ExtensionHost {
	private lifecycleTail: Promise<void> = Promise.resolve();
	private closed = false;
	private generation = 0;
	private readonly extensions = new Map<string, ActivationScope>();
	private readonly failures = new Map<string, { id: string; path: string; error: string }>();
	private ui: ExtensionUIContext;
	readonly registry = new ExtensionRegistry();

	constructor(private readonly options: ExtensionRunnerOptions) {
		super();
		this.ui = createPrintUI((message, type) => {
			if (type === "error") options.onError?.(message);
			else (options.onNotice ?? options.onError)?.(message);
		});
		this.onError((error) => options.onError?.(`[extension_error:${error.extensionName ?? "unknown"}:${error.event}] ${error.error}`));
	}

	attachUI(ui: ExtensionUIContext): void {
		this.ui = ui;
	}

	private idForFile(file: string): string {
		return `project:${file.slice(this.options.cwd.length + 1).replace(/\\/g, "/")}`;
	}

	private async listProjectFiles(): Promise<string[] | undefined> {
		const directory = join(this.options.cwd, ".uina", "extensions");
		try {
			const files = await readdir(directory);
			return files.filter((name) => /\.(?:[cm]?js|ts)$/.test(name)).sort().map((f) => resolve(directory, f));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	load(): Promise<void> { return this.enqueueLifecycle(() => this.loadProjects()); }

	private async loadProjects(): Promise<void> {
		const files = await this.listProjectFiles();
		if (!files) return;
		for (const file of files) {
			await this.activate(file);
		}
	}

	/** Core-owned capabilities use the same scope and teardown path as project extensions. */
	activateBuiltin(id: string, activate: ExtensionActivation): Promise<void> {
		return this.enqueueLifecycle(() => this.activateBuiltinScope(id, activate));
	}

	private async activateBuiltinScope(id: string, activate: ExtensionActivation): Promise<void> {
		try {
			await this.activateScope(`builtin:${id}`, `builtin:${id}`, activate);
		} catch (error) {
			this.failures.set(`builtin:${id}`, { id: `builtin:${id}`, path: `builtin:${id}`, error: errorMessage(error) });
			this.emitOwnedError(`builtin:${id}`, "activate", error);
		}
	}

	reload(): Promise<void> {
		return this.enqueueLifecycle(async () => {
			const files = await this.listProjectFiles();
			if (files === undefined) {
				await this.deactivateScopes(true);
				for (const id of this.failures.keys()) if (id.startsWith("project:")) this.failures.delete(id);
				return;
			}

			// 阶段一：模块解析预检（零副作用验证文件导入与默认导出）。
			// 若有文件语法错误或加载失败，保护现有旧扩展不被卸载并抛错。
			const modules: Array<{ id: string; file: string; activate: ExtensionActivation }> = [];
			const importFailures: Array<{ id: string; file: string; error: string }> = [];

			for (const file of files) {
				const id = this.idForFile(file);
				try {
					const module = await import(`${pathToFileURL(file).href}?uinaReload=${Date.now()}-${++this.generation}`) as ExtensionModule;
					if (typeof module.default !== "function") throw new Error("扩展必须默认导出 activate(pi)");
					modules.push({ id, file, activate: module.default });
				} catch (error) {
					importFailures.push({ id, file, error: errorMessage(error) });
				}
			}

			if (importFailures.length > 0) {
				for (const f of importFailures) {
					this.failures.set(f.id, { id: f.id, path: f.file, error: f.error });
					this.emitOwnedError(f.id, "import", new Error(f.error));
				}
				throw new Error("Extension reload pre-import failed: " + importFailures.map(f => `${f.id}: ${f.error}`).join("; "));
			}

			// 阶段二：卸载旧项目扩展（倒序 LIFO 执行 teardown，注销旧工具/命令/Provider/UI）
			await this.deactivateScopes(true);
			for (const id of this.failures.keys()) {
				if (id.startsWith("project:")) this.failures.delete(id);
			}

			// 阶段三：逐个激活新扩展。单扩展激活异常自动触发其局部 deactivate 精准回收，不影响其他扩展。
			for (const { id, file, activate } of modules) {
				try {
					await this.activateScope(id, file, activate);
				} catch (error) {
					this.failures.set(id, { id, path: file, error: errorMessage(error) });
					this.emitOwnedError(id, "activate", error);
				}
			}
		});
	}

	disposeProjects(): Promise<void> {
		return this.enqueueLifecycle(() => this.deactivateScopes(true));
	}

	dispose(): Promise<void> {
		if (this.closed) return this.lifecycleTail;
		this.closed = true;
		const result = this.lifecycleTail.then(() => this.deactivateScopes(false));
		this.lifecycleTail = result;
		return result;
	}

	private enqueueLifecycle(work: () => Promise<void>): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Extension host is closed"));
		const result = this.lifecycleTail.then(work);
		this.lifecycleTail = result.catch(() => undefined);
		return result;
	}

	private async deactivateScopes(projectsOnly: boolean): Promise<void> {
		const errors: unknown[] = [];
		for (const extension of [...this.extensions.values()].reverse()) {
			if (projectsOnly && !extension.id.startsWith("project:")) continue;
			try { await this.deactivate(extension); } catch (error) { errors.push(error); }
		}
		await this.flush();
		if (errors.length) throw new AggregateError(errors, "Extension cleanup failed");
	}

	list(): ReadonlyArray<{ id: string; path: string; active: boolean }> {
		return [...this.extensions.values()].map(({ id, path, active }) => ({ id, path, active }));
	}

	/** Active scopes plus the last failure for scopes that never activated.
	 * Extensions that fail to load must stay observable instead of vanishing. */
	diagnostics(): ReadonlyArray<{ id: string; path: string; status: "active" | "failed"; error?: string }> {
		const active = [...this.extensions.values()].map(({ id, path }) => ({ id, path, status: "active" as const }));
		const failed = [...this.failures.values()].map(({ id, path, error }) => ({ id, path, status: "failed" as const, error }));
		return [...active, ...failed];
	}

	/** Produces a dispatch view over this one Host; it never creates another owner. */
	runtimeHooks(scope?: readonly string[]): RuntimeHooks {
		return createRuntimeHooks(this, scope);
	}

	private async activate(file: string): Promise<void> {
		const id = this.idForFile(file);
		try {
			const module = await import(`${pathToFileURL(file).href}?uinaReload=${Date.now()}-${++this.generation}`) as ExtensionModule;
			if (typeof module.default !== "function") throw new Error("扩展必须默认导出 activate(pi)");
			await this.activateScope(id, file, module.default);
			this.failures.delete(id);
		} catch (error) {
			this.failures.set(id, { id, path: file, error: errorMessage(error) });
			this.emitOwnedError(id, "activate", error);
		}
	}

	private async activateScope(id: string, path: string, activate: ExtensionActivation): Promise<void> {
		if (this.extensions.has(id)) throw new Error(`扩展重复加载: ${id}`);
		this.failures.delete(id);
		const scope = new ActivationScope(id, path);
		this.extensions.set(id, scope);
		try {
			const dispose = await activate(this.apiFor(scope));
			if (typeof dispose === "function") scope.setDispose(dispose);
		} catch (error) {
			await this.deactivate(scope);
			throw error;
		}
	}

	private async deactivate(scope: ActivationScope): Promise<void> {
		try { await scope.deactivate((event, error) => this.emitOwnedError(scope.id, event, error)); }
		catch (error) {
			this.failures.set(scope.id, { id: scope.id, path: scope.path, error: errorMessage(error) });
			throw error;
		} finally { this.extensions.delete(scope.id); }
	}

	private apiFor(scope: ActivationScope): ExtensionAPI {
		const assertActive = () => { if (!scope.active) throw new Error(`扩展上下文已失效: ${scope.id}`); };
		const own = (dispose: ExtensionTeardown): void => { scope.own(dispose); };
		const ownKeyed = (key: string, dispose: ExtensionTeardown): void => { scope.ownKeyed(key, dispose); };
		const ui = ownedUI(dynamicUI(() => this.ui), scope.id, assertActive, own, ownKeyed);
		return {
			id: scope.id,
			path: scope.path,
			ui,
			reportError: (error) => this.emitOwnedError(scope.id, "external", error),
			submitInput: async (input) => {
				assertActive();
				if (!this.options.onInput) throw new Error("宿主未提供输入入口");
				try {
					await this.options.onInput(structuredClone(input));
				} catch (error) {
					this.emitOwnedError(scope.id, "submitInput", error);
					throw error;
				}
			},
			on: (type, handler) => {
				assertActive();
				const wrapped: ExtensionEventHandler = async (event) => {
					try {
						return await handler(event as never);
					} catch (error) {
						this.emitOwnedError(scope.id, type, error);
						return undefined;
					}
				};
				const dispose = super.onScoped(scope.id, type, wrapped as never);
				own(dispose);
				return dispose;
			},
			registerTool: (tool) => {
				assertActive();
				this.options.tools.register(tool);
				own(() => this.options.tools.remove(tool.def.function.name));
			},
			registerCommand: (command) => {
				assertActive();
				own(this.registry.registerCommand(command));
			},
			registerMessageRenderer: (type, renderer) => {
				assertActive();
				own(this.registry.registerMessageRenderer(type, renderer));
			},
			registerEntryRenderer: (type, renderer) => {
				assertActive();
				own(this.registry.registerEntryRenderer(type, renderer));
			},
			registerProvider: (name, provider) => {
				assertActive();
				if (!this.options.onProvider) throw new Error(`宿主未提供 Provider 注册入口，无法注册 ${name}`);
				const scoped: ModelProvider = {
					get name() { return provider.name; },
					get contextWindow() { return provider.contextWindow; },
					get thinkingLevels() { return provider.thinkingLevels; },
					get includeThinking() { return provider.includeThinking; },
					stream: async (...args) => { assertActive(); return provider.stream(...args); },
					...(provider.refreshModels ? { refreshModels: async () => { assertActive(); return provider.refreshModels!(); } } : {}),
				};
				const dispose = this.options.onProvider(name, scoped);
				if (typeof dispose !== "function") throw new Error("Provider registration must return a disposer: " + name);
				own(dispose);
			},
			sendMessage: async (message) => {
				assertActive();
				if (!this.options.onCustomMessage) throw new Error("宿主未提供 custom message 入口");
				await this.options.onCustomMessage(structuredClone(message));
			},
			appendEntry: async (entry) => {
				assertActive();
				if (!this.options.onCustomEntry) throw new Error("宿主未提供 custom entry 入口");
				await this.options.onCustomEntry(structuredClone(entry));
			},
		};
	}

	private emitOwnedError(extensionName: string, event: string, error: unknown): void {
		this.emitError(event, error, extensionName);
	}
}

/** Live view over the current UI context. Forwarding is generic (Pi: {...ui}),
 * so adding a member to ExtensionUIContext cannot be silently dropped here. */
function dynamicUI(get: () => ExtensionUIContext): ExtensionUIContext {
	return new Proxy({} as ExtensionUIContext, {
		get: (_target, property) => {
			const value = Reflect.get(get() as object, property) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(get()) : value;
		},
	});
}

/** Scope-owned view: every call asserts the activation is alive, stateful UI
 * slots are namespaced per extension and cleaned up on deactivate. */
function ownedUI(
	base: ExtensionUIContext,
	id: string,
	assertActive: () => void,
	own: (dispose: ExtensionTeardown) => void,
	ownKeyed: (key: string, dispose: ExtensionTeardown) => void,
): ExtensionUIContext {
	const key = (value: string) => `${id}:${value}`;
	const overrides: Partial<ExtensionUIContext> = {
		setStatus: (name, text) => {
			assertActive();
			const scoped = key(name);
			base.setStatus(scoped, text);
			ownKeyed(`status:${name}`, () => base.setStatus(scoped, undefined));
		},
		setWidget: (name, component, options) => {
			assertActive();
			const scoped = key(name);
			base.setWidget(scoped, component, options);
			ownKeyed(`widget:${name}`, () => base.setWidget(scoped, undefined));
		},
		setHeader: (component) => {
			assertActive();
			base.setHeader(component);
			ownKeyed("header", () => base.setHeader(undefined));
		},
		setFooter: (component) => {
			assertActive();
			base.setFooter(component);
			ownKeyed("footer", () => base.setFooter(undefined));
		},
		showOverlay: (component, options) => {
			assertActive();
			const handle = base.showOverlay(component, options);
			own(() => handle.hide());
			return handle;
		},
		onTerminalInput: (handler) => {
			assertActive();
			const dispose = base.onTerminalInput(handler);
			own(dispose);
			return dispose;
		},
	};
	return new Proxy(base, {
		get: (target, property) => {
			const override = Reflect.get(overrides as object, property) as unknown;
			if (override !== undefined) return override;
			const value = Reflect.get(target as object, property) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				assertActive();
				return (value as (...inner: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createPrintUI(write: (message: string, type?: "info" | "warning" | "error") => void): ExtensionUIContext {
	return {
		select: async () => undefined, confirm: async () => false, input: async () => undefined,
		notify: write, clearNotification: () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWidget: () => {}, setHeader: () => {}, setFooter: () => {},
		hasUI: () => false,
		showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => true, focus() {}, unfocus() {}, isFocused: () => false }),
		pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", onTerminalInput: () => () => {},
		getGutterMode: () => "scrollbar", setGutterMode: () => {},
	};
}
