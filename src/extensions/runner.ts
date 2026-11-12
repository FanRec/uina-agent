/** Project-local, trusted extension runtime. It deliberately mirrors Pi's
 * lifecycle model: registrations are owned by an activation and become stale
 * on reload/dispose instead of leaking into the next runtime. */
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { AgentInput } from "../agent/loop.js";
import { deliveryKey } from "../core/delivery.js";
import { errorMessage } from "../core/errors.js";
import { Registrations } from "../core/registrations.js";
import type {
	ContextSnapshot,
	ContextSource,
	FileGuidanceSource,
	HostDeliveryPort,
	InputDeliveryOwner,
	Provider,
	RequestInspection,
	RequestUsage,
} from "../core/types.js";
import { HEADLESS_CAPABILITIES } from "../presentation/surface.js";
import { guardRuntimeHooks } from "../runtime/guard.js";
import type { HookName, RuntimeHooks } from "../runtime/hooks.js";
import type { Tool, ToolBroker, ToolExecutionResult } from "../tools/broker.js";
import { type ExtensionEvent, type ExtensionEventHandler, ExtensionHost, type HookHandler } from "./host.js";
import { ResourceScope } from "./lifecycle-scope.js";
import { type DiscoveredExtensionEntry, discoverExtensionEntries, importExtension } from "./loader.js";
import { compilePromptFile } from "./prompt-compiler.js";
import { ExtensionRegistry } from "./renderer-registry.js";
import { createRuntimeHooks } from "./runtime-hooks.js";
import type { CallOptions, ExtensionModelAccess, ExtensionModelRequest, ServiceHandler } from "./services.js";
import type {
	BuiltinUIActionRequest,
	Component,
	CustomEntry,
	CustomMessage,
	ExtensionUIContext,
	LocalCommand,
	PromptOptions,
	TerminalUIContext,
} from "./ui-contract.js";

export interface ExtensionAPI {
	readonly session: {
		list: import("../session/types.js").SessionAccess["list"];
		read: import("../session/types.js").SessionAccess["read"];
		requestRewind(
			request: import("../session/types.js").RewindRequest,
			options?: CallOptions,
		): Promise<import("../session/types.js").RewindResult>;
	};
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly ui: ExtensionUIContext;
	delivery(scope?: string): HostDeliveryPort;
	submitInput(input: AgentInput, options?: { deliveryScope?: string; signal?: AbortSignal }): Promise<void>;
	/**
	 * 多条输入一次交出：每条独立持久入队、独立结果，全部落队后才调度一次消费。
	 * 用于同源的成批事实（例如多处任务同时完成），不要用它把 Steer 和普通输入混成一批。
	 */
	submitInputs(
		inputs: readonly AgentInput[],
		options?: { deliveryScope?: string; signal?: AbortSignal },
	): Promise<readonly import("../agent/loop.js").InputSubmissionOutcome[]>;
	reportError(error: unknown): void;
	on<T extends ExtensionEvent["type"]>(
		type: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void;
	/**
	 * 在干预点注册（Hook ≠ Event，L1）：hook 专属词汇（如 "tools.beforeCall"），
	 * 返回值按该链的合并规则参与组合。事实观察用 on()。
	 * options.tail 仅对 turn.transformContext 有语义（尾部相位，见 ExtensionHost.onHook）。
	 */
	onHook<K extends HookName>(hook: K, handler: HookHandler<K>, options?: { tail?: boolean }): () => void;
	/**
	 * 声明式提供模型可见信息（信息注入重构）：扩展信息贡献的推荐入口。
	 *
	 * - guidance：稳定、可信用法/协议（注册时确定，不随在线状态变化）；
	 * - capability：当前能做什么（动态状态快照，不可用时返回 null）；
	 * - observation：此刻的事实/证据（read 是只读快照，不得产生业务副作用）。
	 *
	 * guidance 有两种等价形态：
	 * - 内联 `text`：同步注册，立即生效；
	 * - 文件式 `file`（扩展 Prompt 文件机制）：相对本扩展资源根的 Markdown 入口，
	 *   注册时一次性编译为普通静态 guidance，Promise 完成后生效；编译失败 Promise
	 *   拒绝并给出定位，不留下半个 Source。两种形态统一装配为 System 后的固定 User
	 *   前缀，语义一致。
	 *
	 * 贡献由运行时统一排版（来源外壳归 Composer），随激活作用域自动注销；
	 * 不修改 model/turn/tools/history——扩展没有普通的请求整体控制权。
	 */
	provideContext: {
		(source: import("../core/types.js").ContextSource): () => void;
		(source: import("../core/types.js").FileGuidanceSource): Promise<() => void>;
	};
	/** 主体绑定：profile 模式下的只读资源根；非 profile 模式为 undefined。
	 * 扩展从这里拿路径，不从模型参数或 cwd 猜测——隔离边界由 Host 装配保证。 */
	readonly subject: { subjectId: string; sessionId: string; memoryRoot: string; stateRoot: string } | undefined;
	/** 主线 hydrated entries（canonical only）：capability 读对话历史的通道。 */
	history(): readonly import("../session/types.js").HydratedSessionEntry[];
	/** auxiliary timeline（仅登记的 records）：capability 读自身私有持久状态的通道——
	 * 私有状态不进主线（非对话事实、非回溯语义节点），故与 history() 分离。 */
	auxiliary(): readonly (
		| import("../session/types.js").SessionEventRecord
		| import("../session/types.js").SessionCustomEntryRecord
	)[];
	/** 事实出口（RuntimeEvent 单流广播）：capability 产生"已发生"的事实（如 session_compact）。 */
	emitEvent(event: import("../runtime/events.js").RuntimeEvent): Promise<void>;
	registerTool(tool: Tool, options?: { replace?: boolean; deliveryScope?: string }): () => void;
	callTool(
		name: string,
		args: Record<string, unknown>,
		options?: CallOptions,
	): Promise<ToolExecutionResult & { callId: string }>;
	registerService<I, O>(name: string, handler: ServiceHandler<I, O>, options?: { replace?: boolean }): () => void;
	callService<O = unknown>(name: string, input: unknown, options?: CallOptions): Promise<O>;
	hasService(name: string): boolean;
	/**
	 * 同进程具名共享：把活引用（对象/函数）交给其他扩展消费。
	 *
	 * 与 callService 的分工是铁律：**纯数据走 callService，活引用走 share**。
	 * callService 双向 structuredClone，传不了函数与带原型的对象；share 不序列化，
	 * 因此**仅同进程有效**。宿主不解释名字与值的语义。
	 *
	 * 生命周期与 registerService 同权：调用方 scope 销毁时自动清理。
	 */
	share(name: string, value: unknown): () => void;
	/** 查询同进程共享值（未登记返回 undefined）。 */
	shared(name: string): unknown | undefined;
	readonly models: {
		current(): import("../core/types.js").Model;
		list(): readonly import("../core/types.js").Model[];
		/** Provider 分组的模型目录（模型选择器数据源）。 */
		groups(): import("./ui-contract.js").ModelPickerGroup[];
		resolve(name: string): import("../core/types.js").Model;
		select(name: string): Promise<void>;
		/** 当前思考档位；模型未声明 thinking 能力时为 undefined。 */
		thinkingLevel(): import("../core/types.js").ThinkingLevel | undefined;
		/** 设置思考档位（与宿主同纪律：失效 usage 锚、广播 thinking_level_select）。 */
		setThinkingLevel(level: import("../core/types.js").ThinkingLevel): void;
		stream(
			model: import("../core/types.js").Model,
			request: ExtensionModelRequest,
			onDelta: Parameters<import("../core/types.js").ModelStreamFn>[2],
			signal?: AbortSignal,
		): Promise<void>;
	};
	/** 当前已知 RequestProjection 的上下文快照（可按需执行纯 inspection）。 */
	context(): Promise<ContextSnapshot>;
	/** Build and measure the same transformed request projection without sending it. */
	inspectRequest(): Promise<RequestInspection>;
	/** 最近一次已发生 Provider 调用的用量事实。 */
	usage(): RequestUsage | undefined;
	/** 主体是否正在回合中。 */
	isBusy(): boolean;
	/** 回合外排他前台活动：占用 Subject、阻止新 turn、受 interrupt 控制、被
	 * waitForIdle/dispose 等待。仅 idle 可进入；传入的 signal 在 Subject interrupt
	 * 与扩展卸载时都会 abort。 */
	runActivity(fn: (signal: AbortSignal) => Promise<void>): Promise<void>;
	/** 重载项目扩展（与宿主 /reload 同一入口：忙时受理，空闲后执行）。 */
	reload(): Promise<void>;
	/** 请求宿主关闭（消费者自定义关闭流程；未接入时走宿主 dispose）。 */
	shutdown(): Promise<void>;
	readonly signal: AbortSignal;
	registerCommand(command: LocalCommand, options?: { replace?: boolean }): () => void;
	listCommands(): readonly LocalCommand[];
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
	/** 主体绑定：提供时 pi.subject 暴露绑定的身份与资源根；缺省 pi.subject 为 undefined。 */
	subjectBinding?: { subjectId: string; sessionId: string; memoryRoot: string; stateRoot: string };
	models?: ExtensionModelAccess;
	tools: ToolBroker;
	onError?: (text: string) => void;
	/** Informational/warning notifications from the fallback UI before a real UI attaches. */
	onNotice?: (text: string) => void;
	onProvider?: (name: string, provider: Provider, options?: { replace?: boolean }) => () => void;
	onModel?: (model: import("../core/types.js").Model, options?: { replace?: boolean }) => () => void;
	onCustomMessage?: (message: CustomMessage) => Promise<void>;
	onCustomEntry?: (entry: CustomEntry) => Promise<void>;
	onInput?: (input: AgentInput, owner?: InputDeliveryOwner) => Promise<void>;
	/**
	 * 批量受理：逐条入队，不逐条启动回合。返回逐条结果，允许部分成功。
	 * 缺省时调用方必须显式处理"合批不可用"，不能假装已经集中受理，也不能静默丢事件。
	 */
	onInputs?: (
		inputs: readonly AgentInput[],
		owner?: InputDeliveryOwner,
	) => Promise<readonly import("../agent/loop.js").InputSubmissionOutcome[]>;
	delivery?: (namespace: string) => HostDeliveryPort;
	/** 当前上下文事实（pi.context()）。 */
	context?: () => Promise<ContextSnapshot>;
	/** 完整 RequestProjection inspection（不发送 Provider、不发布 ContextSnapshot）。 */
	inspectRequest?: () => Promise<RequestInspection>;
	/** 最近一次 Provider 请求用量（pi.usage()）。 */
	usage?: () => RequestUsage | undefined;
	/** 思考档位读写（pi.models.thinkingLevel / setThinkingLevel）。 */
	thinkingLevel?: () => import("../core/types.js").ThinkingLevel | undefined;
	setThinkingLevel?: (level: import("../core/types.js").ThinkingLevel) => void;
	/** 主体忙闲（pi.isBusy()）。 */
	isBusy?: () => boolean;
	/** 回合外排他前台活动（pi.runActivity）。 */
	runActivity?: (fn: (signal: AbortSignal) => Promise<void>) => Promise<void>;
	/** 主线 hydrated entries（pi.history()，canonical only）。 */
	history?: () => readonly import("../session/types.js").HydratedSessionEntry[];
	/** auxiliary timeline（pi.auxiliary()，仅登记 records）。 */
	auxiliary?: () => readonly (
		| import("../session/types.js").SessionEventRecord
		| import("../session/types.js").SessionCustomEntryRecord
	)[];
	/** 事实出口（pi.emitEvent → RuntimeEvent 单流广播）。 */
	emitRuntimeEvent?: (event: import("../runtime/events.js").RuntimeEvent) => Promise<void>;
	/** 宿主级扩展重载（pi.reload()）。 */
	reload?: () => Promise<void>;
	/** 消费者关闭流程（pi.shutdown()）。 */
	shutdown?: () => Promise<void>;
}

export class ExtensionRunner extends ExtensionHost {
	private lifecycleTail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly services = new Registrations<ServiceHandler>();
	private readonly sharedUI = new Map<string, Map<string, Component | undefined>>();
	private readonly extensions = new Map<string, ResourceScope>();
	private readonly failures = new Map<string, { id: string; path: string; error: string }>();
	/** 扩展资源根（Prompt 文件机制）：激活时由 Loader 发现结果注入，卸载时释放。 */
	private readonly resourceRoots = new Map<string, string>();
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
		if (ui.terminal === undefined) return;
		for (const [slot, entries] of this.sharedUI) {
			const current = [...entries.values()].at(-1);
			if (slot === "header") ui.terminal.setHeader(current);
			else ui.terminal.setFooter(current);
		}
	}

	private idForFile(file: string): string {
		return `project:${relative(this.options.cwd, file).replace(/\\/g, "/")}`;
	}

	private listProjectFiles(): Promise<readonly DiscoveredExtensionEntry[]> {
		return discoverExtensionEntries(this.options.cwd, this.options.extensionPaths);
	}

	private setSharedUI(slot: "header" | "footer", owner: string, component: Component | undefined): void {
		const entries = this.sharedUI.get(slot) ?? new Map();
		entries.delete(owner);
		if (component !== undefined) entries.set(owner, component);
		this.sharedUI.set(slot, entries);
		const current = [...entries.values()].at(-1);
		if (this.ui.terminal === undefined) return;
		if (slot === "header") this.ui.terminal.setHeader(current);
		else this.ui.terminal.setFooter(current);
	}

	load(): Promise<void> {
		return this.enqueueLifecycle(() => this.loadProjects());
	}

	private async loadProjects(): Promise<void> {
		const files = await this.listProjectFiles();
		for (const found of files) {
			await this.activate(found.file, found.root);
		}
	}

	/** Core-owned capabilities use the same scope and teardown path as project extensions.
	 * options.resourceRoot：装配点明确提供的独占资源根（启用文件式 guidance），缺省只能用内联。 */
	activateBuiltin(id: string, activate: ExtensionActivation, options?: { resourceRoot?: string }): Promise<void> {
		return this.enqueueLifecycle(() => this.activateBuiltinScope(id, activate, options?.resourceRoot));
	}

	private async activateBuiltinScope(id: string, activate: ExtensionActivation, root?: string): Promise<void> {
		try {
			await this.activateScope(`builtin:${id}`, `builtin:${id}`, activate, root);
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
			const modules: Array<{ id: string; file: string; root?: string; activate: ExtensionActivation }> = [];
			const importFailures: Array<{ id: string; file: string; error: string }> = [];

			for (const found of files) {
				const id = this.idForFile(found.file);
				try {
					const module = await importExtension(found.file);
					if (typeof module.default !== "function") throw new Error("扩展必须默认导出 activate(pi)");
					modules.push({ id, file: found.file, ...(found.root ? { root: found.root } : {}), activate: module.default });
				} catch (error) {
					importFailures.push({ id, file: found.file, error: errorMessage(error) });
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
			for (const { id, file, root, activate } of modules) {
				try {
					await this.activateScope(id, file, activate, root);
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

	/** Produces a dispatch view over this one Host; it never creates another owner.
	 * 所有出口统一过 guard（clone+freeze 单点）：Subject 与 runToolDirect/callTool
	 * 旁路同权，host.run* 由此敢假设输入只读；guard 幂等，重复包装零成本。 */
	runtimeHooks(scope?: readonly string[]): RuntimeHooks {
		return guardRuntimeHooks(createRuntimeHooks(this, scope));
	}

	private async activate(file: string, root?: string): Promise<void> {
		const id = this.idForFile(file);
		try {
			const module = await importExtension(file);
			if (typeof module.default !== "function") throw new Error("扩展必须默认导出 activate(pi)");
			await this.activateScope(id, file, module.default, root);
			this.failures.delete(id);
		} catch (error) {
			this.failures.set(id, { id, path: file, error: errorMessage(error) });
			this.emitOwnedError(id, "activate", error);
		}
	}

	private async activateScope(id: string, path: string, activate: ExtensionActivation, root?: string): Promise<void> {
		if (this.extensions.has(id)) throw new Error(`扩展重复加载: ${id}`);
		this.failures.delete(id);
		const scope = new ResourceScope(id, path);
		this.extensions.set(id, scope);
		if (root !== undefined) this.resourceRoots.set(id, root);
		try {
			const dispose = await activate(this.apiFor(scope));
			if (typeof dispose === "function") scope.onDispose(dispose);
		} catch (error) {
			await this.deactivate(scope);
			throw error;
		}
	}

	private async deactivate(scope: ResourceScope): Promise<void> {
		try {
			await scope.close();
		} catch (error) {
			this.emitOwnedError(scope.id, "cleanup", error);
			this.failures.set(scope.id, { id: scope.id, path: scope.path, error: errorMessage(error) });
			throw error;
		} finally {
			this.extensions.delete(scope.id);
			this.resourceRoots.delete(scope.id);
		}
	}

	private apiFor(scope: ResourceScope): ExtensionAPI {
		const assertActive = () => {
			if (!scope.active) throw new Error(`扩展上下文已失效: ${scope.id}`);
		};
		const ownedKeys = new Set<string>();
		const own = (dispose: ExtensionTeardown): void => scope.onDispose(dispose);
		const ownKeyed = (key: string, dispose: ExtensionTeardown): void => {
			if (ownedKeys.has(key)) return;
			ownedKeys.add(key);
			scope.onDispose(dispose);
		};
		const ui = ownedUI(
			dynamicUI(() => this.ui),
			this.registry,
			scope.id,
			assertActive,
			own,
			ownKeyed,
			(slot, component) => this.setSharedUI(slot, scope.id, component),
			scope.signal,
			<T>(work: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal) => scope.run(work, signal),
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
				list: (options) => sessionAccess().list(options),
				read: (id) => sessionAccess().read(id),
				requestRewind: (request, options) =>
					scope.run((signal) => sessionAccess().requestRewind(request, scope.id, signal), options?.signal),
			},
			id: scope.id,
			path: scope.path,
			cwd: this.options.cwd,
			subject: this.options.subjectBinding ? Object.freeze({ ...this.options.subjectBinding }) : undefined,
			ui,
			signal: scope.signal,
			usage: () => {
				assertActive();
				if (!this.options.usage) throw new Error("宿主未提供用量事实入口");
				return structuredClone(this.options.usage());
			},
			context: async () => {
				assertActive();
				if (!this.options.context) throw new Error("宿主未提供上下文事实入口");
				return structuredClone(await this.options.context());
			},
			inspectRequest: async () => {
				assertActive();
				if (!this.options.inspectRequest) throw new Error("宿主未提供请求检查入口");
				return structuredClone(await this.options.inspectRequest());
			},
			isBusy: () => {
				assertActive();
				if (!this.options.isBusy) throw new Error("宿主未提供忙闲事实入口");
				return this.options.isBusy();
			},
			runActivity: (fn) => {
				assertActive();
				if (!this.options.runActivity) throw new Error("宿主未提供回合外活动入口");
				// scope.run 把 Subject 信号与扩展卸载信号合并后交给 fn：两条取消源
				// （用户 interrupt / deactivate）都到达工作体，且 pending 计入 scope。
				return this.options.runActivity((signal) => scope.run(fn, signal));
			},
			reload: () => {
				assertActive();
				if (!this.options.reload) throw new Error("宿主未提供扩展重载入口");
				return this.options.reload();
			},
			shutdown: () => {
				assertActive();
				if (!this.options.shutdown) throw new Error("宿主未提供关闭入口");
				return this.options.shutdown();
			},
			models: {
				current: () => structuredClone(modelAccess().current()),
				list: () => structuredClone(modelAccess().list()),
				groups: () => structuredClone(modelAccess().groups()),
				resolve: (name) => structuredClone(modelAccess().resolve(name)),
				select: (name) => modelAccess().select(name),
				thinkingLevel: () => {
					assertActive();
					if (!this.options.thinkingLevel) throw new Error("宿主未提供思考档位事实入口");
					return this.options.thinkingLevel();
				},
				setThinkingLevel: (level) => {
					assertActive();
					if (!this.options.setThinkingLevel) throw new Error("宿主未提供思考档位设置入口");
					return this.options.setThinkingLevel(level);
				},
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
			callService: <O>(name: string, input: unknown, options?: CallOptions): Promise<O> => {
				if (!scope.active) return Promise.reject(new Error(`扩展上下文已失效: ${scope.id}`));
				return scope.run(async (signal) => {
					signal.throwIfAborted();
					const service = this.services.get(name);
					if (!service) throw new Error("扩展服务不可用: " + name);
					return structuredClone(await service(structuredClone(input), { callerId: scope.id, signal })) as O;
				}, options?.signal);
			},
			share: (name, value) => {
				assertActive();
				return ownRegistration(this.share(name, value));
			},
			shared: (name) => {
				assertActive();
				return this.shared(name);
			},
			callTool: (name, args, options) =>
				scope.run(async (signal) => {
					const callId = randomUUID();
					const invocationId = `extension:${scope.id}:${callId}`;
					const started = Date.now();
					const record = async (phase: string, data: unknown) => {
						await this.options.onCustomEntry?.({
							customType: "extension.tool",
							data: { phase, callId, name, source: scope.id, data },
						});
					};
					return this.options.tools.createScopedView({ callerId: scope.id }).executePipeline(
						{ name, args: structuredClone(args), callId, invocationId },
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
			delivery: (localScope) => {
				assertActive();
				if (!this.options.delivery) throw new Error("宿主未提供交付回执端口");
				return this.options.delivery(deliveryKey(scope.id, localScope ?? ""));
			},
			submitInput: async (input, inputOptions) => {
				assertActive();
				if (!this.options.onInput) throw new Error("宿主未提供输入入口");
				try {
					await this.options.onInput(cloneAgentInputForHost(input), {
						namespace: deliveryKey(scope.id, inputOptions?.deliveryScope ?? ""),
						isActive: () => scope.active && !inputOptions?.signal?.aborted,
					});
				} catch (error) {
					this.emitOwnedError(scope.id, "submitInput", error);
					throw error;
				}
			},
			submitInputs: async (inputs, inputOptions) => {
				assertActive();
				if (!this.options.onInputs) throw new Error("宿主未提供批量输入入口");
				try {
					return await this.options.onInputs(
						inputs.map((input) => cloneAgentInputForHost(input)),
						{
							namespace: deliveryKey(scope.id, inputOptions?.deliveryScope ?? ""),
							isActive: () => scope.active && !inputOptions?.signal?.aborted,
						},
					);
				} catch (error) {
					this.emitOwnedError(scope.id, "submitInputs", error);
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
			onHook: (hook, handler, options) => {
				assertActive();
				const wrapped: HookHandler<HookName> = async (input) => {
					try {
						return await handler(input as never);
					} catch (error) {
						this.emitOwnedError(scope.id, hook, error);
						return undefined;
					}
				};
				const dispose = this.onHook(hook, wrapped, { scopeId: scope.id, ...(options?.tail ? { tail: true } : {}) });
				own(dispose);
				return dispose;
			},
			provideContext: ((raw: ContextSource | FileGuidanceSource) => {
				assertActive();
				if ("file" in raw) {
					// 文件式：Runner 先在扩展资源根内编译，再注册为普通静态 guidance。
					return this.registerFileGuidance(scope, raw as FileGuidanceSource, ownRegistration);
				}
				// owner 由 Registry 注入真实激活身份：扩展无法通过字符串伪造其他扩展的 Source。
				return ownRegistration(this.provideContext(scope.id, raw as ContextSource, () => scope.active));
			}) as ExtensionAPI["provideContext"],
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
						{ ...options, deliveryNamespace: deliveryKey(scope.id, options?.deliveryScope ?? "") },
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
			listCommands: () => this.registry.listCommands(),
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
					...(provider.measureContext
						? { measureContext: (model, projection) => provider.measureContext!(model, projection) }
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
			history: () => {
				if (!this.options.history) throw new Error("宿主未提供历史读取入口");
				// 所有权边界浅拷贝：canonical 数组属宿主，扩展不得通过数组结构操作破坏
				// state === replay(journal)。条目对象仍共享引用（本地扩展默认受信任）。
				return [...this.options.history()];
			},
			auxiliary: () => {
				if (!this.options.auxiliary) throw new Error("宿主未提供 auxiliary 读取入口");
				return [...this.options.auxiliary()];
			},
			emitEvent: async (event) => {
				if (!this.options.emitRuntimeEvent) throw new Error("宿主未提供事实出口");
				await this.options.emitRuntimeEvent(event);
			},
		};
	}

	private emitOwnedError(extensionName: string, event: string, error: unknown): void {
		this.emitError(event, error, extensionName);
	}

	/**
	 * 文件式 guidance 注册：先完成全部校验与编译，再原子注册；失败不留半个 Source。
	 * 异步编译期间作用域若已停用，不补注册过期 Source。
	 */
	private registerFileGuidance(
		scope: ResourceScope,
		source: FileGuidanceSource,
		ownRegistration: (dispose: () => void) => () => void,
	): Promise<() => void> {
		const reject = (message: string): Promise<never> => Promise.reject(new Error(message));
		if ("text" in source && typeof (source as { text?: unknown }).text === "string")
			return reject("guidance 不允许同时指定 text 和 file");
		if (typeof source.file !== "string" || !source.file.trim()) return reject("guidance 的 file 必须是非空字符串");
		if (typeof source.id !== "string" || !source.id.trim() || source.id.includes("::"))
			return reject('guidance 的 id 必须是非空且不含 "::" 的字符串');
		const root = this.resourceRoots.get(scope.id);
		if (!root)
			return reject(
				`扩展 ${scope.id} 没有独占资源根（单文件扩展无根；内置扩展需在装配点提供 resourceRoot），不能注册文件式 guidance；请改用内联 text`,
			);
		return compilePromptFile(source.file, root).then((compiled) => {
			if (!compiled.text.trim()) throw new Error(`Prompt 入口编译结果为空文本: ${compiled.entry}`);
			if (!scope.active) throw new Error(`扩展上下文已失效: ${scope.id}（编译期间扩展已卸载，未注册）`);
			return ownRegistration(
				this.provideContext(
					scope.id,
					{
						id: source.id,
						kind: "guidance",
						text: compiled.text,
						prompt: { entry: compiled.entry, sources: compiled.sources, hash: compiled.hash },
					},
					() => scope.active,
				),
			);
		});
	}
}

/** AgentInput combines durable data with one runtime-only capability. The host must
 * not retain mutable extension-owned data, but deferred render is intentionally a
 * live callback evaluated at canonical commit time and is never journaled. */
function cloneAgentInputForHost(input: AgentInput): AgentInput {
	const { render, ...durable } = input;
	const cloned: AgentInput = structuredClone(durable);
	return render ? { ...cloned, render } : cloned;
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
	registry: ExtensionRegistry,
	id: string,
	assertActive: () => void,
	own: (dispose: ExtensionTeardown) => void,
	ownKeyed: (key: string, dispose: ExtensionTeardown) => void,
	setShared: (slot: "header" | "footer", component: Component | undefined) => void,
	scopeSignal: AbortSignal,
	runScoped: <T>(work: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal) => Promise<T>,
): ExtensionUIContext {
	const key = (value: string) => `${id}:${value}`;
	const withScopeSignal = (options?: PromptOptions): PromptOptions => ({
		signal: options?.signal ? AbortSignal.any([scopeSignal, options.signal]) : scopeSignal,
	});
	const ownRegistration = (dispose: () => void): (() => void) => {
		own(dispose);
		return dispose;
	};
	const terminalOverrides: Partial<TerminalUIContext> = {
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
			if (base.terminal === undefined) {
				// 无终端 surface：明确不受理，而不是静默成功（audit H1）。
				throw new Error(`扩展 ${id} 调用 showOverlay，但当前 surface 无终端能力；应先用 capabilities() 判断`);
			}
			const handle = base.terminal.showOverlay(component, options);
			own(() => handle.hide());
			return handle;
		},
		registerMessageRenderer: (type, renderer, options) => {
			assertActive();
			return ownRegistration(registry.registerMessageRenderer(type, renderer, options));
		},
		registerToolRenderer: (name, renderer, options) => {
			assertActive();
			return ownRegistration(registry.registerToolRenderer(name, renderer, options));
		},
		registerMarkdownTransformer: (name, transformer, options) => {
			assertActive();
			return ownRegistration(registry.registerMarkdownTransformer(name, transformer, options));
		},
	};
	const terminal: TerminalUIContext | undefined =
		base.terminal === undefined
			? undefined
			: new Proxy(base.terminal, {
					get: (target, property) => {
						const override = Reflect.get(terminalOverrides as object, property) as unknown;
						if (override !== undefined) return override;
						const value = Reflect.get(target as object, property) as unknown;
						if (typeof value !== "function") return value;
						return (...args: unknown[]) => {
							assertActive();
							return (value as (...inner: unknown[]) => unknown).apply(target, args);
						};
					},
				});
	const overrides: Partial<ExtensionUIContext> = {
		terminal,
		select: (title, options, promptOptions) => {
			assertActive();
			return base.select(title, options, withScopeSignal(promptOptions));
		},
		confirm: (title, message, promptOptions) => {
			assertActive();
			return base.confirm(title, message, withScopeSignal(promptOptions));
		},
		input: (title, placeholder, promptOptions) => {
			assertActive();
			return base.input(title, placeholder, withScopeSignal(promptOptions));
		},
		openFeature: (action: BuiltinUIActionRequest) => {
			assertActive();
			const signal = action.signal ? AbortSignal.any([scopeSignal, action.signal]) : scopeSignal;
			if (action.name === "model-picker") {
				const payload = action.payload;
				return base.openFeature({
					...action,
					signal,
					payload: {
						...payload,
						onPick: (name) =>
							runScoped((callbackSignal) => {
								if (callbackSignal.aborted) throw callbackSignal.reason;
								return payload.onPick(name, callbackSignal);
							}, action.signal),
					},
				});
			}
			if (action.name === "effort-slider") {
				const payload = action.payload;
				return base.openFeature({
					...action,
					signal,
					payload: {
						...payload,
						onChange: (level) => {
							if (!signal.aborted) payload.onChange(level);
						},
					},
				});
			}
			return base.openFeature({ ...action, signal });
		},
		setWorking: (name, message) => {
			assertActive();
			const scoped = key(name);
			const ack = base.setWorking(scoped, message);
			ownKeyed(`working:${name}`, () => {
				base.setWorking(scoped, undefined);
			});
			return ack;
		},
		capabilities: () => base.capabilities(),
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
		// print 面把通知直接写出去：受理即已表达，无像素概念。
		notify: (message, type) => {
			write(message, type);
			return { accepted: true };
		},
		clearNotification: () => {},
		// 无展示面可承载工作指示：明确不受理，不静默成功（audit H1）。
		setWorking: () => ({ accepted: false }),
		hasUI: () => false,
		capabilities: () => HEADLESS_CAPABILITIES,
		openFeature: () => false,
	};
}
