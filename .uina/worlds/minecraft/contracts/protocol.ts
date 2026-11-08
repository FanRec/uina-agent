/**
 * 连接级协议扩展契约（Addon ↔ Driver 的唯一接缝）。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3.2、modules/driver.md §3.1。
 * 两种接入时机是**同一条连接**的两个阶段，不是两个运行时：
 * - prepare：客户端创建前，可覆盖协议版本或提供预先构造的 minecraft-protocol client；
 * - attach：客户端已创建（登录/配置/Play 阶段包都会到达），只读订阅 + 事实发布。
 *
 * 写入不在这个端口上：改变服务器世界的 Payload 必须由动作在 Runtime 授权的
 * BodyScope 内经 `CallContext.protocol`（ProtocolWritePort）发出。
 */

import type { JsonValue, Ref } from "./values.js";

export interface ProtocolPrepareContext {
	readonly minecraftVersion: string;
	readonly host: string;
	readonly port: number;
	readonly username: string;
}

export interface PreparedProtocol {
	/** 覆盖本次连接的协议版本（缺省用 settings/identity 里的版本）。 */
	version?: string;
	/** 预先构造的 minecraft-protocol client（由调用方 import 并构造）。 */
	client?: unknown;
}

export interface ConnectionPort {
	readonly addonId: string;
	readonly connection: Ref;
	/** 当前身体代次；重生/跨维度后变化，未就绪为 null。 */
	readonly incarnation: Ref | null;
	readonly version: string;
	state(): "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	/** 原始 clientbound 包订阅；name 是协议包名（如 "custom_payload"）。 */
	onPacket(name: string, handler: (payload: unknown) => void): () => void;
	/** 自定义通道订阅：只回调 channel 匹配的 custom_payload 原始字节。 */
	onCustomPayload(channel: string, handler: (data: Uint8Array) => void): () => void;
	/** 少量连接事件；不做第二套事件总线。 */
	onEvent(name: "spawn" | "death" | "end", handler: () => void): () => void;
	/** 发布本连接的模组事实；断线清空，旧连接迟到的发布被丢弃。 */
	publishFact(key: string, value: JsonValue, unknown?: string[]): void;
}

/**
 * 本地界面活动：Uina 自己的窗口事务边界，不含任何第三方协议知识。
 *
 * 只描述"个人背包正在被操作"这一 Minecraft 通用事实。真实方块/实体窗口走原版
 * 协议，由服务端自行观察，**不经过**这个事件（否则会和上游镜像互相覆盖）。
 */
export interface LocalScreenActivity {
	kind: "player_inventory";
	phase: "open" | "close";
	/** 同一次 withInventoryScope 的稳定引用；一次事务最多一对 open/close。 */
	session: Ref;
	connection: Ref;
	incarnation: Ref;
}

/** Addon 的纯编码结果：只说"要发什么"，不含发送能力。 */
export interface ClientPresentationPayload {
	channel: string;
	data: Uint8Array;
}

/** 组合根注入的贡献；id 必须等于 addon id。 */
export interface ProtocolExtension {
	id: string;
	prepare?(ctx: ProtocolPrepareContext): PreparedProtocol | void;
	attach?(ctx: ConnectionPort): void | (() => void);
	/**
	 * 纯同步映射，无写权限：只把本地界面活动编码成 Payload，实际派发由 Driver 完成。
	 * 不允许异步、不允许持有连接对象；返回 null 表示本包对这次事件无话可说。
	 */
	localScreen?(event: Readonly<LocalScreenActivity>): ClientPresentationPayload | null;
}

/** ClientHost 发布事实所需的最小口子（由 FactsSource 实现）。 */
export interface ConnectionFactSink {
	publishAddonFact(addonId: string, key: string, value: JsonValue, unknown?: string[]): void;
}
