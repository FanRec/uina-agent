import { randomUUID } from "node:crypto";
import { type AgentInput, Subject } from "../agent/loop.js";
import type { ProjectionPolicy } from "../agent/projection.js";
import type { QueuedMessage } from "../agent/queue.js";
import { activeProvider, loadConfig } from "../ai/config.js";
import { ModelRegistry, modelKey } from "../ai/providers.js";
import { loadSettings, saveSettings } from "../ai/settings.js";
import { errorMessage } from "../core/errors.js";
import type { Model, ModelStreamFn, Provider, ThinkingLevel } from "../core/types.js";
import { activateBuiltinCommands } from "../extensions/builtin.js";
import { CommandRouter } from "../extensions/commands.js";
import activateCompaction from "../extensions/compaction/index.js";
import { createEventFrameProfile } from "../extensions/event-frames/index.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { activateRuntimeTools } from "../extensions/runtime-tools/index.js";
import { activateSessionTools } from "../extensions/session-tools/index.js";
import type { ExtensionUIContext } from "../extensions/ui-contract.js";
import activateWorkspaceTools from "../extensions/workspace-tools/index.js";
import { activateWorldFramework } from "../extensions/world-framework/index.js";
import { killTrackedDetachedChildren } from "../runtime/process-tracker.js";
import { createSessionAccess } from "../session/access.js";
import { MemorySessionStore, openJsonlSession } from "../session/jsonl-store.js";
import type { SessionEntry, SessionStore } from "../session/types.js";
import { ToolBroker, type ToolExecutionResult } from "../tools/broker.js";
import type { HostEvent, HostEventListener, HostEventRecordListener, HostSnapshot } from "./events.js";
import type { SubjectProfile } from "./profile.js";

/**
 * 宿主：主体生命期的所有者。
 *
 * 它拥有 provider、工具、扩展宿主、会话存储与唯一的根 Subject，
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
	/** 投影 Replacement 缝（单 owner = Subject 实例；组合根经此提供，宿主可注入）。 */
	projection?: ProjectionPolicy;
	systemPrompt?: string;
	/** 主体 profile：提供时 session/settings/扩展资源绑定全部从 profile 解析。 */
	profile?: SubjectProfile;
	/** 诊断出口：消费者尚未接入时也必须可见，绝不静默吞掉。 */
	onError?: (text: string) => void;
}

export interface HostStartOptions {
	/** 消费者自己的关闭流程（例如同时关闭 TUI）。默认只 dispose 宿主。 */
	requestShutdown?: () => Promise<void>;
}

export class UinaHost {
	private readonly listeners: Set<HostEventListener>;
	private readonly recordListeners: Set<HostEventRecordListener>;
	/** 唯一派发点：事件与带时刻的记录从同一处广播，消费者与记录订阅者不分叉。 */
	private readonly dispatch: (event: HostEvent) => void;
	private stopPromise?: Promise<void>;
	private readonly directRuns = new Map<AbortController, Promise<ToolExecutionResult>>();
	private reloading = 0;
	/** 消费者自定义关闭流程（start 时接入；pi.shutdown 与 /quit 经此关闭）。 */
	private requestShutdown?: () => Promise<void>;

	private constructor(
		private readonly options: UinaHostOptions,
		readonly subject: Subject,
		private readonly store: SessionStore,
		private readonly extensionHost: ExtensionRunner,
		private readonly tools: ToolBroker,
		readonly models: ModelRegistry,
		readonly commands: CommandRouter,
		/** 会话恢复出来的有序条目，交给消费者建立自己的视图。 */
		readonly restoredEntries: readonly SessionEntry[],
		/** 会话恢复出来的 auxiliary 登记（capability 私有持久状态），消费者回放装饰用。 */
		readonly restoredAuxiliary: readonly (
			| import("../session/types.js").SessionEventRecord
			| import("../session/types.js").SessionCustomEntryRecord
		)[],
		listeners: Set<HostEventListener>,
		recordListeners: Set<HostEventRecordListener>,
		dispatch: (event: HostEvent) => void,
		/** 共享的关闭标志：钩子与扩展输入入口据此拒绝关闭后的新工作。 */
		private readonly state: { stopping: boolean },
	) {
		this.listeners = listeners;
		this.recordListeners = recordListeners;
		this.dispatch = dispatch;
	}

	/** 当前 canonical 会话的 auxiliary 登记（store 活状态的副本）。
	 * session_rewind 回放装饰等消费者需要的是"现在"的登记；restoredAuxiliary
	 * 只是启动快照，覆盖不了恢复之后新发生的压缩。 */
	auxiliaryEntries(): readonly (
		| import("../session/types.js").SessionEventRecord
		| import("../session/types.js").SessionCustomEntryRecord
	)[] {
		return [...this.store.state.auxiliary];
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
		// profile 模式：settings 读写定向到主体根（settingsDir），不碰全局 ~/.uina。
		const settingsHome = options.profile?.settingsDir;
		const settings = options.modelName || options.model ? {} : await loadSettings(settingsHome);
		// 偏好里存的是 modelKey（providerId/id）身份键：跨 provider 的同名模型必须精确还原，
		// 只按裸 id 分辨会落到注册表里恰好先注册的那一个。只认身份键；解析失败
		// （provider 改名/模型下线/旧格式裸名）即落回默认模型，不猜旧配置的含义。
		let restoredModel: Model | undefined;
		if (settings.model) {
			try {
				restoredModel = models.resolve(settings.model);
			} catch {
				restoredModel = undefined; // 上次的模型已不存在（配置变更/下线），落回默认
			}
		}
		const activeModel =
			options.model ??
			restoredModel ??
			(() => {
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
		const thinkingLevel =
			options.thinkingLevel ??
			(restoredModel?.thinkingLevels?.includes(settings.thinkingLevel as ThinkingLevel)
				? (settings.thinkingLevel as ThinkingLevel)
				: undefined) ??
			config?.thinkingLevel;
		const streamFn: ModelStreamFn =
			options.stream ?? ((m, req, onDelta, signal) => models.stream(m, req, onDelta, signal));

		const tools = new ToolBroker({ ownerId: "root" });

		let store: SessionStore = new MemorySessionStore();
		let restoredEntries: readonly SessionEntry[] = [];
		let restoredQueue: readonly QueuedMessage[] = [];
		if (options.sessionPath !== undefined) {
			const opened = await openJsonlSession(options.sessionPath);
			store = opened.store;
			restoredEntries = opened.snapshot.entries;
			restoredQueue = opened.snapshot.queued;
		}

		try {
			// 这些对象在宿主实例之前建立，并被实例与其钩子共享，避免任何后补赋值。
			const listeners = new Set<HostEventListener>();
			const recordListeners = new Set<HostEventRecordListener>();
			const state = { stopping: false };
			const emit = (event: HostEvent): void => {
				// 记录在派发点生成一次：所有监听者看到同一个 `at`，消费者不得自行再记时刻。
				const record = { at: Date.now(), event } as const;
				for (const listener of [...listeners]) {
					try {
						listener(event);
					} catch (error) {
						options.onError?.(`消费者处理事件失败: ${errorMessage(error)}`);
					}
				}
				for (const listener of [...recordListeners]) {
					try {
						listener(record);
					} catch (error) {
						options.onError?.(`事实消费者处理事件失败: ${errorMessage(error)}`);
					}
				}
			};

			// extensionHost 只捕获 subject 的延迟引用，因此可以先建立。
			let subject!: Subject;
			let hostSelf!: UinaHost;
			// Lazy session view: navigation reads compose from the store, rewind routes
			// through the Subject's run-safety points. Built lazily because subject is
			// assigned after the extension host below.
			const rootSessionView = (): import("../session/types.js").SessionAccess =>
				createSessionAccess(store, (request, source, signal) => subject.requestRewind(request, source, signal));
			// Host 默认装配事件帧 profile（外部输入以 external_event_frame 回执呈现，协议校验
			// 随每请求执行；预算门仍归 Subject）。显式传入 projection/systemPrompt 的装配方
			// （测试与组合根）完全覆盖默认值，不叠加。profile 存在时把主体 persona 追加为
			// 身份段（profile 启动时解析一次此后只读，与"systemPrompt 保持完全静态"一致）。
			const eventFrameProfile = createEventFrameProfile();
			const resolvedProjection = options.projection ?? eventFrameProfile.projection;
			const baseSystemPrompt = eventFrameProfile.systemPrompt;
			// personaText 已在 resolveProfile 装配点归一化（trim），此处只做 truthy 判断。
			const personaText = options.profile?.personaText;
			const resolvedSystemPrompt =
				options.systemPrompt ?? (personaText ? `${baseSystemPrompt}\n\n${personaText}` : baseSystemPrompt);
			const extensionHost = new ExtensionRunner({
				// 主体绑定：扩展经 pi.subject 拿到绑定的资源根；无 profile 时缺省
				// undefined——旧扩展与测试零影响。
				subjectBinding: options.profile
					? {
							subjectId: options.profile.identity.subjectId,
							sessionId: options.profile.sessions.sessionId,
							memoryRoot: options.profile.resources.memoryRoot,
							stateRoot: options.profile.resources.stateRoot,
						}
					: undefined,
				session: {
					list: (options) => rootSessionView().list(options),
					read: (id) => rootSessionView().read(id),
					requestRewind: (request, source, signal) =>
						state.stopping
							? Promise.reject(new Error("宿主正在关闭"))
							: rootSessionView().requestRewind(request, source, signal),
				},
				cwd: options.cwd,
				extensionPaths: options.extensionPaths,
				models: {
					current: () => subject.getModel(),
					list: () => models.listModels(),
					groups: () => models.groups(),
					resolve: (name) => models.resolve(name),
					select: (name) => subject.setModel(models.resolve(name)),
					stream: streamFn,
				},
				context: () => subject.getContextSnapshot(),
				inspectRequest: () => subject.inspectRequest(),
				usage: () => subject.getRequestUsage(),
				thinkingLevel: () => subject.getThinkingLevel(),
				setThinkingLevel: (level) => subject.setThinkingLevel(level),
				isBusy: () => subject.isBusy(),
				runActivity: (fn) => subject.runActivity(fn),
				history: () => store.state.entries,
				auxiliary: () => store.state.auxiliary,
				emitRuntimeEvent: (event) => extensionHost.runtimeHooks().events.emit(event),
				reload: () => hostSelf.reloadExtensions(),
				shutdown: () => hostSelf.requestShutdown?.() ?? hostSelf.dispose(),
				tools,
				delivery: (namespace) => subject.delivery(namespace),
				onInput: (input, owner) =>
					state.stopping ? Promise.reject(new Error("宿主正在关闭")) : subject.accept(input, owner),
				onInputs: (inputs, owner) =>
					state.stopping ? Promise.reject(new Error("宿主正在关闭")) : subject.acceptBatch(inputs, owner),
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
			const settingsHomeForSave = options.profile?.settingsDir;
			const persistSettings = (): void => {
				settingsSaveTail = settingsSaveTail.then(() =>
					saveSettings(
						{
							model: modelKey(subject.getModel()),
							thinkingLevel: subject.getThinkingLevel(),
						},
						settingsHomeForSave,
					).catch(() => {}),
				);
			};
			extensionHost.on("model_select", persistSettings);
			extensionHost.on("thinking_level_select", persistSettings);

			subject = new Subject(activeModel, streamFn, tools, {
				store,
				thinkingLevel,
				systemPrompt: resolvedSystemPrompt,
				runtimeHooks: extensionHost.runtimeHooks(),
				projection: resolvedProjection,
				measureContext: (model, projection) =>
					models.getProvider(model.providerId)?.measureContext?.(model, projection),
			});

			subject.subscribe((event) => {
				// 事实单流 1:1 透传：宿主不翻译字段、不改形状。notice 是宿主域事件，
				// 主体词汇表不收它，只在此处产生。
				emit(event);
			});
			const commands = new CommandRouter(extensionHost.registry, (text) => emit({ type: "error", text }));

			subject.addHistory(subject.projection.projectHistory(restoredEntries, store.state));
			if (restoredQueue.length > 0) subject.seedQueue(restoredQueue);

			if (config !== undefined) {
				void models.refreshModels().catch((error: unknown) => {
					options.onError?.(`[模型目录] ${errorMessage(error)}`);
				});
			}
			return (hostSelf = new UinaHost(
				options,
				subject,
				store,
				extensionHost,
				tools,
				models,
				commands,
				restoredEntries,
				[...store.state.auxiliary],
				listeners,
				recordListeners,
				emit,
				state,
			));
		} catch (error) {
			await store.close().catch(() => undefined);
			throw error;
		}
	}

	subscribe(listener: HostEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * 事实记录订阅：与 subscribe 同一派发点，额外携带宿主派发时刻。
	 * Presentation Core 只经此入口取事件；它不知道 Host 的存在，Host 也不认识它。
	 */
	onEventRecord(listener: HostEventRecordListener): () => void {
		this.recordListeners.add(listener);
		return () => {
			this.recordListeners.delete(listener);
		};
	}

	/** 向当前所有消费者广播。单个消费者抛错不影响其它消费者，但错误绝不静默。 */
	emit(event: HostEvent): void {
		this.dispatch(event);
	}

	async send(input: AgentInput): Promise<void> {
		this.assertAccepting();
		return this.subject.accept(input);
	}

	private assertAccepting(): void {
		if (this.state.stopping) throw new Error("宿主正在关闭");
		if (this.reloading) throw new Error("扩展正在重载，请稍后重试");
	}

	/** 人工恢复入口：只请求当前 session 的 TTS reset，不重播旧台词、不修改偏好。 */
	async resetVoice(signal?: AbortSignal): Promise<ToolExecutionResult> {
		return this.runToolDirect("tts", { action: "recover", operation: "reset" }, signal);
	}

	async runToolDirect(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		this.assertAccepting();
		const controller = new AbortController();
		const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const hooks = this.extensionHost.runtimeHooks().tools;
		const callId = "direct-" + randomUUID();
		const invocationId = `direct:${callId}`;
		const run = this.tools.executePipeline({ callId, invocationId, name, args }, { signal: cancellation, hooks });
		this.directRuns.set(controller, run);
		try {
			return await run;
		} finally {
			this.directRuns.delete(controller);
		}
	}

	/**
	 * 提交一行用户文本（交互行）。两段规则的划分（P2-C 单点化）：
	 * - 此处只表达交互契约"空闲时用户输入必须立即开跑"→ 空闲统一按 direct 提交；
	 * - direct 的忙时升级（→steer）等投递规则唯一归属 Subject.pushInput。
	 * `source` 供远端消费者（多前端网关）标注归属通道；缺省是本机操作者。
	 */
	async submitText(
		text: string,
		mode: "direct" | "steer" | "followUp" = "followUp",
		source?: import("../core/types.js").InputSource,
	): Promise<void> {
		// 装配未收口时排队等待而不是拒绝：第 1 回合必须看到最终系统提示词。
		await this.startCompletion;
		this.assertAccepting();
		const effective = this.subject.isBusy() ? mode : "direct";
		// 操作者输入来源标注（外部事件帧协议）：TUI/console 提交是已知操作者通道，
		// 显式标注 type=operator，不再落到投影层的 unknown 缺省——消费端（模型）
		// 据此区分操作者指令与环境快照的响应权重，不靠内容猜测。
		return this.subject.pushInput(text, {
			mode: effective,
			source: source ?? { kind: "user", type: "operator", origin: "external" },
		});
	}

	/** 程序化投递：原样入队，不做“忙时升级”转换（队列移交、后台通知走这条路）。 */
	async pushInput(text: string, mode: "direct" | "steer" | "followUp"): Promise<void> {
		await this.startCompletion;
		this.assertAccepting();
		return this.subject.pushInput(text, { mode });
	}

	/** 当前会话历史的消息条数，供消费者显示恢复信息。 */
	historyCount(): number {
		return this.subject.historySnapshot().length;
	}

	/** 扩展渲染器与命令注册表：消费者据此渲染自定义消息与补全命令。 */
	get extensionRegistry(): ExtensionRunner["registry"] {
		return this.extensionHost.registry;
	}

	interrupt(): void {
		this.subject.interrupt();
	}
	isBusy(): boolean {
		return this.subject.isBusy();
	}
	waitForIdle(): Promise<void> {
		return this.subject.waitForIdle();
	}
	resumePending(): Promise<void> {
		return (async () => {
			// 恢复未完成回合同样会开启模型回合，必须等装配收口（系统提示词完整性）。
			await this.startCompletion;
			this.assertAccepting();
			return this.subject.resumePending();
		})();
	}
	claimAllQueued(): Promise<import("../agent/loop.js").ClaimAllResult> {
		return this.subject.claimAllQueued();
	}
	claimQueued(id: string): Promise<QueuedMessage | null> {
		return this.subject.claimQueued(id);
	}
	cycleThinkingLevel(): ThinkingLevel {
		return this.subject.cycleThinkingLevel();
	}
	setThinkingLevel(level: ThinkingLevel): void {
		this.subject.setThinkingLevel(level);
	}
	attachExtensionUI(ui: ExtensionUIContext): void {
		this.extensionHost.attachUI(ui);
	}

	/** 最近一次真实发送的活动请求观察（只读；preview 走 inspectRequest，独立身份）。
	 * /prompt 等检查面经此端口消费，不直接 import Subject 或访问扩展 Registry。 */
	getRequestObservation(): import("../agent/loop.js").ActiveRequestObservation | undefined {
		return this.subject.getRequestObservation();
	}

	/** 当前请求预览（纯读装配；独立身份，不冒充"刚刚实际发送"）。 */
	inspectRequest(): Promise<import("../core/types.js").RequestInspection> {
		return this.subject.inspectRequest();
	}

	/** 消费者渲染所需的全部事实，一次取齐。 */
	snapshot(): HostSnapshot {
		const model = this.subject.getModel();
		const queue = this.subject.queuedSnapshot();
		return {
			modelName: model.name,
			thinkingLevels: model.thinkingLevels,
			thinkingLevel: model.thinkingLevels?.length ? this.subject.getThinkingLevel() : undefined,
			context: this.subject.getCurrentContextSnapshot(),
			busy: this.subject.isBusy(),
			queue,
			queueDepth: queue.length,
			queueOldestAgeMs: this.subject.queueOldestAgeMs(),
		};
	}

	/** 扩展装配收口门：start() 同步赋值，回合开始的输入入口等它 resolve。
	 * 没有它，用户在装配窗口内打字会让第 1 回合跑在项目扩展激活前——系统提示词
	 * 缺片段（提示词变更横幅的来源），服务端前缀缓存也随之失效一次。 */
	private startCompletion?: Promise<void>;

	/** 内置能力与项目扩展共享同一套 ResourceScope 与同一张 pi API 面；在消费者接入之后调用。 */
	async start(startOptions: HostStartOptions = {}): Promise<void> {
		this.requestShutdown = startOptions.requestShutdown;
		// 先同步赋值再进入第一个 await：消费者接入发生在 start() 之前，装配窗口内的
		// 提交必须落到这扇门上，而不是落到未定义的门。
		const completion = this.assembleCapabilities();
		this.startCompletion = completion;
		await completion;
	}

	private async assembleCapabilities(): Promise<void> {
		// 先发布一次恢复基线快照：扩展装配（伴生服务预热、world 启动）可能拖住
		// start 数十秒，上下文条先以恢复出的历史基线可见。start 末尾的快照在全部
		// 扩展装配完成后重算，仍是权威收口。
		await this.subject.getContextSnapshot();
		// 装配顺序只表达启动依赖（命令注册、工具注册、History View/Context Source 注册）。
		// 请求装配顺序不依赖这里：History View 单一所有者（compaction）+ Context Source
		// 由 Composer 按稳定身份排序；systemPrompt 保持静态（前缀缓存合同）。
		await this.extensionHost.activateBuiltin(
			"session-tools",
			activateSessionTools(() => this.rootSession),
		);
		if (this.options.workspaceTools !== false)
			await this.extensionHost.activateBuiltin("workspace-tools", activateWorkspaceTools);
		await this.extensionHost.activateBuiltin("runtime-tools", activateRuntimeTools());
		await this.extensionHost.activateBuiltin("commands", activateBuiltinCommands);
		// 压缩预算直接读 Subject 声明的工具。再在宿主里拼一次，以后声明规则一变就会静默分叉。
		await this.extensionHost.activateBuiltin("compaction", activateCompaction);
		await this.extensionHost.activateBuiltin("world-framework", activateWorldFramework);
		await this.extensionHost.load();
		await this.subject.getContextSnapshot();
	}

	get session(): import("../session/types.js").SessionAccess {
		return {
			list: (options) => this.rootSession.list(options),
			listBranches: () => this.rootSession.listBranches(),
			readBranch: (id) => this.rootSession.readBranch(id),
			read: (id) => this.rootSession.read(id),
			requestRewind: (request, source, signal) => {
				this.assertAccepting();
				return this.rootSession.requestRewind(request, source, signal);
			},
		};
	}

	/** Root session view composed from the store; rewind goes through the Subject. */
	get rootSession(): import("../session/types.js").SessionAccess {
		return createSessionAccess(this.store, (request, source, signal) =>
			this.subject.requestRewind(request, source, signal),
		);
	}

	async reloadExtensions(): Promise<void> {
		this.assertAccepting();
		// 忙时不阻塞命令派发：立即回执受理，等本轮（及队列）排空后后台执行。
		if (this.subject.isBusy()) {
			this.emit({ type: "notice", text: "已受理 /reload：本轮结束后自动重新加载项目扩展。" });
			void this.subject
				.waitForIdle()
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
			await this.subject.getContextSnapshot();
			this.emit({ type: "notice", text: this.reloadSummaryNotice() });
		} finally {
			this.reloading--;
		}
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
		this.subject.closeDelivery();
		this.stopPromise = (async () => {
			this.subject.interrupt();
			for (const controller of this.directRuns.keys()) controller.abort();
			await Promise.allSettled([...this.directRuns.values()]);
			await this.subject.waitForIdle();
			const errors: unknown[] = [];
			try {
				await this.extensionHost.dispose();
			} catch (error) {
				errors.push(error);
			}
			try {
				killTrackedDetachedChildren();
			} catch (error) {
				errors.push(error);
			}
			await this.subject.waitForIdle();
			try {
				await this.store.close();
			} catch (error) {
				errors.push(error);
			}
			this.listeners.clear();
			this.recordListeners.clear();
			if (errors.length) throw new AggregateError(errors, "宿主关闭时发生错误");
		})();
		return this.stopPromise;
	}
}
