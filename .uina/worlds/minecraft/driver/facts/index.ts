/**
 * Client Facts：Driver → World 的当前事实入口（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1、modules/driver.md §11。
 * sample() 同步读取同一本地提交边界的只读纯值；不造值：players/map 返回
 * null + unknown，实体 metadata/components 未捕获如实为 null。
 * sections() 经 bot.blockAt 逐格构建 palette+indices（与 mineflayer findBlocks
 * 同一扫描策略；代价随加载体量线性增长，I1 场景用小半径）。
 * 选定证据（I1：chat/connection 事件）在流内 mark 从 1 起；evidence_gap 如实发，
 * 不把缺订阅者解释为无事件。reset/epoch 规则见 §4.1 尾段。
 */

import type {
	CapturedClientFact,
	ClientEvidenceAck,
	ClientEvidenceMark,
	ClientFactCapture,
	ClientFactNotice,
	ClientFactScope,
	ClientFactStamp,
	ClientFactView,
	ClientFactsPort,
	ClientFactsSubscription,
	ClientFactsSubscribeOptions,
	ClientWindowObservation,
} from "../../contracts/client-facts.js";
import type { SelfState, WindowSnapshot } from "../../contracts/body.js";
import { plain } from "../../contracts/values.js";
import type { Fact, JsonValue, Ref } from "../../contracts/values.js";
import type { ClientHost } from "../client-host.js";
import { createView } from "./view.js";
import { buildRegistryKnowledge, type RegistryLike } from "./knowledge.js";
import { fromMineflayerVec3, type MineflayerBot } from "../mineflayer/adapter.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";

export interface FactsBinding {
	binding: Ref;
	world: Ref;
	worldRevision: Ref;
	/**
	 * 本进程启动的流命名空间（组合根每次启动生成，跨进程不复用）。
	 * world.md §5.3：证据流不可复用——每进程从 1 重来的 `evs:N` 会与持久
	 * 历史库的 (stream, seq) 主键跨启动冲突。不得为空或包含冒号。
	 */
	streamNamespace: string;
}

const MAX_PENDING_EVIDENCE = 1024;

interface PendingEvidence {
	record: CapturedClientFact;
}

/**
 * 每前缀独立单调发号。证据 ref（ev:/gap:）随 CapturedClientFact 落 world-history.db，
 * 每进程从 1 重来会与已提交记录的 (ref) 主键跨启动冲突，故一律带启动命名空间（§5.3）。
 */
function makeRefIssuer(namespace: string) {
	const counters = new Map<string, number>();
	return (prefix: string): Ref => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${prefix}:${namespace}:${next}`;
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function refIssuerFrom(start: number): () => number {
	let n = start;
	return () => ++n;
}

interface EvidenceReceiver {
	notify: (n: ClientFactNotice) => void;
	/** 只有消费证据的接收方能推进释放水线（见 subscribe 选项）。 */
	consumesEvidence: boolean;
	/**
	 * 每个证据流各自的已持久水线。换流后序号从 1 重来，
	 * 若沿用单值高水位，旧流的高位会覆盖新流，导致证据在落盘前被释放。
	 */
	durable: Map<Ref, number>;
}

export class FactsSource implements ClientFactsPort {
	private readonly nextRef: (prefix: string) => Ref;
	private readonly nextStreamNo = refIssuerFrom(0);
	private readonly listeners = new Map<Ref, EvidenceReceiver>();
	private readonly pendingEvidence: PendingEvidence[] = [];
	/** Gap identities remain replayable until durable ACK, just like their payload obligations. */
	private readonly pendingGaps: Extract<ClientFactNotice, { kind: "evidence_gap" }>[] = [];
	private readonly pendingEnds = new Map<Ref, ClientEvidenceMark>();
	private stamp: ClientFactStamp;
	/** 本次启动的命名空间（已校验）：证据流与证据 ref 都带它。 */
	private readonly namespace: string;
	private _evidenceThrough: ClientEvidenceMark;
	private evidenceSeq = refIssuerFrom(0);
	private evidenceStream: Ref;
	private changedScheduled = false;
	private attachedBot: MineflayerBot | null = null;
	private windowFact: Fact<WindowSnapshot> | null = null;
	private detachFns: (() => void)[] = [];
	/** 按当前连接版本构建的静态知识缓存；换 bot 即失效。 */
	private knowledgeCache: { bot: MineflayerBot; value: RegistryKnowledge } | null = null;

	constructor(
		private readonly host: ClientHost,
		private readonly binding: FactsBinding,
	) {
		const ns = binding.streamNamespace;
		if (ns.length === 0 || ns.includes(":")) {
			throw new Error("FactsBinding.streamNamespace must be a non-empty string without ':'");
		}
		this.namespace = ns;
		this.nextRef = makeRefIssuer(ns);
		this.stamp = {
			source: this.nextRef("facts"),
			epoch: this.nextRef("ep"),
			sequence: 0,
			connection: host.identity?.connection ?? null,
			incarnation: host.identity?.incarnation ?? null,
		};
		this.evidenceStream = this.openEvidenceStream();
		this._evidenceThrough = { stream: this.evidenceStream, sequence: 0 };
		// 构造时宿主可能已就绪（后装配）也可能尚未连接；挂接跟随连接生命周期：
		// ready 通知时建立源，disconnected/faulted 时封印旧 bot 引用（§3 状态机）。
		this.attach(host.bot);
		host.on((notice) => {
			if (notice.kind === "state") {
				if (notice.state === "ready") {
					// 新活连接：先换代（stamp 携带新身份），再挂接 bot 开始采样提交。
					this.resetSource("source_rebuilt");
					this.attach(this.host.bot);
				} else if (notice.state === "disconnected" || notice.state === "faulted") {
					// 旧 bot 引用封印：sample 转为 DISCONNECTED，不读死连接。
					this.detach();
					this.resetSource("connection_changed");
				}
				return;
			}
			if (notice.kind === "incarnation_changed") {
				this.resetSource("incarnation_changed");
				return;
			}
		});
	}

	// ---- ClientFactsPort ----

	sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T> {
		if (this.attachedBot == null) {
			// 断线/故障与"尚未连接"必须区分：前者不可自动恢复，调用方据此报 unavailable。
			const state = this.host.state;
			const gone = state === "disconnected" || state === "faulted";
			throw Object.assign(
				new Error(
					gone
						? `client facts source is gone: connection is ${state}`
						: `client facts source is not attached to a live connection (state ${state})`,
				),
				{ code: gone ? "DISCONNECTED" : "WRONG_STATE" },
			);
		}
		// read 在同一同步边界内执行；view 闭包不外泄（调用者约定，见 §4.1）。
		const value = read(this.buildView());
		return {
			stamp: { ...this.stamp },
			scope: this.currentScope(),
			evidenceThrough: { ...this._evidenceThrough },
			value,
		};
	}

	subscribe(
		listener: (notice: ClientFactNotice) => void,
		options?: ClientFactsSubscribeOptions,
	): ClientFactsSubscription {
		const receiver = this.nextRef("recv");
		const stamp = { ...this.stamp };
		const evidenceThrough = { ...this._evidenceThrough };
		const replay =
			options?.consumesEvidence === true
				? {
						gaps: [...this.pendingGaps],
						records: this.pendingEvidence.map((entry) => entry.record),
						ends: [...this.pendingEnds.values()],
					}
				: null;
		this.listeners.set(receiver, {
			notify: listener,
			consumesEvidence: options?.consumesEvidence === true,
			durable: new Map(),
		});
		// Register before replay so concurrent capture and ACK observe this receiver.
		if (replay != null) {
			const notify = (notice: ClientFactNotice): void => {
				try {
					listener(notice);
				} catch {
					/* Subscribers cannot interrupt Driver capture. */
				}
			};
			for (const gap of replay.gaps) notify(gap);
			if (replay.records.length > 0) notify({ kind: "evidence", records: replay.records });
			for (const through of replay.ends) notify({ kind: "evidence_end", through });
		}
		return {
			stamp,
			evidenceThrough,
			acknowledge: (ack: ClientEvidenceAck) => {
				const entry = this.listeners.get(receiver);
				if (entry == null) return;
				// 按 ack 自带的 stream 记账：同 receiver/stream 内不回退，异流互不覆盖。
				const previous = entry.durable.get(ack.stream) ?? 0;
				if (ack.durableThrough <= previous) return;
				entry.durable.set(ack.stream, ack.durableThrough);
				this.releaseAckedEvidence();
			},
			close: () => {
				this.listeners.delete(receiver);
				this.releaseAckedEvidence();
			},
		};
	}

	// ---- 内部：证据与提交 ----

	/**
	 * 供组合根注入 Body（drive.end 等需 Fact<SelfState>）的快速自采样；
	 * 未附着活连接时返回 null，不虚构状态（public-api §4 反馈 self 缺口语义）。
	 * 附着但实体尚未就绪时值为 null + unknown，不填 0（values.ts：未知不得伪装成已知）。
	 */
	sampleSelf(): Fact<SelfState | null> | null {
		if (this.attachedBot == null) return null;
		try {
			return this.buildView().self();
		} catch {
			return null;
		}
	}

	/**
	 * 静态知识（item@1/recipe@1/mine/eat 共用）：按连接版本构建一次，换 bot 即重建。
	 * 未附着活连接时返回 null——知识随版本，不随世界；连接前没有版本可依据。
	 */
	knowledge(): RegistryKnowledge | null {
		const bot = this.attachedBot;
		if (bot == null) return null;
		if (this.knowledgeCache?.bot !== bot) {
			this.knowledgeCache = {
				bot,
				value: buildRegistryKnowledge(bot.registry as unknown as RegistryLike),
			};
		}
		return this.knowledgeCache.value;
	}

	get evidenceThrough(): ClientEvidenceMark {
		return { ...this._evidenceThrough };
	}

	/** 真实服务端窗口观察；关闭只清当前值，已捕获材料仍等待 durable ACK。 */
	publishWindow(observation: ClientWindowObservation | null): void {
		if (observation == null) {
			this.windowFact = null;
			this.commit();
			return;
		}
		if (this.attachedBot == null) return;
		const value = JSON.parse(JSON.stringify(observation)) as ClientWindowObservation;
		this.commit();
		const unknown: string[] = [];
		const snapshot = value.snapshot;
		const slots = new Set(snapshot.slots.map((slot) => slot.slot));
		if (slots.size !== snapshot.layout.slotCount) unknown.push("window slots are only partially observed");
		if (
			snapshot.slots.some((slot) => slot.item != null && (slot.item as { components?: unknown }).components == null)
		) {
			unknown.push("some window item components are unknown");
		}
		this.capture("client.window@1", plain(value), unknown, (record) => {
			this.windowFact = { ...record.fact, value: snapshot, evidence: [record.ref] };
		});
	}

	/** 每条材料按自己的流计算持久水线，旧流迟到 ACK 不授权新流。 */
	private releaseAckedEvidence(): void {
		const consumers = [...this.listeners.values()].filter((entry) => entry.consumesEvidence);
		if (consumers.length === 0) return;
		for (let i = this.pendingEvidence.length - 1; i >= 0; i--) {
			const mark = this.pendingEvidence[i].record.mark;
			if (consumers.every((entry) => (entry.durable.get(mark.stream) ?? 0) >= mark.sequence)) {
				this.pendingEvidence.splice(i, 1);
			}
		}
		for (let i = this.pendingGaps.length - 1; i >= 0; i--) {
			const gap = this.pendingGaps[i];
			if (consumers.every((entry) => (entry.durable.get(gap.stream) ?? 0) >= (gap.through ?? gap.after + 1)))
				this.pendingGaps.splice(i, 1);
		}
		for (const [stream, mark] of this.pendingEnds) {
			if (consumers.every((entry) => (entry.durable.get(stream) ?? 0) >= mark.sequence))
				this.pendingEnds.delete(stream);
		}
	}

	/** 证据流 ref = evs:<namespace>:<n>：namespace 跨进程不复用（§5.3）。 */
	private openEvidenceStream(): Ref {
		return `evs:${this.namespace}:${this.nextStreamNo()}`;
	}

	private resetSource(reason: "connection_changed" | "incarnation_changed" | "source_rebuilt"): void {
		// 旧流封口：只证明源捕获结束，不证明已收到/持久化（§4.1）。
		if (
			this.pendingEvidence.some((entry) => entry.record.mark.stream === this.evidenceStream) ||
			this.pendingGaps.some((gap) => gap.stream === this.evidenceStream)
		) {
			const through = { ...this._evidenceThrough };
			this.pendingEnds.set(through.stream, through);
			this.deliverNotice({ kind: "evidence_end", through });
		}
		this.windowFact = null;
		this.evidenceStream = this.openEvidenceStream();
		this.evidenceSeq = refIssuerFrom(0);
		this._evidenceThrough = { stream: this.evidenceStream, sequence: 0 };
		this.stamp = {
			...this.stamp,
			epoch: this.nextRef("ep"),
			sequence: 0,
			connection: this.host.identity?.connection ?? null,
			incarnation: this.host.identity?.incarnation ?? null,
		};
		this.deliverNotice({
			kind: "reset",
			stamp: { ...this.stamp },
			reason,
		});
	}

	private commit(): void {
		this.stamp = { ...this.stamp, sequence: this.stamp.sequence + 1 };
		if (this.changedScheduled) return;
		this.changedScheduled = true;
		queueMicrotask(() => {
			this.changedScheduled = false;
			this.deliverNotice({ kind: "changed", stamp: { ...this.stamp }, changed: [] });
		});
	}

	private deliverNotice(notice: ClientFactNotice): void {
		for (const entry of [...this.listeners.values()]) {
			try {
				entry.notify(notice);
			} catch {
				// 订阅者异常不进入 Driver 关键路径（§4.1）。
			}
		}
	}

	/** I1 选定证据：chat / damage / death / connection 事件。 */
	private captureEvent(schema: "client.event@1", payload: JsonValue, unknowns: string[]): void {
		if (this.attachedBot == null) return;
		this.capture(schema, payload, unknowns);
	}

	private capture(
		schema: CapturedClientFact["schema"],
		payload: JsonValue,
		unknowns: string[],
		beforeNotify?: (record: CapturedClientFact) => void,
	): CapturedClientFact {
		const stream = this.evidenceStream;
		const seq = this.evidenceSeq();
		this._evidenceThrough = { stream, sequence: seq };
		const record: CapturedClientFact = {
			ref: this.nextRef("ev"),
			schema,
			mark: { stream, sequence: seq },
			stamp: { ...this.stamp },
			scope: this.currentScope(),
			fact: {
				value: payload,
				observedAt: nowIso(),
				connection: this.stamp.connection ?? undefined,
				incarnation: this.stamp.incarnation ?? undefined,
				source: "server",
				coverage: unknowns.length > 0 ? "partial" : "complete",
				unknown: unknowns,
				evidence: [],
			},
		};
		beforeNotify?.(record);
		this.pendingEvidence.push({ record });
		this.deliverNotice({ kind: "evidence", records: [record] });
		// 无接收方时缓冲有界；溢出如实发缺口（末端未知），不静默丢弃。
		if (this.pendingEvidence.length > MAX_PENDING_EVIDENCE) {
			const dropped = this.pendingEvidence.shift()!.record.mark;
			const after = dropped.sequence - 1;
			const gap: Extract<ClientFactNotice, { kind: "evidence_gap" }> = {
				kind: "evidence_gap",
				ref: this.nextRef("gap"),
				stream: dropped.stream,
				after,
				through: null,
				reason: "evidence buffer overflow without durable acknowledgement",
			};
			this.pendingGaps.push(gap);
			this.deliverNotice(gap);
		}
		return record;
	}

	private attach(bot: MineflayerBot | null): void {
		this.detach();
		this.attachedBot = bot;
		if (bot == null) return;
		const on = (event: string, fn: () => void) => {
			bot.on(event as never, fn as never);
			this.detachFns.push(() => bot.removeListener(event as never, fn as never));
		};
		on("move", () => this.commit());
		on("health", () => this.commit());
		on("forcedMove", () => this.commit());
		on("entitySpawn", () => this.commit());
		on("entityDespawn", () => this.commit());
		on("chunkColumnLoad", () => this.commit());
		on("chunkColumnUnload", () => this.commit());
		// 自身受伤：只认本客户端玩家的实体，不把附近实体受伤记成自己的。
		const onHurt = (entity: { id?: number } | null, source: { id?: number } | null) => {
			// 只认本客户端玩家：实体缺失或不是自己不记（不把附近伤害记成自身事件）。
			const selfId = bot.entity?.id;
			if (selfId == null || entity?.id !== selfId) return;
			const actor = source?.id != null ? bot.entities[source.id] : undefined;
			this.captureEvent(
				"client.event@1",
				{
					kind: "damage",
					// 协议只给伤害事件本身，不给数值/原因；如实 null。
					amount: null,
					healthAfter: typeof bot.health === "number" ? bot.health : null,
					cause: null,
					attacker:
						actor == null
							? null
							: {
									name: (actor as unknown as { name?: string }).name ?? null,
									uuid: (actor as unknown as { uuid?: string }).uuid ?? null,
									entity: null,
								},
				},
				["damage amount and cause are not reported in this protocol path"],
			);
			this.commit();
		};
		bot.on("entityHurt", onHurt as never);
		this.detachFns.push(() => bot.removeListener("entityHurt", onHurt as never));
		const onDeath = () => {
			const pos = fromMineflayerVec3(bot.entity?.position);
			this.captureEvent(
				"client.event@1",
				plain({
					kind: "death",
					message: null,
					place:
						pos == null
							? null
							: {
									...this.currentScope(),
									position: pos,
								},
				}),
				["death message not captured in I1"],
			);
			this.commit();
		};
		bot.on("death", onDeath);
		this.detachFns.push(() => bot.removeListener("death", onDeath));
		// 运行时发射为 (text, position, jsonMsg, sender)；类型只声明前三参，sender 走 rest。
		const onMessageStr = (message: string, ...rest: unknown[]) => {
			const sender = rest[2];
			const botName = bot.username;
			const text = String(message);
			// 我方消息回声由 chat 动作核验，不重复捕获（chat 证据归属动作回执）。
			if (sender != null && sender === botName) return;
			this.captureEvent(
				"client.event@1",
				{
					kind: "chat",
					channel: "public",
					text,
					sender: typeof sender === "string" ? { name: sender, uuid: null, entity: null } : null,
					recipient: null,
					self: sender === botName ? true : null,
				},
				["chat channel inferred as public; private/system classification not captured in I1"],
			);
			this.commit();
		};
		bot.on("messagestr", onMessageStr as never);
		this.detachFns.push(() => bot.removeListener("messagestr", onMessageStr as never));
		on("end", (reason?: string) => {
			// 断线本身是事件：先入库再封流（流封口不影响已捕获载荷）。
			this.captureEvent(
				"client.event@1",
				{ kind: "connection", state: "disconnected", reason: typeof reason === "string" ? reason : null },
				[],
			);
			this.resetSource("connection_changed");
		});
		// 库存窗口提交：同一函数引用登记/移除。
		const inv = bot.inventory;
		if (inv != null) {
			const onSlotUpdate = () => this.commit();
			inv.on("updateSlot", onSlotUpdate);
			this.detachFns.push(() => inv.removeListener("updateSlot", onSlotUpdate));
		}
		this.captureEvent("client.event@1", { kind: "connection", state: "connected", reason: null }, []);
		this.commit();
	}

	private detach(): void {
		for (const fn of this.detachFns) {
			try {
				fn();
			} catch {
				// 已断开的监听器移除失败无害
			}
		}
		this.detachFns = [];
		this.attachedBot = null;
		this.knowledgeCache = null;
	}

	private currentScope(): ClientFactScope {
		return {
			binding: this.binding.binding,
			world: this.binding.world,
			worldRevision: this.binding.worldRevision,
			dimension: this.host.dimension,
		};
	}

	// ---- 视图构建 ----

	private buildView(): ClientFactView {
		const bot = this.attachedBot;
		if (bot == null) throw new Error("facts view requires live bot");
		return createView({ bot, scope: this.currentScope(), stamp: { ...this.stamp }, window: this.windowFact });
	}
}
