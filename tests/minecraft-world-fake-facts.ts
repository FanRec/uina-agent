/**
 * ClientFactsPort 测试事实源（严格遵循共享合同，不实现第二个 Driver）。
 *
 * 合同要点（public-api §4.1）：
 * - sample 同步读取同一本地提交边界的只读纯值与水位，返回不可变纯数据；
 * - subscribe 原子登记并返回当前 stamp/证据头；状态先提交、再排变化通知；
 * - 证据 ref 与 mark 绑定不可变载荷，重传复用原值。
 *
 * 归属：tests/minecraft-world-* 测试前缀（World AI），仅 World 切片测试使用。
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
	ClientBlockValue,
	ClientInventoryValue,
} from "../.uina/worlds/minecraft/contracts/client-facts.js";
import type { SelfState, BlockTarget } from "../.uina/worlds/minecraft/contracts/body.js";
import type { Fact, Ref } from "../.uina/worlds/minecraft/contracts/values.js";

export function mkFact<T>(value: T, overrides?: Partial<Fact<T>>): Fact<T> {
	return {
		value,
		observedAt: "2026-10-16T08:00:00.000Z",
		source: "server",
		coverage: "complete",
		unknown: [],
		evidence: [],
		...overrides,
	};
}

export class FakeClientFacts implements ClientFactsPort {
	readonly stream: Ref = "mcw:test:stream:s1";
	private stampState: ClientFactStamp = {
		source: "mcw:test:source:1",
		epoch: "mcw:test:epoch:e1",
		sequence: 0,
		connection: "conn:1",
		incarnation: "inc:1",
	};
	private scopeState: ClientFactScope = {
		binding: "mcw:binding:b1",
		world: "mcw:world:w1",
		worldRevision: "mcw:rev:r1",
		dimension: "minecraft:overworld",
	};
	private evidenceHead = 0;
	private selfFact: Fact<SelfState | null> = mkFact<SelfState | null>(null, {
		coverage: "partial",
		unknown: ["self 未就绪"],
	});
	private inventoryFact: Fact<ClientInventoryValue | null> = mkFact<ClientInventoryValue | null>(null, {
		coverage: "partial",
		unknown: ["inventory 未就绪"],
	});
	private blocks = new Map<string, Fact<ClientBlockValue>>();
	private listeners: ((notice: ClientFactNotice) => void)[] = [];
	readonly acks: ClientEvidenceAck[] = [];
	/** 调用顺序记录：验证 World 先订阅后采样。 */
	readonly callLog: string[] = [];
	/** 记录每块证据是否被 acknowledge 至 durable（供测试断言 Driver 退役时机）。 */
	private closed = false;

	sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T> {
		this.callLog.push("sample");
		const view: ClientFactView = {
			self: () => this.selfFact,
			inventory: () => this.inventoryFact,
			block: (target: BlockTarget) => {
				const key = `${target.place.dimension}:${target.block.x},${target.block.y},${target.block.z}`;
				return (
					this.blocks.get(key) ??
					mkFact<ClientBlockValue>({ target, state: null }, { coverage: "partial", unknown: ["该格未知"] })
				);
			},
			sections: () => {
				throw new Error("fake facts 未实现 sections（S-W1 切片不使用）");
			},
			entities: () => {
				throw new Error("fake facts 未实现 entities（S-W1 切片不使用）");
			},
			window: () => mkFact<null>(null, { coverage: "partial", unknown: ["window 未就绪"] }),
		};
		return {
			stamp: { ...this.stampState },
			scope: { ...this.scopeState },
			evidenceThrough: { stream: this.stream, sequence: this.evidenceHead },
			value: read(view),
		};
	}

	subscribe(listener: (notice: ClientFactNotice) => void): ClientFactsSubscription {
		this.callLog.push("subscribe");
		const listeners = this.listeners;
		listeners.push(listener);
		return {
			stamp: { ...this.stampState },
			evidenceThrough: { stream: this.stream, sequence: this.evidenceHead },
			acknowledge: (ack: ClientEvidenceAck) => {
				this.acks.push(ack);
			},
			close: () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			},
		};
	}

	// ---- 测试控制面 ----

	private emit(notice: ClientFactNotice): void {
		if (this.closed) return;
		for (const listener of [...this.listeners]) listener(notice);
	}

	private bumpSequence(): number {
		this.stampState = { ...this.stampState, sequence: this.stampState.sequence + 1 };
		return this.stampState.sequence;
	}

	/** 状态提交 + changed 通知（合同顺序：先提交，再排通知）。 */
	setSelf(value: SelfState | null, changedRefs: Ref[] = ["fact:self"], opts?: { observedAt?: string }): void {
		const seq = this.bumpSequence();
		this.selfFact = mkFact(value, {
			observedAt: opts?.observedAt ?? this.selfFact.observedAt,
			coverage: value === null ? "partial" : "complete",
			unknown: value === null ? ["self 不可用"] : [],
		});
		this.emit({ kind: "changed", stamp: { ...this.stampState }, changed: changedRefs });
		void seq;
	}

	setInventory(value: ClientInventoryValue | null, changedRefs: Ref[] = ["fact:inventory"]): void {
		this.bumpSequence();
		this.inventoryFact = mkFact(value, {
			coverage: value === null ? "partial" : "complete",
			unknown: value === null ? ["inventory 不可用"] : [],
		});
		this.emit({ kind: "changed", stamp: { ...this.stampState }, changed: changedRefs });
	}

	/** 状态提交但不发通知：模拟通知排队/丢失，驱动 World 检查点保守失效。 */
	commitWithoutNotice(update: (current: { self: Fact<SelfState | null> }) => void): void {
		this.bumpSequence();
		update({ self: this.selfFact });
	}

	/** 乱序/合并场景：直接发布指定 sequence 的 changed（跳号由测试控制）。 */
	emitChangedAt(sequence: number, changedRefs: Ref[]): void {
		this.stampState = { ...this.stampState, sequence: Math.max(this.stampState.sequence, sequence) };
		this.emit({ kind: "changed", stamp: { ...this.stampState }, changed: changedRefs });
	}

	/** 直接注入原始通知：用于对抗性时序（迟到/乱序/重复）测试。 */
	emitRawNotice(notice: ClientFactNotice): void {
		this.emit(notice);
	}

	setScope(scope: Partial<ClientFactScope>): void {
		this.scopeState = { ...this.scopeState, ...scope };
	}

	setStamp(partial: Partial<ClientFactStamp>): void {
		this.stampState = { ...this.stampState, ...partial };
	}

	/** Driver reset：合同定义的源断裂通知。 */
	emitReset(reason: "connection_changed" | "incarnation_changed" | "source_rebuilt" | "gap", nextEpoch?: string): void {
		if (nextEpoch) this.stampState = { ...this.stampState, epoch: nextEpoch };
		this.emit({ kind: "reset", stamp: { ...this.stampState }, reason });
	}

	/** 交付一批捕获证据（mark.sequence 为源 E）。 */
	emitEvidence(records: CapturedClientFact[]): void {
		this.emit({ kind: "evidence", records });
		for (const record of records) this.evidenceHead = Math.max(this.evidenceHead, record.mark.sequence);
	}

	emitGap(ref: Ref, stream: Ref, after: number, through: number | null, reason = "源缓存丢失"): void {
		this.emit({ kind: "evidence_gap", ref, stream, after, through, reason });
	}

	emitEnd(through: ClientEvidenceMark): void {
		this.emit({ kind: "evidence_end", through });
	}

	currentStamp(): ClientFactStamp {
		return { ...this.stampState };
	}

	closePort(): void {
		this.closed = true;
	}
}

export function blockTarget(x: number, y: number, z: number, dimension = "minecraft:overworld"): BlockTarget {
	return {
		place: { world: "mcw:world:w1", worldRevision: "mcw:rev:r1", dimension, position: { x, y, z } },
		block: { x, y, z },
	};
}

export function capturedFact(overrides: {
	stream?: Ref;
	sequence: number;
	ref?: Ref;
	schema?: ExactRefAlias;
	fact?: Fact<JsonValueAlias>;
}): CapturedClientFact {
	const stream = overrides.stream ?? "mcw:test:stream:ev1";
	const ref = overrides.ref ?? `${stream}:${overrides.sequence}`;
	return {
		ref,
		schema: overrides.schema ?? "client.inventory@1",
		mark: { stream, sequence: overrides.sequence },
		stamp: {
			source: "mcw:test:source:1",
			epoch: "mcw:test:epoch:e1",
			sequence: overrides.sequence,
			connection: "conn:1",
			incarnation: "inc:1",
		},
		scope: {
			binding: "mcw:binding:b1",
			world: "mcw:world:w1",
			worldRevision: "mcw:rev:r1",
			dimension: "minecraft:overworld",
		},
		fact: overrides.fact ?? mkFact({ note: `evidence-${overrides.sequence}` } as JsonValueAlias),
	};
}

type JsonValueAlias = import("../.uina/worlds/minecraft/contracts/values.js").JsonValue;
type ExactRefAlias = import("../.uina/worlds/minecraft/contracts/values.js").ExactRef;
