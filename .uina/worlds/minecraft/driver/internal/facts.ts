/**
 * ClientFactsPort 实现：Driver 当前客户端事实的唯一出口。
 *
 * 设计依据 public-api.md §4.1 与 modules/driver.md §11：
 * - sample 同步读取同一本地提交边界的只读纯值；view 返回即失效，拒绝 Promise/thenable。
 * - stamp：source/epoch/sequence + connection/incarnation；epoch 在连接重建/源重建时更换。
 * - 通知先提交后发出；changed 可合并，选定证据不可被静默合并掉。
 * - 证据在原始数据被覆盖/移除前捕获；mark 序号从 1 起、stream 不可复用；
 *   ACK 按接收方记账，材料保留至 durable 覆盖。
 * - 不复制完整世界模型：只维护来源/覆盖/水位元数据与稀疏证据。
 */

import {
	type CapturedClientFact,
	type ClientEvidenceAck,
	type ClientEvidenceMark,
	type ClientFactCapture,
	type ClientFactNotice,
	type ClientFactScope,
	type ClientFactStamp,
	type ClientFactView,
	type ClientFactsPort,
	type ClientFactsSubscription,
	type ClientBlockValue,
	type ClientEntitiesValue,
	type ClientEntityValue,
	type ClientInventoryValue,
	type ClientSectionsValue,
	type ClientSlotValue,
	type SectionTarget,
} from "../../contracts/client-facts.js";
import type { BlockTarget, EntityRef, SelfState, WindowSnapshot } from "../../contracts/body.js";
import type { ExactRef, Fact, FactBasis, JsonValue, Ref, Vec3 } from "../../contracts/values.js";
import { CallFailureError } from "../../contracts/errors.js";
import { invalidArgument } from "./failure.js";
import type { ClientBot, BotBlockPos } from "./bot-shape.js";

/** 驱动单调时钟毫秒；反馈帧 validUntil 与停滞检测共用。 */
export type MonotonicClock = () => number;

export function defaultClock(): MonotonicClock {
	return () => performance.now();
}

export function utcNow(): string {
	return new Date().toISOString();
}

export interface FactScopeProvider {
	/** 可信运行期绑定；组合根注入。没有可信绑定时显式 unbound，不从连接地址推断。 */
	scope(): ClientFactScope;
	/** 协议窗口 ID → Driver 窗口代次 ref；未登记窗口返回 null。 */
	windowRefOf(windowId: number): Ref | null;
	/** 实体出现代次：同一网络 ID 的每次出现分配新的 appearance。 */
	appearanceOf(networkId: number): Ref;
}

export interface FactsDeps {
	bot: ClientBot;
	scopeProvider: FactScopeProvider;
	clock: MonotonicClock;
	/** 事实源 ref；稳定标识本 Driver 的客户端事实流。 */
	sourceRef: Ref;
}

/** 事实种类 ref：changed 通知里的提示性引用，不承诺穷举。 */
export const FACT_KIND = {
	self: "self",
	inventory: "inventory",
	window: "window",
	entities: "entities",
	block: "block",
	sections: "sections",
} as const;

const SELF_SCHEMA: ExactRef = "client.self@1";
const INVENTORY_SCHEMA: ExactRef = "client.inventory@1";
const WINDOW_SCHEMA: ExactRef = "client.window@1";
const ENTITIES_SCHEMA: ExactRef = "client.entities@1";
const BLOCK_SCHEMA: ExactRef = "client.block@1";
const SECTIONS_SCHEMA: ExactRef = "client.sections@1";

export { BLOCK_SCHEMA, ENTITIES_SCHEMA, INVENTORY_SCHEMA, SELF_SCHEMA, SECTIONS_SCHEMA, WINDOW_SCHEMA };

function canonicalBlockName(name: string): string {
	return name.includes(":") ? name : `minecraft:${name}`;
}

function vec3(v: { x: number; y: number; z: number }): Vec3 {
	return { x: v.x, y: v.y, z: v.z };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

function itemKey(i: { name: string; count: number; components: JsonValue | null } | null | undefined): string {
	if (i === null || i === undefined) return "∅";
	return `${i.name}#${i.count}#${JSON.stringify(i.components ?? null)}`;
}

interface EvidenceStreamState {
	stream: Ref;
	nextSequence: number;
	/** 已宣告未解缺口：ref → (after, through|null)。缺口序号无实际载荷，不进入 materials。 */
	openGaps: Map<Ref, { after: number; through: number | null }>;
}

interface AckRecord {
	/** ACK 归属的流；回收只看同流 ACK，跨流 durableThrough 不得误释放材料。 */
	stream: string;
	receivedThrough: number;
	durableThrough: number;
	gapRefs: Ref[];
}

export class ClientFactsSource implements ClientFactsPort {
	readonly #deps: FactsDeps;
	readonly #listeners = new Set<(notice: ClientFactNotice) => void>();
	/** stream ref → 序号 → 材料；reset 保留旧材料（reset 不删除旧证据）。 */
	readonly #materials = new Map<string, Map<number, CapturedClientFact>>();
	readonly #streams = new Map<string, EvidenceStreamState>();
	readonly #acks = new Map<string, AckRecord>();

	#epochCounter = 0;
	#epoch: Ref;
	#sequence = 0;
	#connectionRef: Ref | null = null;
	#incarnationRef: Ref | null = null;
	#pendingChanged = new Set<string>();
	#changeDeliveryScheduled = false;

	inventoryRevision = 0;
	windowRevision = 0;
	#lastInventoryKey: string | null = null;
	#lastWindowKey: string | null = null;

	constructor(deps: FactsDeps) {
		this.#deps = deps;
		this.#epochCounter += 1;
		this.#epoch = `${deps.sourceRef}-epoch-${this.#epochCounter}`;
	}

	// ---- stamp / scope ----

	get stamp(): ClientFactStamp {
		return {
			source: this.#deps.sourceRef,
			epoch: this.#epoch,
			sequence: this.#sequence,
			connection: this.#connectionRef,
			incarnation: this.#incarnationRef,
		};
	}

	/** 宿主在连接/化身建立时调用。 */
	setIdentity(connection: Ref | null, incarnation: Ref | null): void {
		this.#connectionRef = connection;
		this.#incarnationRef = incarnation;
	}

	get scope(): ClientFactScope {
		return this.#deps.scopeProvider.scope();
	}

	get deps(): FactsDeps {
		return this.#deps;
	}

	// ---- 通知投递 ----

	subscribe(listener: (notice: ClientFactNotice) => void): ClientFactsSubscription {
		// 原子登记：返回登记时刻的 stamp 与证据头快照。
		this.#listeners.add(listener);
		const stampAtSubscribe = this.stamp;
		const evidenceThroughAtSubscribe = this.evidenceThroughAll();
		return {
			stamp: stampAtSubscribe,
			evidenceThrough: evidenceThroughAtSubscribe,
			acknowledge: (ack: ClientEvidenceAck) => this.#acknowledge(ack),
			close: () => this.#listeners.delete(listener),
		};
	}

	/** changed 提交：先推进 stamp，再合并发送；同值但证据性质变化也推进版本。 */
	markChanged(kinds: string[]): void {
		this.#sequence += 1;
		for (const k of kinds) this.#pendingChanged.add(k);
		if (!this.#changeDeliveryScheduled) {
			this.#changeDeliveryScheduled = true;
			queueMicrotask(() => {
				this.#changeDeliveryScheduled = false;
				const changed = [...this.#pendingChanged];
				this.#pendingChanged = new Set();
				if (changed.length === 0 || this.#listeners.size === 0) return;
				this.#emit({ kind: "changed", stamp: this.stamp, changed });
			});
		}
	}

	#emit(notice: ClientFactNotice): void {
		for (const l of [...this.#listeners]) {
			try {
				l(notice);
			} catch {
				// 观察者异常不回滚已提交状态。
			}
		}
	}

	// ---- reset ----

	reset(reason: "connection_changed" | "incarnation_changed" | "source_rebuilt" | "gap"): void {
		this.#epochCounter += 1;
		this.#epoch = `${this.#deps.sourceRef}-epoch-${this.#epochCounter}`;
		this.#sequence = 0;
		// 换 stream 身份；旧材料保留，旧 stream 不再追加（其 ACK 记账按旧 ref 继续有效）。
		this.#streams.clear();
		this.#emit({ kind: "reset", stamp: this.stamp, reason });
	}

	// ---- 选定证据 ----

	#streamOf(name: string): EvidenceStreamState {
		let s = this.#streams.get(name);
		if (!s) {
			s = { stream: `${this.#deps.sourceRef}-ev-${name}-${this.#epochCounter}`, nextSequence: 1, openGaps: new Map() };
			this.#streams.set(name, s);
		}
		return s;
	}

	/** 在原始数据被覆盖/移除前调用：捕获不可变载荷并排 evidence 通知。 */
	capture(
		streamName: string,
		schema: ExactRef,
		value: JsonValue,
		source: FactSourceInput = "server",
	): CapturedClientFact {
		const s = this.#streamOf(streamName);
		const sequence = s.nextSequence++;
		const ref = `${s.stream}-${sequence}`;
		const record: CapturedClientFact = {
			ref,
			schema,
			mark: { stream: s.stream, sequence },
			stamp: this.stamp,
			scope: this.scope,
			fact: {
				value,
				observedAt: utcNow(),
				source,
				coverage: "complete",
				unknown: [],
				evidence: [ref],
			},
		};
		let bucket = this.#materials.get(s.stream);
		if (!bucket) {
			bucket = new Map();
			this.#materials.set(s.stream, bucket);
		}
		bucket.set(sequence, record);
		this.#emit({ kind: "evidence", records: [record] });
		return record;
	}

	/** 不可恢复缺口显式交付：区间 (after, through]，null 表示末端未知。 */
	announceGap(streamName: string, after: number, through: number | null, reason: string): Ref {
		const s = this.#streamOf(streamName);
		const ref = `${s.stream}-gap-${after}-${through ?? "open"}`;
		s.openGaps.set(ref, { after, through });
		this.#emit({ kind: "evidence_gap", ref, stream: s.stream, after, through, reason });
		return ref;
	}

	/** 源封口：只证明源捕获结束，不证明收到/持久化。 */
	announceEnd(streamName: string): void {
		const s = this.#streamOf(streamName);
		this.#emit({ kind: "evidence_end", through: { stream: s.stream, sequence: s.nextSequence - 1 } });
	}

	/** 指定证据流当前未回收材料数（观察口；不构成合同承诺）。 */
	materialCount(streamRef: string): number {
		return this.#materials.get(streamRef)?.size ?? 0;
	}

	evidenceThroughAll(): ClientEvidenceMark {
		let best: ClientEvidenceMark | null = null;
		for (const s of this.#streams.values()) {
			const seq = s.nextSequence - 1;
			if (best === null || seq > best.sequence) best = { stream: s.stream, sequence: seq };
		}
		return best ?? { stream: "", sequence: 0 };
	}

	#acknowledge(ack: ClientEvidenceAck): void {
		// durableThrough 不得大于 receivedThrough；同 receiver/stream 内不回退。
		if (ack.durableThrough > ack.receivedThrough) return;
		const key = `${ack.receiver}|${ack.stream}`;
		const prev = this.#acks.get(key);
		const received = Math.max(prev?.receivedThrough ?? 0, ack.receivedThrough);
		const durable = Math.max(prev?.durableThrough ?? 0, ack.durableThrough);
		this.#acks.set(key, {
			stream: ack.stream,
			receivedThrough: received,
			durableThrough: durable,
			gapRefs: [...(prev?.gapRefs ?? []), ...ack.gaps],
		});
		this.#releaseCovered(ack.stream);
	}

	/**
	 * 材料按提交进度回收：所有已登记接收方的 durableThrough 覆盖即释放。
	 * 缺口覆盖的序号本无实际载荷，不进入 materials；gap ref 归接收方记账。
	 */
	#releaseCovered(stream: string): void {
		const bucket = this.#materials.get(stream);
		if (!bucket) return;
		// 只统计本流的 ACK：其他流的 durableThrough 与本流序号空间不可比。
		const receivers = [...this.#acks.values()].filter((a) => a.stream === stream && a.durableThrough > 0);
		if (receivers.length === 0) return;
		for (const seq of [...bucket.keys()]) {
			if (receivers.every((a) => seq <= a.durableThrough)) bucket.delete(seq);
		}
		if (bucket.size === 0) this.#materials.delete(stream);
	}

	// ---- 采样 ----

	sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T> {
		const view = new LiveView(this);
		let value: T;
		try {
			value = read(view);
		} finally {
			view.kill();
		}
		if (isThenable(value)) {
			throw invalidArgument("ClientFactsPort.sample 的 read 必须同步返回纯值，不接受 Promise/thenable");
		}
		return {
			stamp: this.stamp,
			scope: this.scope,
			evidenceThrough: this.evidenceThroughAll(),
			value,
		};
	}

	// ---- 协议更新提交点（由宿主事件接线调用）----

	/** 完整快照比较：值改变才推进 revision（不只数 updateSlot / 不比较对象引用）。 */
	commitInventoryChanged(): void {
		const bot = this.#deps.bot;
		const inv = bot.inventorySlots();
		const key = `${inv.slots.map((s) => itemKey(s)).join(",")}|sel=${inv.selectedSlot}`;
		if (key !== this.#lastInventoryKey) {
			this.#lastInventoryKey = key;
			this.inventoryRevision += 1;
			this.markChanged([FACT_KIND.inventory]);
		}
	}

	commitWindowChanged(): void {
		const w = this.#deps.bot.currentWindow();
		const key =
			w === null
				? null
				: `${w.id}|${w.type}|${w.slots.map((s) => itemKey(s)).join(",")}|cursor=${itemKey(w.cursor)}|props=${JSON.stringify(w.properties)}`;
		if (key !== this.#lastWindowKey) {
			this.#lastWindowKey = key;
			this.windowRevision += 1;
			this.markChanged([FACT_KIND.window]);
		}
	}

	commitSelfChanged(): void {
		this.markChanged([FACT_KIND.self]);
	}

	commitEntitiesChanged(): void {
		this.markChanged([FACT_KIND.entities]);
	}

	commitBlockChanged(): void {
		this.markChanged([FACT_KIND.block]);
	}
}

type FactSourceInput = "server" | "prediction" | "history" | "derived";

// ---- LiveView：同步只读视图，sample 返回即失效 ----

class LiveView implements ClientFactView {
	#dead = false;

	constructor(private readonly facts: ClientFactsSource) {}

	kill(): void {
		this.#dead = true;
	}

	#alive(): void {
		if (this.#dead) {
			throw new CallFailureError({
				code: "REFERENCE_STALE",
				message: "ClientFactView 已在 sample 返回时失效；不能逃逸后再读",
			});
		}
	}

	/** 断连后 bot 为 null：可空事实返回 null+unknown，空间事实明确失败。 */
	#requireBot(): ClientBot {
		const bot = this.facts.deps.bot;
		if (!bot) throw new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: "客户端事实源当前不可用（未连接）" });
		return bot;
	}

	#entityRef(networkId: number): EntityRef {
		return {
			connection: this.facts.stamp.connection ?? "unknown",
			incarnation: this.facts.stamp.incarnation ?? "unknown",
			appearance: this.facts.deps.scopeProvider.appearanceOf(networkId),
			networkId,
		};
	}

	self(): Fact<SelfState | null> {
		this.#alive();
		if (!this.facts.deps.bot) {
			return {
				value: null,
				observedAt: utcNow(),
				source: "server",
				coverage: "partial",
				unknown: ["client not connected"],
				evidence: [],
			};
		}
		const s = this.facts.deps.bot.self();
		const scope = this.facts.scope;
		const now = utcNow();
		const motionBasis: FactBasis = {
			paths: ["/place/position", "/velocity", "/onGround"],
			source: "prediction",
			observedAt: now,
			evidence: [],
		};
		const vitalsBasis: FactBasis = {
			paths: ["/health", "/food"],
			source: "server",
			observedAt: now,
			evidence: [],
		};
		const value: SelfState = {
			place: {
				world: scope.world,
				worldRevision: scope.worldRevision,
				dimension: s.dimension ?? "unknown",
				position: vec3(s.position),
			},
			velocity: vec3(s.velocity),
			health: s.health,
			food: s.food,
			onGround: s.onGround,
		};
		return {
			value,
			observedAt: now,
			source: "mixed",
			basis: [motionBasis, vitalsBasis],
			coverage: "complete",
			unknown: [],
			evidence: [],
		};
	}

	block(target: BlockTarget): Fact<ClientBlockValue> {
		this.#alive();
		const pos: BotBlockPos = { x: target.block.x, y: target.block.y, z: target.block.z };
		const b = this.#requireBot().blockAt(pos);
		const unknown: string[] = [];
		if (b === null) unknown.push("block state not loaded for target");
		const value: ClientBlockValue = {
			target,
			state: b === null ? null : { name: canonicalBlockName(b.name), properties: { ...b.properties } },
		};
		return {
			value,
			observedAt: utcNow(),
			source: "server",
			coverage: b === null ? "partial" : "complete",
			unknown,
			evidence: [],
		};
	}

	sections(targets: SectionTarget[]): Fact<ClientSectionsValue> {
		this.#alive();
		const bot = this.#requireBot();
		const sections = targets.map((t) => {
			const data = bot.section({ x: t.section.x, y: t.section.y, z: t.section.z });
			return {
				target: t,
				revision: data?.revision ?? "missing",
				base: data?.base
					? {
							palette: data.base.palette.map((p) => ({
								name: canonicalBlockName(p.name),
								properties: { ...p.properties },
							})),
							indices: [...data.base.indices],
						}
					: null,
				patches: [],
			};
		});
		const missing = sections.filter((s) => s.base === null).length;
		return {
			value: { sections },
			observedAt: utcNow(),
			source: "server",
			coverage: missing === 0 ? "complete" : "partial",
			unknown: missing > 0 ? [`${missing} section(s) not loaded`] : [],
			evidence: [],
		};
	}

	entities(): Fact<ClientEntitiesValue> {
		this.#alive();
		const list: ClientEntityValue[] = this.#requireBot()
			.entities()
			.map((e) => ({
				ref: this.#entityRef(e.networkId),
				uuid: e.uuid,
				type: e.type,
				position: vec3(e.position),
				velocity: vec3(e.velocity),
				metadata: null,
			}));
		return {
			value: { extent: "tracked", entities: list },
			observedAt: utcNow(),
			source: "server",
			coverage: "complete",
			unknown: list.some((e) => e.uuid === null || e.type === null) ? ["some entity fields unavailable"] : [],
			evidence: [],
		};
	}

	inventory(): Fact<ClientInventoryValue | null> {
		this.#alive();
		if (!this.facts.deps.bot) {
			return {
				value: null,
				observedAt: utcNow(),
				source: "server",
				coverage: "partial",
				unknown: ["client not connected"],
				evidence: [],
			};
		}
		const inv = this.facts.deps.bot.inventorySlots();
		const slots: ClientSlotValue[] = inv.slots.map((item, slot) =>
			item === null || item === undefined
				? { slot, known: true, item: null }
				: {
						slot,
						known: true,
						item: { name: canonicalBlockName(item.name), count: item.count, components: item.components ?? null },
					},
		);
		const value: ClientInventoryValue = {
			revision: this.facts.inventoryRevision,
			layout: { slotCount: inv.slotCount, regions: [] },
			slots,
			selectedSlot: inv.selectedSlot,
		};
		return {
			value,
			observedAt: utcNow(),
			source: "server",
			coverage: "complete",
			unknown: [],
			evidence: [],
		};
	}

	window(): Fact<WindowSnapshot | null> {
		this.#alive();
		if (!this.facts.deps.bot) {
			return {
				value: null,
				observedAt: utcNow(),
				source: "server",
				coverage: "partial",
				unknown: ["client not connected"],
				evidence: [],
			};
		}
		const w = this.facts.deps.bot.currentWindow();
		if (w === null) {
			return { value: null, observedAt: utcNow(), source: "server", coverage: "complete", unknown: [], evidence: [] };
		}
		const windowRef = this.facts.deps.scopeProvider.windowRefOf(w.id);
		const value: WindowSnapshot = {
			window: windowRef ?? `unregistered-window-${w.id}`,
			type: w.type,
			revision: this.facts.windowRevision,
			layout: { slotCount: w.slotCount, regions: [] },
			properties: { ...w.properties },
			slots: w.slots.map((item, slot) => ({
				slot,
				item:
					item === null
						? null
						: { name: canonicalBlockName(item.name), count: item.count, components: item.components ?? null },
			})),
			cursor:
				w.cursor === null
					? null
					: { name: canonicalBlockName(w.cursor.name), count: w.cursor.count, components: w.cursor.components ?? null },
		};
		return {
			value,
			observedAt: utcNow(),
			source: "mixed",
			coverage: windowRef === null ? "partial" : "complete",
			unknown: windowRef === null ? ["window id not registered by driver"] : [],
			evidence: [],
		};
	}
}
