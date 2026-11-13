/**
 * Uina 扩展事件宿主（ExtensionHost）。
 *
 * 两个词表严格分离（铁律 L1：Hook ≠ Event）：
 * 1. **事实**（on / emit）：RuntimeEvent 单流广播，订阅方无返回值——系统告诉世界"已经发生了"。
 * 2. **干预**（onHook / run*）：hook 专属词汇（HookName），有返回协议，按各自链的合并规则组合——
 *    系统问扩展"你要不要影响这件事？"。禁止以事件形状挂干预。
 *
 * 另负责扩展 Handler 注册与生命周期派发、异常安全隔离（单个扩展异常不阻塞核心运行）。
 */

import { errorMessage } from "../core/errors.js";
import type { ChatMsg, ContextCollection, ContextRead, ContextSource } from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "../runtime/events.js";
import {
	type HookContributions,
	type HookHandler,
	type HookInputs,
	type HookName,
	warnIgnoredToolStatus,
} from "../runtime/hooks.js";
import { ContextSourceRegistry } from "./context-registry.js";

export type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	ErrorEvent,
	ModelSelectEvent,
	OutputEndEvent,
	OutputInterruptedEvent,
	OutputStartEvent,
	OutputUpdateEvent,
	QueueEvent,
	RuntimeEvent,
	SessionCompactEvent,
	SessionCompactProgressEvent,
	SessionCompactStartEvent,
	ThinkingLevelSelectEvent,
	ToolCallEvent,
	ToolResultEvent,
	TurnAbortedEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../runtime/events.js";

export type {
	HookContributions,
	HookHandler,
	HookInputs,
	HookName,
} from "../runtime/hooks.js";

export interface ExtensionError {
	extensionName?: string;
	event: string;
	error: string;
	stack?: string;
}

export type ExtensionErrorListener = (err: ExtensionError) => void;

/** 事实事件订阅（on）的 handler：只观察，无返回协议。 */
export type ExtensionEventHandler<T extends RuntimeEvent = RuntimeEvent> = (
	event: DeepReadonly<T>,
) => Promise<unknown> | unknown;

/** 事实事件类型（干预已退出事件词表，on() 的类型域由此收窄）。 */
export type ExtensionEvent = RuntimeEvent;

/** 注册容器的中性存储签名：事实与干预 handler 共用容器，存取两侧各自 cast。 */
type RegistryHandler = (input: never) => unknown;

interface RegisteredHandler {
	readonly handler: RegistryHandler;
	readonly scopeId?: string;
}

export type RuntimeScopeFilter = readonly string[] | undefined;

export class ExtensionHost {
	private handlers = new Map<string, Set<RegisteredHandler>>();
	/** 干预注册空间：键是 HookName 词汇，与事实事件名（handlers）分属两个词表。 */
	private hookHandlers = new Map<HookName, Set<RegisteredHandler>>();
	/** Context Source 注册表（信息注入体系）：provideContext 的持有方，随激活作用域注销。 */
	protected readonly contextSources = new ContextSourceRegistry();
	/** History View 提供者槽位（信息注入体系）：单一所有者，重复注册明确报错；
	 * 无提供者时 project 为 identity。随激活作用域注销。 */
	private historyView?: {
		readonly owner: string;
		readonly view: (history: readonly ChatMsg[]) => readonly ChatMsg[];
		readonly isActive: () => boolean;
	};
	/** 同进程共享值表（M1）：零语义，不做序列化，与 services 的纯数据通道互补。 */
	private readonly sharedValues = new Map<string, unknown>();
	private errorListeners = new Set<ExtensionErrorListener>();
	private observedTail: Promise<void> = Promise.resolve();

	/** 订阅事实事件：只观察"已经发生的"，无返回协议。干预注册请用 onHook。 */
	on<T extends ExtensionEvent["type"]>(
		eventType: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void {
		return this.onScoped(undefined, eventType, handler);
	}

	protected onScoped<T extends ExtensionEvent["type"]>(
		scopeId: string | undefined,
		eventType: T,
		handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>,
	): () => void {
		let set = this.handlers.get(eventType);
		if (!set) {
			set = new Set();
			this.handlers.set(eventType, set);
		}
		const entry: RegisteredHandler = {
			handler: handler as unknown as RegistryHandler,
			...(scopeId === undefined ? {} : { scopeId }),
		};
		set.add(entry);
		return () => {
			set?.delete(entry);
		};
	}

	/** 在干预点注册：返回值按该链的合并规则参与组合（Hook ≠ Event，L1）。 */
	onHook<K extends HookName>(hook: K, handler: HookHandler<K>, options?: { scopeId?: string }): () => void {
		let set = this.hookHandlers.get(hook);
		if (!set) {
			set = new Set();
			this.hookHandlers.set(hook, set);
		}
		const entry: RegisteredHandler = {
			handler: handler as unknown as RegistryHandler,
			...(options?.scopeId === undefined ? {} : { scopeId: options.scopeId }),
		};
		set.add(entry);
		return () => {
			set?.delete(entry);
		};
	}

	/**
	 * 注册 Context Source（信息注入体系）：owner 强制使用激活作用域身份，不由 Source
	 * 自报；返回注销句柄。这是 Source 的唯一注册入口——没有第二条 onHook("context...")
	 * 链，避免"注册 Source"与"Context Hook"两种重复写法。
	 */
	provideContext(owner: string, source: ContextSource, isActive: () => boolean): () => void {
		return this.contextSources.register(owner, source, isActive);
	}

	/**
	 * 注册 History View（信息注入体系）：压缩后的可见历史的唯一提供者槽位。
	 * 同一 Host 同时只允许一个提供者；重复注册明确报错。视图只接收历史消息、
	 * 返回合法的历史消息序列；只读、无副作用。可替换函数槽，不建多层 Hook 链。
	 */
	registerHistoryView(
		owner: string,
		view: (history: readonly ChatMsg[]) => readonly ChatMsg[],
		isActive: () => boolean,
	): () => void {
		if (this.historyView) {
			throw new Error(`History View 已由 ${this.historyView.owner} 注册；同一 Host 只允许一个提供者`);
		}
		this.historyView = { owner, view, isActive };
		return () => {
			if (this.historyView?.owner === owner) this.historyView = undefined;
		};
	}

	/** history.project 端口（RuntimeHooks.history）：单一提供者，不活跃视为未注册。 */
	projectHistory(history: readonly ChatMsg[]): readonly ChatMsg[] {
		const view = this.historyView;
		if (!view || !view.isActive()) return history;
		return view.view(history);
	}

	/** context.collect 端口（RuntimeHooks.context）：只读收集当前注册快照，无干预返回协议。 */
	runCollectContext(input: Readonly<ContextRead>, scope?: RuntimeScopeFilter): Promise<ContextCollection> {
		return this.contextSources.collect(input, scope);
	}

	/**
	 * 登记同进程共享值（活引用：对象/函数）。
	 *
	 * 与 services 的分工是一条铁律：**纯数据走 callService，活引用走 share**。
	 * callService 对入参与返回值双向 structuredClone，只能承载纯数据；share 不做任何
	 * 序列化，专门承载活引用，因此**仅同进程有效**。
	 *
	 * 本表零语义：宿主不解释名字与值的含义，只负责登记、查询与销毁。
	 * 重名直接失败而非静默覆盖——覆盖会让已取值的消费者指向非预期对象。
	 */
	share(name: string, value: unknown): () => void {
		if (this.sharedValues.has(name)) {
			throw new Error(`共享名已被占用: ${name}`);
		}
		this.sharedValues.set(name, value);
		return () => {
			if (this.sharedValues.get(name) === value) {
				this.sharedValues.delete(name);
			}
		};
	}

	/** 查询同进程共享值（未登记返回 undefined）。 */
	shared(name: string): unknown | undefined {
		return this.sharedValues.get(name);
	}

	/** 监听扩展执行异常 */
	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	protected emitError(event: string, err: unknown, extensionName?: string): void {
		const message = errorMessage(err);
		const stack = err instanceof Error ? err.stack : undefined;
		for (const listener of this.errorListeners) {
			try {
				listener({ ...(extensionName === undefined ? {} : { extensionName }), event, error: message, stack });
			} catch {
				// 避免错误监听器本身发生次生异常
			}
		}
	}

	/** 广播通用无返回值事件（安全隔离异常） */
	async emit(event: ExtensionEvent, scope?: RuntimeScopeFilter): Promise<void> {
		const handlers = this.handlersFor(event.type, scope);
		if (handlers.length === 0) return;

		for (const handler of handlers) {
			try {
				await handler(event as never);
			} catch (err) {
				this.emitError(event.type, err);
			}
		}
	}

	/** Queue observational events so stream consumers always observe start → update → end. */
	emitObserved(event: OutputEvent, scope?: RuntimeScopeFilter): void {
		if (!this.handlers.has(event.type)) return;
		this.observedTail = this.observedTail
			.then(() => this.emit(event, scope))
			.catch((error) => this.emitError(event.type, error));
	}

	async flush(): Promise<void> {
		await this.observedTail;
	}

	/** tools.beforeCall：短路链——任一 block=true 即拦截。
	 * 纯聚合器：只读不变量由 guard 入侧 clone+freeze 保证（P1-3），此处不再复制。 */
	async runBeforeCall(
		input: HookInputs["tools.beforeCall"],
		scope?: RuntimeScopeFilter,
	): Promise<HookContributions["tools.beforeCall"] | undefined> {
		for (const handler of this.hooksFor("tools.beforeCall", scope)) {
			try {
				const res = (await handler(input as never)) as HookContributions["tools.beforeCall"] | undefined;
				if (res?.block) return res; // 立即短路，跳过后续拦截器
			} catch (err) {
				this.emitError("tools.beforeCall", err);
			}
		}
		return undefined;
	}

	/** tools.transformResult：链式——后一个收到前一个改写后的结果，逐字段覆盖。
	 * status 是执行事实，不参与链式覆盖（贡献合同已删除该字段；流水线独占）。
	 * 纯聚合器（P1-3）：深拷贝只发生在 guard 边界；此处链步间以 shallow rebuild +
	 * Object.freeze 呈现只读视图（O(1)，零拷贝），返回收口在 guard 一次。 */
	async runTransformResult(
		input: HookInputs["tools.transformResult"],
		scope?: RuntimeScopeFilter,
	): Promise<HookContributions["tools.transformResult"] | undefined> {
		let current = input;
		let modified = false;

		for (const handler of this.hooksFor("tools.transformResult", scope)) {
			try {
				const res = (await handler(current as never)) as HookContributions["tools.transformResult"] | undefined;
				if (res) {
					warnIgnoredToolStatus(res);
					const patch: Record<string, unknown> = {};
					if (res.result !== undefined) patch.result = res.result;
					if (res.details !== undefined) patch.details = res.details;
					if (res.images !== undefined) patch.images = res.images;
					if (Object.keys(patch).length > 0) {
						current = Object.freeze({ ...current, ...patch }) as typeof current;
						modified = true;
					}
				}
			} catch (err) {
				this.emitError("tools.transformResult", err);
			}
		}

		return modified ? { result: current.result, details: current.details, images: current.images } : undefined;
	}

	/** turn.preflight：所有决策看同一个只读投影与明确历史视图，归并优先级 fail > rebuild > send。 */
	async runPreflight(
		input: HookInputs["turn.preflight"],
		scope?: RuntimeScopeFilter,
	): Promise<HookContributions["turn.preflight"]> {
		let action: "send" | "rebuild" | "fail" = "send";
		const reasons: string[] = [];
		for (const handler of this.hooksFor("turn.preflight", scope)) {
			try {
				const res = (await handler(input as never)) as HookContributions["turn.preflight"] | undefined;
				if (!res) continue;
				if (res.reason) reasons.push(res.reason);
				if (res.action === "fail") action = "fail";
				else if (res.action === "rebuild" && action === "send") action = "rebuild";
			} catch (err) {
				this.emitError("turn.preflight", err);
				if (action !== "fail") action = "fail";
				reasons.push(errorMessage(err));
			}
		}
		return { action, ...(reasons.length > 0 ? { reason: reasons.join("；") } : {}) };
	}

	/** All observers have seen agent_end; queued work has not resumed yet. */
	async runAfterEnd(input: HookInputs["turn.afterEnd"], scope?: RuntimeScopeFilter): Promise<void> {
		for (const handler of this.hooksFor("turn.afterEnd", scope)) {
			try {
				await handler(input as never);
			} catch (error) {
				this.emitError("turn.afterEnd", error);
			}
		}
	}

	/** turn.shouldStop：短路链——任一 stop=true 即收尾。 */
	async runShouldStop(input: HookInputs["turn.shouldStop"], scope?: RuntimeScopeFilter): Promise<boolean> {
		for (const handler of this.hooksFor("turn.shouldStop", scope)) {
			try {
				const res = (await handler(input as never)) as HookContributions["turn.shouldStop"] | undefined;
				if (res?.stop) return true;
			} catch (err) {
				this.emitError("turn.shouldStop", err);
			}
		}
		return false;
	}

	/** provider.transformHeaders：链式——后一个收到前一个的输出，整组替换。 */
	async runTransformHeaders(
		provider: string,
		headers: Readonly<Record<string, string>>,
		scope?: RuntimeScopeFilter,
	): Promise<Record<string, string>> {
		const handlers = this.hooksFor("provider.transformHeaders", scope);
		if (handlers.length === 0) return { ...headers };

		let current = { ...headers };
		for (const handler of handlers) {
			try {
				const res = (await handler({ provider, headers: current } as never)) as
					| HookContributions["provider.transformHeaders"]
					| undefined;
				if (res?.headers) current = res.headers;
			} catch (err) {
				this.emitError("provider.transformHeaders", err);
			}
		}
		return current;
	}

	/** provider.observeResponse：观察点——响应已发生的审计，无返回值。 */
	async runObserveResponse(input: HookInputs["provider.observeResponse"], scope?: RuntimeScopeFilter): Promise<void> {
		for (const handler of this.hooksFor("provider.observeResponse", scope)) {
			try {
				await handler(input as never);
			} catch (err) {
				this.emitError("provider.observeResponse", err);
			}
		}
	}

	private hookEntriesFor(hook: HookName, scope?: RuntimeScopeFilter): RegisteredHandler[] {
		const set = this.hookHandlers.get(hook);
		if (!set) return [];
		if (scope === undefined) return [...set];
		const visible = new Set(scope);
		return [...set].filter((entry) => entry.scopeId === undefined || visible.has(entry.scopeId));
	}

	private hooksFor(hook: HookName, scope?: RuntimeScopeFilter): RegistryHandler[] {
		return this.hookEntriesFor(hook, scope).map((entry) => entry.handler);
	}

	private handlersFor(eventType: string, scope?: RuntimeScopeFilter): RegistryHandler[] {
		const set = this.handlers.get(eventType);
		if (!set) return [];
		if (scope === undefined) return [...set].map((entry) => entry.handler);
		const visible = new Set(scope);
		return [...set]
			.filter((entry) => entry.scopeId === undefined || visible.has(entry.scopeId))
			.map((entry) => entry.handler);
	}
}
