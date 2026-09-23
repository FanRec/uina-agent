import type { ChatMsg, FinishReason, Model, RequestProjection, ThinkingLevel, TokenMeasurement, ToolResultStatus } from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "./events.js";
import type { ImageContent } from "../core/content.js";

export interface ProviderHooks {
	transformHeaders(provider: string, headers: Readonly<Record<string, string>>): Promise<Record<string, string>>;
	transformPayload(provider: string, payload: DeepReadonly<unknown>): Promise<unknown>;
	observeResponse(input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>): Promise<void>;
}

/**
 * 干预注册点词汇（Hook ≠ Event，铁律 L1）。
 *
 * Hook = 系统问扩展"你要不要影响这件事？"——有返回协议，按下面各链的合并规则组合；
 * Event = 系统告诉世界"这件事已经发生了"——无返回值，单流广播（RuntimeEvent）。
 * 干预注册只能用这里的名字（onHook），事实订阅只能用 RuntimeEvent 的 type（on）。
 * 两个词表不得混居：混居会让扩展作者无法分辨自己在影响系统还是在观察系统。
 */
export type HookName =
	| "turn.prepare"
	| "turn.transformContext"
	| "turn.preflight"
	| "turn.afterEnd"
	| "turn.shouldStop"
	| "tools.beforeCall"
	| "tools.transformResult"
	| "provider.transformHeaders"
	| "provider.transformPayload"
	| "provider.observeResponse";

/** 各干预注册点的输入（只读化由 HookHandler 统一施加，形状与 RuntimeHooks 对应方法的入参一致）。 */
export interface HookInputs {
	"turn.prepare": { readonly prompt: string; readonly systemPrompt: string };
	"turn.transformContext": RequestProjection;
	"turn.preflight": { readonly projection: RequestProjection; readonly measurement: TokenMeasurement; readonly pass: number };
	"turn.afterEnd": { readonly turnNumber: number; readonly success: boolean; readonly error?: string };
	"turn.shouldStop": { readonly turnNumber: number; readonly finishReason: FinishReason; readonly reply: string; readonly toolCallCount: number };
	"tools.beforeCall": { readonly callId: string; readonly name: string; readonly args: Record<string, unknown> };
	"tools.transformResult": { readonly callId: string; readonly name: string; readonly args: Record<string, unknown>; readonly result: string; readonly status: ToolResultStatus; readonly images?: readonly ImageContent[]; readonly details?: unknown };
	"provider.transformHeaders": { readonly provider: string; readonly headers: Readonly<Record<string, string>> };
	"provider.transformPayload": { readonly provider: string; readonly payload: unknown };
	"provider.observeResponse": { readonly provider: string; readonly status: number; readonly headers: Record<string, string> };
}

/**
 * 单个扩展在干预点的贡献形状（onHook handler 的返回值）。
 * RuntimeHooks 对应方法的返回值 = 所有扩展贡献按合并规则聚合后的结果。
 */
export interface HookContributions {
	"turn.prepare": { readonly messages?: readonly ChatMsg[]; readonly systemPrompt?: string; readonly model?: Model; readonly thinkingLevel?: ThinkingLevel };
	"turn.transformContext": { readonly projection?: RequestProjection | DeepReadonly<RequestProjection> };
	"turn.preflight": { readonly action?: "send" | "rebuild" | "fail"; readonly reason?: string };
	"turn.afterEnd": Record<string, never>;
	"turn.shouldStop": { readonly stop?: boolean };
	"tools.beforeCall": { readonly block?: boolean; readonly reason?: string };
	"tools.transformResult": { readonly result?: string; readonly images?: readonly ImageContent[]; readonly details?: unknown };
	"provider.transformHeaders": { readonly headers?: Record<string, string> };
	"provider.transformPayload": { readonly payload?: unknown };
	"provider.observeResponse": void;
}

/** 干预注册点（onHook）的 handler：输入为只读快照，返回该扩展的单点贡献。 */
export type HookHandler<K extends HookName> = (
	input: DeepReadonly<HookInputs[K]>,
) => Promise<HookContributions[K] | undefined> | HookContributions[K] | undefined;

/**
 * 各 Interceptor 链的合并规则（铁律 L6：每条链的组合语义必须成文）。
 *
 * | hook                        | 合并规则                                   |
 * | --------------------------- | ------------------------------------------ |
 * | turn.prepare                | systemPrompt/model/thinkingLevel 后写覆盖先写；messages 聚合追加 |
 * | turn.transformContext       | 链式：后一个收到前一个的输出，返回整组替换      |
 * | turn.preflight              | 归并：fail > rebuild > send；只读投影决策    |
 * | turn.shouldStop             | 短路：任一 stop=true 即收尾，后续不再询问       |
 * | tools.beforeCall            | 短路：任一 block=true 即拦截，后续不再询问      |
 * | tools.transformResult       | 链式：后一个收到前一个改写后的结果，逐字段覆盖（status 除外——执行事实由流水线独占） |
 * | provider.transformHeaders   | 链式：后一个收到前一个的输出，整组替换          |
 * | provider.transformPayload   | 链式：后一个收到前一个的输出，整组替换          |
 * | provider.observeResponse    | 观察：无返回值，只多播（响应已发生的审计点）     |
 */


/** 贡献合同没有 status。JS 扩展仍可能带回该字段：丢弃前警告，不把笔误升级成整回合失败。 */
export function warnIgnoredToolStatus(contribution: object | null | undefined): void {
	if (contribution != null && "status" in contribution && (contribution as { status?: unknown }).status !== undefined) {
		console.warn("[工具结果] tools.transformResult 贡献的 status 已被忽略：执行状态由工具结果独占，不可改写");
	}
}

export interface RuntimeHooks {
	readonly turn: {
		/**
		 * 回合边界准备：可注入消息、改写 systemPrompt，也可直接给出新的 Model 事实
		 * 或 thinking 档位（Subject 在安全点以 setModel 的完整纪律应用：失效 usage 锚、
		 * 广播 model_select）。对应 Pi 的 prepareNextTurn。
		 */
		prepare(input: Readonly<{ prompt: string; systemPrompt: string }>): Promise<Readonly<{ messages?: readonly ChatMsg[]; systemPrompt?: string; model?: Model; thinkingLevel?: ThinkingLevel }>>;
		/** Pure projection transform. Handlers must not consume events, persist state or
		 * perform external effects merely because inspection ran. */
		transformContext(projection: DeepReadonly<RequestProjection>): Promise<RequestProjection>;
		/** Read-only post-measurement decision. Core applies fail > rebuild > send. */
		preflight(input: Readonly<{ projection: DeepReadonly<RequestProjection>; measurement: TokenMeasurement; pass: number }>): Promise<Readonly<{ action?: "send" | "rebuild" | "fail"; reason?: string }>>;
		/** Awaited safe point after all agent_end observers and before queue resume. */
		afterEnd(input: Readonly<{ turnNumber: number; success: boolean; error?: string }>): Promise<void>;
		/**
		 * 回合间停止决策：在工具交换后的续跑点询问；返回 stop 时本轮立即收尾，
		 * 不再发起下一次模型调用。对应 Pi 的 shouldStopAfterTurn。
		 */
		shouldStop(input: Readonly<{ turnNumber: number; finishReason: FinishReason; reply: string; toolCallCount: number }>): Promise<Readonly<{ stop?: boolean }>>;
	};
	readonly tools: {
		beforeCall(input: Readonly<{ callId: string; name: string; args: DeepReadonly<Record<string, unknown>> }>): Promise<Readonly<{ block?: boolean; reason?: string }>>;
		transformResult(input: Readonly<{ callId: string; name: string; args: DeepReadonly<Record<string, unknown>>; result: string; status: ToolResultStatus; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>): Promise<Readonly<{ result?: string; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>>;
	};
	readonly provider: ProviderHooks;
	readonly events: {
		emit(event: RuntimeEvent): Promise<void>;
		observe(event: OutputEvent): void;
		flush(): Promise<void>;
	};
}
