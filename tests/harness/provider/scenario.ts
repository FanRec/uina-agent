import type {
	Model,
	ModelRequest,
	Provider,
	StreamDelta,
} from "../../../src/core/types.js";
import { stream, StreamBuilder } from "./stream-builder.js";

export type ScenarioMatcher = (req: ModelRequest) => boolean;

export function mockModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "mock-model",
		name: "mock-model",
		providerId: "mock",
		contextWindow: 128_000,
		thinkingLevels: ["off", "low", "high"],
		...overrides,
	};
}

interface ScenarioStep {
	readonly matcher?: ScenarioMatcher;
	readonly produce?: (req: ModelRequest) => StreamDelta[];
	readonly stream?: (
		model: Model,
		req: ModelRequest,
		onDelta: (d: StreamDelta) => void,
		signal?: AbortSignal,
	) => Promise<void>;
}

/**
 * 声明式大模型剧本提供者（Scenario Provider）：
 * 允许在测试中像写剧本一样链式声明大模型的响应序列，
 * 消除手动拼装 Mock 事件的繁琐劳动。
 */
export class Scenario implements Provider {
	readonly id = "scenario-provider";
	readonly name = "Scenario Test Provider";
	readonly model: Model;
	readonly calls: ModelRequest[] = [];

	private readonly queue: ScenarioStep[] = [];
	private readonly rules: ScenarioStep[] = [];
	private defaultFallback: (req: ModelRequest) => StreamDelta[] = () => [
		{ kind: "text", text: "（scenario: 默认回复）" },
		{ kind: "finish", reason: "stop" },
	];

	static create(modelOverrides: Partial<Model> = {}): Scenario {
		return new Scenario(modelOverrides);
	}

	constructor(modelOverrides: Partial<Model> = {}) {
		this.stream = this.stream.bind(this);
		this.model = {
			id: "scenario-model",
			name: "Scenario Model",
			providerId: this.id,
			contextWindow: 128_000,
			...modelOverrides,
		};
	}

	/** 按调用先后顺序入队一次纯文本回复 */
	reply(text: string): this {
		this.queue.push({
			produce: () => stream().text(text).finish("stop").build(),
		});
		return this;
	}

	/** 按调用先后顺序入队一次思考 + 文本回复 */
	thinkAndReply(thinking: string, text: string): this {
		this.queue.push({
			produce: () => stream().thinking(thinking).text(text).finish("stop").build(),
		});
		return this;
	}

	/** 按调用先后顺序入队一次工具调用 */
	callTool(name: string, args: Record<string, unknown> | string, id?: string): this {
		this.queue.push({
			produce: () => stream().toolCall(name, args, id).finish("tool_calls").build(),
		});
		return this;
	}

	/** 别名：按调用先后顺序入队一次工具调用 */
	replyWithToolCall(id: string, name: string, args: Record<string, unknown> | string): this {
		return this.callTool(name, args, id);
	}

	/** 自定义入队完整 StreamBuilder 逻辑 */
	custom(builderFn: (builder: StreamBuilder, req: ModelRequest) => void): this {
		this.queue.push({
			produce: (req) => {
				const b = stream();
				builderFn(b, req);
				return b.build();
			},
		});
		return this;
	}

	/** 条件规则匹配（只要满足 matcher 即触发该回复，不消耗队列） */
	when(matcher: ScenarioMatcher): {
		reply: (text: string) => Scenario;
		callTool: (name: string, args: Record<string, unknown>, id?: string) => Scenario;
		replyWithToolCall: (id: string, name: string, args: Record<string, unknown> | string) => Scenario;
		then: (produce: (req: ModelRequest) => StreamDelta[]) => Scenario;
		thenStream: (
			streamFn: (
				model: Model,
				req: ModelRequest,
				onDelta: (d: StreamDelta) => void,
				signal?: AbortSignal,
			) => Promise<void>,
		) => Scenario;
	} {
		return {
			reply: (text: string) => {
				this.rules.push({
					matcher,
					produce: () => stream().text(text).finish("stop").build(),
				});
				return this;
			},
			callTool: (name: string, args: Record<string, unknown>, id?: string) => {
				this.rules.push({
					matcher,
					produce: () => stream().toolCall(name, args, id).finish("tool_calls").build(),
				});
				return this;
			},
			replyWithToolCall: (id: string, name: string, args: Record<string, unknown> | string) => {
				this.rules.push({
					matcher,
					produce: () => stream().toolCall(name, args, id).finish("tool_calls").build(),
				});
				return this;
			},
			then: (produce: (req: ModelRequest) => StreamDelta[]) => {
				this.rules.push({ matcher, produce });
				return this;
			},
			thenStream: (streamFn) => {
				this.rules.push({ matcher, stream: streamFn });
				return this;
			},
		};
	}

	/** 当队列耗尽且无规则匹配时的兜底行为 */
	fallback(fn: (req: ModelRequest) => StreamDelta[]): this {
		this.defaultFallback = fn;
		return this;
	}

	async stream(
		model: Model,
		req: ModelRequest,
		onDelta: (d: StreamDelta) => void,
		signal?: AbortSignal,
	): Promise<void> {
		this.calls.push(req);

		if (signal?.aborted) {
			throw new Error("模型流式已被中断");
		}

		// 1. 优先尝试条件规则
		const matchedRule = this.rules.find((r) => r.matcher?.(req));

		if (matchedRule) {
			if (matchedRule.stream) {
				await matchedRule.stream(model, req, onDelta, signal);
				return;
			}
			const deltas = matchedRule.produce ? matchedRule.produce(req) : [];
			for (const d of deltas) {
				if (signal?.aborted) throw new Error("模型流式已被中断");
				onDelta(d);
			}
			return;
		}

		// 2. 依次消耗顺序队列
		if (this.queue.length > 0) {
			const step = this.queue.shift()!;
			if (step.stream) {
				await step.stream(model, req, onDelta, signal);
				return;
			}
			const deltas = step.produce ? step.produce(req) : [];
			for (const d of deltas) {
				if (signal?.aborted) throw new Error("模型流式已被中断");
				onDelta(d);
			}
			return;
		}

		// 3. 兜底
		const deltas = this.defaultFallback(req);
		for (const d of deltas) {
			if (signal?.aborted) throw new Error("模型流式已被中断");
			onDelta(d);
		}
	}

	/** 获取最近一次请求中最后一条 user 消息内容 */
	get lastUserText(): string | undefined {
		const lastCall = this.calls.at(-1);
		if (!lastCall) return undefined;
		const userMsg = [...lastCall.messages].reverse().find((m) => m.role === "user");
		return typeof userMsg?.content === "string" ? userMsg.content : undefined;
	}

	get lastPrompt(): string | undefined {
		return this.lastUserText;
	}
}

export function createScenario(modelOverrides?: Partial<Model>): Scenario {
	return new Scenario(modelOverrides);
}
