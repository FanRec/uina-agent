import { describe, expect, test } from "vitest";
import type { ControlOwner, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { DriverExecutionFact } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { CallFailure, Ref } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { RuntimeEngine } from "../../.uina/worlds/minecraft/runtime/engine.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { RuntimeRefs } from "../../.uina/worlds/minecraft/runtime/refs.js";
import type { EffectRow, RecoveredRows } from "../../.uina/worlds/minecraft/runtime/runtime-db-worker.js";

// ---- 测试侧最小装配：readRecord 不触达 world/playerPort，传空 stub 即可 ----

function makeEngine(queue: RecordQueue): RuntimeEngine {
	return new RuntimeEngine({
		refs: new RuntimeRefs("t"),
		queue,
		world: {} as WorldPort,
		playerPort: {} as PlayerPort,
		callables: [],
		worldOwner: "world:t:1",
	});
}

function makeQueue(): RecordQueue {
	const refs = new RuntimeRefs("t");
	return new RecordQueue({
		instance: refs.writerInstance(),
		mintRecord: () => refs.record(),
		recoveredWatermarks: {},
		apply: () => {},
	});
}

function fact(overrides: Partial<DriverExecutionFact> = {}): DriverExecutionFact {
	return {
		effect: "eff:t:1",
		operation: "mine@1",
		contract: "world.mine@1",
		observedAt: "2026-01-01T00:00:00.000Z",
		kind: "receipt",
		dispatch: "sent",
		completion: "not_met",
		evidence: ["evidence:t:1"],
		...overrides,
	};
}

function runOwner(): ControlOwner {
	return { kind: "run", run: "run:t:1", segment: "seg:t:1", callId: "call:t:1" };
}

interface EffectValue {
	effect: Ref;
	operation: Ref;
	record: Ref;
	facts: DriverExecutionFact[];
	latest: { effect: Ref; dispatch: string; completion: string; evidence: Ref[] };
}

// ---- readRecord：eff:/rec: 双口径解析、未知 ref NOT_FOUND ----

describe("readRecord", () => {
	test("未知 ref 抛 CallFailure，code=NOT_FOUND", () => {
		const engine = makeEngine(makeQueue());
		try {
			engine.readRecord("rec:t:999");
			expect.unreachable("readRecord 对未知 ref 应当抛出 CallFailure");
		} catch (err) {
			expect((err as CallFailure).name).toBe("CallFailure");
			expect((err as CallFailure).code).toBe("NOT_FOUND");
			expect((err as CallFailure).dispatch).toBe("not_sent");
		}
	});

	test("活跃内存侧：rec: 效果记录 ref 与 eff: 身份引用双口径均返回 effect 截面", () => {
		const queue = makeQueue();
		const engine = makeEngine(queue);
		queue.setQualificationOwner(runOwner());
		expect(queue.record(fact())).not.toBeNull();

		const attribution = queue.effectRecord("eff:t:1");
		expect(attribution).not.toBeNull();

		// rec: 口径：效果记录 ref（recordIndex 未命中，走队列内存侧反查）
		const viaRecord = engine.readRecord(attribution!.record);
		expect(viaRecord.kind).toBe("effect");
		expect(viaRecord.record).toBe(attribution!.record);
		const recordValue = viaRecord.value as unknown as EffectValue;
		expect(recordValue.effect).toBe("eff:t:1");
		expect(recordValue.latest.dispatch).toBe("sent");
		expect(recordValue.latest.completion).toBe("not_met");

		// eff: 口径：effect 身份引用固定最新已提交效果记录截面
		const viaEffect = engine.readRecord("eff:t:1");
		expect(viaEffect.kind).toBe("effect");
		expect(viaEffect.record).toBe(attribution!.record);
		const effectValue = viaEffect.value as unknown as EffectValue;
		expect(effectValue.operation).toBe("mine@1");
		expect(effectValue.latest.completion).toBe("not_met");
		expect(effectValue.latest.dispatch).toBe("sent");
	});

	test("同一 effect 的第二条 fact：晚到证据不换绑，latest 跟随", () => {
		const queue = makeQueue();
		const engine = makeEngine(queue);
		queue.setQualificationOwner(runOwner());
		queue.record(fact());
		const attribution = queue.effectRecord("eff:t:1");
		expect(attribution).not.toBeNull();

		queue.record(fact({ completion: "met", evidence: ["evidence:t:2"] }));

		const viaEffect = engine.readRecord("eff:t:1");
		expect(viaEffect.kind).toBe("effect");
		// 记录 ref 不换绑
		expect(viaEffect.record).toBe(attribution!.record);
		const value = viaEffect.value as unknown as EffectValue;
		expect(value.facts).toHaveLength(2);
		expect(value.latest.completion).toBe("met");
		expect(value.latest.evidence).toEqual(["evidence:t:2"]);
	});

	test("recover 后：eff: 身份引用仍走 effect 截面（持久效果行）", () => {
		const owner = runOwner();
		const effectRow: EffectRow = {
			effect: "eff:t:9",
			owner: JSON.stringify(owner),
			operation: "place@1",
			record: "rec:t:9",
			facts: JSON.stringify([fact({ effect: "eff:t:9", operation: "place@1", completion: "met" })]),
			verifications: "[]",
		};
		const rows: RecoveredRows = {
			submissions: [],
			stopIntents: [],
			runs: [],
			segments: [],
			calls: [],
			effects: [effectRow],
			records: [],
		};

		const engine = makeEngine(makeQueue());
		engine.recover(rows);

		// eff: 口径：恢复载入的 effect→record 映射
		const viaEffect = engine.readRecord("eff:t:9");
		expect(viaEffect.kind).toBe("effect");
		expect(viaEffect.record).toBe("rec:t:9");
		const effectValue = viaEffect.value as unknown as EffectValue;
		expect(effectValue.operation).toBe("place@1");
		expect(effectValue.latest.completion).toBe("met");

		// rec: 口径：恢复载入的 recordIndex effect 行
		const viaRecord = engine.readRecord("rec:t:9");
		expect(viaRecord.kind).toBe("effect");
		expect(viaRecord.value).toEqual(viaEffect.value);
	});
});
