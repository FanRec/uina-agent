/** Project-local, trusted extension runtime. It deliberately mirrors Pi's
 * lifecycle model: registrations are owned by an activation and become stale
 * on reload/dispose instead of leaking into the next runtime. */
import { errorMessage } from "../core/errors.js";
import { randomUUID } from "node:crypto";
import { Registrations } from "../core/registrations.js";
import { discoverExtensions, importExtension } from "./loader.js";
import type { Compactor, CompactionTrigger } from "../core/compaction.js";
import type { CallOptions, ServiceHandler, ExtensionModelAccess, ExtensionModelRequest } from "./services.js";
import { relative } from "node:path";

import type { AgentInput } from "../agent/loop.js";
import type { Provider } from "../core/types.js";
import type { ToolBroker, Tool, ToolExecutionResult } from "../tools/broker.js";
import type {
	ExtensionUIContext,
	CustomEntry,
	CustomMessage,
	EntryRenderer,
	LocalCommand,
	MessageRenderer,
	ToolRenderer,
	MarkdownTransformer,
} from "./ui-contract.js";
import { ExtensionRegistry } from "./renderer-registry.js";
import { ExtensionHost, type ExtensionEvent, type ExtensionEventHandler, type HookHandler } from "./host.js";
import type { HookName } from "../runtime/hooks.js";
import { createRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeHooks } from "../runtime/hooks.js";

export interface ExtensionAPI {
	readonly session: {
		list: import("../session/types.js").SessionAccess["list"];
		read: import("../session/types.js").SessionAccess["read"];
		requestRewind(request: import("../session/types.js").RewindRequest, options?: CallOptions): Promise<import("../session/types.js").RewindResult>;
	};
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly ui: ExtensionUIContext;
	submitInput(input: AgentInput): Promise<void>;
	reportError(error: unknown): void;
	on<T extends ExtensionEvent["type"]>(
		type: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void;
	/**
	 * 在干预点注册（Hook ≠ Event，L1）：hook 专属词汇（如 "tools.beforeCall"），
	 * 返回值按该链的合并规则参与组合。事实观察用 on()。
	 */
	onHook<K extends HookName>(hook: K, handler: HookHandler<K>): () => void;
	registerTool(tool: Tool, options?: { replace?: boolean }): () => void;
	callTool(
		name: string,
		args: Record<string, unknown>,
		options?: CallOptions,
	): Promise<ToolExecutionResult & { callId: string }>;
	registerService<I, O>(name: string, handler: ServiceHandler<I, O>, options?: { replace?: boolean }): () => void;
	callService<O = unknown>(name: string, input: unknown, options?: CallOptions): Promise<O>;
	hasService(name: string): boolean;
	registerContextContributor(
		name: string,
		contributor: (
			input: Readonly<{ prompt: string; systemPrompt: string }>,
			signal: AbortSignal,
		) => readonly import("../core/types.js").ChatMsg[] | Promise<readonly import("../core/types.js").ChatMsg[]>,
		options?: { replace?: boolean },
	): () => void;
	registerCompactor(
		compactor: Compactor,
		options?: { replace?: boolean; shouldCompact?: CompactionTrigger },
	): () => void;
	compact(instruction?: string): Promise<void>;
	readonly models: {
		current(): import("../core/types.js").Model;
		list(): readonly import("../core/types.js").Model[];
		resolve(name: string): import("../core/types.js").Model;
		select(name: string): Promise<void>;
		stream(
			model: import("../core/types.js").Model,
			request: ExtensionModelRequest,
			onDelta: Parameters<import("../core/types.js").ModelStreamFn>[2],
			signal?: AbortSignal,
		): Promise<void>;
	};
	readonly signal: AbortSignal;
	registerCommand(command: LocalCommand, options?: { replace?: boolean }): () => void;
	registerMessageRenderer<T = unknown>(
		customType: string,
		renderer: MessageRenderer<T>,
		options?: { replace?: boolean },
	): () => void;
	registerEntryRenderer<T = unknown>(
		customType: string,
		renderer: EntryRenderer<T>,
		options?: { replace?: boolean },
	): () => void;
	registerToolRenderer(name: string, renderer: ToolRenderer, options?: { replace?: boolean }): () => void;
	registerMarkdownTransformer(
		name: string,
		transformer: MarkdownTransformer,
		options?: { replace?: boolean },
	): () => void;
	registerProvider(name: string, provider: Provider, options?: { replace?: boolean }): () => void;
	registerModel(model: import("../core/types.js").Model, options?: { replace?: boolean }): () => void;
	sendMessage(message: CustomMessage): Promise<void>;
	appendEntry(entry: CustomEntry): Promise<void>;
}

export type ExtensionTeardown = () => void | Promise<void>;
export type ExtensionActivation = (pi: ExtensionAPI) => void | ExtensionTeardown | Promise<void | ExtensionTeardown>;
export type ExtensionModule = { default?: ExtensionActivation };

/** 运行器真正需要的会话能力：查询与回溯请求。分支查询不在其中，所以不向宿主索取。 */
type SessionQuery = Pick<import("../session/types.js").SessionAccess, "list" | "read" | "requestRewind">;

export interface ExtensionRunnerOptions {
	session?: SessionQuery;
	cwd: string;
	extensionPaths?: readonly string[];
	models?: ExtensionModelAccess;
	onCompact?: (instruction?: string) => Promise<void>;
	tools: ToolBroker;
	onError?: (text: string) => void;
	/** Informational/warning notifications from the fallback UI before a real UI attaches. */
	onNotice?: (text: string) => void;
	onProvider?: (name: string, provider: Provider, options?: { replace?: boolean }) => () => void;
	onModel?: (model: import("../core/types.js").Model, options?: { replace?: boolean }) => () => void;
	onCustomMessage?: (message: CustomMessage) => Promise<void>;
	onCustomEntry?: (entry: CustomEntry) => Promise<void>;
	onInput?: (input: AgentInput) => Promise<void>;
}

/** One activation owns every registration it creates. This is the small part
 * of Pi's extension loader/runner lifecycle that Uina needs today. */
class ActivationScope {
	active = true;
	readonly abort = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();
	run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!this.active) return Promise.reject(new Error("扩展上下文已失效: " + this.id));
		const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
		const promise = Promise.resolve().then(() => work(combined));
		this.pending.add(promise);
		void promise.then(
			() => this.pending.delete(promise),
			() => this.pending.delete(promise),
		);
		return promise;
	}
	private readonly cleanup: ExtensionTeardown[] = [];
	private readonly keyed = new Map<string, ExtensionTeardown>();
	private dispose?: ExtensionTeardown;

	constructor(
		readonly id: string,
		readonly path: string,
	) {}

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
		this.abort.abort(new Error("扩展已卸载: " + this.id));
		const errors: unknown[] = [];
		const failed = (event: string, error: unknown): void => {
			errors.push(error);
			report(event, error);
		};
		if (this.dispose) {
			try {
				await this.dispose();
			} catch (error) {
				failed("dispose", error);
			}
		}
		await Promise.allSettled([...this.pending]);
		for (const teardown of this.keyed.values()) {
			try {
				await teardown();
			} catch (error) {
				failed("cleanup", error);
			}
		}
		this.keyed.clear();
		for (const cleanup of this.cleanup.splice(0).reverse()) {
			try {
				await cleanup();
			} catch (error) {
				failed("cleanup", error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "Extension cleanup failed: " + this.id);
	}
}

export class ExtensionRunner extends ExtensionHost {
	private lifecycleTail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly services = new Registrations<ServiceHandler>();
	private readonly compactors = new Registrations<{ run: Compactor; shouldCompact?: CompactionTrigger }>();
	private readonly sharedUI = new Map<string, Map<string, Parameters<ExtensionUIContext["setHeader"]>[0]>>();
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
		this.onError((error) =>
			options.onError?.(`[extension_error:${error.extensionName ?? "unknown"}:${error.event}] ${error.error}`),
		);
	}

	attachUI(ui: ExtensionUIContext): void {
		this.ui = ui;
		for (const [slot, entries] of this.sharedUI) {
			const current = [...entries.values()].at(-1);
			if (slot === "header") ui.setHeader(current);
			else ui.setFooter(current);
		}
	}

	private idForFile(file: string): string {
		return `project:${relative(this.options.cwd, file).replace(/\\/g, "/")}`;
	}

	private listProjectFiles(): Promise<string[]> {
		return discoverExtensions(this.options.cwd, this.options.extensionPaths);
	}

	readonly compactionTrigger: CompactionTrigger = (input) => this.compactors.get("compaction")?.shouldCompact?.(input);
	readonly compactor: Compactor = async (request, signal) => this.compactors.get("compaction")?.run(request, signal);

	private setSharedUI(
		slot: "header" | "footer",
		owner: string,
		component: Parameters<ExtensionUIContext["setHeader"]>[0],
	): void {
		const entries = this.sharedUI.get(slot) ?? new Map();
		entries.delete(owner);
		if (component !== undefined) entries.set(owner, component);
		this.sharedUI.set(slot, entries);
		const current = [...entries.values()].at(-1);
		if (slot === "header") this.ui.setHeader(current);
		else this.ui.setFooter(current);
	}

	load(): Promise<void> {
		return this.enqueueLifecycle(() => this.loadProjects());
	}

	private async loadProjects(): Promise<void> {
		const files = await this.listProjectFiles();
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

			// 阶段一：模块导入预检（执行模块顶层代码，不调用 activate）。
			// 若有文件语法错误或加载失败，保护现有旧扩展不被卸载并抛错。
			const modules: Array<{ id: string; file: string; activate: ExtensionActivation }> = [];
			const importFailures: Array<{ id: string; file: string; error: string }> = [];

			for (const file of files) {
				const id = this.idForFile(file);
				try {
					const module = await importExtension(file);
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
				throw new Error(
					"Extension reload pre-import failed: " + importFailures.map((f) => `${f.id}: ${f.error}`).join("; "),
				);
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
			try {
				await this.deactivate(extension);
			} catch (error) {
				errors.push(error);
			}
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
		const failed = [...this.failures.values()].map(({ id, path, error }) => ({
			id,
			path,
			status: "failed" as const,
			error,
		}));
		return [...active, ...failed];
	}

	/** Produces a dispatch view over this one Host; it never creates another owner. */
	runtimeHooks(scope?: readonly string[]): RuntimeHooks {
		return createRuntimeHooks(this, scope);
	}

	private async activate(file: string): Promise<void> {
		const id = this.idForFile(file);
		try {
			const module = await importExtension(file);
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
		try {
			await scope.deactivate((event, error) => this.emitOwnedError(scope.id, event, error));
		} catch (error) {
			this.failures.set(scope.id, { id: scope.id, path: scope.path, error: errorMessage(error) });
			throw error;
		} finally {
			this.extensions.delete(scope.id);
		}
	}

	private apiFor(scope: ActivationScope): ExtensionAPI {
		const assertActive = () => {
			if (!scope.active) throw new Error(`扩展上下文已失效: ${scope.id}`);
		};
		const own = (dispose: ExtensionTeardown): void => {
			scope.own(dispose);
		};
		const ownKeyed = (key: string, dispose: ExtensionTeardown): void => {
			scope.ownKeyed(key, dispose);
		};
		const ui = ownedUI(
			dynamicUI(() => this.ui),
			scope.id,
			assertActive,
			own,
			ownKeyed,
			(slot, component) => this.setSharedUI(slot, scope.id, component),
		);
		const ownRegistration = (dispose: () => void): (() => void) => {
			own(dispose);
			return dispose;
		};
		const sessionAccess = (): SessionQuery => {
			assertActive();
			if (!this.options.session) throw new Error("宿主未提供会话入口");
			return this.options.session;
		};
		const modelAccess = (): ExtensionModelAccess => {
			assertActive();
			if (!this.options.models) throw new Error("宿主未提供模型服务");
			return this.options.models;
		};
		return {
			session: {
				list: options => sessionAccess().list(options),
				read: id => sessionAccess().read(id),
				requestRewind: (request, options) => scope.run(signal => sessionAccess().requestRewind(request,scope.id,signal),options?.signal),
			},
			id: scope.id,
			path: scope.path,
			cwd: this.options.cwd,
			ui,
			signal: scope.abort.signal,
			compact: (instruction) => {
				assertActive();
				if (!this.options.onCompact) throw new Error("宿主未提供压缩入口");
				return this.options.onCompact(instruction);
			},
			registerContextContributor: (name, contributor, options) => {
				assertActive();
				return ownRegistration(
					this.registerContextContributor(
						name,
						(input, cancellation) =>
							scope.run(async (signal) => {
								signal.throwIfAborted();
								return await contributor(input, signal);
							}, cancellation),
						{ ...options, scopeId: scope.id },
					),
				);
			},
			registerCompactor: (compactor, options) => {
				assertActive();
				return ownRegistration(
					this.compactors.register(
						"compaction",
						{
							run: (request, signal) =>
								scope.run(async (combined) => {
									const proposal = await compactor(request, combined);
									combined.throwIfAborted();
									return proposal;
								}, signal),
							shouldCompact: options?.shouldCompact,
						},
						options,
					),
				);
			},
			models: {
				current: () => structuredClone(modelAccess().current()),
				list: () => structuredClone(modelAccess().list()),
				resolve: (name) => structuredClone(modelAccess().resolve(name)),
				select: (name) => modelAccess().select(name),
				stream: (model, request, onDelta, signal) =>
					scope.run(
						(combined) =>
							modelAccess().stream(
								model,
								{ ...request, providerHooks: this.runtimeHooks().provider },
								onDelta,
								combined,
							),
						signal,
					),
			},
			registerService: (name, handler, options) => {
				assertActive();
				return ownRegistration(
					this.services.register(
						name,
						(input, context) =>
							scope.run((signal) => Promise.resolve(handler(input as never, { ...context, signal })), context.signal),
						options,
					),
				);
			},
			hasService: (name) => {
				assertActive();
				return this.services.has(name);
			},
			callService: <O>(name: string, input: unknown, options?: CallOptions): Promise<O> =>
				scope.run(async (signal) => {
					signal.throwIfAborted();
					const service = this.services.get(name);
					if (!service) throw new Error("扩展服务不可用: " + name);
					return structuredClone(await service(structuredClone(input), { callerId: scope.id, signal })) as O;
				}, options?.signal),
			callTool: (name, args, options) =>
				scope.run(async (signal) => {
					const callId = randomUUID();
					const started = Date.now();
					const record = async (phase: string, data: unknown) => {
						await this.options.onCustomEntry?.({
							customType: "extension.tool",
							data: { phase, callId, name, source: scope.id, data },
						});
					};
					return this.options.tools.createScopedView({ callerId: scope.id }).executePipeline(
						{ name, args: structuredClone(args), callId },
						{
							signal,
							hooks: this.runtimeHooks().tools,
							observers: {
								onStart: () => record("started", { args }),
								onDone: (outcome) => record("finished", { ...outcome, elapsedMs: Date.now() - started }),
							},
						},
					);
				}, options?.signal),
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
			onHook: (hook, handler) => {
				assertActive();
				const wrapped: HookHandler<HookName> = async (input) => {
					try {
						return await handler(input as never);
					} catch (error) {
						this.emitOwnedError(scope.id, hook, error);
						return undefined;
					}
				};
				const dispose = this.onHook(hook, wrapped, { scopeId: scope.id });
				own(dispose);
				return dispose;
			},
			registerTool: (tool, options) => {
				assertActive();
				return ownRegistration(
					this.options.tools.register(
						{
							...tool,
							run: (args, signal, context) => {
								if (!scope.active) return Promise.resolve({ result: "扩展已卸载", status: "not_started" });
								return scope.run(async (combined) => {
									if (combined.aborted) return { result: "工具尚未启动，调用已取消", status: "not_started" };
									try {
										return await tool.run(args, combined, context);
									} catch (error) {
										if (combined.aborted) return { result: "工具已启动，取消后结果未知", status: "unknown" };
										throw error;
									}
								}, signal);
							},
						},
						options,
					),
				);
			},
			registerCommand: (command, options) => {
				assertActive();
				return ownRegistration(
					this.registry.registerCommand(
						{
							...command,
							handler: command.handler
								? (args) => {
										assertActive();
										return command.handler!(args);
									}
								: undefined,
						},
						options,
					),
				);
			},
			registerMessageRenderer: (type, renderer, options) => {
				assertActive();
				return ownRegistration(this.registry.registerMessageRenderer(type, renderer, options));
			},
			registerEntryRenderer: (type, renderer, options) => {
				assertActive();
				return ownRegistration(this.registry.registerEntryRenderer(type, renderer, options));
			},
			registerToolRenderer: (name, renderer, options) => {
				assertActive();
				return ownRegistration(this.registry.registerToolRenderer(name, renderer, options));
			},
			registerMarkdownTransformer: (name, transformer, options) => {
				assertActive();
				return ownRegistration(this.registry.registerMarkdownTransformer(name, transformer, options));
			},
			registerModel: (model, options) => {
				assertActive();
				if (!this.options.onModel) throw new Error("宿主未提供模型注册入口");
				return ownRegistration(this.options.onModel(structuredClone(model), options));
			},
			registerProvider: (name, provider, options) => {
				assertActive();
				if (!this.options.onProvider) throw new Error(`宿主未提供 Provider 注册入口，无法注册 ${name}`);
				const scoped: Provider = {
					id: provider.id ?? name,
					get name() {
						return provider.name;
					},
					get baseUrl() {
						return provider.baseUrl;
					},
					stream: (model, request, emit, signal) =>
						scope.run((combined) => provider.stream(model, request, emit, combined), signal),
					...(provider.refreshModels
						? {
								refreshModels: async () => {
									assertActive();
									return provider.refreshModels!();
								},
							}
						: {}),
				};
				const dispose = this.options.onProvider(name, scoped, options);
				if (typeof dispose !== "function") throw new Error("Provider registration must return a disposer: " + name);
				return ownRegistration(dispose);
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
	setShared: (slot: "header" | "footer", component: Parameters<ExtensionUIContext["setHeader"]>[0]) => void,
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
			setShared("header", component);
			ownKeyed("header", () => setShared("header", undefined));
		},
		setFooter: (component) => {
			assertActive();
			setShared("footer", component);
			ownKeyed("footer", () => setShared("footer", undefined));
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


export function createPrintUI(
	write: (message: string, type?: "info" | "warning" | "error") => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: write,
		clearNotification: () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWidget: () => {},
		setHeader: () => {},
		setFooter: () => {},
		hasUI: () => false,
		showOverlay: () => ({
			hide() {},
			setHidden() {},
			isHidden: () => true,
			focus() {},
			unfocus() {},
			isFocused: () => false,
		}),
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		onTerminalInput: () => () => {},
		getGutterMode: () => "scrollbar",
		setGutterMode: () => {},
	};
}
