/**
 * Client Host：连接生命周期、身份代次与客户端健康。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §3/§4。
 * 状态机 connecting → syncing → ready | disconnected | faulted；ready 不代表动作允许执行，
 * 实际准入还需 Owner/资格/Operation 检查（由 PlayerPort 与注入的核验接缝承担）。
 * Connection ref 每次新建客户端发放；Incarnation ref 在重生/跨维度/身体环境重建时更换（§4.2）。
 * 不自动重连、不自动重启旧游戏任务（§4.4）：重建 = 新 Connection，旧资格全部失效。
 */

import type {
	ClientPresentationPayload,
	ConnectionFactSink,
	LocalScreenActivity,
	ProtocolExtension,
} from "../contracts/protocol.js";
import type { Ref } from "../contracts/values.js";
import { trackVitals } from "./facts/vitals.js";
import {
	type ClientOptions,
	connectMinecraftClient,
	fromMineflayerVec3,
	type MineflayerBot,
} from "./mineflayer/adapter.js";
import { protocolFor } from "./mineflayer/protocol.js";
import { createConnectionPort, type DisposableConnectionPort } from "./protocol-extension.js";
import { fixToolTierMaterials } from "./mineflayer/upstream-fixes.js";

export type ConnectionState = "connecting" | "syncing" | "ready" | "disconnected" | "faulted";

export interface ClientIdentity {
	connection: Ref;
	incarnation: Ref;
}

export interface DisconnectFacts {
	/** 连接断开的真实原因；来自服务器 kick 消息或协议错误。 */
	reason: string | null;
}

export type ClientHostListener =
	| { kind: "state"; state: ConnectionState }
	| { kind: "incarnation_changed"; identity: ClientIdentity }
	| { kind: "incarnation_invalidated"; identity: ClientIdentity }
	| { kind: "disconnected"; facts: DisconnectFacts };

/** 连接级扩展：同一条连接的两个时机（见 contracts/protocol.ts）。 */
export interface ClientHostHooks {
	extensions?: readonly ProtocolExtension[];
	facts?: ConnectionFactSink;
}

/** 第三方返回值不能当类型已验：只接受 `{ channel: string, data: Uint8Array }`。 */
function isPresentationPayload(value: unknown): value is ClientPresentationPayload {
	if (value == null || typeof value !== "object") return false;
	const candidate = value as Partial<ClientPresentationPayload>;
	return typeof candidate.channel === "string" && candidate.data instanceof Uint8Array;
}

/** ref 前缀约定：driver 拥有 conn:/inc:/body:/op:/eff:/ev: 空间，各前缀独立单调发号。 */
function makeRefIssuer() {
	const counters = new Map<string, number>();
	return (prefix: string): Ref => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${prefix}:${next}`;
	};
}

export class ClientHost {
	private readonly nextRef = makeRefIssuer();
	private readonly listeners = new Set<(notice: ClientHostListener) => void>();
	private _state: ConnectionState = "disconnected";
	private _bot: MineflayerBot | null = null;
	private _connection: Ref | null = null;
	private _incarnation: Ref | null = null;
	private _disconnect: DisconnectFacts | null = null;
	private _lastDimension: string | null = null;
	private _attachGeneration = 0;
	/** death（respawn 包）后待重生：下一次 spawn 落位时换 Incarnation。 */
	private _pendingRebirth = false;
	private detachConnection: (() => void) | null = null;
	/** 本代连接的扩展订阅解除器（close 与断线共用）。 */
	private detachExtensions: (() => void) | null = null;
	/** 本代连接里带 localScreen 编码器的扩展；随连接退役一起清空。 */
	private _screenExtensions: { id: string; localScreen: NonNullable<ProtocolExtension["localScreen"]> }[] = [];

	get state(): ConnectionState {
		return this._state;
	}

	/** 连接就绪后的完整身份；未连接时为 null。 */
	get identity(): ClientIdentity | null {
		if (this._connection == null || this._incarnation == null) return null;
		return { connection: this._connection, incarnation: this._incarnation };
	}

	get disconnectFacts(): DisconnectFacts | null {
		return this._disconnect;
	}

	/** Driver 内部模块（facts/body/goto）经此取 Bot；不得逃逸出 Driver。 */
	get bot(): MineflayerBot | null {
		return this._bot;
	}

	on(listener: (notice: ClientHostListener) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 建立新连接。已有活跃连接时明确失败（重建须先 close，§4.4）。
	 * resolve 于 ready 或永久失败；不自动重试。
	 *
	 * hooks 是连接级协议扩展的唯一接入点：
	 * prepare 在建客户端之前运行（可覆盖版本或提供预先构造的 client）；
	 * attach 在建客户端之后立即运行（登录/配置阶段的包也能收到），
	 * 所有订阅随本代连接结束解除。
	 */
	async connect(opts: ClientOptions, hooks: ClientHostHooks = {}): Promise<void> {
		if (this._state === "connecting" || this._state === "syncing" || this._state === "ready") {
			throw new Error(`client host already ${this._state}; close first`);
		}
		const generation = ++this._attachGeneration;
		this._disconnect = null;
		this._lastDimension = null;
		this._pendingRebirth = false;
		this._connection = this.nextRef("conn");
		this._incarnation = this.nextRef("inc");
		this.setState("connecting");

		const extensions = hooks.extensions ?? [];
		const prepared = this.prepare(extensions, opts);
		const bot = connectMinecraftClient({
			...opts,
			...(prepared.version == null ? {} : { version: prepared.version }),
			...(prepared.client == null ? {} : { client: prepared.client }),
		});
		this._bot = bot;
		const protocol = protocolFor(bot);
		trackVitals(bot);
		const ports: DisposableConnectionPort[] = [];
		const detachExtensions = () => {
			for (const port of ports.splice(0)) port.dispose();
			this._screenExtensions = [];
		};
		this.detachExtensions = detachExtensions;
		try {
			this.attachExtensions(extensions, bot, protocol, hooks, generation, ports);
		} catch (error) {
			detachExtensions();
			this.detachExtensions = null;
			this._bot = null;
			this.setState("faulted");
			throw error;
		}

		await new Promise<void>((resolve) => {
			const onSpawn = () => {
				if (generation !== this._attachGeneration) return;
				const dim = bot.game.dimension ?? null;
				const dimensionChanged = this._lastDimension != null && dim != null && dim !== this._lastDimension;
				if (dim != null) this._lastDimension = dim;
				// Incarnation 只在死亡重生或跨维度时更换（§4.2）；
				// 同维度重复 spawn（位置同步）不构成身体环境重建。
				if (this._pendingRebirth || dimensionChanged) {
					this._pendingRebirth = false;
					this._incarnation = this.nextRef("inc");
					this.emit({ kind: "incarnation_changed", identity: this.identity! });
				}
				this.setState("ready");
				resolve();
			};
			const onDeath = () => {
				if (generation !== this._attachGeneration) return;
				this._pendingRebirth = true;
				this.setState("syncing");
				this.emit({ kind: "incarnation_invalidated", identity: this.identity! });
			};
			const onLogin = () => {
				if (generation !== this._attachGeneration) return;
				if (this._state === "connecting") this.setState("syncing");
				// registry 在 loader 的 connect_allowed 之后才就绪（mineflayer loader.js:119），
				// login 时必然可用；挖速表数据修正每个 bot 一次（1.21.11 incorrect_for_* 缺陷，
				// 见 upstream-fixes.ts）。
				fixToolTierMaterials(bot.registry);
			};
			const onEnd = () => {
				if (generation !== this._attachGeneration) return;
				cleanup();
				this._bot = null;
				this.setState("disconnected");
				this.emit({ kind: "disconnected", facts: this._disconnect ?? { reason: null } });
				resolve();
			};
			const onKicked = (reason: string) => {
				this._disconnect = { reason };
			};
			const onError = (err: Error) => {
				if (generation !== this._attachGeneration) return;
				// 连接建立前的协议错误是永久失败；ready 后的错误多数可由断线事件收口。
				this._disconnect = { reason: err.message };
				if (this._state !== "ready") {
					cleanup();
					this._bot = null;
					this.setState("faulted");
					this.emit({ kind: "disconnected", facts: this._disconnect });
					resolve();
				}
			};
			const cleanup = () => {
				bot.removeListener("login", onLogin);
				bot.removeListener("spawn", onSpawn);
				bot.removeListener("death", onDeath);
				bot.removeListener("end", onEnd);
				bot.removeListener("kicked", onKicked);
				bot.removeListener("error", onError);
				// 连接级扩展的订阅与连接同生共死：旧代回调不得进入下一代。
				detachExtensions();
				if (this.detachConnection === cleanup) this.detachConnection = null;
			};
			this.detachConnection = cleanup;
			bot.on("login", onLogin);
			bot.on("spawn", onSpawn);
			bot.on("death", onDeath);
			bot.once("end", onEnd);
			bot.on("kicked", onKicked);
			bot.on("error", onError);
		});
	}

	/** 主动断开：幂等；断开后旧身份永久失效。 */
	async close(): Promise<void> {
		const bot = this._bot;
		this._attachGeneration += 1;
		this.detachConnection?.();
		this.detachExtensions?.();
		this.detachExtensions = null;
		if (bot == null) {
			if (this._state !== "disconnected" && this._state !== "faulted") this.setState("disconnected");
			return;
		}
		this._bot = null;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 2000);
			bot.once("end", () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				bot.quit();
			} catch {
				clearTimeout(timer);
				resolve();
			}
		});
		// 主动关闭也是断线事实：给出真实原因，FactsSource 的断线捕获按字段读取。
		if (this._disconnect == null) this._disconnect = { reason: "closed" };
		this.setState("disconnected");
		this.emit({ kind: "disconnected", facts: this._disconnect });
	}

	/**
	 * 派发一次本地界面展示事件（Driver 内部入口，只在真实个人背包事务期间调用）。
	 *
	 * 三条边界：
	 * - 身份：连接/化身必须与事件一致且连接 ready；否则丢弃，绝不向新连接重放旧事件。
	 * - 顺序：同步编码、同步写入，与随后的原版窗口包保持确定顺序；不排队、不 await。
	 * - 隔离：单个包的编码/发送失败只记录诊断，不影响游戏物品事务的真实结果。
	 *
	 * 返回 true 表示至少一个 Payload 已提交给协议层——这只是"发出去了"，
	 * 没有服务端 ACK 时不能据此宣称观察者真的看到了界面。
	 */
	emitLocalScreen(event: Readonly<LocalScreenActivity>): boolean {
		const bot = this._bot;
		const identity = this.identity;
		if (bot == null || identity == null || this._state !== "ready") return false;
		if (identity.connection !== event.connection || identity.incarnation !== event.incarnation) return false;
		if (this._screenExtensions.length === 0) return false;
		const protocol = protocolFor(bot);
		let sent = false;
		for (const extension of this._screenExtensions) {
			let payload: ClientPresentationPayload | null;
			try {
				payload = extension.localScreen(event) ?? null;
			} catch (error) {
				console.warn(`[mc-addon:${extension.id}] localScreen(${event.phase}) failed: ${String(error)}`);
				continue;
			}
			if (payload == null) continue;
			if (!isPresentationPayload(payload)) {
				console.warn(`[mc-addon:${extension.id}] localScreen(${event.phase}) returned a malformed payload`);
				continue;
			}
			try {
				protocol.customPayload(payload.channel, payload.data);
				sent = true;
			} catch (error) {
				console.warn(`[mc-addon:${extension.id}] localScreen(${event.phase}) was not sent: ${String(error)}`);
			}
		}
		return sent;
	}

	/** 当前维度名（ minecraft: 前缀已剥离）；未就绪为 null。 */
	get dimension(): string | null {
		return this._bot?.game.dimension ?? null;
	}

	/** 当前脚下位置快照；未就绪为 null。 */
	get position(): { x: number; y: number; z: number } | null {
		return fromMineflayerVec3(this._bot?.entity?.position);
	}

	/**
	 * 连接前协议准备：版本覆盖与预先构造的 client 都只允许一个来源。
	 * 冲突不按加载顺序取胜——两个包同时提供 client 就是无法解释的装配。
	 */
	private prepare(
		extensions: readonly ProtocolExtension[],
		opts: ClientOptions,
	): { version?: string; client?: unknown } {
		const prepared: { version?: string; client?: unknown } = {};
		let clientOwner: string | null = null;
		for (const extension of extensions) {
			if (extension.prepare == null) continue;
			const result =
				extension.prepare({
					minecraftVersion: opts.version ?? "unknown",
					host: opts.host,
					port: opts.port,
					username: opts.username,
				}) ?? {};
			if (result.version != null) {
				if (prepared.version != null && prepared.version !== result.version)
					throw new Error(
						`addons disagree on protocol version: ${prepared.version} vs ${result.version} (${extension.id})`,
					);
				prepared.version = result.version;
			}
			if (result.client != null) {
				if (clientOwner != null)
					throw new Error(`two addons supplied a protocol client: ${clientOwner} and ${extension.id}`);
				clientOwner = extension.id;
				prepared.client = result.client;
			}
		}
		return prepared;
	}

	/** 建客户端之后立即挂接：登录/配置阶段的包也能收到，所有订阅随本代连接解除。 */
	private attachExtensions(
		extensions: readonly ProtocolExtension[],
		bot: MineflayerBot,
		protocol: ReturnType<typeof protocolFor>,
		hooks: ClientHostHooks,
		generation: number,
		ports: DisposableConnectionPort[],
	): void {
		const sink: ConnectionFactSink = hooks.facts ?? {
			publishAddonFact: () => {
				throw new Error("connection fact sink is not bound; addon facts would be silently lost");
			},
		};
		// 纯编码器只在当前连接有效；不持有连接对象，也不获得任何写权限。
		this._screenExtensions = extensions.flatMap((extension) =>
			extension.localScreen == null ? [] : [{ id: extension.id, localScreen: extension.localScreen }],
		);
		for (const extension of extensions) {
			if (extension.attach == null) continue;
			const port = createConnectionPort({
				addonId: extension.id,
				host: this,
				bot,
				protocol,
				facts: sink,
				isCurrent: () => generation === this._attachGeneration,
			});
			ports.push(port);
			const disposer = extension.attach(port);
			if (typeof disposer === "function") port.defer(disposer);
		}
	}

	private setState(state: ConnectionState): void {
		if (this._state === state) return;
		this._state = state;
		this.emit({ kind: "state", state });
	}

	private emit(notice: ClientHostListener): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(notice);
			} catch {
				// 监听器异常不传播到连接生命周期；Driver 不因观察者崩溃失控。
			}
		}
	}
}
