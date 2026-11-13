import type { ImageContent } from "../core/content.js";
import type {
	ChatMsg,
	ContextCollection,
	ContextRead,
	FinishReason,
	RequestProjection,
	TokenMeasurement,
	ToolResultStatus,
} from "../core/types.js";
import type { DeepReadonly, OutputEvent, RuntimeEvent } from "./events.js";

/**
 * Provider 协议观察与 Header 注入的窄端口。
 * 没有 payload 变换：Provider Wire 编码归 Provider Adapter 所有，扩展不得在
 * 统一装配与预算校验之后偷改消息或工具声明（Header 注入是传输凭据，不属于
 * Context 注入，予以保留）。
 */
export interface ProviderHooks {
	transformHeaders(provider: string, headers: Readonly<Record<string, string>>): Promise<Record<string, string>>;
	observeResponse(
		input: Readonly<{ provider: string; status: number; headers: Record<string, string> }>,
	): Promise<void>;
}

/**
 * 干预注册点词汇（Hook ≠ Event，铁律 L1）。
 *
 * Hook = 系统问扩展"你要不要影响这件事？"——有返回协议，按下面各链的合并规则组合；
 * Event = 系统告诉世界"这件事已经发生了"——无返回值，单流广播（RuntimeEvent）。
 * 干预注册只能用这里的名字（onHook），事实订阅只能用 RuntimeEvent 的 type（on）。
 * 两个词表不得混居：混居会让扩展作者无法分辨自己在影响系统还是在观察系统。
 *
 * 信息注入体系：扩展提供信息走 provideContext（Context Source）与 registerHistoryView
 * （History View），不存在修改完整请求的通用 Hook。
 */
export type HookName =
	| "turn.preflight"
	| "turn.afterEnd"
	| "turn.shouldStop"
	| "tools.beforeCall"
	| "tools.transformResult"
	| "provider.transformHeaders"
	| "provider.observeResponse";

/** 各干预注册点的输入（只读化由 HookHandler 统一施加，形状与 RuntimeHooks 对应方法的入参一致）。 */
export interface HookInputs {
	/** signal = 当前主体活动的取消信号（preflight 为 turn signal，afterEnd 为 post-turn
	 * signal）。长 IO 工作必须监听它；它与扩展生命周期信号（pi.signal）正交。 */
	"turn.preflight": {
		readonly projection: RequestProjection;
		/** 本次装配实际采用的 History View（压缩后可见历史）：不含 System、Guidance、
		 * 当前动态 Source 与工具定义。预算规划据此进行，不得从完整投影里反猜历史。 */
		readonly history: readonly ChatMsg[];
		readonly measurement: TokenMeasurement;
		readonly pass: number;
		readonly signal: AbortSignal;
	};
	"turn.afterEnd": {
		readonly turnNumber: number;
		readonly success: boolean;
		readonly error?: string;
		readonly signal: AbortSignal;
	};
	"turn.shouldStop": {
		readonly turnNumber: number;
		readonly finishReason: FinishReason;
		readonly reply: string;
		readonly toolCallCount: number;
	};
	"tools.beforeCall": {
		readonly callId: string;
		readonly invocationId?: string;
		readonly name: string;
		readonly args: Record<string, unknown>;
	};
	"tools.transformResult": {
		readonly callId: string;
		readonly invocationId?: string;
		readonly name: string;
		readonly args: Record<string, unknown>;
		readonly result: string;
		readonly status: ToolResultStatus;
		readonly images?: readonly ImageContent[];
		readonly details?: unknown;
	};
	"provider.transformHeaders": { readonly provider: string; readonly headers: Readonly<Record<string, string>> };
	"provider.observeResponse": {
		readonly provider: string;
		readonly status: number;
		readonly headers: Record<string, string>;
	};
}

/**
 * 单个扩展在干预点的贡献形状（onHook handler 的返回值）。
 * RuntimeHooks 对应方法的返回值 = 所有扩展贡献按合并规则聚合后的结果。
 */
export interface HookContributions {
	"turn.preflight": { readonly action?: "send" | "rebuild" | "fail"; readonly reason?: string };
	"turn.afterEnd": Record<string, never>;
	"turn.shouldStop": { readonly stop?: boolean };
	"tools.beforeCall": { readonly block?: boolean; readonly reason?: string };
	"tools.transformResult": {
		readonly result?: string;
		readonly images?: readonly ImageContent[];
		readonly details?: unknown;
	};
	"provider.transformHeaders": { readonly headers?: Record<string, string> };
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
 * | turn.preflight              | 归并：fail > rebuild > send；只读投影决策    |
 * | turn.shouldStop             | 短路：任一 stop=true 即收尾，后续不再询问       |
 * | tools.beforeCall            | 短路：任一 block=true 即拦截，后续不再询问      |
 * | tools.transformResult       | 链式：后一个收到前一个改写后的结果，逐字段覆盖（status 除外——执行事实由流水线独占） |
 * | provider.transformHeaders   | 链式：后一个收到前一个的输出，整组替换          |
 * | provider.observeResponse    | 观察：无返回值，只多播（响应已发生的审计点）     |
 */

/** 贡献合同没有 status。JS 扩展仍可能带回该字段：丢弃前警告，不把笔误升级成整回合失败。 */
export function warnIgnoredToolStatus(contribution: object | null | undefined): void {
	if (contribution != null && "status" in contribution && (contribution as { status?: unknown }).status !== undefined) {
		console.warn("[工具结果] tools.transformResult 贡献的 status 已被忽略：执行状态由工具结果独占，不可改写");
	}
}

/**
 * History View（压缩后可见历史）合同：输入是 canonical history 经现有 ProjectionPolicy
 * convertToLlm（含历史 Event Frame）之后的 History 消息；输出必须是合法的 History 消息
 * 序列。只读、同步、无副作用：不更新 Checkpoint、不提交候选、不发事件。
 */
export type HistoryView = (history: readonly ChatMsg[]) => readonly ChatMsg[];

export interface RuntimeHooks {
	/** 历史投影窄端口：Subject 在装配前取得可见历史；无提供者时为 identity。
	 * 单一所有者（同一 Host 只允许一个提供者），由 Compaction 等 History 形塑者注册。 */
	readonly history: {
		project(history: readonly ChatMsg[]): readonly ChatMsg[];
	};
	readonly turn: {
		/** Read-only post-measurement decision. Core applies fail > rebuild > send. */
		preflight(
			input: Readonly<{
				projection: DeepReadonly<RequestProjection>;
				history: readonly ChatMsg[];
				measurement: TokenMeasurement;
				pass: number;
				readonly signal: AbortSignal;
			}>,
		): Promise<Readonly<{ action?: "send" | "rebuild" | "fail"; reason?: string }>>;
		/** Awaited safe point after all agent_end observers and before queue resume. */
		afterEnd(
			input: Readonly<{ turnNumber: number; success: boolean; error?: string; readonly signal: AbortSignal }>,
		): Promise<void>;
		/**
		 * 回合间停止决策：在工具交换后的续跑点询问；返回 stop 时本轮立即收尾，
		 * 不再发起下一次模型调用。对应 Pi 的 shouldStopAfterTurn。
		 */
		shouldStop(
			input: Readonly<{ turnNumber: number; finishReason: FinishReason; reply: string; toolCallCount: number }>,
		): Promise<Readonly<{ stop?: boolean }>>;
	};
	readonly tools: {
		beforeCall(
			input: Readonly<{
				callId: string;
				invocationId: string;
				name: string;
				args: DeepReadonly<Record<string, unknown>>;
			}>,
		): Promise<Readonly<{ block?: boolean; reason?: string }>>;
		transformResult(
			input: Readonly<{
				callId: string;
				invocationId: string;
				name: string;
				args: DeepReadonly<Record<string, unknown>>;
				result: string;
				status: ToolResultStatus;
				images?: readonly import("../core/content.js").ImageContent[];
				details?: unknown;
			}>,
		): Promise<
			Readonly<{ result?: string; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>
		>;
	};
	readonly provider: ProviderHooks;
	/**
	 * Context Source 只读端口：收集当前激活扩展注册的 Source 快照。
	 * 不是 Hook 链——没有 onHook 注册入口，扩展经 provideContext 注册、Registry 持有；
	 * collect 每次调用固定注册快照、按 Source 身份稳定返回，单 Source 失败不阻断其余。
	 * 调用方（Request Composer 链）在 History View 与工具声明之后、测量/预检之前调用一次。
	 */
	readonly context: {
		collect(input: Readonly<ContextRead>): Promise<ContextCollection>;
	};
	readonly events: {
		emit(event: RuntimeEvent): Promise<void>;
		observe(event: OutputEvent): void;
		flush(): Promise<void>;
	};
}
