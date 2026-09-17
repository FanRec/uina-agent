import { randomUUID } from "node:crypto";
import { errorMessage } from "../core/errors.js";
import type { ContextSegments, Model, ModelStreamFn, Provider, ThinkingLevel } from "../core/types.js";
import { activeProvider, loadConfig } from "../ai/config.js";
import { loadSettings, saveSettings } from "../ai/settings.js";
import { modelKey, ModelRegistry } from "../ai/providers.js";
import { ToolBroker, type ToolExecutionResult } from "../tools/broker.js";
import { Subject, type AgentInput } from "../agent/loop.js";
import type { QueuedMessage } from "../agent/queue.js";
import { DefaultAgentFactory } from "../agent/runtime.js";
import { JobRegistry } from "../extensions/jobs/registry.js";
import { SubagentRegistry } from "../extensions/subagents/registry.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { CommandRouter } from "../extensions/commands.js";
import { activateBuiltinCommands } from "../extensions/builtin.js";
import { activateRuntimeTools, createChildTools, TASK_DISPATCH_EFFECT } from "../extensions/runtime-tools/index.js";
import { activateSessionTools } from "../extensions/session-tools/index.js";
import activateWorkspaceTools from "../extensions/workspace-tools/index.js";
import { killTrackedDetachedChildren } from "../runtime/process-tracker.js";
import { MemorySessionStore, openJsonlSession } from "../session/jsonl-store.js";
import { createSessionAccess } from "../session/access.js";
import type { ProjectionPolicy } from "../agent/projection.js";
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
	/** Disable default filesystem capabilities when the host supplies its own assembly. */
	workspaceTools?: boolean;
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
	/** 投影 Replacement 缝（单 owner = Subject 实例；组合根经此提供，P4 起宿主可注入）。 */
	projection?: ProjectionPolicy;
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
	/** 消费者自己的关闭流程（例如同时关闭 TUI）。默认只 dispose 宿主。 */
	requestShutdown?: () => Promise<void>;
}

export class UinaHost {
	private readonly listeners: Set<HostEventListener>;
	private stopPromise?: Promise<void>;
	private readonly directRuns = new Map<AbortController, Promise<ToolExecutionResult>>();
	private reloading = 0;
	/** 消费者自定义关闭流程（start 时接入；pi.shutdown 与 /quit 经此关闭）。 */
	private requestShutdown?: () => Promise<void>;
	readonly abandonedTaskIds: Set<string>;

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
		abandonedTaskIds: Set<string>,
	) {
		this.listeners = listeners;
		this.abandonedTaskIds = abandonedTaskIds;
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
		// 会话偏好恢复：CLI 显式指定 > settings.json（上次会话）> auth.json 默认。
		// 恢复值必须过与运行时相同的校验（resolve / clamp），失效即静默降级 ——
		// 偏好是会话态，陈旧数据不值得让启动失败。
		const settings = options.modelName || options.model ? {} : await loadSettings();
		// 偏好里存的是 modelKey（providerId/id）身份键：跨 provider 的同名模型必须精确还原，
		// 只按裸 id 分辨会落到注册表里恰好先注册的那一个。兼容旧格式裸名；provider 改名或下线
		// 时回落到同名模型，两者都不阻断开局（偏好是会话态，陈旧数据不值得让启动失败）。
		let restoredModel: Model | undefined;
		if (settings.model) {
			try {
				restoredModel = models.resolve(settings.model);
			} catch {
				const slash = settings.model.indexOf("/");
				const bare = slash >= 0 ? settings.model.slice(slash + 1) : undefined;
				if (bare !== undefined) {
					try {
						restoredModel = models.resolve(bare);
					} catch {
						restoredModel = undefined; // 上次的模型已不存在（配置变更/下线），落回默认
					}
				}
			}
		}
		const activeModel = options.model ?? restoredModel ?? (() => {
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
		const thinkingLevel = options.thinkingLevel
			?? (restoredModel?.thinkingLevels?.includes(settings.thinkingLevel as ThinkingLevel) ? settings.thinkingLevel as ThinkingLevel : undefined)
			?? config?.thinkingLevel;
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
		const state = { stopping: false };
		const abandonedTaskIds = new Set<string>();
		// Host 装配层消费工具声明的 generic effect facts：只认 task.dispatch 的
		// 外部操作身份（与 runtime-tools 的声明契约），不认识具体工具。
		const collectAbandonedTaskIds = (entries: readonly SessionEntry[]): void => {
			for (const entry of entries) {
				if (entry.kind !== "rewind" || !entry.effects) continue;
				for (const effect of entry.effects.effects) {
					if (effect.effectType === TASK_DISPATCH_EFFECT && effect.externalOperationId) {
						abandonedTaskIds.add(effect.externalOperationId);
					}
				}
			}
		};
		collectAbandonedTaskIds(restoredEntries);
		const emit = (event: HostEvent): void => {
			for (const listener of [...listeners]) {
				try { listener(event); }
				catch (error) { options.onError?.(`消费者处理事件失败: ${errorMessage(error)}`); }
			}
		};

		// subagents 与 extensionHost 只捕获 subject 的延迟引用，因此可以先建立。
		let subject!: Subject;
		let hostSelf!: UinaHost;
		// Lazy session view: navigation reads compose from the store, rewind routes
		// through the Subject's run-safety points. Built lazily because subject is
		// assigned after the extension host below.
		const rootSessionView = (): import("../session/types.js").SessionAccess =>
			createSessionAccess(store, (request, source, signal) => subject.requestRewind(request, source, signal));
		const subagents = new SubagentRegistry({
			factory: new DefaultAgentFactory(),
			model: () => subject.getModel(),
			stream: streamFn,
			thinkingLevel,
			createTools: (ownerId) => createChildTools(tools, { ownerId }),
			notify: async (text, data, ownerId) => {
				if (state.stopping) return;
				const idStr = String(data.id);
				const isAbandoned = abandonedTaskIds.has(idStr);
				const input: AgentInput = {
					id: `subagent-notice-${idStr}`,
					mode: "followUp",
					source: {
						kind: "runtime",
						type: "subagent-notice",
						ref: idStr,
						...(isAbandoned ? { provenance: { abandoned: true } } : {}),
					},
					text: isAbandoned ? `${text}（注意：该子代理来自已回溯放弃的历史分支）` : text,
					data,
				};
				await (ownerId === "root" ? subject.accept(input) : subagents.acceptInput(ownerId, input));
			},
		});

		const extensionHost = new ExtensionRunner({
			session: {
				list: options => rootSessionView().list(options),
				read: id => rootSessionView().read(id),
				requestRewind: (request, source, signal) => state.stopping ? Promise.reject(new Error("宿主正在关闭")) : rootSessionView().requestRewind(request, source, signal),
			},
   cwd: options.cwd,
   extensionPaths: options.extensionPaths,
   onCompact: (instruction) => subject.compact(instruction),
   models: { current: () => subject.getModel(), list: () => models.listModels(), groups: () => models.groups(), resolve: name => models.resolve(name), select: name => subject.setModel(models.resolve(name)), stream: streamFn },
			usage: () => ({ used: subject.getUsedTokens(), contextWindow: subject.getContextWindow(), segments: subject.getContextSegments() }),
			thinkingLevel: () => subject.getThinkingLevel(),
			setThinkingLevel: (level) => subject.setThinkingLevel(level),
			isBusy: () => subject.isBusy(),
			reload: () => hostSelf.reloadExtensions(),
			shutdown: () => hostSelf.requestShutdown?.() ?? hostSelf.dispose(),
			tools,
			onInput: (input) => state.stopping ? Promise.reject(new Error("宿主正在关闭")) : subject.accept(input),
			onError: (text) => emit({ type: "error", text }),
   onNotice: (text) => emit({ type: "notice", text }),
			onProvider: (name, registered, options) => models.register(name, registered, options),
   onModel: (model, options) => models.registerModel(model, options),
			onCustomMessage: (message) => subject.appendCustomMessage(message),
			onCustomEntry: (entry) => subject.appendCustomEntry(entry),
		});

		// 会话偏好持久化：model_select / thinking_level_select 只经扩展宿主分发
		// （Subject 不把它们发给 subscribe 监听者），组合根在此以监听者身份落盘。
		// 静默失败 —— 偏好落盘失败不值得打断回合，下一次切换会再写。
		// 写必须串行：两次切换背靠背时，未保序的并发写会让慢的旧快照
		// rename 覆盖快的新快照，settings.json 停在过期状态。
		let settingsSaveTail: Promise<void> = Promise.resolve();
		const persistSettings = (): void => {
			settingsSaveTail = settingsSaveTail.then(() => saveSettings({
				model: modelKey(subject.getModel()),
				thinkingLevel: subject.getThinkingLevel(),
			}).catch(() => {}));
		};
		extensionHost.on("model_select", persistSettings);
		extensionHost.on("thinking_level_select", persistSettings);

		subject = new Subject(activeModel, streamFn, tools, {
			store,
			thinkingLevel,
			runtimeHooks: extensionHost.runtimeHooks(),
			compactor: extensionHost.compactor,
			compactionTrigger: extensionHost.compactionTrigger,
			projection: options.projection,
		});

		subject.subscribe((event) => {
			// 宿主内部派生状态：回溯后刷新被放弃的任务集合（它只关心 task.dispatch 效果事实，
			// 不是翻译——事件本身 1:1 透传给消费者）。
			if (event.type === "session_rewind") {
				// 被放弃切片直接读常驻 canonical 状态，不再重放 journal。
				collectAbandonedTaskIds(store.state.allEntries);
			}
			// 事实单流 1:1 透传：宿主不翻译字段、不改形状。notice 是宿主域事件，
			// 主体词汇表不收它，只在此处产生。
			emit(event);
		});
		const commands = new CommandRouter(extensionHost.registry, (text) => emit({ type: "error", text }));

		subject.addHistory(subject.projection.projectHistory(restoredEntries, store.state));
		if (restoredQueue.length > 0) subject.seedQueue(restoredQueue);

		if (config !== undefined) {
			void models.refreshModels().catch((error: unknown) => {
				options.onError?.(`[模型目录刷新失败] ${errorMessage(error)}`);
			});
		}
		return (hostSelf = new UinaHost(options, subject, store, extensionHost, tools, models, jobs, subagents, commands, restoredEntries, listeners, state, abandonedTaskIds));
	}

	subscribe(listener: HostEventListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** 向当前所有消费者广播。单个消费者抛错不影响其它消费者，但错误绝不静默。 */
	emit(event: HostEvent): void {
		for (const listener of [...this.listeners]) {
			try { listener(event); }
			catch (error) { this.options.onError?.(`消费者处理事件失败: ${errorMessage(error)}`); }
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
	claimAllQueued(): Promise<QueuedMessage[]> { return this.subject.claimAllQueued(); }
	claimQueued(id: string): Promise<QueuedMessage | null> { return this.subject.claimQueued(id); }
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

	/** 内置能力与项目扩展走同一套 ActivationScope 与同一张 pi API 面；在消费者接入之后调用。 */
	async start(startOptions: HostStartOptions = {}): Promise<void> {
		this.requestShutdown = startOptions.requestShutdown;
		await this.extensionHost.activateBuiltin("session-tools", activateSessionTools(ownerId => ownerId === "root" ? this.rootSession : this.subagents.session(ownerId)));
		if (this.options.workspaceTools !== false) await this.extensionHost.activateBuiltin("workspace-tools", activateWorkspaceTools);
		await this.extensionHost.activateBuiltin("runtime-tools", activateRuntimeTools({ jobs: this.jobs, subagents: this.subagents, isTaskAbandoned: (id) => this.abandonedTaskIds.has(id) }));
		await this.extensionHost.activateBuiltin("commands", activateBuiltinCommands);
		await this.extensionHost.load();
	}

	get session(): import("../session/types.js").SessionAccess {
		return { list: options => this.rootSession.list(options), listBranches: () => this.rootSession.listBranches(), readBranch: id => this.rootSession.readBranch(id), read: id => this.rootSession.read(id), requestRewind: (request,source,signal) => { this.assertAccepting(); return this.rootSession.requestRewind(request,source,signal); } };
	}

	/** Root session view composed from the store; rewind goes through the Subject. */
	get rootSession(): import("../session/types.js").SessionAccess {
		return createSessionAccess(this.store, (request, source, signal) => this.subject.requestRewind(request, source, signal));
	}

	async reloadExtensions(): Promise<void> {
		this.assertAccepting();
		// 忙时不阻塞命令派发：立即回执受理，等本轮（及队列）排空后后台执行。
		if (this.subject.isBusy()) {
			this.emit({ type: "notice", text: "已受理 /reload：本轮结束后自动重新加载项目扩展。" });
			void this.subject.waitForIdle()
				.then(() => this.runReload())
				.catch(() => undefined);
			return;
		}
		await this.runReload();
	}

	private async runReload(): Promise<void> {
		this.reloading++;
		try {
			await this.subject.waitForIdle();
			await Promise.allSettled([...this.directRuns.values()]);
			if (this.state.stopping) throw new Error("宿主正在关闭");
			await this.extensionHost.reload();
			this.emit({ type: "notice", text: this.reloadSummaryNotice() });
		} finally { this.reloading--; }
	}

	/** 重载完成通知：项目扩展激活数 + 失败摘要，让 reload 结果可观测而非一句空话。 */
	private reloadSummaryNotice(): string {
		const project = this.extensionHost.diagnostics().filter((d) => d.id.startsWith("project:"));
		if (project.length === 0) return "项目扩展已重新加载：当前没有项目扩展。";
		const active = project.filter((d) => d.status === "active").length;
		const failed = project.filter((d) => d.status === "failed");
		let text = `项目扩展已重新加载：${active} 个扩展激活`;
		if (failed.length > 0) text += `，失败 ${failed.length}：${failed.map((f) => f.path).join("、")}`;
		return text + "。";
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
