/**
 * Client Facts：Driver → World 的当前事实入口（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1、modules/driver.md §11。
 * sample() 同步读取同一本地提交边界的只读纯值；不造值：map 只投影本连接实际收到的
 * 地图包（map-cache），players 在未收到名单公告前同样 null + unknown，
 * 实体 metadata/components 未捕获如实为 null。
 * sections() 经 bot.blockAt 逐格构建 palette+indices（与 mineflayer findBlocks
 * 同一扫描策略；代价随加载体量线性增长，I1 场景用小半径）。
 * 选定证据（I1：chat/connection 事件）在流内 mark 从 1 起；evidence_gap 如实发，
 * 不把缺订阅者解释为无事件。reset/epoch 规则见 §4.1 尾段。
 */

import type { SelfState, WindowSnapshot } from "../../contracts/body.js";
import type {
	CapturedClientFact,
	ClientEvidenceAck,
	ClientEvidenceMark,
	ClientFactCapture,
	ClientFactNotice,
	ClientFactScope,
	ClientFactStamp,
	ClientFactsPort,
	ClientFactsSubscribeOptions,
	ClientFactsSubscription,
	ClientFactView,
	ClientWindowObservation,
	FactCategory,
} from "../../contracts/client-facts.js";
import { emptyFactRevisions } from "../../contracts/client-facts.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { AddonFactEntry, AddonFactPublication } from "../../contracts/protocol.js";
import type { RichText } from "../../contracts/ui.js";
import type { Fact, JsonValue, Ref } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { ClientHost } from "../client-host.js";
import { fromMineflayerVec3, type MineflayerBot } from "../mineflayer/adapter.js";
import { protocolFor } from "../mineflayer/protocol.js";
import { projectUi } from "../ui/projection.js";
import { parseComponent } from "../ui/text.js";
import { windowStateFor } from "../window/state.js";
import { buildRegistryKnowledge, type RegistryLike } from "./knowledge.js";
import { MapCache } from "./map-cache.js";
import { createView } from "./view.js";
import { trackVitals } from "./vitals.js";

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

/**
 * mineflayer 消息对象上的结构化组件（真服探针：`jsonMsg.json` 保留 click_event/extra）。
 * 取不到就返回 null：富文本是增强，不是正文的替代品。
 */
function richOfComponent(raw: unknown, prefix: string): RichText | null {
	if (raw == null || typeof raw !== "object") return null;
	const json = (raw as { json?: unknown }).json;
	if (json == null) return null;
	return parseComponent(json, prefix);
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
	/** 最近一次界面投影的身份：关闭事件需要报告"关掉的是哪个界面"。 */
	private lastUiRef: string | null = null;
	private lastUiKind: "none" | "container" | "dialog" | "book" | null = null;
	private lastUiPhase: "play" | "config" | "local" = "play";
	/**
	 * Addon 发布的连接级事实（key = `<addonId>/<key>`）。值里同时留档采集事件
	 * 来源身份与作用域：换代只清 incarnation 域，断线/换服清全部。
	 * 不为每个包建独立事实引擎或游标体系。
	 */
	private readonly addonFacts = new Map<string, AddonFactEntry>();
	/** 本连接是否已收到至少一条玩家名单公告；换连接清零，名单未到不冒充空服。 */
	private rosterSeen = false;
	/** 本连接收到的地图增量包缓存；换连接（resetSource）清空当前覆盖（§11.8）。 */
	private readonly maps = new MapCache();
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
			revisions: emptyFactRevisions(),
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
					// 断线本身是事件：先捕获再封源。capture 不要求活 bot，证据落旧流并同步送达
					// 订阅者（断线通知由此真实发出）。faulted 只发生在 ready 之前——从未 attach
					// 过就只报连接错误，不伪造已断开的游戏会话。
					if (this.attachedBot != null)
						this.capture(
							"client.event@1",
							{
								kind: "connection",
								state: "disconnected",
								reason: this.host.disconnectFacts?.reason ?? null,
							},
							[],
						);
					// 旧 bot 引用封印：sample 转为 DISCONNECTED，不读死连接。
					this.detach();
					this.addonFacts.clear();
					this.resetSource("connection_changed");
				} else if (notice.state === "connecting") {
					// 新连接开始：上一代的模组事实立即失效（不等 ready）。
					this.addonFacts.clear();
				}
				return;
			}
			if (notice.kind === "incarnation_changed") {
				this.resetSource("incarnation_changed");
				this.expireIncarnationFacts();
				return;
			}
			if (notice.kind === "incarnation_invalidated") {
				this.expireIncarnationFacts();
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
			this.commit("window");
			return;
		}
		if (this.attachedBot == null) return;
		const value = JSON.parse(JSON.stringify(observation)) as ClientWindowObservation;
		this.commit("window");
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

	/**
	 * Addon 的连接级事实发布口（contracts/protocol.ts ConnectionFactSink）。
	 * 身份取**采集事件来源**（publication.origin），不是提交时读当前身份。迟到发布
	 * 按采集身份与当前身份逐项比对后拒绝，旧异步结果不会被误标成新连接/新化身。
	 * source 由原始证据确定：解码服务端包是 server，addon 自行推算/置未知是 derived。
	 */
	publishAddonFact(addonId: string, key: string, value: JsonValue, publication: AddonFactPublication): void {
		const current = this.host.identity;
		if (this.host.bot == null || current == null) return;
		if (publication.origin.connection !== current.connection || publication.origin.incarnation !== current.incarnation)
			return;
		let payload: JsonValue;
		try {
			payload = JSON.parse(JSON.stringify(value)) as JsonValue;
		} catch {
			// 非纯值（函数/循环引用）不是事实：显式拒绝，不写入半成品。
			throw new Error(`addon fact ${addonId}/${key} is not a plain JSON value`);
		}
		const unknown = publication.unknown ?? [];
		// 发布本身是一条真实采集证据：走现有 capture 发一个 ev: ref，
		// 事实的 evidence 指向它，查询回读时才有可引用的观察证据（confirm 用得上）。
		const record = this.capture("addon.fact@1", { addonId, key, value: payload }, unknown);
		const fact: Fact<JsonValue> = {
			...record.fact,
			// 事实值仍是 addon 自己发布的值；capture 的 payload 只是证据记录的外壳。
			value: payload,
			connection: publication.origin.connection,
			incarnation: publication.origin.incarnation,
			source: publication.source,
			evidence: [record.ref],
		};
		this.addonFacts.set(`${addonId}/${key}`, {
			fact,
			scope: publication.scope,
			origin: { ...publication.origin },
		});
		this.commit("addon");
	}

	/** 换代/身体失效只清 incarnation 域；服务器范围事实保留到本连接断开。 */
	private expireIncarnationFacts(): void {
		let removed = false;
		for (const [key, entry] of this.addonFacts) {
			if (entry.scope !== "incarnation") continue;
			this.addonFacts.delete(key);
			removed = true;
		}
		if (removed) this.commit("addon");
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
		this.maps.clear();
		this.evidenceStream = this.openEvidenceStream();
		this.evidenceSeq = refIssuerFrom(0);
		this._evidenceThrough = { stream: this.evidenceStream, sequence: 0 };
		this.stamp = {
			...this.stamp,
			epoch: this.nextRef("ep"),
			sequence: 0,
			// 换代后 stream/epoch 变化已使所有 watch reset；类别修订从零重开保持口径一致。
			revisions: emptyFactRevisions(),
			connection: this.host.identity?.connection ?? null,
			incarnation: this.host.identity?.incarnation ?? null,
		};
		this.deliverNotice({
			kind: "reset",
			stamp: { ...this.stamp },
			reason,
		});
	}

	/**
	 * 推进事实版本：全局 sequence 单调 +1，受影响类别的修订 +1（无参 = 全类别，
	 * 用于连接建立这类"一切可能都变了"的时刻）。同一轮事件循环内多次 commit 合并
	 * 为一条 changed 通知，通知携带最新 stamp（含已推进的类别修订）。
	 */
	private commit(...categories: FactCategory[]): void {
		const revisions = { ...this.stamp.revisions };
		if (categories.length === 0) {
			for (const category of Object.keys(revisions) as FactCategory[]) revisions[category] += 1;
		} else {
			for (const category of categories) revisions[category] += 1;
		}
		this.stamp = { ...this.stamp, sequence: this.stamp.sequence + 1, revisions };
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

	/**
	 * 界面开启/关闭的有界事件：只报告"界面变了"与当前身份的摘要，
	 * 详细结构仍由 ui@1 按需读取（不在事件里塞整份菜单）。
	 * closed 用上一次的投影身份，因为关闭后当前状态已经是 none。
	 */
	private captureUiEvent(state: "opened" | "closed"): void {
		const bot = this.attachedBot;
		if (bot == null) return;
		const uiState = windowStateFor(protocolFor(bot));
		const projected = projectUi({
			screen: uiState.screen(),
			dialog: uiState.dialog(),
			dialogData: uiState.dialogData(),
		});
		const screenRef = state === "closed" ? (this.lastUiRef ?? "none") : (projected.screenRef ?? "none");
		const uiKind = state === "closed" ? (this.lastUiKind ?? "none") : projected.kind;
		const title = state === "closed" ? null : (projected.title?.text ?? null);
		// 关闭后 dialog() 已是 null：阶段取关闭前那一次的身份，否则 config 阶段的对话框会被报成 play。
		const phase = state === "closed" ? this.lastUiPhase : (uiState.dialog()?.phase ?? "play");
		this.lastUiRef = projected.screenRef;
		this.lastUiKind = projected.kind;
		this.lastUiPhase = uiState.dialog()?.phase ?? "play";
		this.captureEvent("client.event@1", { kind: "ui", state, screenRef, uiKind, title, phase }, []);
	}

	/** I1 选定证据：chat / damage / death / ui / connection 事件。返回记录以便登记富文本动作。 */
	private captureEvent(schema: "client.event@1", payload: JsonValue, unknowns: string[]): CapturedClientFact | null {
		if (this.attachedBot == null) return null;
		return this.capture(schema, payload, unknowns);
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
		// 事件源按事实类别提交（Watch 类别化失效）：无法精确归类就保守多报，不得漏报。
		// 自己也是实体：位置变化会改变 entities@1 的排序与 selfRef，move 一并失效 entities。
		on("move", () => this.commit("self", "entities"));
		on("forcedMove", () => this.commit("self", "entities"));
		on("health", () => this.commit("self"));
		on("breath", () => this.commit("self"));
		on("entityAttributes", () => this.commit("self", "entities"));
		this.detachFns.push(trackVitals(bot).subscribe(() => this.commit("self")));
		// 物理拍：无专用事件的连续量兜底——自身/实体运动与时间天气（world@1 的 ticks
		// 每拍递增）。方块变化有真实 blockUpdate 事件，不在这里冒认。
		on("physicsTick", () => this.commit("self", "entities", "world"));
		on("blockUpdate", () => this.commit("blocks"));
		on("entitySpawn", () => this.commit("entities"));
		on("entityDespawn", () => this.commit("entities"));
		// 区块装卸：方块可用性变化，biome（来自区块列）随之。
		on("chunkColumnLoad", () => this.commit("blocks", "world"));
		on("chunkColumnUnload", () => this.commit("blocks", "world"));
		// 玩家名单：首个公告事件起名单可用；三类事件都推进版本（capabilities.md §players 可等待口径）。
		on("playerJoined", () => {
			this.rosterSeen = true;
			this.commit("players");
		});
		on("playerUpdated", () => {
			this.rosterSeen = true;
			this.commit("players");
		});
		on("playerLeft", () => {
			this.rosterSeen = true;
			this.commit("players");
		});
		// 地图：协议窄口解码 map 包，这里校验矩形后一次提交（driver.md §11.8）。
		this.detachFns.push(
			protocolFor(bot).subscribe((notice) => {
				if (notice.kind !== "map") return;
				this.maps.apply(notice);
				this.commit("maps");
			}),
		);
		// 连接级界面/HUD：ui 与 hud 分开失效——计分板每秒刷新的插件不该把菜单观察者全部唤醒。
		// 界面开启/关闭额外发一条有界事件，让 Agent 知道"菜单出现了"，细节仍按需读 ui@1。
		this.detachFns.push(
			windowStateFor(protocolFor(bot)).subscribe((notice) => {
				if (notice.kind === "hud") {
					this.commit("hud");
					return;
				}
				if (notice.kind === "screen") {
					this.commit("ui");
					if (notice.action === "opened") this.captureUiEvent("opened");
					else if (notice.action === "closed") this.captureUiEvent("closed");
					return;
				}
				if (notice.kind === "dialog") {
					this.commit("ui");
					if (notice.action === "opened") this.captureUiEvent("opened");
					else if (notice.action === "closed") this.captureUiEvent("closed");
				}
			}),
		);
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
			this.commit("self");
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
			this.commit("self");
		};
		bot.on("death", onDeath);
		this.detachFns.push(() => bot.removeListener("death", onDeath));
		// 聊天分类对齐 public-api §events 的 channel 合同。whisper/chat 事件由 mineflayer
		// 内建聊天模式从 messagestr 派生（插件的 messagestr 匹配器先于本监听注册），携带
		// 同一原始消息对象；messagestr 处理器按对象身份跳过已分类消息——同一入包只记一条，
		// 不做文本去重（不同包相同文本互不吞）。内建模式不识别的自定义格式如实记 unknown。
		const classified = new WeakSet<object>();
		const actorOf = (name: unknown): { name: string | null; uuid: string | null; entity: null } => ({
			name: typeof name === "string" ? name : null,
			uuid: null,
			entity: null,
		});
		const captureChat = (
			channel: "public" | "private" | "system" | "action_bar" | "unknown",
			text: string,
			sender: { name: string | null; uuid: string | null; entity: null } | null,
			recipient: string | null,
			self: boolean | null,
			unknowns: string[],
			rawMessage: unknown = null,
		): void => {
			// 富文本只取 mineflayer 消息对象上的结构化组件（真服探针确认 `.json` 保留 click_event）；
			// 取不到就如实 null——纯文本仍是完整正文，不因为缺组件丢消息。
			const rich = richOfComponent(rawMessage, this.nextRef("chat"));
			// 聊天不改变任何当前事实（events@1 走历史库 record_version 失效），不推进版本。
			const record = this.captureEvent(
				"client.event@1",
				plain({ kind: "chat", channel, text, sender, recipient, self, rich }),
				unknowns,
			);
			// 登记文本动作：activate_text 只执行这里登记过的 ref，模型不能自己拼动作。
			if (record != null && rich != null && rich.actions.length > 0)
				windowStateFor(protocolFor(bot)).registerTextActions(record.ref, rich.actions);
		};
		// 运行时发射为 (sender, text, translate, raw)；raw 是 messagestr 同一个原始消息对象。
		const onPatternChat =
			(channel: "public" | "private") =>
			(sender: unknown, text: unknown, ...rest: unknown[]) => {
				const raw = rest[1];
				if (typeof raw === "object" && raw !== null) classified.add(raw);
				const name = typeof sender === "string" ? sender : null;
				// 我方消息回声由 chat 动作核验，不重复捕获（chat 证据归属动作回执）。
				if (name == null || name === bot.username) return;
				captureChat(channel, String(text), actorOf(name), channel === "private" ? bot.username : null, false, [], raw);
			};
		const onWhisper = onPatternChat("private");
		bot.on("whisper", onWhisper as never);
		this.detachFns.push(() => bot.removeListener("whisper", onWhisper as never));
		const onPublic = onPatternChat("public");
		bot.on("chat", onPublic as never);
		this.detachFns.push(() => bot.removeListener("chat", onPublic as never));
		// 运行时发射为 (text, position, jsonMsg, sender)；未分类的按 position 归位：
		// system→system、game_info（动作栏）→action_bar、玩家位但格式未匹配→unknown。
		const onMessageStr = (message: string, ...rest: unknown[]) => {
			const raw = rest[1];
			if (typeof raw === "object" && raw !== null && classified.has(raw)) return;
			const position = rest[0];
			const sender = rest[2];
			const text = String(message);
			// 我方消息回声由 chat 动作核验，不重复捕获（chat 证据归属动作回执）。
			if (sender != null && sender === bot.username) return;
			const channel = position === "system" ? "system" : position === "game_info" ? "action_bar" : "unknown";
			// playerChat 路径的 sender 是 UUID 而非名字，格式未解析时只记 uuid，不冒充 name。
			captureChat(
				channel,
				text,
				typeof sender === "string" ? { name: null, uuid: sender, entity: null } : null,
				null,
				null,
				channel === "unknown" ? ["chat channel not recognized in this protocol path"] : [],
				raw,
			);
		};
		bot.on("messagestr", onMessageStr as never);
		this.detachFns.push(() => bot.removeListener("messagestr", onMessageStr as never));
		// 库存窗口提交：同一函数引用登记/移除。
		const inv = bot.inventory;
		if (inv != null) {
			const onSlotUpdate = () => this.commit("inventory");
			inv.on("updateSlot", onSlotUpdate);
			this.detachFns.push(() => inv.removeListener("updateSlot", onSlotUpdate));
		}
		this.captureEvent("client.event@1", { kind: "connection", state: "connected", reason: null }, []);
		// 连接建立：一切事实都可能已变，全类别失效。
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
		this.rosterSeen = false;
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
		return createView({
			bot,
			scope: this.currentScope(),
			stamp: { ...this.stamp },
			window: this.windowFact,
			rosterSeen: this.rosterSeen,
			maps: this.maps,
			addonFacts: this.addonFacts,
		});
	}
}
