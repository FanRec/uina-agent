/**
 * 可编程 mock provider：模拟 LLM 的流式输出与工具调用，用于离线验证链路。
 * 按消息内容决定行为（确定性脚本），不调用任何真实模型。
 * 注意：这只证明本仓库代码链路正确，不证明任何真实模型的集成效果。
 */
import type {
	Model,
	ModelRequest,
	ModelStreamFn,
	Provider,
	StreamDelta,
} from "../../src/core/types.js";
import { Subject, type LoopHooks, type SubjectOptions } from "../../src/agent/loop.js";
import type { ToolView } from "../../src/tools/broker.js";

export interface ScriptRule {
	match: (req: ModelRequest) => boolean;
	produce: () => StreamDelta[];
}

export function mockModel(overrides?: Partial<Model>): Model {
	return {
		id: "mock-model",
		name: "mock-model",
		providerId: "mock",
		...overrides,
	};
}

export function mockStream(deltas: StreamDelta[] = [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]): ModelStreamFn {
	return async (_model, _req, onDelta) => {
		for (const d of deltas) onDelta(d);
	};
}

export function createMockProvider(
	streamImpl?: ModelStreamFn,
	id = "mock",
): Provider {
	return {
		id,
		name: id,
		stream: streamImpl ?? (async (_model, _req, onDelta) => {
			onDelta({ kind: "text", text: "mock response" });
			onDelta({ kind: "finish", reason: "stop" });
		}),
	};
}

export interface ScriptedMockProvider extends Provider {
	model: Model;
	calls: ModelRequest[];
}

export function scriptedProvider(
	rules: ScriptRule[],
	modelOverrides?: Partial<Model>,
): ScriptedMockProvider {
	const calls: ModelRequest[] = [];
	const model = mockModel(modelOverrides);
	const streamImpl: ModelStreamFn = async (_m, req, onDelta) => {
		calls.push(req);
		const rule = rules.find((r) => r.match(req));
		const deltas = rule
			? rule.produce()
			: [
					{
						kind: "text" as const,
						text: "（mock 无匹配规则，回复默认文本）",
					},
				];
		for (const d of deltas) onDelta(d);
		if (!deltas.some((delta) => delta.kind === "finish")) {
			onDelta({ kind: "finish", reason: deltas.some((delta) => delta.kind === "tool_call") ? "tool_calls" : "stop" });
		}
	};
	return {
		id: model.providerId,
		name: model.providerId,
		model,
		calls,
		stream: streamImpl,
	};
}

export function createTestSubject(
	providerOrStream: { model: Model; stream: ModelStreamFn } | ModelStreamFn,
	tools: ToolView,
	hooks: LoopHooks,
	options?: SubjectOptions,
	model?: Model,
): Subject {
	if (typeof providerOrStream === "function") {
		return new Subject(model ?? mockModel(), providerOrStream, tools, hooks, options);
	}
	return new Subject(providerOrStream.model, providerOrStream.stream, tools, hooks, options);
}

/** 消息文本：取最后一条 user 内容 */
export function lastUser(req: ModelRequest): string {
	const u = [...req.messages].reverse().find((m) => m.role === "user");
	return typeof u?.content === "string" ? u.content : "";
}

/** 构造一个工具调用 delta */
export function toolCallDelta(
	id: string,
	name: string,
	args: Record<string, unknown>,
): StreamDelta {
	return { kind: "tool_call", call: { id, name, args: JSON.stringify(args) } };
}
