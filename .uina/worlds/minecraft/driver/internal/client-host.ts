/**
 * Client Host：Bot、连接状态、身份代次、物理步计数与事件接线。
 *
 * 设计依据 modules/driver.md §4：
 * - 连接状态：connecting → syncing → ready；断开 → disconnected；控制正确性无法保证 → faulted。
 * - 连接/化身代次更替必须使相应旧引用失效：撤销资格、失效事实覆盖、清登记。
 * - 物理步：每个实际消费步只计一次——只计实际模拟后的 physicsTick
 *   （physics.js L84-96：不可模拟路径不 emit physicsTick；tick_end 包不计数）。
 * - 实体出现代次：同一网络 ID 的每次出现分配新 appearance，防止指向错误实体。
 */

import type { Ref } from "../../contracts/values.js";
import type { ClientBot } from "./bot-shape.js";
import { Identity, RefGenerator } from "./identity.js";
import { ClientFactsSource, type FactScopeProvider, type MonotonicClock } from "./facts.js";

export type ConnectionState = "connecting" | "syncing" | "ready" | "disconnected" | "faulted";

export interface PhysicsStep {
	connection: Ref;
	incarnation: Ref;
	sequence: number;
}

export type StepListener = (step: PhysicsStep) => void;

export interface ClientHostDeps {
	clock: MonotonicClock;
	scopeProvider: FactScopeProvider;
	sourceRef: Ref;
	/** 物理步停滞的墙钟检测窗口（毫秒）。 */
	stallTimeoutMs: number;
}

export class ClientHost {
	readonly identity = new Identity();
	readonly windowRefs = new RefGenerator(this.identity.refs.next("wgen"));
	readonly facts: ClientFactsSource;

	#state: ConnectionState = "connecting";
	#bot: ClientBot | null = null;
	#stepCounter = 0;
	#stepListeners = new Set<StepListener>();
	/** 协议窗口 ID → Driver 窗口 ref。 */
	readonly windowRegistry = new Map<number, Ref>();
	/** 网络 ID → 当前出现代次。 */
	readonly #appearances = new Map<number, Ref>();
	#disposers: (() => void)[] = [];
	#faultReason: string | null = null;
	/** 同一客户端只允许一个在途窗口打开（modules/driver.md §12.2）。 */
	openingInProgress = false;
	/** 死亡后等待重生：重生时建立新化身。 */
	#awaitingRespawn = false;

	constructor(deps: ClientHostDeps) {
		this.facts = new ClientFactsSource({
			bot: null as unknown as ClientBot,
			scopeProvider: deps.scopeProvider,
			clock: deps.clock,
			sourceRef: deps.sourceRef,
		});
		this.facts.setIdentity(this.identity.connection, this.identity.incarnation);
	}

	get state(): ConnectionState {
		return this.#state;
	}

	get faultReason(): string | null {
		return this.#faultReason;
	}

	get bot(): ClientBot | null {
		return this.#bot;
	}

	get physicsStep(): PhysicsStep {
		return {
			connection: this.identity.connection,
			incarnation: this.identity.incarnation,
			sequence: this.#stepCounter,
		};
	}

	onPhysicsStep(listener: StepListener): () => void {
		this.#stepListeners.add(listener);
		return () => this.#stepListeners.delete(listener);
	}

	// ---- 连接 ----

	/** 接管新 bot 并接线；解析时达到 ready。 */
	async attach(bot: ClientBot): Promise<void> {
		this.#bot = bot;
		this.#state = "syncing";
		this.facts.deps.bot = bot;
		this.#wire(bot);
		// 真实 Mineflayer：spawn 事件表示玩家/世界状态就绪（syncing → ready）。
		await new Promise<void>((resolve, reject) => {
			const offSpawn = bot.on("spawn", () => {
				cleanup();
				this.#state = "ready";
				resolve();
			});
			const offEnd = bot.on("end", (reason) => {
				cleanup();
				reject(new Error(`connection ended before spawn: ${reason}`));
			});
			const offError = bot.on("error", (err) => {
				cleanup();
				reject(err);
			});
			const cleanup = () => {
				offSpawn();
				offEnd();
				offError();
			};
		});
	}

	#wire(bot: ClientBot): void {
		this.#disposers.push(
			bot.on("physicsTick", () => this.#onPhysicsTick()),
			bot.on("end", (reason) => this.#onDisconnected(reason)),
			bot.on("kicked", (reason) => this.#onDisconnected(reason)),
			bot.on("error", () => {
				// 错误本身不断开；真实断开由 end/kicked 通知。记录为可观测故障。
			}),
			bot.on("death", () => this.#onDeath()),
			bot.on("spawn", () => this.#onSpawn()),
			bot.on("entitySpawn", () => {
				this.facts.commitEntitiesChanged();
			}),
			bot.on("entityGone", (entity) => this.#onEntityGone(entity)),
			bot.on("blockUpdate", () => this.facts.commitBlockChanged()),
			bot.on("health", () => this.facts.commitSelfChanged()),
			bot.on("setSlot", () => {
				this.facts.commitInventoryChanged();
				this.facts.commitWindowChanged();
			}),
			bot.on("windowOpen", (w) => {
				this.facts.commitWindowChanged();
				void w;
			}),
			bot.on("windowClose", () => {
				this.facts.commitWindowChanged();
			}),
		);
	}

	#onPhysicsTick(): void {
		if (this.#state !== "ready") return;
		this.#stepCounter += 1;
		const step = this.physicsStep;
		for (const l of [...this.#stepListeners]) {
			try {
				l(step);
			} catch {
				// 步进监听者异常不中断物理循环。
			}
		}
	}

	#onDisconnected(reason: string): void {
		if (this.#state === "disconnected") return;
		this.#state = "disconnected";
		this.#fullTeardown("connection_changed", `connection ended: ${reason}`);
	}

	#onDeath(): void {
		// 死亡立即撤销旧控制（modules/driver.md §16）；化身在重生时建立。
		if (this.#state !== "ready") return;
		this.#state = "syncing";
		this.#awaitingRespawn = true;
		this.revokeCallbacks.forEach((cb) => cb());
	}

	#onSpawn(): void {
		if (this.#awaitingRespawn) {
			// 重生/跨维度：建立新化身，旧窗口/实体/窗口引用全部跨代。
			this.#awaitingRespawn = false;
			this.identity.nextIncarnation();
			this.#stepCounter = 0;
			this.facts.setIdentity(this.identity.connection, this.identity.incarnation);
			this.windowRegistry.clear();
			this.#appearances.clear();
			this.facts.reset("incarnation_changed");
			if (this.#bot) this.#wire(this.#bot);
			this.#state = "ready";
			return;
		}
		if (this.#state !== "ready") {
			this.#state = "ready";
		}
	}

	#onEntityGone(entity: {
		networkId: number;
		uuid: string | null;
		type: string | null;
		position: { x: number; y: number; z: number };
		velocity: { x: number; y: number; z: number };
	}): void {
		// 原始载荷消失前捕获：实体出现/离开是不可合并的选定证据。
		this.facts.capture("entities", "client.entities@1", {
			kind: "entityGone",
			networkId: entity.networkId,
			uuid: entity.uuid,
			type: entity.type,
			position: entity.position,
		});
		this.#appearances.delete(entity.networkId);
		this.facts.commitEntitiesChanged();
	}

	/** 代次更替的统一出口：清登记、失效事实覆盖、断开时退出 bot。 */
	#fullTeardown(resetReason: "connection_changed" | "incarnation_changed", note: string): void {
		this.hostNote = note;
		for (const d of this.#disposers) d();
		this.#disposers = [];
		this.windowRegistry.clear();
		this.#appearances.clear();
		this.revokeCallbacks.forEach((cb) => cb());
		if (resetReason === "connection_changed") {
			// 连接不存在了：当前事实源不再挂接任何 connection/incarnation；
			// 新身份在客户端重建时建立（M5 重建策略）。
			this.facts.setIdentity(null, null);
		}
		this.facts.reset(resetReason);
		if (this.#bot && resetReason === "connection_changed") {
			try {
				this.#bot.quit();
			} catch {
				// 退出失败不阻断故障登记。
			}
			this.#bot = null;
			this.facts.deps.bot = null as unknown as ClientBot;
		}
	}

	hostNote: string | null = null;
	/** 控制撤销回调：gate.revokeAll 与身体端口清理在此登记。 */
	readonly revokeCallbacks = new Set<() => void>();

	onRevoked(cb: () => void): () => void {
		this.revokeCallbacks.add(cb);
		return () => this.revokeCallbacks.delete(cb);
	}

	// ---- 登记接缝（scopeProvider 用）----

	appearanceOf(networkId: number): Ref {
		let a = this.#appearances.get(networkId);
		if (!a) {
			a = this.identity.refs.next("app");
			this.#appearances.set(networkId, a);
		}
		return a;
	}

	windowRefOf(windowId: number): Ref | null {
		return this.windowRegistry.get(windowId) ?? null;
	}

	registerWindow(windowId: number): Ref {
		const ref = this.windowRefs.next("win");
		this.windowRegistry.set(windowId, ref);
		return ref;
	}

	unregisterWindow(windowId: number): void {
		this.windowRegistry.delete(windowId);
	}

	/** 状态读取：faulted 判定由上层显式标记。 */
	markFaulted(reason: string): void {
		this.#state = "faulted";
		this.#faultReason = reason;
	}

	async close(): Promise<void> {
		this.#fullTeardown("connection_changed", "driver closed");
		this.#state = "disconnected";
	}
}
