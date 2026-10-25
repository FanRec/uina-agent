/**
 * Client Host：连接生命周期、身份代次与客户端健康。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §3/§4。
 * 状态机 connecting → syncing → ready | disconnected | faulted；ready 不代表动作允许执行，
 * 实际准入还需 Owner/资格/Operation 检查（由 PlayerPort 与注入的核验接缝承担）。
 * Connection ref 每次新建客户端发放；Incarnation ref 在重生/跨维度/身体环境重建时更换（§4.2）。
 * 不自动重连、不自动重启旧游戏任务（§4.4）：重建 = 新 Connection，旧资格全部失效。
 */

import { protocolFor } from "./mineflayer/protocol.js";
import type { Ref } from "../contracts/values.js";
import {
	connectMinecraftClient,
	fromMineflayerVec3,
	type ClientOptions,
	type MineflayerBot,
} from "./mineflayer/adapter.js";

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
	| { kind: "disconnected"; facts: DisconnectFacts };

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
	 */
	async connect(opts: ClientOptions): Promise<void> {
		if (this._state === "connecting" || this._state === "syncing" || this._state === "ready") {
			throw new Error(`client host already ${this._state}; close first`);
		}
		const generation = ++this._attachGeneration;
		this._disconnect = null;
		this._lastDimension = null;
		this._connection = this.nextRef("conn");
		this._incarnation = this.nextRef("inc");
		this.setState("connecting");

		const bot = connectMinecraftClient(opts);
		this._bot = bot;
		protocolFor(bot);

		await new Promise<void>((resolve) => {
			const onReady = () => {
				if (generation !== this._attachGeneration) return;
				cleanup();
				// 重新同步维度快照后再 ready（spawn 时 bot.game.dimension 已可读）。
				this._lastDimension = bot.game.dimension ?? null;
				this.setState("ready");
				resolve();
			};
			const onSpawn = () => {
				if (generation !== this._attachGeneration) return;
				if (this._state !== "ready") return; // 首个 spawn 由 ready 路径处理
				const dim = bot.game.dimension ?? null;
				const dimensionChanged = dim != null && dim !== this._lastDimension;
				if (dim != null) this._lastDimension = dim;
				// Incarnation 只在死亡重生或跨维度时更换（§4.2）；
				// 同维度重复 spawn（位置同步）不构成身体环境重建。
				if (this._pendingRebirth || dimensionChanged) {
					this._pendingRebirth = false;
					this._incarnation = this.nextRef("inc");
					this.emit({ kind: "incarnation_changed", identity: this.identity! });
				}
			};
			const onDeath = () => {
				this._pendingRebirth = true;
			};
			const onLogin = () => {
				if (generation !== this._attachGeneration) return;
				if (this._state === "connecting") this.setState("syncing");
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
			};
			bot.on("login", onLogin);
			bot.on("spawn", onSpawn);
			bot.on("death", onDeath);
			bot.once("end", onEnd);
			bot.on("kicked", onKicked);
			bot.on("error", onError);
			bot.once("spawn", onReady);
		});
	}

	/** 主动断开：幂等；断开后旧身份永久失效。 */
	async close(): Promise<void> {
		const bot = this._bot;
		this._attachGeneration += 1;
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
		this.setState("disconnected");
		this.emit({ kind: "disconnected", facts: this._disconnect ?? { reason: "closed" } });
	}

	/** 当前维度名（ minecraft: 前缀已剥离）；未就绪为 null。 */
	get dimension(): string | null {
		return this._bot?.game.dimension ?? null;
	}

	/** 当前脚下位置快照；未就绪为 null。 */
	get position(): { x: number; y: number; z: number } | null {
		return fromMineflayerVec3(this._bot?.entity?.position);
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
