import { validImages } from "../core/content.js";
import type { ToolResultStatus } from "../core/types.js";
import type { DeepReadonly } from "../runtime/events.js";
import type { PreparedToolCall, ToolExecutionResult, ToolView } from "./broker.js";

export interface ToolPipelineHooks {
	beforeCall?(input: Readonly<{ callId: string; name: string; args: DeepReadonly<Record<string, unknown>> }>): Promise<Readonly<{ block?: boolean; reason?: string }>>;
	transformResult?(input: Readonly<{ callId: string; name: string; args: DeepReadonly<Record<string, unknown>>; result: string; status: ToolResultStatus; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>): Promise<Readonly<{ result?: string; status?: ToolResultStatus; images?: readonly import("../core/content.js").ImageContent[]; details?: unknown }>>;
}

export interface ToolCallRequest {
	readonly callId: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly prepared?: PreparedToolCall;
}

export interface ToolPipelineObservers {
	onStart?(call: ToolCallRequest): Promise<void> | void;
	onDone?(outcome: ToolExecutionResult, call: ToolCallRequest): Promise<void> | void;
}

export interface ToolPipelineOptions {
	readonly signal?: AbortSignal;
	readonly hooks?: ToolPipelineHooks;
	readonly observers?: ToolPipelineObservers;
}

/**
 * 统一的工具调用执行流水线：
 * 编排预取消检查、扩展 beforeCall 拦截、参数准备校验、核心执行、transformResult 结果改写和生命周期观测。
 */
export async function executeToolPipeline(
	broker: ToolView,
	call: ToolCallRequest,
	options: ToolPipelineOptions = {},
): Promise<ToolExecutionResult & { callId: string }> {
	const { signal, hooks, observers } = options;

	// 1. 预检查取消：若工具尚未启动时已被中断，直接返回 not_started，不触发 beforeCall 与 onStart
	if (signal?.aborted) {
		const outcome: ToolExecutionResult = {
			result: JSON.stringify({ error: "工具调用未启动（本轮已取消）", status: "not_started" }),
			status: "not_started",
		};
		await observers?.onDone?.(outcome, call);
		return { ...outcome, callId: call.callId };
	}

	// 2. 扩展前置拦截
	const blocked = await hooks?.beforeCall?.({
		callId: call.callId,
		name: call.name,
		args: call.args as DeepReadonly<Record<string, unknown>>,
	});
	if (blocked?.block) {
		const reason = blocked.reason || "操作已被扩展阻止";
		const outcome: ToolExecutionResult = {
			result: `[blocked] 工具执行已被拦截: ${reason}`,
			status: "not_started",
		};
		await observers?.onDone?.(outcome, call);
		return { ...outcome, callId: call.callId };
	}

	// 3. 参数准备与校验（tool identity 的最终复核在 broker.execute，此处不做二次 prepare）
	let prepared = call.prepared ?? broker.prepare(call.name, call.args);
	if (prepared.error) {
		const outcome = await broker.execute(prepared, signal);
		await observers?.onDone?.(outcome, call);
		return { ...outcome, callId: call.callId };
	}

	// 4. 执行前观测点（仅当确认启动时触发，满足会话 recovery 协议）
	await observers?.onStart?.(call);

	// 5. 核心工具执行
	let outcome = await broker.execute(prepared, signal);

	// 6. 扩展后置结果改写
	const transformed = await hooks?.transformResult?.({
		callId: call.callId,
		name: call.name,
		args: call.args as DeepReadonly<Record<string, unknown>>,
		result: outcome.result,
  images: outcome.images,
  details: outcome.details,
		status: outcome.status,
	});
	if (transformed?.result !== undefined || transformed?.status !== undefined || transformed?.images !== undefined || transformed?.details !== undefined) {
		if (!validImages(transformed?.images)) throw new Error("tool_result hook 返回无效图片");
  outcome = {
			...outcome,
   ...(transformed?.images !== undefined ? { images: structuredClone([...transformed.images]) } : {}),
   ...(transformed?.details !== undefined ? { details: structuredClone(transformed.details) } : {}),
			result: transformed.result ?? outcome.result,
			status: transformed.status ?? outcome.status,
		};
	}

	// 7. 执行后观测点
	await observers?.onDone?.(outcome, call);

	return { ...outcome, callId: call.callId };
}
