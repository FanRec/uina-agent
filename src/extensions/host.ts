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
import { Registrations } from "../core/registrations.js";
import type { ChatMsg } from "../core/types.js";
import { copyValue, readonlySnapshot } from "../runtime/guard.js";
import type {
	DeepReadonly,
	OutputEvent,
	RuntimeEvent,
} from "../runtime/events.js";
import type {
	HookContributions,
	HookHandler,
	HookInputs,
	HookName,
} from "../runtime/hooks.js";

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
	SessionCompactFailedEvent,
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
	private readonly contextContributors = new Registrations<{ scopeId?: string; run: (input: Readonly<{ prompt: string; systemPrompt: string }>, signal?: AbortSignal) => Promise<readonly ChatMsg[]> }>();
 registerContextContributor(name: string, contributor: (input: Readonly<{ prompt: string; systemPrompt: string }>, signal?: AbortSignal) => Promise<readonly ChatMsg[]>, options?: { replace?: boolean; scopeId?: string }): () => void { return this.contextContributors.register(name, { run: contributor, scopeId: options?.scopeId }, options); }
	private handlers = new Map<string, Set<RegisteredHandler>>();
	/** 干预注册空间：键是 HookName 词汇，与事实事件名（handlers）分属两个词表。 */
	private hookHandlers = new Map<HookName, Set<RegisteredHandler>>();
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
		const entry: RegisteredHandler = { handler: handler as unknown as RegistryHandler, ...(scopeId === undefined ? {} : { scopeId }) };
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
		const entry: RegisteredHandler = { handler: handler as unknown as RegistryHandler, ...(options?.scopeId === undefined ? {} : { scopeId: options.scopeId }) };
		set.add(entry);
		return () => {
			set?.delete(entry);
		};
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
				await handler(readonlySnapshot(event) as never);
			} catch (err) {
				this.emitError(event.type, err);
			}
		}
	}

	/** Queue observational events so stream consumers always observe start → update → end. */
	emitObserved(event: OutputEvent, scope?: RuntimeScopeFilter): void {
		this.observedTail = this.observedTail.then(() => this.emit(event, scope)).catch((error) => this.emitError(event.type, error));
	}

	async flush(): Promise<void> {
		await this.observedTail;
	}

	/** tools.beforeCall：短路链——任一 block=true 即拦截。 */
	async runBeforeCall(input: HookInputs["tools.beforeCall"], scope?: RuntimeScopeFilter): Promise<HookContributions["tools.beforeCall"] | undefined> {
		for (const handler of this.hooksFor("tools.beforeCall", scope)) {
			try {
				const res = (await handler(readonlySnapshot(input) as never)) as HookContributions["tools.beforeCall"] | undefined;
				if (res?.block) return res; // 立即短路，跳过后续拦截器
			} catch (err) {
				this.emitError("tools.beforeCall", err);
			}
		}
		return undefined;
	}

	/** tools.transformResult：链式——后一个收到前一个改写后的结果，逐字段覆盖。 */
	async runTransformResult(input: HookInputs["tools.transformResult"], scope?: RuntimeScopeFilter): Promise<HookContributions["tools.transformResult"] | undefined> {
		const current = { ...input };
		let modified = false;

		for (const handler of this.hooksFor("tools.transformResult", scope)) {
			try {
				const res = (await handler(readonlySnapshot(current) as never)) as HookContributions["tools.transformResult"] | undefined;
				if (res) {
					if (res.result !== undefined) { current.result = res.result; modified = true; }
					if (res.details !== undefined) { current.details = copyValue(res.details); modified = true; }
					if (res.images !== undefined) { current.images = copyValue(res.images); modified = true; }
					if (res.status !== undefined) { current.status = res.status; modified = true; }
				}
			} catch (err) {
				this.emitError("tools.transformResult", err);
			}
		}

		return modified ? { result: current.result, status: current.status, details: current.details, images: current.images } : undefined;
	}

	/** turn.transformContext：链式——后一个收到前一个的输出，返回整组替换。 */
	async runTransformContext(messages: readonly ChatMsg[], scope?: RuntimeScopeFilter): Promise<ChatMsg[]> {
		const handlers = this.hooksFor("turn.transformContext", scope);
		if (handlers.length === 0) return [...messages];

		let currentMessages = [...messages];
		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot(currentMessages) as never)) as HookContributions["turn.transformContext"] | undefined;
				if (res?.messages) {
					// 贡献里的元素允许是只读视图；归一化为可变 ChatMsg[] 是 host 的收口职责。
					currentMessages = structuredClone(res.messages) as ChatMsg[];
				}
			} catch (err) {
				this.emitError("turn.transformContext", err);
			}
		}
		return currentMessages;
	}

	/**
	 * turn.prepare：systemPrompt/model/thinkingLevel 后写覆盖先写；message 聚合追加。
	 * 返回值是全链聚合后的回合准备结果（RuntimeHooks.turn.prepare 的形状）。
	 * contextContributors 是同一注入时机的第三条路径（inventory #2），P2 收敛时退役。
	 */
	async runTurnPrepare(
		input: HookInputs["turn.prepare"],
		scope?: RuntimeScopeFilter,
		signal?: AbortSignal,
	): Promise<Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string; model?: import("../core/types.js").Model; thinkingLevel?: import("../core/types.js").ThinkingLevel }> | undefined> {
		const handlers = this.hooksFor("turn.prepare", scope);
		const messages: ChatMsg[] = [];
		let currentPrompt = input.systemPrompt;
		let currentModel: HookContributions["turn.prepare"]["model"];
		let currentThinking: HookContributions["turn.prepare"]["thinkingLevel"];
		let modified = false;

		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({
					prompt: input.prompt,
					systemPrompt: currentPrompt,
				}) as never)) as HookContributions["turn.prepare"] | undefined;
				if (res) {
					if (res.message) {
						messages.push(structuredClone(res.message));
						modified = true;
					}
					if (res.systemPrompt !== undefined) {
						currentPrompt = res.systemPrompt;
						modified = true;
					}
					if (res.model !== undefined) {
						currentModel = structuredClone(res.model);
						modified = true;
					}
					if (res.thinkingLevel !== undefined) {
						currentThinking = res.thinkingLevel;
						modified = true;
					}
				}
			} catch (err) {
				this.emitError("turn.prepare", err);
			}
		}

		{
			for (const contributor of this.contextContributors.values()) {
				if (scope && (!contributor.scopeId || !scope.includes(contributor.scopeId))) continue;
				const additions = await contributor.run(readonlySnapshot({ prompt: input.prompt, systemPrompt: currentPrompt }), signal);
				messages.push(...structuredClone(additions));
				if (additions.length) modified = true;
			}
		}
		return modified
			? {
					messages: messages.length > 0 ? messages : undefined,
					systemPrompt: currentPrompt !== input.systemPrompt ? currentPrompt : undefined,
					...(currentModel !== undefined ? { model: currentModel } : {}),
					...(currentThinking !== undefined ? { thinkingLevel: currentThinking } : {}),
				}
			: undefined;
	}

	/** turn.beforeCompact：短路链——任一 cancel=true 即取消。返回值协议冻结（P2 裁定不扩约）。 */
	async runBeforeCompact(tokensBefore: number, scope?: RuntimeScopeFilter): Promise<boolean> {
		for (const handler of this.hooksFor("turn.beforeCompact", scope)) {
			try {
				const res = (await handler(readonlySnapshot({ tokensBefore }) as never)) as HookContributions["turn.beforeCompact"] | undefined;
				if (res?.cancel) {
					return true; // 请求取消压缩
				}
			} catch (err) {
				this.emitError("turn.beforeCompact", err);
			}
		}
		return false;
	}

	/** turn.shouldStop：短路链——任一 stop=true 即收尾。 */
	async runShouldStop(
		input: HookInputs["turn.shouldStop"],
		scope?: RuntimeScopeFilter,
	): Promise<boolean> {
		for (const handler of this.hooksFor("turn.shouldStop", scope)) {
			try {
				const res = (await handler(readonlySnapshot(input) as never)) as HookContributions["turn.shouldStop"] | undefined;
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
				const res = (await handler(readonlySnapshot({ provider, headers: current }) as never)) as HookContributions["provider.transformHeaders"] | undefined;
				if (res?.headers) current = structuredClone(res.headers);
			} catch (err) {
				this.emitError("provider.transformHeaders", err);
			}
		}
		return structuredClone(current);
	}

	/** provider.transformPayload：链式——后一个收到前一个的输出，整组替换。 */
	async runTransformPayload(provider: string, payload: DeepReadonly<unknown>, scope?: RuntimeScopeFilter): Promise<unknown> {
		const handlers = this.hooksFor("provider.transformPayload", scope);
		if (handlers.length === 0) return payload;

		let current = payload;
		for (const handler of handlers) {
			try {
				const res = (await handler(readonlySnapshot({ provider, payload: current }) as never)) as HookContributions["provider.transformPayload"] | undefined;
				if (res !== undefined && res.payload !== undefined) {
					current = copyValue(res.payload) as typeof current;
				}
			} catch (err) {
				this.emitError("provider.transformPayload", err);
			}
		}
		return copyValue(current);
	}

	/** provider.observeResponse：观察点——响应已发生的审计，无返回值。 */
	async runObserveResponse(
		input: HookInputs["provider.observeResponse"],
		scope?: RuntimeScopeFilter,
	): Promise<void> {
		for (const handler of this.hooksFor("provider.observeResponse", scope)) {
			try {
				await handler(readonlySnapshot(input) as never);
			} catch (err) {
				this.emitError("provider.observeResponse", err);
			}
		}
	}

	private hooksFor(hook: HookName, scope?: RuntimeScopeFilter): RegistryHandler[] {
		const set = this.hookHandlers.get(hook);
		if (!set) return [];
		if (scope === undefined) return [...set].map((entry) => entry.handler);
		const visible = new Set(scope);
		return [...set].filter((entry) => entry.scopeId === undefined || visible.has(entry.scopeId)).map((entry) => entry.handler);
	}

	private handlersFor(eventType: string, scope?: RuntimeScopeFilter): RegistryHandler[] {
		const set = this.handlers.get(eventType);
		if (!set) return [];
		if (scope === undefined) return [...set].map((entry) => entry.handler);
		const visible = new Set(scope);
		return [...set].filter((entry) => entry.scopeId === undefined || visible.has(entry.scopeId)).map((entry) => entry.handler);
	}
}
