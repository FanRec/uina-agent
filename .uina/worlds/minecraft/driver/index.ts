/**
 * Driver 模块公共入口（实现；签名保持 lead 固定桩）。
 *
 * 职责：Mineflayer 私有客户端（经 ClientBot 接缝）、连接与身份代次、身体资格与写入隔离、
 * 连续/离散控制、高频反馈、当前事实采样（ClientFactsPort）、窗口会话。
 *
 * 边界：不依赖具体玩法能力、不依赖 Uina 接入层；只能 import ../contracts/ 与自己的子模块。
 * 真实 Mineflayer 依赖归 M5（lead 批准后接真实工厂）；当前切片经 options.botFactory
 * 注入替身客户端（driver/fake/），替身行为按固定上游源码建模。
 */

import type { BodySession, ControlOwner, PlayerPort } from "../contracts/body.js";
import type { ClientFactScope, ClientFactsPort } from "../contracts/client-facts.js";
import { CallFailureError } from "../contracts/errors.js";
import type { EffectReceipt, Fact, JsonValue, Ref } from "../contracts/values.js";
import { type BodyDeps, BodySessionImpl } from "./internal/body.js";
import type { ClientBot } from "./internal/bot-shape.js";
import { ClientHost } from "./internal/client-host.js";
import { defaultClock, type MonotonicClock } from "./internal/facts.js";
import { controlInvalid, sourceUnavailable } from "./internal/failure.js";
import { type HostCallVerifier, WriteGate } from "./internal/gate.js";

export interface DriverConfig {
	/** 服务器地址（连接位置，不是世界身份）。 */
	host: string;
	port: number;
	/** 协议版本；省略时由 Mineflayer 协商。 */
	version?: string;
	username: string;
	/** 本地测试可用 offline 验证模式。 */
	authMode?: "offline" | "microsoft";
}

export interface DriverOptions {
	/**
	 * 客户端工厂：M5 前由测试注入 FakeClientBot；M5 由组合根注入真实 Mineflayer 工厂。
	 * 省略且无真实工厂时明确失败，不制造假连接。
	 */
	botFactory?: (config: DriverConfig) => ClientBot;
	/** Runtime 调用身份核验接缝；M2/M3 Executor 接入时注入。 */
	verifier?: HostCallVerifier;
	clock?: MonotonicClock;
	/** 反馈传感器实现：确切查询 ref → 快速纯采样。组合根注入。 */
	sensors?: Record<string, (bot: ClientBot) => Fact<JsonValue>>;
	/** 可信运行期世界绑定；未提供时显式 unbound，不从连接地址推断。 */
	worldBinding?: { world: Ref; worldRevision: Ref };
	/** 物理步停滞检测（毫秒）。 */
	stallTimeoutMs?: number;
	/** 连接建立期限（毫秒）；默认 30s，超时按故障处理。 */
	attachTimeoutMs?: number;
	openTimeoutMs?: number;
	/** 反馈帧输入有效期（毫秒）；具体值由实测决定。 */
	feedbackValidityMs?: number;
}

export interface DriverHandle {
	/** 连接状态（connecting/syncing/ready/disconnected/faulted 的只读投影）。 */
	readonly connectionState: () => "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	/** 受控玩家端口：acquire 由运行管理调用。 */
	readonly player: PlayerPort;
	/** 当前客户端事实端口：由 World 订阅 + 采样。 */
	readonly facts: ClientFactsPort;
	/** 游戏聊天：不占身体、不参与身体调度。 */
	say(text: string, signal: AbortSignal): Promise<EffectReceipt>;
	close(): Promise<void>;
}

const SOURCE_REF = "uina.driver.client-facts";

class PlayerPortImpl implements PlayerPort {
	#queue: {
		owner: ControlOwner;
		signal: AbortSignal;
		resolve: (s: BodySession) => void;
		reject: (e: Error) => void;
		onAbort: () => void;
	}[] = [];
	#sessionDisposers = new Map<BodySessionImpl, () => void>();

	constructor(
		private readonly host: ClientHost,
		private readonly gate: WriteGate,
		private readonly deps: BodyDeps,
	) {}

	async acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession> {
		if (signal.aborted) throw controlInvalid("acquire 信号已取消");
		if (this.host.state !== "ready") {
			throw sourceUnavailable(`连接状态为 ${this.host.state}，不能取得身体资格`);
		}
		// gate 是资格唯一权威：permit 非空（active/revoking/quiesced）即需排队。
		if (!this.gate.permit && this.#queue.length === 0) {
			return this.#grant(owner, signal);
		}
		// FIFO：Runtime 未协调的并发申请排队；signal 取消移出队列。
		return new Promise<BodySession>((resolve, reject) => {
			const onAbort = () => {
				this.#queue = this.#queue.filter((e) => e.onAbort !== onAbort);
				reject(controlInvalid("排队中的 acquire 已取消"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#queue.push({ owner, signal, resolve, reject, onAbort });
		});
	}

	#grant(owner: ControlOwner, signal: AbortSignal): BodySession {
		const permit = this.gate.acquire(
			owner,
			this.host.identity.connection,
			this.host.identity.incarnation,
			`${this.host.identity.refs.next("body")}`,
		);
		let activeRef: BodySessionImpl;
		const session = new BodySessionImpl(this.deps, permit, this.gate, this.host.bot!, () => {
			void this.#settle(activeRef);
		});
		activeRef = session;
		// 组合注销：代次更替强制退役 + 清理 acquire 信号的 abort 监听（长生命周期信号不泄漏）。
		const onAbort = () => {
			void session.close();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const offRevokedSession = this.host.onRevoked(() => void session.close());
		this.#sessionDisposers.set(session, () => {
			offRevokedSession();
			signal.removeEventListener("abort", onAbort);
		});
		return session;
	}

	async #settle(settled: BodySessionImpl): Promise<void> {
		// 按具体会话清理登记（含 acquire 信号监听）；资格状态以 gate 为唯一权威。
		this.#sessionDisposers.get(settled)?.();
		this.#sessionDisposers.delete(settled);
		this.gate.settleRevoked();
		// 与 acquire 的准入一致：排队期间连接已不可用 → 明确拒绝整队，
		// 不把无法履行的资格发给等待者（bot 为空时发放会让后续写入指向空化身）。
		if (this.host.state !== "ready") {
			this.handleRevoked(`连接状态为 ${this.host.state}，排队中的身体申请被撤销`);
			return;
		}
		const next = this.#queue.shift();
		if (next) {
			next.signal.removeEventListener("abort", next.onAbort);
			try {
				const session = this.#grant(next.owner, next.signal);
				next.resolve(session);
			} catch (err) {
				next.reject(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	/**
	 * 排队申请结算：连接/化身代次更替或驱动关闭时明确拒绝，不让等待者悬挂
	 * （每项都摘掉自己的 abort 监听，长生命周期 signal 不泄漏）。
	 */
	handleRevoked(reason = "连接/化身代次更替，排队中的身体申请被撤销"): void {
		const queued = this.#queue;
		this.#queue = [];
		for (const e of queued) {
			e.signal.removeEventListener("abort", e.onAbort);
			e.reject(sourceUnavailable(reason));
		}
	}
}

export function createDriver(config: DriverConfig, options: DriverOptions = {}): DriverHandle {
	if (!options.botFactory) {
		// 明确失败，不制造假连接：真实 Mineflayer 依赖归 M5（lead 批准后接入）。
		throw new CallFailureError({
			code: "CALL_UNAVAILABLE",
			message: "真实 Mineflayer 客户端工厂未接入（M5，依赖待 lead 批准）；当前可经 options.botFactory 注入替身客户端",
		});
	}

	const clock = options.clock ?? defaultClock();
	const host = new ClientHost({
		clock,
		scopeProvider: {
			scope: (): ClientFactScope => {
				const dimension = host.bot?.self().dimension ?? null;
				if (!options.worldBinding) {
					// 显式 unbound：不凭地址推断存档身份。
					return { binding: "unbound", world: "unbound", worldRevision: "unbound", dimension };
				}
				return {
					binding: `${options.worldBinding.world}@${options.worldBinding.worldRevision}`,
					world: options.worldBinding.world,
					worldRevision: options.worldBinding.worldRevision,
					dimension,
				};
			},
			windowRefOf: (windowId) => host.windowRefOf(windowId),
			appearanceOf: (networkId) => host.appearanceOf(networkId),
		},
		sourceRef: SOURCE_REF,
		stallTimeoutMs: options.stallTimeoutMs ?? 2_000,
		attachTimeoutMs: options.attachTimeoutMs ?? 30_000,
	});

	const gate = new WriteGate(options.verifier);
	const deps: BodyDeps = {
		host,
		gate,
		clock,
		stallTimeoutMs: options.stallTimeoutMs ?? 2_000,
		openTimeoutMs: options.openTimeoutMs ?? 5_000,
		feedbackValidityMs: options.feedbackValidityMs ?? 250,
		sensors: new Map(Object.entries(options.sensors ?? {})),
	};

	const playerPort = new PlayerPortImpl(host, gate, deps);
	const offRevoked = host.onRevoked(() => {
		// 连接/化身代次更替：撤销全部资格与操作，清退排队申请。
		gate.revokeAll();
		playerPort.handleRevoked();
	});

	const handle: DriverHandle = {
		connectionState: () => host.state,
		player: playerPort,
		facts: host.facts,

		async say(text: string, signal: AbortSignal): Promise<EffectReceipt> {
			if (signal.aborted) throw controlInvalid("say 已取消");
			if (host.state !== "ready") throw sourceUnavailable(`连接状态为 ${host.state}，不能聊天`);
			if (typeof text !== "string" || text.length === 0) {
				throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "聊天文本须为非空字符串" });
			}
			// 聊天不占身体、不要求 Body Permit，但必须过停用准入：
			// 身体交接期拒绝 + 连接/化身身份核验 + 宿主调用归属核验（Runtime 接缝）。
			const effect = host.identity.refs.next("say");
			gate.admitEphemeralWrite("say", host.identity.connection, host.identity.incarnation, effect);
			host.bot!.chat(text);
			// chat 无本地可确认回执：sent ≠ 服务器已处理（driver.md §13），完成度如实 unknown。
			return { effect, dispatch: "sent", completion: "unknown", evidence: [] };
		},

		async close(): Promise<void> {
			// 先结算排队申请：host 的代次撤销回调在此后解除，不能指望它来清队列
			// （否则排队中的 acquire 永不结算，且其 abort 监听在长生命周期 signal 上泄漏）。
			playerPort.handleRevoked("驱动关闭，排队中的身体申请被撤销");
			offRevoked();
			await host.close();
		},
	};

	// 异步建连：ready 前的所有准入被状态检查拒绝。
	void (async () => {
		try {
			const bot = options.botFactory!(config);
			await host.attach(bot);
		} catch (err) {
			host.markFaulted(err instanceof Error ? err.message : String(err));
		}
	})();

	return handle;
}

export { FakeClientBot } from "./fake/fake-bot.js";
export type { ClientBot } from "./internal/bot-shape.js";
export type { JsonValue };
