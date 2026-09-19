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
}

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
	 * 框架会将不可信应用数据结构化包裹，防范 Prompt Injection
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
