import type { ToolExecutionResult } from "../../tools/broker.js";

/**
 * 上下文视口档位（Context Surface Budget）
 * - hidden: 0 Token，不出现在 Context 中
 * - ambient: ~10-20 Tokens，单行环境状态感知（如 [Jukebox: 正在播放《晴天》]）
 * - expanded: ~100-200 Tokens，完整状态数据与操作指南
 */
export type SurfaceTier = "hidden" | "ambient" | "expanded";

/**
 * 全局操作权威身份（OperationIdentity）
 * 格式：app:<appName>/<actionName>
 * 例如：app:jukebox/play, app:live2d/set_expression
 * 铁律：Facade 是视觉压缩，绝不是语义压缩；系统内部审计与拦截永远保留该身份。
 */
export type OperationIdentity = `app:${string}/${string}`;

/**
 * 操作上下文（注入给 Action 执行函数的上下文工具）
 */
export interface ActionContext {
	/**
	 * 主动切换本应用的视口档位
	 * 例如点歌成功后切换为 "ambient"（转入后台感知）
	 */
	setTier: (tier: SurfaceTier) => void;
	/**
	 * 获取当前应用的视口档位（"hidden" | "ambient" | "expanded"）
	 */
	getTier: () => SurfaceTier;
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
	/** 动作描述，展示在 Expanded 面板的操作指南中 */
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
	run: (params: TParams, ctx: ActionContext) => Promise<string | ToolExecutionResult> | string | ToolExecutionResult;
}

/**
 * 外部伴生服务上下文
 */
export interface ServiceCompanionContext {
	/** 取消信号（当宿主或应用关闭时触发） */
	signal: AbortSignal;
	/** 投递输入/机会至主脑信道（可选通用能力） */
	submitInput?: (input: import("../../agent/loop.js").AgentInput) => Promise<void>;
	/** 探测主脑是否忙碌（可选通用能力） */
	isBusy?: () => boolean;
	/** 应用数据目录（可选） */
	appDataDir?: string;
	/** 监听宿主通用活动事件（可选通用能力） */
	onActivity?: (listener: (event: { origin: "human" | "external" | "runtime" }) => void) => () => void;
	/**
	 * 订阅宿主事实事件流（可选通用能力）。
	 *
	 * 与 onActivity 的分工：onActivity 是"有人/有东西在动"的极简信号，事件类型已丢失；
	 * onHostEvent 保留 type 与 channel，供需要区分思考/输出/回合边界的应用使用。
	 * 事件按 RuntimeEvent 词汇只读投递，订阅方不得回写。
	 */
	onHostEvent?: (
		listener: (event: { readonly type: string; readonly channel?: string; readonly [key: string]: unknown }) => void,
	) => () => void;
	/**
	 * 同进程行为出口（可选通用能力）。
	 *
	 * 把应用内部**活引用**（对象/函数）登记到宿主的同进程共享表，供系统扩展消费。
	 * 这是与 callService 互补的通道：callService 走 structuredClone 只承载纯数据，
	 * expose 不序列化因而能承载带原型方法的对象。**仅同进程有效**。
	 *
	 * 方向约束：应用只拿写方。应用不获得"读取他人共享值"的能力，因此无法主动伸手
	 * 触及宿主内部——消费方一律是有 pi.shared 的系统扩展。
	 */
	expose?: (name: string, value: unknown) => () => void;
	/** 调用其他扩展注册的通用服务（可选通用能力） */
	callService?: <O = unknown>(name: string, input: unknown) => Promise<O>;
	/** 检查某通用服务是否已注册（可选通用能力） */
	hasService?: (name: string) => boolean;
}

/**
 * 应用暴露的活引用登记表。
 *
 * 由 app-framework 以 `APP_EXPOSED_SHARED_NAME` 为名登记进宿主同进程共享表，
 * 系统扩展通过 `pi.shared(APP_EXPOSED_SHARED_NAME)` 取得。应用自身**拿不到**该表，
 * 因此应用只能被消费、不能主动读取他人共享值。
 */
export interface AppExposedRegistry {
	/** 当前所有已登记的共享名（按登记顺序，重复登记同名只保留首个）。 */
	names(): readonly string[];
	/** 按名取值；未登记返回 undefined。 */
	get(name: string): unknown;
	/** 订阅登记表变化（登记 / 注销 / 应用停用整体清理）。返回退订函数。 */
	subscribe(listener: () => void): () => void;
}

/** `AppExposedRegistry` 在宿主同进程共享表中的登记名。 */
export const APP_EXPOSED_SHARED_NAME = "app-framework.exposed";

/**
 * 应用侧可观察的宿主事件子集：回合边界 + 输出流（含 thinking 通道）。
 * 刻意不收窄为"全部 RuntimeEvent"——应用只需知道自己与回合并行的时序事实。
 */
export const APP_HOST_EVENT_TYPES = ["turn_start", "output_update", "turn_end", "turn_aborted"] as const;

/**
 * 应用静态契约定义（App Definition）
 */
export interface AppDef {
	/** 唯一应用标识（如 "jukebox", "live2d"） */
	name: string;
	/** 应用桌面描述，供大模型在 Tool 列表里判断何时使用 */
	description: string;

	/**
	 * 应用启动/启用时的钩子（可选）
	 * 适用场景：按需探测并拉起外部独立服务（如 api-enhanced, Python ASR/TTS 服务）
	 */
	onStart?: (ctx: ServiceCompanionContext) => Promise<void> | void;

	/**
	 * 应用停用/退出时的钩子（可选）
	 * 适用场景：清理并终止由本应用拉起的外部子进程，释放端口
	 */
	onStop?: (ctx: ServiceCompanionContext) => Promise<void> | void;

	/**
	 * 视口渲染函数（纯函数，仅在 tier 为 ambient 或 expanded 时调用）
	 * 渲染结果作为 App-owned transient model context 注入（现网经 turn.prepare 的
	 * systemPrompt 进瞬态上下文，不落 Session）。框架以 [App: name] 帧界定各应用
	 * 渲染块——这是展示分隔，不是现成的 Prompt Injection 安全边界。
	 */
	render?: (tier: "ambient" | "expanded") => Promise<string> | string;

	/** 应用支持的子动作字典（框架会自动补充 close / ambient / help 内置动作） */
	actions: Record<string, ActionDef>;

	/** 默认启动配置（可选，默认 enabled: true, tier: "hidden"） */
	defaultState?: {
		enabled?: boolean;
		tier?: SurfaceTier;
	};
}

/**
 * 应用运行时元数据（由框架维护，不涉及应用内部业务状态）
 */
export interface AppRuntime {
	readonly definition: AppDef;
	enabled: boolean;
	surfaceTier: SurfaceTier;
	lastActiveTurn: number;
}
