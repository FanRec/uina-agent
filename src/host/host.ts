import { randomUUID } from "node:crypto";
import type { ContextSegments, Model, ModelStreamFn, Provider, ThinkingLevel } from "../core/types.js";
import { activeProvider, loadConfig } from "../ai/config.js";
import { ModelRegistry } from "../ai/providers.js";
import { ToolBroker, type ToolExecutionResult } from "../tools/broker.js";
import { Subject, type AgentInput } from "../agent/loop.js";
import type { QueuedMessage } from "../agent/queue.js";
import { DefaultAgentFactory } from "../agent/runtime.js";
import { JobRegistry } from "../extensions/jobs/registry.js";
import { SubagentRegistry } from "../extensions/subagents/registry.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { CommandRouter } from "../extensions/commands.js";
import { activateBuiltinCommands, type BuiltinUI } from "../extensions/builtin.js";
import { activateRuntimeTools, createChildTools } from "../extensions/runtime-tools/index.js";
import { killTrackedDetachedChildren } from "../runtime/process-tracker.js";
import { MemorySessionStore, openJsonlSession } from "../session/jsonl-store.js";
import { projectAgentHistory } from "../session/recovery.js";
import type { SessionEntry, SessionStore } from "../session/types.js";
import type { ExtensionUIContext } from "../extensions/ui-contract.js";
import type { HostEvent, HostEventListener } from "./events.js";

/**
 * 宿主：主体生命期的所有者。
 *
 * 它拥有 provider、工具、后台任务、子 Agent、扩展宿主、会话存储与唯一的根 Subject，
 * 对外只暴露两件事：**一个输入入口**（send / submitText）与**一条有序事件流**
 * （subscribe）。它不引用任何 UI 类型（由 check-boundaries 强制），因此 TUI 关闭、
 * 换成 stdio、或接入第二个观察者，都不影响主体是否继续存活。
 *
 * 组合根（cli/app.ts）只负责：建宿主 → 挂一个消费者 → 装信号 → 等 → dispose。
 */
export interface UinaHostOptions {
	/** 组合根工作目录；项目扩展从 <cwd>/.uina/extensions 加载。 */
	cwd: string;
 extensionPaths?: readonly string[];
	/** 会话 journal 路径。省略时使用内存 store（测试与嵌入场景）。 */
	sessionPath?: string;
	/** 注入 provider（测试与嵌入）。省略时按 ~/.uina/auth.json 创建。 */
	provider?: Provider;
	/** 注入初始活跃模型。 */
	model?: Model;
	/** 显式指定初始活跃模型名称（例如 deepseek-r1 或 openai/gpt-4o）。 */
	modelName?: string;
	/** 注入流式函数。 */
	stream?: ModelStreamFn;
	/** 默认 thinking 档位。 */
	thinkingLevel?: ThinkingLevel;
	/** 诊断出口：消费者尚未接入时也必须可见，绝不静默吞掉。 */
	onError?: (text: string) => void;
}

/** 消费者渲染所需的事实快照。消费者据此渲染，而不是伸手进 Subject。 */
export interface HostSnapshot {
	readonly modelName: string;
	readonly thinkingLevels?: readonly ThinkingLevel[];
	readonly thinkingLevel?: ThinkingLevel;
	readonly usedTokens: number;
	readonly contextWindow?: number;
	readonly segments: ContextSegments;
	readonly busy: boolean;
	readonly queue: readonly QueuedMessage[];
	readonly queueDepth: number;
	readonly queueOldestAgeMs?: number;
}

export interface HostStartOptions {
	/** 内置命令需要的消费者 UI 能力；无 UI 的消费者省略即可。 */
	ui?: BuiltinUI;
	/** 消费者自己的关闭流程（例如同时关闭 TUI）。默认只 dispose 宿主。 */
	requestShutdown?: () => Promise<void>;
}

export class UinaHost {
	private readonly listeners: Set<HostEventListener>;
	private stopPromise?: Promise<void>;
	private readonly directRuns = new Map<AbortController, Promise<ToolExecutionResult>>();
	private reloading = 0;

	private constructor(
		private readonly options: UinaHostOptions,
		readonly subject: Subject,
		private readonly store: SessionStore,
		private readonly extensionHost: ExtensionRunner,
		private readonly tools: ToolBroker,
		readonly models: ModelRegistry,
		readonly jobs: JobRegistry,
		readonly subagents: SubagentRegistry,
		readonly commands: CommandRouter,
		/** 会话恢复出来的有序条目，交给消费者建立自己的视图。 */
		readonly restoredEntries: readonly SessionEntry[],
		listeners: Set<HostEventListener>,
		/** 共享的关闭标志：钩子与扩展输入入口据此拒绝关闭后的新工作。 */
		private readonly state: { stopping: boolean },
	) {
		this.listeners = listeners;
	}

	static async create(options: UinaHostOptions): Promise<UinaHost> {
		const config = options.provider === undefined && options.model === undefined ? loadConfig() : undefined;
		const models = new ModelRegistry(config);
		if (options.provider) {
			models.registerProvider(options.provider);
		}
		if (options.model) {
			models.registerModel(options.model);
		}
		const activeModel = options.model ?? (() => {
			if (options.modelName) {
				return models.resolve(options.modelName);
			}
			if (config) {
				const active = activeProvider(config);
				return models.resolve(active.name);
			}
			if (options.provider) {
				const candidate = models.getModel(options.provider.id);
				if (candidate) return candidate;
			}
			throw new Error("必须提供 model 或有效的配置文件");
		})();
		const thinkingLevel = options.thinkingLevel ?? config?.thinkingLevel;
		const streamFn: ModelStreamFn = options.stream ?? ((m, req, onDelta, signal) => models.stream(m, req, onDelta, signal));

		const tools = new ToolBroker({ ownerId: "root" });
		const jobs = new JobRegistry();

		let store: SessionStore = new MemorySessionStore();
		let restoredEntries: readonly SessionEntry[] = [];
		let restoredQueue: readonly QueuedMessage[] = [];
		if (options.sessionPath !== undefined) {
			const opened = await openJsonlSession(options.sessionPath);
			store = opened.store;
			restoredEntries = opened.snapshot.entries;
			restoredQueue = opened.snapshot.queued;
		}

		// 这三个对象在宿主实例之前建立，并被实例与其钩子共享，避免任何后补赋值。
		const listeners = new Set<HostEventListener>();
		const toolStartedAt = new Map<string, number>();
		const state = { stopping: false };
		const emit = (event: HostEvent): void => {
			for (const listener of [...listeners]) {
				try { listener(event); }
				catch (error) { options.onError?.(`消费者处理事件失败: ${error instanceof Error ? error.message : String(error)}`); }
			}
		};

		// subagents 与 extensionHost 只捕获 subject 的延迟引用，因此可以先建立。
		let subject!: Subject;
		const subagents = new SubagentRegistry({
			factory: new DefaultAgentFactory(),
			model: () => subject.getModel(),
			stream: streamFn,
			thinkingLevel,
			createTools: (ownerId) => createChildTools(tools, { ownerId }),
			notify: async (text, data, ownerId) => {
				if (state.stopping) return;
				const input: AgentInput = {
					id: `subagent-notice-${String(data.id)}`,
					mode: "followUp",
					source: { kind: "runtime", type: "subagent-notice", ref: String(data.id) },
					text,
					data,
				};
				await (ownerId === "root" ? subject.accept(input) : subagents.acceptInput(ownerId, input));
			},
		});

		const extensionHost = new ExtensionRunner({
   cwd: options.cwd,
   extensionPaths: options.extensionPaths,
   onCompact: (instruction) => subject.compact(instruction),
   models: { current: () => subject.getModel(), list: () => models.listModels(), resolve: name => models.resolve(name), select: name => subject.setModel(models.resolve(name)), stream: streamFn },
			tools,
			onInput: (input) => state.stopping ? Promise.reject(new Error("宿主正在关闭")) : subject.accept(input),
			onError: (text) => emit({ type: "error", text }),
			onNotice: (text) => emit({ type: "notice", text }),
			onProvider: (name, registered, options) => models.register(name, registered, options),
   onModel: (model, options) => models.registerModel(model, options),
			onCustomMessage: async (message) => { await subject.appendCustomMessage(message); emit({ type: "custom_message", message }); },
			onCustomEntry: async (entry) => { await subject.appendCustomEntry(entry); emit({ type: "custom_entry", entry }); },
		});

		subject = new Subject(activeModel, streamFn, tools, {
			store,
			thinkingLevel,
			runtimeHooks: extensionHost.runtimeHooks(),
   compactor: extensionHost.compactor,
   compactionTrigger: extensionHost.compactionTrigger,
		});

		subject.subscribe((event) => {
			switch (event.type) {
				case "output_update":
					if (event.channel === "content") emit({ type: "text", text: event.text });
					else if (event.channel === "thinking") emit({ type: "thinking", text: event.text });
					break;
				case "turn_start":
					emit({ type: "turn_start", n: event.turnNumber, text: event.userText, images: event.images });
					break;
				case "turn_end":
					emit({ type: "turn_end", n: event.turnNumber, usage: event.usage });
					break;
				case "tool_call":
					if (event.callId) toolStartedAt.set(event.callId, Date.now());
					emit({ type: "tool_start", name: event.toolName, args: event.args, callId: event.callId });
					break;
				case "tool_result": {
					const ts = event.callId ? toolStartedAt.get(event.callId) : undefined;
					if (event.callId) toolStartedAt.delete(event.callId);
					emit({
						type: "tool_done",
						name: event.toolName,
						result: event.result,
      images: event.images ? [...event.images] : undefined,
      details: event.details,
						status: event.status,
						callId: event.callId,
						ts,
						elapsedMs: ts === undefined ? undefined : Date.now() - ts,
					});
					break;
				}
				case "queue":
					emit({ type: "queue", items: event.items as QueuedMessage[] });
					break;
				case "turn_aborted":
					emit({ type: "turn_aborted", n: event.turnNumber });
					break;
				case "error":
					emit({ type: "error", text: event.text });
					break;
			}
		});
		const commands = new CommandRouter(extensionHost.registry, (text) => emit({ type: "error", text }));

		subject.addHistory(projectAgentHistory(restoredEntries));
		if (restoredQueue.length > 0) subject.seedQueue(restoredQueue);

		if (config !== undefined) {
			void models.refreshModels().catch((error: unknown) => {
				options.onError?.(`[模型目录刷新失败] ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		return new UinaHost(options, subject, store, extensionHost, tools, models, jobs, subagents, commands, restoredEntries, listeners, state);
	}

	subscribe(listener: HostEventListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** 向当前所有消费者广播。单个消费者抛错不影响其它消费者，但错误绝不静默。 */
	emit(event: HostEvent): void {
		for (const listener of [...this.listeners]) {
			try { listener(event); }
			catch (error) { this.options.onError?.(`消费者处理事件失败: ${error instanceof Error ? error.message : String(error)}`); }
		}
	}

	async send(input: AgentInput): Promise<void> { this.assertAccepting(); return this.subject.accept(input); }

	private assertAccepting(): void {
		if (this.state.stopping) throw new Error("宿主正在关闭");
		if (this.reloading) throw new Error("扩展正在重载，请稍后重试");
	}

	/** Explicit user invocation: registered capability and hooks, without model history. */
	async runToolDirect(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		this.assertAccepting();
		const controller = new AbortController();
		const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const hooks = this.extensionHost.runtimeHooks().tools;
		const callId = "direct-" + randomUUID();
		const run = this.tools.executePipeline(
			{ callId, name, args },
			{ signal: cancellation, hooks },
		);
		this.directRuns.set(controller, run);
		try { return await run; }
		finally { this.directRuns.delete(controller); }
	}

	/**
	 * 提交一行用户文本：这是**投递模式规则**的唯一归属。
	 * 忙时 direct 升级为 steer；空闲时一律 direct，与 CLI 的既有语义一致。
	 */
	async submitText(text: string, mode: "direct" | "steer" | "followUp" = "followUp"): Promise<void> {
		this.assertAccepting();
		const effective: "direct" | "steer" | "followUp" = this.subject.isBusy()
			? (mode === "direct" ? "steer" : mode)
			: "direct";
		return this.subject.pushInput(text, { mode: effective });
	}

	/** 程序化投递：原样入队，不做“忙时升级”转换（队列移交、后台通知走这条路）。 */
	async pushInput(text: string, mode: "direct" | "steer" | "followUp"): Promise<void> {
		this.assertAccepting();
		return this.subject.pushInput(text, { mode });
	}

	/** 当前会话历史的消息条数，供消费者显示恢复信息。 */
	historyCount(): number { return this.subject.historySnapshot().length; }

	/** 扩展渲染器与命令注册表：消费者据此渲染自定义消息与补全命令。 */
	get extensionRegistry(): ExtensionRunner["registry"] { return this.extensionHost.registry; }

	interrupt(): void { this.subject.interrupt(); }
	isBusy(): boolean { return this.subject.isBusy(); }
	waitForIdle(): Promise<void> { return this.subject.waitForIdle(); }
 resumePending(): Promise<void> { this.assertAccepting(); return this.subject.resumePending(); }
	takeQueuedForEditor(): Promise<QueuedMessage[]> { return this.subject.takeQueuedForEditor(); }
	takeLastQueuedForEditor(): Promise<QueuedMessage | null> { return this.subject.takeLastQueuedForEditor(); }
	cycleThinkingLevel(): ThinkingLevel { return this.subject.cycleThinkingLevel(); }
	setThinkingLevel(level: ThinkingLevel): void { this.subject.setThinkingLevel(level); }
	attachExtensionUI(ui: ExtensionUIContext): void { this.extensionHost.attachUI(ui); }

	/** 消费者渲染所需的全部事实，一次取齐。 */
	snapshot(): HostSnapshot {
		const model = this.subject.getModel();
		return {
			modelName: model.name,
			thinkingLevels: model.thinkingLevels,
			thinkingLevel: model.thinkingLevels?.length ? this.subject.getThinkingLevel() : undefined,
			usedTokens: this.subject.getUsedTokens(),
			contextWindow: this.subject.getContextWindow(),
			segments: this.subject.getContextSegments(),
			busy: this.subject.isBusy(),
			queue: this.subject.queuedSnapshot(),
			queueDepth: this.subject.queuedSnapshot().length,
			queueOldestAgeMs: this.subject.queueOldestAgeMs(),
		};
	}

	/** 内置能力与项目扩展走同一套 ActivationScope；在消费者接入之后调用。 */
	async start(startOptions: HostStartOptions = {}): Promise<void> {
		await this.extensionHost.activateBuiltin("runtime-tools", activateRuntimeTools({ jobs: this.jobs, subagents: this.subagents }));
		await this.extensionHost.activateBuiltin("commands", activateBuiltinCommands({
			subject: this.subject,
			models: this.models,
			jobs: this.jobs,
			subagents: this.subagents,
			ui: startOptions.ui,
			reload: () => this.reloadExtensions(),
			shutdown: startOptions.requestShutdown ?? (() => this.dispose()),
		}));
		await this.extensionHost.load();
	}

	async reloadExtensions(): Promise<void> {
		this.assertAccepting();
		this.reloading++;
		try {
			await this.subject.waitForIdle();
			await Promise.allSettled([...this.directRuns.values()]);
			if (this.state.stopping) throw new Error("宿主正在关闭");
			await this.extensionHost.reload();
			this.emit({ type: "notice", text: "项目扩展已重新加载。" });
		} finally { this.reloading--; }
	}

	/** 关闭主体：等待活动结束、释放扩展、杀掉工具留下的分离子进程、关闭会话。 */
	async dispose(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.state.stopping = true;
		this.stopPromise = (async () => {
			this.subject.interrupt();
			for (const controller of this.directRuns.keys()) controller.abort();
			await Promise.allSettled([...this.directRuns.values()]);
			await this.subject.waitForIdle();
			const errors: unknown[] = [];
			try { await this.extensionHost.dispose(); } catch (error) { errors.push(error); }
			try { killTrackedDetachedChildren(); } catch (error) { errors.push(error); }
			await this.subject.waitForIdle();
			try { await this.store.close(); } catch (error) { errors.push(error); }
			this.listeners.clear();
			if (errors.length) throw new AggregateError(errors, "宿主关闭时发生错误");
		})();
		return this.stopPromise;
	}
}
