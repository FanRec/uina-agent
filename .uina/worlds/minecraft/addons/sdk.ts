/**
 * Uina Minecraft Addon SDK：第三方包的**类型契约**（api 1）。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3。这里只有贡献面：
 * Addon 不拥有执行层，也不能创建 Runtime/World/Loop。动作走现有 NativeCallable，
 * 查询走现有 QueryDescriptor + QueryReader，连接级协议走 install/attach/localScreen
 * 三个贡献时机，事实走 FactsSource 的连接绑定发布口（按采集身份与作用域验证）。
 *
 * 运行时安全边界：
 * - `install` 在网络尚未开始时同步注册包处理器、阶段回复与通道声明；一条连接只有
 *   一个由 Driver 创建、连接和释放的 Client，Addon 拿不到裸 Client 也不能替换它；
 * - `attach` 只拿到只读 ConnectionPort（订阅包、发布事实）；
 * - 游戏写入必须由动作在 Runtime 授权的 BodyScope 内使用 `scope.protocol.send`，
 *   不在 attach 时预先取得身体或写权限；
 * - Login / Configuration 的握手回复走 `PhaseContext`，是连接级协议动作，
 *   不是游戏 Effect；Play 阶段改变世界的 Payload 不走这条路径。
 *
 * 失败结算契约：动作抛出 `name === "CallFailure"` 且带字符串 `code` 的错误时，
 * Runtime 按 `dispatch` / `effects` / `recoverable` 原样结算；其它抛出按
 * INTERNAL/not_sent 处理。纯 JS 包不需要导入运行时库，但必须满足这个形状
 * （见 examples/addons/example-mod/index.js）。
 */

import type { NativeCallable, QueryDescriptor, QueryReader } from "../contracts/capabilities.js";
import type {
	AddonFactOrigin,
	AddonFactPublicationOptions,
	AddonFactScope,
	ClientPresentationPayload,
	ConnectionPort,
	LocalScreenActivity,
	PhaseContext,
	ProtocolBootstrap,
	ProtocolPhase,
} from "../contracts/protocol.js";
import type { JsonValue } from "../contracts/values.js";

/** 连接级端口与装配端口由 contracts/protocol.ts 定义，SDK 只做公开再导出。 */
export type {
	AddonFactOrigin,
	AddonFactPublicationOptions,
	AddonFactScope,
	ClientPresentationPayload,
	ConnectionPort,
	LocalScreenActivity,
	PhaseContext,
	ProtocolBootstrap,
	ProtocolPhase,
};

/** manifest 与模块导出的 API 版本；不匹配即拒绝装配。 */
export const ADDON_API_VERSION = 1 as const;

export interface AddonLogger {
	info(message: string, detail?: JsonValue): void;
	warn(message: string, detail?: JsonValue): void;
	error(message: string, detail?: JsonValue): void;
}

export interface ClientContribution {
	/**
	 * 预连接阶段同步装配协议贡献；此时 Socket 尚未连接，注册的动作全部在首包前就绪。
	 * 冲突用 `boot.claim()` 显式声明，不按装载顺序覆盖。没有早期协议需求的包可以不提供。
	 */
	install?(boot: ProtocolBootstrap): void;
	attach?(ctx: ConnectionPort): void | (() => void);
	/**
	 * 本地界面活动的纯编码器（可选）。只返回 Payload，不发送、不持有连接；
	 * 与 attach 互不依赖：只做协议转换的包不需要订阅任何包。
	 */
	localScreen?(event: Readonly<LocalScreenActivity>): ClientPresentationPayload | null;
}

/** 包内静态知识：只声明可确证的身份字段，其余来源保持未知。 */
export interface AddonKnowledgeItem {
	/** 必须是 `namespace:path`；与原版简名冲突时以注册表为准并记录冲突。 */
	name: string;
	displayName: string;
	stackSize: number;
	placeAs?: string | null;
}

export interface KnowledgeContribution {
	items?: readonly AddonKnowledgeItem[];
}

export interface AddonQuery {
	descriptor: QueryDescriptor;
	reader: QueryReader;
}

export interface AddonContribution {
	/** 与内置动作共用 ref 唯一性校验；ref 必须以 `<id>.` 开头。 */
	actions?: readonly NativeCallable<JsonValue, JsonValue>[];
	queries?: readonly AddonQuery[];
	knowledge?: KnowledgeContribution;
	client?: ClientContribution;
	close?(): void | Promise<void>;
}

export interface AddonSetupContext {
	/** Profile `addons.json` 中该包的配置值；缺省为 {}。 */
	config: JsonValue;
	minecraftVersion: string;
	logger: AddonLogger;
}

/** 包入口的默认导出形状。 */
export interface AddonDefinition {
	readonly api: 1;
	readonly id: string;
	create(ctx: AddonSetupContext): AddonContribution | Promise<AddonContribution>;
}
