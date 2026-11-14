import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentInput, Subject } from "../agent/loop.js";
import type { ProjectionPolicy } from "../agent/projection.js";
import type { QueuedMessage } from "../agent/queue.js";
import { activeProvider, loadConfig } from "../ai/config.js";
import { ModelRegistry, modelKey } from "../ai/providers.js";
import { loadSettings, saveSettings } from "../ai/settings.js";
import { errorMessage } from "../core/errors.js";
import type {
	InputSource,
	Model,
	ModelStreamFn,
	Provider,
	ResourceReloadOutcome,
	SystemSnapshot,
	ThinkingLevel,
} from "../core/types.js";
import { activateBuiltinCommands } from "../extensions/builtin.js";
import { CommandRouter } from "../extensions/commands.js";
import activateCompaction from "../extensions/compaction/index.js";
import { createEventFrameProfile, EVENT_FRAME_PROMPT } from "../extensions/event-frames/index.js";
import { ExtensionRunner } from "../extensions/runner.js";
import { activateRuntimeTools } from "../extensions/runtime-tools/index.js";
import { activateSessionTools } from "../extensions/session-tools/index.js";
import { agentsSkillAncestors } from "../extensions/skills/loader.js";
import { createSkillsCapability } from "../extensions/skills/index.js";
import type { SkillSource } from "../extensions/skills/types.js";
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
import { computeResourceRevision, composeSystemText, resolveSystemSubject } from "./system.js";

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
	/**
	 * Host 显式指定的 Skill 根（最高优先级来源）：按声明顺序，先声明者优先。
	 * 缺省走默认来源装配（工作区/近层 .agents/Profile/用户全局/活跃扩展）。
	 */
	skillRoots?: readonly string[];
	/**
	 * Skill 来源完整覆写：提供时替换默认来源装配（嵌入方/测试完全掌控来源集合，
	 * 不继承本机全局目录）。priority 语义与默认装配一致：数值越小越优先。
	 */
	skillSources?: readonly SkillSource[];
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
	/** Skill 官方内置能力：来源装配、刷新与显式调用展开的唯一所有者。 */
	private readonly skills = createSkillsCapability();
	/** 消费者自定义关闭流程（start 时接入；pi.shutdown 与 /quit 经此关闭）。 */
	private requestShutdown?: () => Promise<void>;
	/** 当前已发布的 System 快照（Host 唯一发布者；Subject 持有同一身份做版本复核）。 */
	private systemSnapshot!: SystemSnapshot;
	/** 默认事件帧投影启用时的 Runtime Protocol 段（自定义 projection 不附加）。 */
	private readonly protocolSection?: string;
	/** Host 显式 System 文本（资源刷新不覆盖；undefined = 文件来源可选）。 */
	private readonly hostExplicitSubjectText?: string;
	/** 资源刷新串行尾：并发请求按序执行，发布边界互不交错。 */
	private refreshResourcesTail: Promise<unknown> = Promise.resolve();
	/** 唯一的待执行扩展换代（受理 Reload Intent 时设置；执行后清除）。 */
	private pendingExtensionsReload?: { reloadId: string; done: Promise<void> };

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
		/** 共享的运行标志：关闭与重载准入门，钩子与扩展输入入口据此拒绝跨界的新工作。 */
		private readonly state: { stopping: boolean; reloading: number },
		system: { snapshot: SystemSnapshot; protocolSection?: string; hostExplicitSubjectText?: string },
	) {
		this.listeners = listeners;
		this.recordListeners = recordListeners;
		this.dispatch = dispatch;
		this.systemSnapshot = system.snapshot;
		if (system.protocolSection !== undefined) this.protocolSection = system.protocolSection;
		if (system.hostExplicitSubjectText !== undefined) this.hostExplicitSubjectText = system.hostExplicitSubjectText;
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
			const state = { stopping: false, reloading: 0 };
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
			// （测试与组合根）覆盖主体 System 段；默认投影启用时 Event Frame 协议段始终
			// 附加——options.systemPrompt 只覆盖主体段，不能无意删除协议说明（S1 §3.3）。
			// profile 不再携带 Persona 层：主体身份并入唯一可编辑 system.md（见 host/system.ts）。
			const eventFrameProfile = createEventFrameProfile();
			const resolvedProjection = options.projection ?? eventFrameProfile.projection;
			const useEventFrameProtocol = options.projection === undefined;
			// 主体 System 段解析（S1 §3.1 选择规则）：Host 显式文本 > Profile system.md >
			// 工作区 .uina/system.md > 内置默认。已存在但损坏/为空的文件直接报错，不静默退级。
			const systemSubject = await resolveSystemSubject({
				cwd: options.cwd,
				...(options.systemPrompt !== undefined ? { explicitText: options.systemPrompt } : {}),
				...(options.profile
					? { profileRoot: options.profile.root, subjectId: options.profile.identity.subjectId }
					: {}),
			});
			const hostExplicitSubjectText = options.systemPrompt !== undefined ? systemSubject.text : undefined;
			const protocolSection = useEventFrameProtocol ? EVENT_FRAME_PROMPT : undefined;
			const initialSubjectText = hostExplicitSubjectText ?? systemSubject.text;
			const initialFinalText = composeSystemText(initialSubjectText, protocolSection);
			// 启动基线版本：Guidance/Skill 尚未装配，先只锚定 System 正文；assembleCapabilities
			// 收尾时按已注册 Guidance 与 Skill Catalog 重算发布版本。
			const systemSnapshot: SystemSnapshot = {
				text: initialFinalText,
				source: systemSubject.source,
				revision: computeResourceRevision(initialFinalText, [], ""),
				...(systemSubject.entry !== undefined ? { entry: systemSubject.entry } : {}),
				...(systemSubject.sources !== undefined ? { sources: systemSubject.sources } : {}),
			};
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
				// pi.reload() 留存并转接换代协调器（忙时受理、空闲同步执行的原语义）。
				reload: () => hostSelf.reloadExtensions(),
				reloadResources: () => hostSelf.refreshResources(),
				scheduleExtensionsReload: () => {
					const { reloadId } = hostSelf.scheduleExtensionsReload();
					return { reloadId };
				},
				shutdown: () => hostSelf.requestShutdown?.() ?? hostSelf.dispose(),
				tools,
				delivery: (namespace) => subject.delivery(namespace),
				onInput: (input, owner) => {
					if (state.stopping) return Promise.reject(new Error("宿主正在关闭"));
					// 重载准入门覆盖扩展输入入口：资源替换边界期间不放入新的 Agent 回合。
					if (state.reloading > 0) return Promise.reject(new Error("扩展正在重载，请稍后重试"));
					return subject.accept(input, owner);
				},
				onInputs: (inputs, owner) => {
					if (state.stopping) return Promise.reject(new Error("宿主正在关闭"));
					if (state.reloading > 0) return Promise.reject(new Error("扩展正在重载，请稍后重试"));
					return subject.acceptBatch(inputs, owner);
				},
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
				system: systemSnapshot,
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
			const commands = new CommandRouter(extensionHost.registry);

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
				{
					snapshot: systemSnapshot,
					...(protocolSection !== undefined ? { protocolSection } : {}),
					...(hostExplicitSubjectText !== undefined ? { hostExplicitSubjectText } : {}),
				},
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
		// 装配未收口时排队等待：直接投递的输入也必须等系统提示词完整后再开跑。
		await this.startCompletion;
		this.assertAccepting();
		return this.subject.accept(input);
	}

	private assertAccepting(): void {
		if (this.state.stopping) throw new Error("宿主正在关闭");
		if (this.state.reloading > 0) throw new Error("扩展正在重载，请稍后重试");
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

	/**
	 * 操作者命令入口（TUI/stdin/print 与网关共用）：等待装配收口、执行命令、
	 * 把 handler 返回的 agent-input 结果转成一条真实操作者输入（经 Host.send 同一
	 * 路径 → Subject.accept）。Router 不直接给 Subject 发消息；未知命令与 handler
	 * 异常以 throw 表达——本地消费者显示、网关返回拒绝，不静默吞掉。
	 */
	async submitOperatorCommand(
		rawText: string,
		mode: "direct" | "steer" | "followUp" = "followUp",
		source?: InputSource,
	): Promise<void> {
		await this.startCompletion;
		this.assertAccepting();
		const outcome = await this.commands.dispatch(rawText);
		if (!outcome.handled) return;
		const agentInput = outcome.agentInput;
		if (!agentInput) return; // 本地管理命令（/help、/model 等），无输入要投递
		await this.submitOperatorInput(agentInput, mode, source);
	}

	/**
	 * 结构化 Skill 显式调用（网关 skill.invoke）：与 /skill 命令共用同一展开函数，
	 * 不经命令 Router、不接受任意斜杠命令。
	 */
	async submitSkillInvocation(
		name: string,
		args: string,
		mode: "direct" | "steer" | "followUp" = "followUp",
		source?: InputSource,
	): Promise<void> {
		await this.startCompletion;
		this.assertAccepting();
		const expanded = await this.skills.invoke(name, args);
		await this.submitOperatorInput(expanded, mode, source);
	}

	/** 命令展开结果 → 一条真实操作者输入：投递规则（direct 忙时升级、空闲直启）
	 * 单点归 Subject.pushInput，Host 只表达交互契约与来源。 */
	private submitOperatorInput(
		spec: { text: string; displayText?: string; data?: unknown },
		mode: "direct" | "steer" | "followUp",
		source?: InputSource,
	): Promise<void> {
		this.assertAccepting();
		return this.subject.pushInput(spec.text, {
			mode,
			source: source ?? { kind: "user", type: "operator", origin: "external" },
			...(spec.displayText !== undefined ? { displayText: spec.displayText } : {}),
			...(spec.data !== undefined ? { data: spec.data } : {}),
		});
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

	/** 当前已发布的 System 快照（/prompt 显示已发布版本与选用来源）。 */
	getSystemSnapshot(): SystemSnapshot {
		return structuredClone(this.systemSnapshot);
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
		await this.extensionHost.activateBuiltin("skills", this.skills.activate);
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
		// Skill 来源在全部扩展激活后装配：项目/扩展资源根已就位；刷新发布 read_skill
		// 与 Catalog（首次真实模型请求仍要等 startCompletion 装配门）。
		await this.refreshSkills();
		// Guidance/Skill 首次装配完成后重算并发布资源版本（启动基线只锚定 System 正文）。
		this.republishResourceRevision();
		await this.subject.getContextSnapshot();
	}

	/** Skill 来源装配（§4 优先级表）：数值越小越优先。 */
	private collectSkillSources(): SkillSource[] {
		// 完整覆写（嵌入方/测试）：来源集合完全由调用方给定，不继承默认装配。
		if (this.options.skillSources) return [...this.options.skillSources];
		const sources: SkillSource[] = [];
		const push = (ownerId: string, directory: string): void => {
			sources.push({ ownerId, directory, priority: sources.length });
		};
		// 1. Host 显式指定的 Skill 根：明确指定时不可用要报诊断（缺失默认来源不报）。
		for (const [index, root] of (this.options.skillRoots ?? []).entries()) {
			const directory = resolve(this.options.cwd, root);
			if (!existsSync(directory)) {
				this.emit({ type: "notice", text: `[Skill] 显式来源不可用（目录缺失）: ${directory}` });
				continue;
			}
			push(`explicit:${index}`, directory);
		}
		// 2. 工作区
		push("workspace", join(this.options.cwd, ".uina", "skills"));
		// 3. 从 cwd 到 Git 根之间的 .agents/skills/：越靠近 cwd 越优先；不在 Git 仓库只扫 cwd。
		for (const directory of agentsSkillAncestors(this.options.cwd, (candidate) => existsSync(join(candidate, ".git"))))
			push("agents", directory);
		// 4. 主体 Profile（目录不预创建）
		if (this.options.profile) push("profile", join(this.options.profile.root, "skills"));
		// 5. Uina 用户全局目录（UINA_HOME 或 homedir 的 .uina）
		push("user", join(process.env.UINA_HOME ?? homedir(), ".uina", "skills"));
		// 6. 用户全局 ~/.agents/skills/（始终系统用户目录，不随 UINA_HOME 改变）
		push("agents-user", join(homedir(), ".agents", "skills"));
		// 7. 活跃扩展资源根下的 skills/（激活成功且拥有独占资源根；多入口共享根已去重）
		for (const { ownerId, root } of this.extensionHost.activeResourceRoots())
			push(`ext:${ownerId}`, join(root, "skills"));
		return sources;
	}

	private refreshSkills(): Promise<void> {
		return this.skills.refresh(this.collectSkillSources());
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

	/**
	 * 人工 /reload 与 Agent runtime_reload(extensions) 共用的换代协调器（S3）：
	 * 受理 Reload Intent 时即设置续队屏障与换代准入门（state.reloading 门 + Subject
	 * queueHold），重复请求合并到同一待执行 Reload（同一 reloadId）；真正 Idle 后在
	 * 准入门内执行 ExtensionRunner.reload() 与资源刷新，随后以内部 runtime Input
	 * 交付最终事实，解除准入门并恢复原队列处理。
	 */
	scheduleExtensionsReload(): { reloadId: string; done: Promise<void> } {
		if (this.state.stopping) throw new Error("宿主正在关闭");
		if (this.pendingExtensionsReload) {
			return { reloadId: this.pendingExtensionsReload.reloadId, done: this.pendingExtensionsReload.done };
		}
		const reloadId = randomUUID();
		// 受理即关门（不等到 Idle 才设置）：后续输入按现有可见拒绝规则处理，回合尾的
		// 自动续队被屏障暂停——避免回合尾与新输入在换代前抢跑。
		this.state.reloading++;
		this.subject.holdQueueResume();
		this.emit({
			type: "notice",
			text: `扩展换代已受理（reloadId ${shortId(reloadId)}）：当前回合结算后自动执行，期间新输入会被拒绝，原有排队输入保留。`,
		});
		const execution = this.subject
			.waitForIdle()
			.then(() => Promise.allSettled([...this.directRuns.values()]))
			.then(() => this.executeScheduledReload(reloadId));
		const done = execution.catch(() => undefined);
		this.pendingExtensionsReload = { reloadId, done };
		return { reloadId, done };
	}

	/** 换代执行：等待已在协调器受理时排定的安全点（Idle + 直连工具结算），执行重载，
	 * 交付最终事实，解除准入门并恢复队列。 */
	private async executeScheduledReload(reloadId: string): Promise<void> {
		const intent = this.pendingExtensionsReload;
		if (!intent || intent.reloadId !== reloadId) return; // 已被合并/清除：不重复执行
		this.pendingExtensionsReload = undefined;
		try {
			if (this.state.stopping) {
				this.emit({ type: "notice", text: `扩展换代 ${shortId(reloadId)} 因宿主关闭而取消。` });
				return;
			}
			const result = await this.runReloadCore();
			// 最终事实交付：以稳定 reloadId 生成一次内部 runtime 来源 Input（非外部操作者/
			// Event Frame）。走 Host 可信路径写入现有队列（屏障仍在，先落队不启动回合），
			// 不经会被自身 Reload 门拒绝的扩展 pi.submitInput()。入队失败如实报告，不伪装已交付。
			try {
				await this.subject.acceptDeferred({
					id: `runtime-reload-${reloadId}`,
					mode: "followUp",
					source: { kind: "runtime", origin: "internal", type: "runtime.reload", ref: reloadId },
					text: this.reloadCompletionReport(reloadId, result),
				});
			} catch (error) {
				this.emit({
					type: "error",
					text: `扩展换代完成报告未能入队（${shortId(reloadId)}）: ${errorMessage(error)}`,
				});
			}
		} finally {
			this.state.reloading--;
			this.subject.releaseQueueResume();
			// 解除准入门并恢复队列处理：完成报告（若已入队）与原有排队输入按既有来源/
			// 顺序语义消费——完成报告保证在下一次模型决策前可见，已有输入不丢、不重排。
			// 解除门与恢复队列之间可能有新输入直启回合：忙碌时交给既有队列消费纪律。
			if (!this.subject.isBusy()) {
				try {
					await this.subject.resumePending();
				} catch (error) {
					this.emit({ type: "error", text: `换代后恢复队列失败: ${errorMessage(error)}` });
				}
			}
		}
	}

	/** 换代最终报告：completed/partial/failed、实际有效扩展与资源状态，不声称全量应用。 */
	private reloadCompletionReport(
		reloadId: string,
		result: { importError?: string; resources: ResourceReloadOutcome },
	): string {
		const project = this.extensionHost.diagnostics().filter((d) => d.id.startsWith("project:"));
		const active = project.filter((d) => d.status === "active").length;
		const failed = project.filter((d) => d.status === "failed");
		const phase = result.importError !== undefined || failed.length > 0 ? "partial" : "completed";
		const lines: string[] = [];
		lines.push(`[扩展换代${phase === "completed" ? "已完成" : "部分完成"}（reloadId: ${shortId(reloadId)}）]`);
		if (result.importError) lines.push(`预导入失败，旧项目扩展保持不变：${result.importError}`);
		lines.push(
			`当前有效项目扩展 ${active} 个${failed.length > 0 ? `；激活失败 ${failed.length} 个：${failed.map((f) => f.path).join("、")}` : ""}。`,
		);
		if (result.resources.ok) {
			lines.push(`资源已按新激活集合刷新：${result.resources.summary ?? "System/文件式 Guidance/Skills 重新发布"}。`);
		} else {
			lines.push(
				`资源刷新失败，System/文件式 Guidance/Skills 保持上一发布版本：${result.resources.error ?? "未知原因"}。`,
			);
		}
		lines.push("原有排队输入已保留，本次通知后按原顺序继续处理。");
		return lines.join("\n");
	}

	async reloadExtensions(): Promise<void> {
		if (this.state.stopping) throw new Error("宿主正在关闭");
		const merged = this.pendingExtensionsReload !== undefined;
		const { done } = this.scheduleExtensionsReload();
		if (merged) {
			this.emit({ type: "notice", text: "扩展换代已在安排中，本次请求合并到同一待执行 Reload。" });
			return;
		}
		// 空闲时同步执行完（人工命令看到最终结果）；忙时保持受理即返回的原语义。
		if (!this.subject.isBusy()) await done;
	}

	/**
	 * 扩展换代核心（准入门内执行）：预导入失败保留旧扩展；单扩展激活失败如实部分
	 * 成功；资源按新激活集合刷新。结构性失败不吞掉——由调用方区分报告。
	 */
	private async runReloadCore(): Promise<{ importError?: string; resources: ResourceReloadOutcome }> {
		await this.subject.waitForIdle();
		await Promise.allSettled([...this.directRuns.values()]);
		if (this.state.stopping) throw new Error("宿主正在关闭");
		let importError: string | undefined;
		try {
			await this.extensionHost.reload();
		} catch (error) {
			// Pre-import 失败沿用 Runner 的"旧扩展不卸载"逻辑：如实记录，不声称全量应用。
			importError = errorMessage(error);
			this.emit({ type: "error", text: `扩展预导入失败，旧项目扩展保持不变: ${importError}` });
		}
		// 项目扩展集合可能已变：资源必须按新激活集合重建发布；资源失败如实报告实际状态
		//（扩展有效集已改变 ≠ "旧版本全部保留"）。
		const resources = await this.refreshResources();
		await this.subject.getContextSnapshot();
		this.emit({ type: "notice", text: this.reloadSummaryNotice() });
		return { ...(importError !== undefined ? { importError } : {}), resources };
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

	/**
	 * 资源刷新入口（S2）：runtime_reload(scope="resources")、/reload resources 与扩展
	 * 换代共用。串行执行；Busy 时同样安全应用（请求级版本一致性检查防混版）。
	 */
	refreshResources(): Promise<ResourceReloadOutcome> {
		const run: Promise<ResourceReloadOutcome> = this.refreshResourcesTail.then(() => this.runResourceReload());
		this.refreshResourcesTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * 资源刷新的"准备—发布"合同（§4.2）：准备阶段异步读盘（失败不触碰现役资源，
	 * 整体拒绝发布）；发布阶段在同一同步边界替换 System、文件式 Guidance 与 Skill
	 * 快照。内容无变化时不推进版本、不重复注册。单个无效 Skill 按现有宽容合同
	 * 跳过并报告 diagnostics，不阻断其他有效 Skill 发布。
	 */
	private async runResourceReload(): Promise<ResourceReloadOutcome> {
		try {
			// ── 准备阶段 ────────────────────────────────────────────────────
			const subject = await resolveSystemSubject({
				cwd: this.options.cwd,
				// Host 显式文本仍参与版本计算，但文件修改不覆盖该文本。
				...(this.hostExplicitSubjectText !== undefined
					? { explicitText: this.hostExplicitSubjectText }
					: this.options.profile
						? { profileRoot: this.options.profile.root, subjectId: this.options.profile.identity.subjectId }
						: {}),
			});
			const guidance = await this.extensionHost.prepareFileGuidanceRefresh();
			const skills = await this.skills.prepare(this.collectSkillSources());
			// ── 版本计算与无变化短路 ────────────────────────────────────────
			const finalText = composeSystemText(subject.text, this.protocolSection);
			const revision = computeResourceRevision(
				finalText,
				guidance.map(({ key, compiled }) => ({ key, hash: compiled.hash })),
				skills.catalogHash,
			);
			const summary =
				`System ${subject.source}${subject.entry ? `（${subject.entry}）` : ""}；` +
				`文件式 Guidance ${guidance.length} 项；Skills ${skills.snapshot.entries.length} 个` +
				(skills.snapshot.diagnostics.length > 0 ? `（diagnostics ${skills.snapshot.diagnostics.length} 条）` : "") +
				"。";
			if (revision === this.systemSnapshot.revision) {
				return { ok: true, phase: "applied", revision, unchanged: true, summary };
			}
			// ── 发布边界（同步；Guidance 替换先全量校验，Skills 发布自带回滚）──
			const rollbackGuidance = this.extensionHost.publishFileGuidanceRefresh(guidance);
			try {
				this.skills.publish(skills);
			} catch (error) {
				rollbackGuidance();
				throw error;
			}
			const snapshot: SystemSnapshot = {
				text: finalText,
				source: subject.source,
				revision,
				...(subject.entry !== undefined ? { entry: subject.entry } : {}),
				...(subject.sources !== undefined ? { sources: subject.sources } : {}),
			};
			this.systemSnapshot = snapshot;
			this.subject.setSystemSnapshot(snapshot);
			return { ok: true, phase: "applied", revision, summary };
		} catch (error) {
			// 读取/编译/发布失败：现行资源完全不变，精确说明失败来源。
			return {
				ok: false,
				phase: "unchanged",
				error: errorMessage(error),
			};
		}
	}

	/** 按当前注册状态重算并发布资源版本（不重读文件；启动装配收尾与换代后校准用）。 */
	private republishResourceRevision(): void {
		const revision = computeResourceRevision(
			this.systemSnapshot.text,
			this.extensionHost.fileGuidanceHashes(),
			this.skills.catalogHash(),
		);
		if (revision === this.systemSnapshot.revision) return;
		const snapshot: SystemSnapshot = { ...this.systemSnapshot, revision };
		this.systemSnapshot = snapshot;
		this.subject.setSystemSnapshot(snapshot);
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

/** 换代 reloadId 的短展示形式（通知与报告用；完整 id 携带在 Tool Result details 中）。 */
function shortId(reloadId: string): string {
	return reloadId.slice(0, 8);
}
