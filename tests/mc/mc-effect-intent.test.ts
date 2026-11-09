import { describe, expect, test } from "vitest";
import type { ControlOwner } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { DriverExecutionSink } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { EffectRecorder } from "../../.uina/worlds/minecraft/driver/execution.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import type { ApplyItem, EffectRow } from "../../.uina/worlds/minecraft/runtime/runtime-db-worker.js";

/**
 * §5.3 崩溃矩阵 / C02–C05 的确定性 T1 证据。
 * 用真实 RecordQueue 而不是"调用前就决定成功"的纯状态函数：apply 收到材料
 * 不等于已提交，只有 onDurable 回报的水线才是恢复后可信的事实。
 * "崩溃" = 丢弃当前 writer 实例，只把已 ACK 的 effect 行交给新实例。
 */
const OWNER: ControlOwner = {
	kind: "run",
	run: "run:probe:1",
	segment: "seg:probe:1",
	callId: "call:probe:1",
};
const EFFECT = "eff:probe:1";
const OPERATION = "op:probe:1";
const CONTRACT = "body.window.click@1";

function boot(instance = "rw:probe:1", watermarks: Record<string, number> = {}) {
	const applied: ApplyItem[] = [];
	const queue = new RecordQueue({
		instance,
		mintRecord: () => "rec:probe:1",
		recoveredWatermarks: watermarks,
		apply: (items) => {
			applied.push(...items);
		},
	});
	queue.setQualificationOwner(OWNER);
	return { queue, recorder: new EffectRecorder(queue), applied };
}

function intentRow(applied: ApplyItem[]): EffectRow {
	const mutation = applied.find((item) => item.mutation.kind === "effect_fact")?.mutation;
	if (mutation?.kind !== "effect_fact") throw new Error("no effect_fact was applied");
	return mutation.row;
}

/**
 * 只把编号 ≤ through 的材料算作已提交，其余视为崩溃丢失。
 * effect_fact 在 DB 里按 effect upsert，所以恢复看到的是最后一版累积 facts，
 * 而不是逐条重放；这与 runtime-db-worker 的物化方式一致。
 */
function restart(applied: ApplyItem[], through: number) {
	const next = boot("rw:probe:2", { "rw:probe:1": through });
	const committed = applied
		.slice(0, through)
		.filter(
			(
				item,
			): item is { ticket: ApplyItem["ticket"]; mutation: Extract<ApplyItem["mutation"], { kind: "effect_fact" }> } =>
				item.mutation.kind === "effect_fact",
		);
	const last = committed.at(-1);
	if (last) next.queue.restoreEffect(last.mutation.row);
	return next.queue;
}

/** 等 worker 真的收到第 count 份材料；"已交给 apply" 与 "已提交" 是两件事。 */
async function settled(applied: ApplyItem[], count: number): Promise<void> {
	for (let i = 0; i < 20 && applied.length < count; i++) await Promise.resolve();
	if (applied.length < count) throw new Error(`worker never received batch #${count}`);
}

/** 真实 ACK 只可能发生在 apply 之后；先等 apply，再回报水线。 */
async function commit(queue: RecordQueue, applied: ApplyItem[], through: number): Promise<void> {
	await settled(applied, through);
	queue.onDurable("rw:probe:1", through);
}

describe("Effect 写前意图与崩溃窗口", () => {
	test("派发门等真实 SQLite ACK：intent 未提交前 beforeWrite 不放行", async () => {
		const { queue, recorder } = boot();
		let released = false;
		const gate = recorder.beforeWrite(EFFECT, OPERATION, CONTRACT, { slot: 0 }).then(() => {
			released = true;
		});
		await Promise.resolve();
		await Promise.resolve(); // 让 flush 的 microtask 把材料交给 worker
		expect(released).toBe(false); // 材料已发出但没 ACK，仍不许派发

		queue.onDurable("rw:probe:1", 1);
		await gate;
		expect(released).toBe(true);
	});

	test("C02：intent 被拒收时不派发，恢复没有 effect 行，可判 not_sent", async () => {
		const sink: DriverExecutionSink = {
			record: () => null,
			ensureDurable: async () => {
				throw new Error("should not be reached");
			},
		};
		const recorder = new EffectRecorder(sink);
		await expect(recorder.beforeWrite(EFFECT, OPERATION, CONTRACT)).rejects.toMatchObject({
			name: "CallFailure",
			dispatch: "not_sent",
		});
		expect(recorder.isFaulted).toBe(true);
	});

	test("C02b：intent 已受理但 ACK 丢失 → 不能宣称 not_sent，按 unknown 上报", async () => {
		const sink: DriverExecutionSink = {
			record: () => ({ instance: "rw:lost:1", sequence: 1 }),
			ensureDurable: async () => {
				throw new Error("sqlite ack lost");
			},
		};
		const recorder = new EffectRecorder(sink);
		await expect(recorder.beforeWrite(EFFECT, OPERATION, CONTRACT)).rejects.toMatchObject({
			name: "CallFailure",
			dispatch: "unknown",
			effects: [EFFECT],
		});
		expect(recorder.isFaulted).toBe(true);
	});

	test("C03：intent 已提交、派发前崩溃 → 恢复为 unknown，绝不是 not_sent", async () => {
		const { queue, recorder, applied } = boot();
		const gate = recorder.beforeWrite(EFFECT, OPERATION, CONTRACT, { slot: 0 });
		await commit(queue, applied, 1);
		await gate;

		const row = intentRow(applied);
		const facts = JSON.parse(row.facts) as { kind: string; dispatch: string }[];
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({ kind: "intent", dispatch: "unknown" });

		const recovered = restart(applied, 1);
		expect(recovered.effectRecord(EFFECT)?.latest.dispatch).toBe("unknown");
		expect(recovered.effectRecord(EFFECT)?.latest.completion).toBe("unknown");
		expect(recovered.unknownEffectsFor(OWNER.run)).toEqual([EFFECT]);
	});

	test("C04：包已发但 dispatch 事实没落盘 → 恢复仍按 unknown 对账，不盲重放", async () => {
		const { queue, recorder, applied } = boot();
		const gate = recorder.beforeWrite(EFFECT, OPERATION, CONTRACT);
		await commit(queue, applied, 1);
		await gate;

		// 真实派发发生了，但这条事实没等到 ACK 就崩溃。
		recorder.record(EFFECT, OPERATION, CONTRACT, "dispatch", "sent", "unknown");
		await settled(applied, 2);
		expect(applied.length).toBeGreaterThan(1);

		const recovered = restart(applied, 1); // 只认领已提交的 intent
		expect(recovered.effectRecord(EFFECT)?.latest.dispatch).toBe("unknown");
		expect(recovered.unknownEffectsFor(OWNER.run)).toEqual([EFFECT]);
	});

	test("C05：业务结果已提交但核验未提交 → 旧 Effect 不丢，按已提交事实结算", async () => {
		const { queue, recorder, applied } = boot();
		const gate = recorder.beforeWrite(EFFECT, OPERATION, CONTRACT);
		await commit(queue, applied, 1);
		await gate;
		recorder.record(EFFECT, OPERATION, CONTRACT, "receipt", "sent", "met", { verified: true });
		await commit(queue, applied, 2);

		// appendVerification 未 ACK 就崩溃：已提交的 receipt 仍然是可复用证据。
		queue.appendVerification(EFFECT, {
			record: "rec:probe:2",
			observedAt: new Date().toISOString(),
			verifier: "verify/window@1",
			completion: "met",
			evidence: ["ev:server:1"],
		});
		await settled(applied, 3);

		const recovered = restart(applied, 2);
		expect(recovered.effectRecord(EFFECT)?.latest.completion).toBe("met");
		expect(recovered.unknownEffectsFor(OWNER.run)).toEqual([]);
	});

	test("C06：intent 后明确取消并落终态 → 恢复不再列为未知效果", async () => {
		const { queue, recorder, applied } = boot();
		const gate = recorder.beforeWrite(EFFECT, OPERATION, CONTRACT);
		await commit(queue, applied, 1);
		await gate;
		recorder.record(EFFECT, OPERATION, CONTRACT, "cleanup", "not_sent", "not_met", {
			completionContract: "durable intent closed before dispatch; no click packet was written",
		});
		await commit(queue, applied, 2);

		const recovered = restart(applied, 2);
		expect(recovered.effectRecord(EFFECT)?.latest).toMatchObject({
			dispatch: "not_sent",
			completion: "not_met",
		});
		expect(recovered.unknownEffectsFor(OWNER.run)).toEqual([]);
	});

	test("屏障失败后 recorder 封闭新副作用，不再派发", async () => {
		let durable = false;
		const sink: DriverExecutionSink = {
			record: () => ({ instance: "rw:broken:1", sequence: 1 }),
			ensureDurable: async () => {
				if (!durable) throw new Error("sqlite ack lost");
			},
		};
		const recorder = new EffectRecorder(sink);
		await expect(recorder.beforeWrite(EFFECT, OPERATION, CONTRACT)).rejects.toThrow(/sqlite ack lost/);
		expect(recorder.isFaulted).toBe(true); // 后续 guard 会看到 recorder fault，不再派发
		durable = true;
		await expect(recorder.beforeWrite(EFFECT, OPERATION, CONTRACT)).rejects.toMatchObject({
			name: "CallFailure",
			dispatch: "not_sent",
		});
	});
});
