/**
 * 连接级协议扩展契约（Addon ↔ Driver 的唯一接缝）。
 *
 * 一条连接只有一个 minecraft-protocol Client，由 Driver 创建、连接与释放：
 * - install：预连接阶段。Client 已构造、Socket 尚未连接，所有贡献在这个阶段同步
 *   注册包处理器、阶段回复和通道声明；放行连接前统一检查资源冲突。
 * - attach：同一条连接上的只读订阅 + 事实发布；沿用 ConnectionPort。
 * - localScreen：本地界面活动的纯编码器，由 Driver 同步派发。
 *
 * 阶段区分（Play 阶段不能用协议端口改变世界）：
 * - Login / Configuration 的握手回复走 PhaseContext，是连接级协议动作，不需要 Body；
 * - Play 阶段改变世界/物品的自定义 Payload 必须由动作在 Runtime 授权的 BodyScope 内
 *   经 `CallContext.protocol`（ProtocolWritePort）发出；
 * - Play 阶段的展示镜像（localScreen）是展示行为，不要求模型调用额外工具。
 */

import type { Fact, JsonValue, Ref } from "./values.js";

export type ProtocolPhase = "login" | "configuration" | "play";

export interface RecoveryIdentity {
	readonly world: string;
	readonly dimension: string;
}

/** Registry evidence for 64-stack items and opaque, non-luminous single-state cubes. */
export interface ConnectionRegistry {
	readonly world: string;
	readonly items: readonly { name: string; id: number }[];
	readonly solidBlocks: readonly { name: string; id: number; stateId: number; hardness: number }[];
	readonly synchronizedIds: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Addon 事实的作用域：换代即失效（身体相关） / 保留到本连接断开（服务器范围状态）。 */
export type AddonFactScope = "connection" | "incarnation";

/** 采集事件来源身份：在事件到达时定稿，不是发布时临时读取当前身份。 */
export interface AddonFactOrigin {
	readonly connection: Ref;
	readonly incarnation: Ref;
}

/** Addon 发布事实时必须显式给出的原始证据说明，不给默认来源。 */
export interface AddonFactPublicationOptions {
	readonly scope: AddonFactScope;
	/** 解码服务端包 = server；addon 自行推算/置未知 = derived。 */
	readonly source: "server" | "derived";
	readonly unknown?: string[];
}

/** 进入 FactsSource 的完整发布：来源身份由 ConnectionPort 在事件回调边界补上。 */
export interface AddonFactPublication extends AddonFactPublicationOptions {
	readonly origin: AddonFactOrigin;
}

/** FactsSource 内存中的一条 Addon 事实；Fact 保持公共形状，作用域单独留档。 */
export interface AddonFactEntry {
	readonly fact: Fact<JsonValue>;
	readonly scope: AddonFactScope;
	readonly origin: AddonFactOrigin;
}

/** 握手阶段上下文：每次包回调给出，只允许回复当前阶段与当前连接。 */
export interface PhaseContext {
	readonly phase: ProtocolPhase;
	readonly connection: Ref;
	/** 回复当前阶段的协议包（Login QueryResponse / Configuration ACK）。 */
	replyPacket(packetName: string, packet: unknown): void;
	/** 回复当前阶段的 custom payload；只允许 configuration 阶段。 */
	replyPayload(channel: string, data: Uint8Array): void;
	/** Configuration-only. The contributing Addon must claim connection-registry. */
	installRegistry(registry: ConnectionRegistry): void;
}

/**
 * 预连接阶段的组合端口。所有方法都是纯同步注册，网络尚未开始；
 * 不允许在这里触发游戏操作，也不存在第二个 Client。
 */
export interface ProtocolBootstrap {
	readonly minecraftVersion: string;
	readonly connection: Ref;
	/** 订阅指定阶段的 clientbound 包；同一 (phase, name) 允许多个订阅者。 */
	onPacket(phase: ProtocolPhase, name: string, handler: (packet: unknown, ctx: PhaseContext) => void): void;
	/** 订阅指定阶段的自定义通道；订阅即声明接收，普通通道允许多个订阅者。 */
	onPayload(
		phase: "configuration" | "play",
		channel: string,
		handler: (data: Uint8Array, ctx: PhaseContext) => void,
	): void;
	/**
	 * 声明本连接在该阶段愿意接收某通道；play 阶段经真实的 minecraft:register 告知服务端。
	 * configuration 阶段没有这个原版包，Driver 不伪造协商：具体加载器用自己的
	 * onPayload/replyPayload 完成通道交换。
	 */
	declareReceive(phase: "configuration" | "play", channel: string): void;
	/**
	 * 独占声明一个协议资源。同一 (phase, resource) 只能有一个 Owner；
	 * 第二个包声明时立即以 ADDON_PROTOCOL_CONFLICT 失败，不按装载顺序覆盖。
	 */
	claim(phase: ProtocolPhase | "preconnect", resource: string): void;
	/**
	 * 受信任底层协议插件：只在预连接阶段接触同一个 Client 的协议底座
	 * （FML 之类的网络底层扩展）。隐含 claim("preconnect", name)。
	 * 这不是普通 Addon 的写入捷径，也不开放第二个 Client。
	 */
	installLowLevel(name: string, install: (client: unknown) => void | (() => void)): void;
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
	/**
	 * 发布本连接的模组事实。只能在采集事件回调内调用（来源身份由回调边界捕获）；
	 * scope 与 source 必须由原始证据确定。断线清空，旧连接/换代后的迟到发布被拒绝。
	 */
	publishFact(key: string, value: JsonValue, publication: AddonFactPublicationOptions): void;
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
	/** 预连接阶段同步装配协议处理器；没有早期协议需求的包可以不提供。 */
	install?(boot: ProtocolBootstrap): void;
	attach?(ctx: ConnectionPort): void | (() => void);
	/**
	 * 纯同步映射，无写权限：只把本地界面活动编码成 Payload，实际派发由 Driver 完成。
	 * 不允许异步、不允许持有连接对象；返回 null 表示本包对这次事件无话可说。
	 */
	localScreen?(event: Readonly<LocalScreenActivity>): ClientPresentationPayload | null;
}

/** ClientHost 发布事实所需的最小口子（由 FactsSource 实现）。 */
export interface ConnectionFactSink {
	publishAddonFact(addonId: string, key: string, value: JsonValue, publication: AddonFactPublication): void;
}
