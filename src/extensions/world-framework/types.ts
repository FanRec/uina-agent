import type { ToolExecutionResult } from "../../tools/broker.js";

/**
 * 全局操作权威身份（OperationIdentity）
 * 格式：world:<worldName>/<actionName>
 * 例如：world:jukebox/play, world:live2d/set_expression
 * 铁律：Facade 是视觉压缩，绝不是语义压缩；系统内部审计与拦截永远保留该身份。
 */
export type OperationIdentity = `world:${string}/${string}`;

/**
 * 操作上下文（注入给 Action 执行函数的上下文工具）
 */
export interface ActionContext {
	/**
	 * 当前操作的全局权威身份
	 */
	operationIdentity: OperationIdentity;
	/**
	 * 本次工具调用的取消信号。
	 *
	 * 长动作（如多步物理特技、连续分镜）**必须**把它透传给内部可取消原语
	 * （如通道仲裁的 claim、分段等待），否则工具层报 cancelled 时物理动作仍在继续，
	 * 构成对外谎报。短动作可忽略。
	 */
	signal: AbortSignal;
}

/**
 * 单个动作定义（Action Definition）
 */
export interface ActionDef<TParams = Record<string, unknown>> {
	/** 动作描述，展示给模型作为工具使用说明 */
	description: string;
	/**
	 * 参数的 JSON Schema（可选，遵循标准 OpenAI/JSON Schema 格式）
	 * 留空表示无需参数或接受自由参数
	 */
	parameters?: Record<string, unknown>;
	/**
	 * 自定义参数校验器（可选）
	 */
	validate?: (params: unknown) => { valid: boolean; error?: string };
	/** 动作执行逻辑 */
	run: (params: TParams, ctx: ActionContext) => Promise<ToolExecutionResult> | ToolExecutionResult;
}

/**
 * 外部伴生服务上下文
 */
export interface ServiceCompanionContext {
	delivery?: import("../../core/types.js").HostDeliveryPort;
	/** 取消信号（当宿主或世界关闭时触发） */
	signal: AbortSignal;
	/** 投递输入/机会至主脑信道（可选通用能力） */
	submitInput?: (input: import("../../agent/loop.js").AgentInput) => Promise<void>;
	emitEvent?: (event: WorldEvent) => Promise<EventSubmission>;
	/**
	 * 多条事件一次交出：每条独立结果，全部落队后才调度一次消费。
	 *
	 * 只用于"同一批事实"，例如同一世界的多处任务几乎同时完成。它**不**保证一起被模型
	 * 看到：一次决策带几条仍由宿主的有界领取预算决定。Steer 不要混进来——那会打乱
	 * "紧急先处理"的边界。
	 *
	 * 宿主没有这个入口时字段缺省。调用方必须自己决定降级方式并显式知道"合批不可用"：
	 * 既不能自称已经集中受理，也不能静默丢掉事件。
	 */
	emitEvents?: (events: readonly WorldEvent[]) => Promise<readonly EventSubmission[]>;
	/** 探测主脑是否忙碌（可选通用能力） */
	isBusy?: () => boolean;
	/** 世界数据目录（可选） */
	worldDataDir?: string;
	/**
	 * 监听宿主通用活动事件（可选通用能力）。
	 *
	 * 来源来自 input_accepted 的权威 InputSource，不由消费方推断：
	 * - kind="user" → human（人/操作者通道）；
	 * - kind="runtime" 且 origin="external" → external（外部世界的运行时输入）；
	 * - 其余（runtime+internal、agent、无 source）→ runtime（主体自身内部活动）。
	 * 这是"有人/有东西刚投递了输入"的事实，与回合是否已开始无关。
	 */
	onActivity?: (listener: (event: { origin: "human" | "external" | "runtime" }) => void) => () => void;
	/**
	 * 订阅宿主事实事件流（可选通用能力）。
	 *
	 * 与 onActivity 的分工：onActivity 是"有人/有东西在动"的极简信号，事件类型已丢失；
	 * onHostEvent 保留 type 与 channel，供需要区分思考/输出/回合边界的世界使用。
	 * 事件按 RuntimeEvent 词汇只读投递，订阅方不得回写。
	 */
	onHostEvent?: (
		listener: (event: { readonly type: string; readonly channel?: string; readonly [key: string]: unknown }) => void,
	) => () => void;
	/**
	 * 同进程行为出口（可选通用能力）。
	 *
	 * 把世界内部**活引用**（对象/函数）登记到宿主的同进程共享表，供系统扩展消费。
	 * 这是与 callService 互补的通道：callService 走 structuredClone 只承载纯数据，
	 * expose 不序列化因而能承载带原型方法的对象。**仅同进程有效**。
	 *
	 * 方向约束：世界只拿写方。世界不获得"读取他人共享值"的能力，因此无法主动伸手
	 * 触及宿主内部——消费方一律是有 pi.shared 的系统扩展。
	 */
	expose?: (name: string, value: unknown) => () => void;
	/** 调用其他扩展注册的通用服务（可选通用能力） */
	callService?: <O = unknown>(name: string, input: unknown) => Promise<O>;
	/** 检查某通用服务是否已注册（可选通用能力） */
	hasService?: (name: string) => boolean;
}

/**
 * 世界暴露的活引用登记表。
 *
 * 由 world-framework 以 `WORLD_EXPOSED_SHARED_NAME` 为名登记进宿主同进程共享表，
 * 系统扩展通过 `pi.shared(WORLD_EXPOSED_SHARED_NAME)` 取得。世界自身**拿不到**该表，
 * 因此世界只能被消费、不能主动读取他人共享值。
 */
export interface WorldExposedRegistry {
	/** 当前所有已登记的共享名（按登记顺序，重复登记同名只保留首个）。 */
	names(): readonly string[];
	/** 按名取值；未登记返回 undefined。 */
	get(name: string): unknown;
	/** 订阅登记表变化（登记 / 注销 / 世界停用整体清理）。返回退订函数。 */
	subscribe(listener: () => void): () => void;
}

/** `WorldExposedRegistry` 在宿主同进程共享表中的登记名。 */
export const WORLD_EXPOSED_SHARED_NAME = "world-framework.exposed";

/**
 * 世界侧可观察的宿主事件子集：回合边界 + 输出流（含 thinking 通道）。
 * 刻意不收窄为"全部 RuntimeEvent"——世界只需知道自己与回合并行的时序事实。
 */
export const WORLD_HOST_EVENT_TYPES = [
	"turn_start",
	"output_update",
	"turn_end",
	"turn_aborted",
	"input_accepted",
	"input_settled",
	"agent_end",
	"agent_settled",
] as const;

/**
 * 世界静态契约定义（World Definition）
 */
export interface WorldDef {
	/** 唯一世界标识（如 "jukebox", "live2d"） */
	name: string;
	/** 世界描述，供大模型在 Tool 列表里判断何时使用 */
	description: string;

	/**
	 * 世界启动/启用时的钩子（可选）
	 * 适用场景：按需探测并拉起外部独立服务（如 api-enhanced, Python ASR/TTS 服务）
	 */
	onStart?: (ctx: ServiceCompanionContext) => Promise<void> | void;

	/**
	 * 世界停用/退出时的钩子（可选）
	 * 适用场景：清理并终止由本世界拉起的外部子进程，释放端口
	 */
	onStop?: (ctx: ServiceCompanionContext) => Promise<void> | void;

	/** 世界支持的查询与操作动作字典。 */
	actions: Record<string, ActionDef>;

	/**
	 * 每次模型请求前的瞬态观察正文（可选）。
	 *
	 * 与 onStart/onStop 的分工：那是生命周期，这是请求投影。返回值是给模型看的
	 * 有界正文（此刻世界的可读快照），框架把它包成瞬态观察帧追加在请求尾部：
	 * 不落 Session 历史、不产生 Subject 输入、不唤醒模型。返回 null 表示此刻无需注入。
	 *
	 * 实现必须**只读**：本方法在每次模型请求前运行（上下文检视也会触发），
	 * 不得消费事件、推进投递水位、启动 Run 或产生任何外部副作用。
	 * 状态快照失败时应返回"不可用"的明确正文，不得沿用上一次读到的值。
	 */
	requestContext?: () => Promise<string | null>;

	/**
	 * 工具执行模式声明（可选，默认 parallel）。
	 * 有内部串行状态的世界（如 QQ 的单写方操作日志）声明 sequential，
	 * 由 Broker 保证同一工具的调用不并发执行。
	 */
	executionMode?: "parallel" | "sequential";

	/** 默认启动配置（可选，默认 enabled: true） */
	defaultState?: {
		enabled?: boolean;
	};
}

/**
 * 世界运行时元数据（由框架维护，不涉及世界内部业务状态）
 */
export interface WorldRuntime {
	readonly definition: WorldDef;
	enabled: boolean;
}

export interface WorldEvent {
	receipt?: import("../../core/types.js").HostDeliveryTag;
	id: string;
	type: string;
	channel: "world";
	delivery?: "queued" | "urgent";
	/** 来源归属。来源事实事件用稳定去重 id；新生成机会用唯一 id，两者不得混用。 */
	origin: "external" | "internal";
	text?: string;
	render?: () => string | null | Promise<string | null>;
	data?: unknown;
}

/**
 * 事件提交结果——回答"这个事件现在还归不归我"。
 *
 * `accepted: true` 表示它**已经不属于世界**：进了主脑的待处理集合（持久化入队，或直接
 * 启动了一轮），或者已被宿主撤销。世界可以扔掉它，不再重试。
 *
 * `accepted: false` 表示它还在世界手里：世界已停用、宿主拒收、存储失败。`retryable`
 * 只说换一次再来是否有意义；重提必须用同一个 `id`——宿主按 id 去重，换 id 会变成两件事。
 *
 * 事件的展示文案（`text`）与延迟渲染（`render`）都可能很长、也可能在写出时已经过时，
 * 所以"提交成功"只保证这个事件被接管，不保证模型已经读过它。要确认模型处理过，看
 * 宿主侧的 `input_settled` 事实。
 */
export type EventSubmission = { accepted: true } | { accepted: false; reason: string; retryable: boolean };
