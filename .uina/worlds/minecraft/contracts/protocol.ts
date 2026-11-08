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

/** 组合根注入的贡献；id 必须等于 addon id。 */
export interface ProtocolExtension {
	id: string;
	prepare?(ctx: ProtocolPrepareContext): PreparedProtocol | void;
	attach?(ctx: ConnectionPort): void | (() => void);
}

/** ClientHost 发布事实所需的最小口子（由 FactsSource 实现）。 */
export interface ConnectionFactSink {
	publishAddonFact(addonId: string, key: string, value: JsonValue, unknown?: string[]): void;
}
