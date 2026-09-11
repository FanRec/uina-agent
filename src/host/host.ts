import type { ContextSegments, ModelProvider, ThinkingLevel } from "../core/types.js";
import { activeProvider, loadConfig } from "../ai/config.js";
import { createProvider, ModelRegistry } from "../ai/providers.js";
import { ToolBroker } from "../tools/broker.js";
import { Subject, type AgentInput, type LoopHooks } from "../agent/loop.js";
import type { QueuedMessage } from "../agent/queue.js";
import { DefaultAgentFactory } from "../agent/runtime.js";
import { JobRegistry } from "../extensions/jobs/registry.js";
import { SubagentRegistry } from "../extensions/subagents/registry.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { CommandRouter } from "../extensions/commands.js";
import { activateBuiltinCommands, type BuiltinUI } from "../extensions/builtin.js";
import { activateRuntimeTools, createChildTools } from "../extensions/runtime-tools/index.js";
import { killTrackedDetachedChildren } from "../extensions/runtime-tools/exec-command/process.js";
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
	/** 会话 journal 路径。省略时使用内存 store（测试与嵌入场景）。 */
	sessionPath?: string;
	/** 注入 provider（测试与嵌入）。省略时按 ~/.uina/auth.json 创建。 */
	provider?: ModelProvider;
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

	private constructor(
		private readonly options: UinaHostOptions,
		readonly subject: Subject,
		private readonly store: SessionStore,
		private readonly extensionHost: ExtensionRunner,
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
		const config = options.provider === undefined ? loadConfig() : undefined;
		const provider = options.provider ?? (() => {
			const active = activeProvider(config!);
			return createProvider(active.name, active);
		})();
		const thinkingLevel = options.thinkingLevel ?? config?.thinkingLevel;

		const tools = new ToolBroker({ ownerId: "root" });
		const jobs = new JobRegistry();
		const models = new ModelRegistry(config);
		models.register(provider.name, provider);

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
			provider: () => subject.getModel(),
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
			tools,
			onInput: (input) => state.stopping ? Promise.reject(new Error("宿主正在关闭")) : subject.accept(input),
			onError: (text) => emit({ type: "error", text }),
			onNotice: (text) => emit({ type: "notice", text }),
			onProvider: (name, registered) => models.register(name, registered),
			onCustomMessage: async (message) => { await subject.appendCustomMessage(message); emit({ type: "custom_message", message }); },
			onCustomEntry: async (entry) => { await subject.appendCustomEntry(entry); emit({ type: "custom_entry", entry }); },
		});

		const hooks: LoopHooks = {
			onToken: (text) => emit({ type: "text", text }),
			onThinking: (text) => emit({ type: "thinking", text }),
			onTurnStart: (n, text) => emit({ type: "turn_start", n, text }),
			onTurnEnd: (n, usage) => emit({ type: "turn_end", n, usage }),
			onToolStart: (name, args, callId) => {
				if (callId) toolStartedAt.set(callId, Date.now());
				emit({ type: "tool_start", name, args, callId });
			},
			onToolDone: (name, result, status, callId) => {
				const ts = callId ? toolStartedAt.get(callId) : undefined;
				if (callId) toolStartedAt.delete(callId);
				emit({ type: "tool_done", name, result, status, callId, ts, elapsedMs: ts === undefined ? undefined : Date.now() - ts });
			},
			onError: (text) => emit({ type: "error", text }),
			onTurnAborted: (n) => emit({ type: "turn_aborted", n }),
			onQueueChanged: (items) => emit({ type: "queue", items }),
		};

		subject = new Subject(provider, tools, hooks, {
			store,
			thinkingLevel,
			runtimeHooks: extensionHost.runtimeHooks(),
		});
		const commands = new CommandRouter(extensionHost.registry, (text) => emit({ type: "error", text }));

		subject.addHistory(projectAgentHistory(restoredEntries));
		if (restoredQueue.length > 0) subject.seedQueue(restoredQueue);

		if (config !== undefined) {
			void models.refreshModels().catch((error: unknown) => {
				options.onError?.(`[模型目录刷新失败] ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		return new UinaHost(options, subject, store, extensionHost, models, jobs, subagents, commands, restoredEntries, listeners, state);
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

	send(input: AgentInput): Promise<void> { return this.subject.accept(input); }

	/**
	 * 提交一行用户文本：这是**投递模式规则**的唯一归属。
	 * 忙时 direct 升级为 steer；空闲时一律 direct，与 CLI 的既有语义一致。
	 */
	submitText(text: string, mode: "direct" | "steer" | "followUp" = "followUp"): Promise<void> {
		const effective: "direct" | "steer" | "followUp" = this.subject.isBusy()
			? (mode === "direct" ? "steer" : mode)
			: "direct";
		return this.subject.pushInput(text, { mode: effective });
	}

	/** 程序化投递：原样入队，不做“忙时升级”转换（队列移交、后台通知走这条路）。 */
	pushInput(text: string, mode: "direct" | "steer" | "followUp"): Promise<void> {
		return this.subject.pushInput(text, { mode });
	}

	/** 当前会话历史的消息条数，供消费者显示恢复信息。 */
	historyCount(): number { return this.subject.historySnapshot().length; }

	/** 扩展渲染器与命令注册表：消费者据此渲染自定义消息与补全命令。 */
	get extensionRegistry(): ExtensionRunner["registry"] { return this.extensionHost.registry; }

	interrupt(): void { this.subject.interrupt(); }
	isBusy(): boolean { return this.subject.isBusy(); }
	waitForIdle(): Promise<void> { return this.subject.waitForIdle(); }
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
		await this.subject.waitForIdle();
		await this.extensionHost.reload();
		this.emit({ type: "notice", text: "项目扩展已重新加载。" });
	}

	/** 关闭主体：等待活动结束、释放扩展、杀掉工具留下的分离子进程、关闭会话。 */
	async dispose(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.state.stopping = true;
		this.stopPromise = (async () => {
			this.subject.interrupt();
			await this.subject.waitForIdle();
			await this.extensionHost.dispose();
			killTrackedDetachedChildren();
			await this.subject.waitForIdle();
			await this.store.close();
			this.listeners.clear();
		})();
		return this.stopPromise;
	}
}
