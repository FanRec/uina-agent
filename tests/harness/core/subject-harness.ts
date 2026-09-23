import { Subject, type AgentInput } from "../../../src/agent/loop.js";
import { ToolBroker, type Tool } from "../../../src/tools/broker.js";
import { MemorySessionStore } from "../../../src/session/jsonl-store.js";
import type { RewindRequest, RewindResult, SessionRecord, SessionStore } from "../../../src/session/types.js";
import { Scenario } from "../provider/scenario.js";
import type { AgentMessage, ChatMsg, Model, ModelStreamFn, ThinkingLevel, ToolDef } from "../../../src/core/types.js";
import type { RuntimeHooks } from "../../../src/runtime/hooks.js";
import type { ProjectionPolicy } from "../../../src/agent/projection.js";

/** 快速构造轻量测试 Tool 的统一辅助函数，避免在各测试中内联手写 8 行 Schema 样板 */
export function mockTool(
	name: string,
	run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | unknown = () => "ok",
	overrides: Partial<ToolDef["function"]> = {},
): Tool {
	return {
		def: {
			type: "function",
			function: {
				name,
				description: overrides.description ?? name,
				parameters: overrides.parameters ?? { type: "object", properties: {} },
				...overrides,
			},
		},
		run: async (args, signal) => {
			const res = await run(args, signal);
			if (typeof res === "object" && res !== null && "result" in res && "status" in res) {
				return res as import("../../../src/tools/broker.js").ToolExecutionResult;
			}
			return {
				result: typeof res === "string" ? res : JSON.stringify(res),
				status: "succeeded",
			};
		},
	};
}

export interface SubjectHarnessOptions {
	readonly model?: Partial<Model>;
	readonly stream?: ModelStreamFn;
	readonly scenario?: Scenario;
	readonly tools?: Tool[];
	readonly broker?: ToolBroker;
	readonly store?: SessionStore;
	readonly runtimeHooks?: RuntimeHooks;
	readonly thinkingLevel?: ThinkingLevel;
	readonly systemPrompt?: string;
	readonly projection?: ProjectionPolicy;
	readonly maxConsecutiveToolCalls?: number;
}

/**
 * 裸 Core/Subject 测试门面（SubjectHarness）：
 * 专为测试 Core 裸回路（Subject / ToolBroker / MemorySessionStore）打造。
 * 消除全库重复手写 new Subject() + broker + store + waitForIdle() 样板。
 */
export class SubjectHarness {
	readonly subject: Subject;
	readonly broker: ToolBroker;
	readonly store?: SessionStore;
	readonly scenario: Scenario;

	constructor(
		subject: Subject,
		broker: ToolBroker,
		store: SessionStore | undefined,
		scenario: Scenario,
	) {
		this.subject = subject;
		this.broker = broker;
		this.store = store;
		this.scenario = scenario;
	}

	static create(options: SubjectHarnessOptions = {}): SubjectHarness {
		const scenario = options.scenario ?? new Scenario(options.model);
		const broker = options.broker ?? new ToolBroker();
		if (options.tools) {
			for (const t of options.tools) broker.register(t);
		}
		const store = options.store;
		const stream = options.stream ?? ((m, req, onDelta, signal) => scenario.stream(m, req, onDelta, signal));
		const subject = new Subject(
			options.model ? { ...scenario.model, ...options.model } : scenario.model,
			stream,
			broker,
			{
				store,
				runtimeHooks: options.runtimeHooks,
				thinkingLevel: options.thinkingLevel,
				systemPrompt: options.systemPrompt,
				projection: options.projection,
				maxConsecutiveToolCalls: options.maxConsecutiveToolCalls,
			},
		);

		return new SubjectHarness(subject, broker, store, scenario);
	}

	/** 投递输入并等待本轮空闲 */
	async run(input: string | AgentInput): Promise<void> {
		if (typeof input === "string") {
			await this.subject.pushInput(input);
		} else {
			await this.subject.accept(input);
		}
		await this.subject.waitForIdle();
	}

	/** run 的别名 */
	async pushAndIdle(input: string | AgentInput): Promise<void> {
		return this.run(input);
	}

	/** 投递输入（不等待） */
	pushInput(input: string, options?: Parameters<Subject["pushInput"]>[1]): Promise<void> {
		return this.subject.pushInput(input, options);
	}

	/** 等待当前回合空闲 */
	async waitForIdle(): Promise<void> {
		await this.subject.waitForIdle();
	}

	/** 订阅 Subject 内部事件 */
	subscribe(listener: (event: Parameters<Parameters<Subject["subscribe"]>[0]>[0]) => void): () => void {
		return this.subject.subscribe(listener);
	}

	/** 中断当前回合 */
	interrupt(): void {
		this.subject.interrupt();
	}

	/** 获取当前模型配置 */
	getModel(): Model {
		return this.subject.getModel();
	}

	/** 切换模型 */
	async setModel(model: Model): Promise<void> {
		return this.subject.setModel(model);
	}

	/** 获取上下文窗口大小 */
	getContextWindow(): number | undefined {
		return this.subject.getContextWindow();
	}

	/** 设置思考深度 */
	setThinkingLevel(level: ThinkingLevel): void {
		this.subject.setThinkingLevel(level);
	}

	/** 获取当前生效的思考深度 */
	getThinkingLevel(): ThinkingLevel {
		return this.subject.getThinkingLevel();
	}

	/** 获取首选思考深度 */
	getPreferredThinkingLevel(): ThinkingLevel {
		return this.subject.getPreferredThinkingLevel();
	}

	/** 检查 Subject 是否正处于活动状态 */
	isBusy(): boolean {
		return this.subject.isBusy();
	}

	/** 领取所有队列项（mailbox claim 原语） */
	async claimAllQueued() {
		return this.subject.claimAllQueued();
	}

	/** 按标识领取单个队列项 */
	async claimQueued(id: string) {
		return this.subject.claimQueued(id);
	}

	/** 请求会话回溯 */
	async requestRewind(request: RewindRequest, source: string, signal?: AbortSignal): Promise<RewindResult> {
		return this.subject.requestRewind(request, source, signal);
	}

	/** 获取主线历史快照 */
	historySnapshot(): readonly AgentMessage[] {
		return this.subject.historySnapshot();
	}

	/** 获取当前队列快照 */
	queuedSnapshot() {
		return this.subject.queuedSnapshot();
	}

	/** 获取主线历史消息快照 */
	get history(): readonly (AgentMessage | ChatMsg)[] {
		return this.subject.historySnapshot();
	}

	/** 获取会话存储中的所有持久化记录 */
	get records(): readonly SessionRecord[] {
		if (!this.store) return [];
		if ("readRecords" in this.store && typeof (this.store as any).readRecords === "function") {
			return (this.store as MemorySessionStore).readRecords();
		}
		return (this.store.state?.allEntries as unknown as readonly SessionRecord[]) ?? [];
	}
}
