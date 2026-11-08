/**
 * Uina Minecraft Addon SDK：第三方包的**类型契约**（api 1）。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3。这里只有贡献面：
 * Addon 不拥有执行层，也不能创建 Runtime/World/Loop。动作走现有 NativeCallable，
 * 查询走现有 QueryDescriptor + QueryReader，连接级协议走 prepare/attach 两个时机，
 * 事实走 FactsSource 的连接绑定发布口。
 *
 * 运行时安全边界：
 * - `attach` 只拿到只读 ConnectionPort（订阅包、发布事实），**没有**裸 bot/socket；
 * - 游戏写入必须由动作在 Runtime 授权的 BodyScope 内使用 `scope.protocol.send`，
 *   不在 attach 时预先取得身体或写权限；
 * - `prepare` 可以覆盖协议版本或提供预先构造的 minecraft-protocol client（早期握手），
 *   但实现必须真实可用，不支持时由 Driver 明确报 UNSUPPORTED_PROTOCOL。
 *
 * 失败结算契约：动作抛出 `name === "CallFailure"` 且带字符串 `code` 的错误时，
 * Runtime 按 `dispatch` / `effects` / `recoverable` 原样结算；其它抛出按
 * INTERNAL/not_sent 处理。纯 JS 包不需要导入运行时库，但必须满足这个形状
 * （见 examples/addons/example-mod/index.js）。
 */

import type { NativeCallable, QueryDescriptor, QueryReader } from "../contracts/capabilities.js";
import type { ConnectionPort, PreparedProtocol, ProtocolPrepareContext } from "../contracts/protocol.js";
import type { JsonValue } from "../contracts/values.js";

/** 连接级端口与准备入参由 contracts/protocol.ts 定义，SDK 只做公开再导出。 */
export type { ConnectionPort, PreparedProtocol, ProtocolPrepareContext };

/** manifest 与模块导出的 API 版本；不匹配即拒绝装配。 */
export const ADDON_API_VERSION = 1 as const;

export interface AddonLogger {
	info(message: string, detail?: JsonValue): void;
	warn(message: string, detail?: JsonValue): void;
	error(message: string, detail?: JsonValue): void;
}

export interface ClientContribution {
	prepare?(ctx: ProtocolPrepareContext): PreparedProtocol | void;
	attach?(ctx: ConnectionPort): void | (() => void);
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
