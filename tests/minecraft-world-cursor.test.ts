/**
 * Minecraft World 历史 cursor 模型：cursor 与读取视图对齐（world.md §6.2、§9）。
 *
 * 不变量：
 * 1. 提交前不唤醒：证据在提交前不可读，提前失效只会让调用方读到同样的历史。
 * 2. 已读到的提交不再通知：cursor 取本页读取边界的提交版本，读取与版本同源。
 * 3. 读取边界之后的提交一定唤醒：宁可多唤醒一次，绝不漏失效。
 *
 * 三条都用闸门存储构造确定窗口，不依赖微任务时序运气。
 */

import { describe, expect, it } from "vitest";
import { createWorld, type WorldHandle } from "../.uina/worlds/minecraft/world/index.js";
import { InvalidationLedger } from "../.uina/worlds/minecraft/world/internal/invalidation.js";
import {
	type AppendOutcome,
	type EvidenceFilter,
	type EvidencePage,
	MemoryWorldStore,
	type StoredEntry,
} from "../.uina/worlds/minecraft/world/internal/store.js";
import { FakeClientFacts, capturedFact } from "./minecraft-world-fake-facts.js";

const HISTORY_QUERY = { ref: "evidence.list@1", input: {} } as const;

/** 追加被闸门挡住：模拟"已接收但未提交"的窗口（durable 与提交版本都未推进）。 */
class GatedAppendStore extends MemoryWorldStore {
	private gate: { promise: Promise<void>; release: () => void } | null = null;

	closeGate(): void {
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.gate = { promise, release };
	}

	openGate(): void {
		const gate = this.gate;
		this.gate = null;
		gate?.release();
	}

	override async append(entries: StoredEntry[]): Promise<AppendOutcome> {
		const gate = this.gate;
		if (gate) await gate.promise;
		return super.append(entries);
	}
}

/**
 * 读取被闸门挡住。takeAtEntry=true 时进入即取页（模拟读取视图早于本次提交），
 * false 时放行后取页（模拟提交已包含在本读取视图内）。
 */
class GatedListStore extends MemoryWorldStore {
	private gate: { promise: Promise<void>; release: () => void } | null = null;

	constructor(private readonly takeAtEntry: boolean) {
		super();
	}

	closeGate(): void {
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.gate = { promise, release };
	}

	openGate(): void {
		const gate = this.gate;
		this.gate = null;
		gate?.release();
	}

	override async listEvidence(filter: EvidenceFilter): Promise<EvidencePage | null> {
		const earlier = this.takeAtEntry ? super.listEvidenceSync(filter) : null;
		const gate = this.gate;
		if (gate) await gate.promise;
		return earlier ?? super.listEvidenceSync(filter);
	}
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

function quiet(pending: Promise<unknown>, ms = 80): Promise<"quiet" | "fired"> {
	return Promise.race([
		pending.then(() => "fired" as const),
		new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), ms)),
	]);
}

function items(observation: { value: unknown }): unknown[] {
	return (observation.value as { items: unknown[] }).items;
}

const controller = () => new AbortController();

describe("minecraft world 历史 cursor 与读取视图对齐", () => {
	it("提交前不唤醒：证据已接收但未持久时，历史 watcher 不被通知", async () => {
		const facts = new FakeClientFacts();
		const store = new GatedAppendStore();
		const world: WorldHandle = await createWorld({ facts, dataDir: "unused-memory" }, { store });
		try {
			const first = await world.read(HISTORY_QUERY);
			const watch = await world.watch(HISTORY_QUERY, first.cursor, controller().signal);
			const pending = watch.next(first.cursor, controller().signal);

			// 接收 → 冲刷步被闸门挡住：尚未提交，历史仍不可读。
			store.closeGate();
			facts.emitEvidence([capturedFact({ sequence: 1 })]);
			expect(await quiet(pending)).toBe("quiet");

			// 提交完成（durable 与提交版本同源推进）→ 唤醒恰好在这一点发生。
			store.openGate();
			const change = await pending;
			expect(change.kind).toBe("changed");
			await watch.close();
		} finally {
			await world.close();
		}
	});

	it("已读到的提交不再通知：读取视图已包含本次提交时首轮 next 静默", async () => {
		const facts = new FakeClientFacts();
		const store = new GatedListStore(false); // 放行后取页：提交进入本读取视图
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store });
		try {
			store.closeGate();
			const readPromise = world.read(HISTORY_QUERY);
			await tick(); // read 已进入读取窗口并停在闸门前
			facts.emitEvidence([capturedFact({ sequence: 1 })]);
			await tick(); // 冲刷提交完成
			store.openGate();

			const observation = await readPromise;
			expect(items(observation)).toHaveLength(1); // 数据确实覆盖了该提交

			const watch = await world.watch(HISTORY_QUERY, observation.cursor, controller().signal);
			const pending = watch.next(observation.cursor, controller().signal);
			expect(await quiet(pending)).toBe("quiet"); // 已看到的版本不重复通知

			// 之后的新提交仍然要唤醒（不因上面的静默失去灵敏度）。
			facts.emitEvidence([capturedFact({ sequence: 2 })]);
			const change = await pending;
			expect(change.kind).toBe("changed");
			await watch.close();
		} finally {
			await world.close();
		}
	});

	it("读取边界之后的提交一定唤醒：本页未包含的提交不被 cursor 吞掉", async () => {
		const facts = new FakeClientFacts();
		const store = new GatedListStore(true); // 进入即取页：读取窗口内的提交不在本页
		const world = await createWorld({ facts, dataDir: "unused-memory" }, { store });
		try {
			store.closeGate();
			const readPromise = world.read(HISTORY_QUERY);
			await tick();
			facts.emitEvidence([capturedFact({ sequence: 1 })]);
			await tick();
			store.openGate();

			const observation = await readPromise;
			expect(items(observation)).toHaveLength(0); // 本页不含该提交

			const watch = await world.watch(HISTORY_QUERY, observation.cursor, controller().signal);
			const change = await watch.next(observation.cursor, controller().signal);
			expect(change.kind).toBe("changed"); // cursor 未覆盖它 → 必须交付
			await watch.close();
		} finally {
			await world.close();
		}
	});
});

describe("minecraft world 失效水位不变量（单元）", () => {
	it("两类水位量纲不可比：混声明依赖在组合机制激活前被显式拒绝（不静默漏失效）", () => {
		const ledger = new InvalidationLedger("b1");
		const mixed = new Set(["current", "history"] as const);
		expect(() => ledger.ensureStream("mcw:q:mixed", mixed)).toThrow(/不支持混合依赖/);
		expect(() => ledger.createRegistration("mcw:q:mixed", mixed)).toThrow(/不支持混合依赖/);
	});

	it("历史流登记基线取当前提交版本：不为流建立前的事件凭空唤醒", () => {
		const ledger = new InvalidationLedger("b1");
		ledger.advanceHistory(7); // 流建立前已有提交
		const deps = new Set(["history"] as const);
		ledger.ensureStream("mcw:q:h", deps);
		expect(ledger.watermark("mcw:q:h", deps)).toBe(7);
		// 登记（watch）以 read 的 cursor（视图版本 7）为基准：水位相同 → 不自激。
		const registration = ledger.createRegistration("mcw:q:h", deps);
		expect(registration.check({ stream: "mcw:q:h", epoch: ledger.epoch, sequence: 7 })).toBeNull();
		// 提交版本前进 → 唤醒。
		ledger.advanceHistory(8);
		const change = registration.check({ stream: "mcw:q:h", epoch: ledger.epoch, sequence: 7 });
		expect(change?.kind).toBe("changed");
		registration.close();
	});
});
