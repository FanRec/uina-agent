/**
 * G34：破坏方块的写前意图门。
 *
 * `runMining` 自己有一套 dispatch 状态机，但原来的 `dispatch = "unknown"` 只是内存
 * 标记——崩溃后连"可能已经开始挖"都没有持久证据。这里钉两件事：
 * 1. startDig 发包那一刻，意图已经是这条 effect 的第一条事实；
 * 2. 意图落不了盘就一次包都不发，失败按 not_sent 收口（不是"挖了但不知道结果"）。
 */
import { expect, test } from "vitest";
import type { DriverExecutionFact } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { BodyOperationDeps } from "../../.uina/worlds/minecraft/driver/body/operation.js";
import { EffectRecorder } from "../../.uina/worlds/minecraft/driver/execution.js";
import { runMining } from "../../.uina/worlds/minecraft/driver/body/mining.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { ProtocolNotice } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";

const target = {
	place: { world: "w", worldRevision: "r", dimension: "overworld", position: { x: 0, y: 64, z: 0 } },
	block: { x: 0, y: 64, z: 0 },
};

function rig(intent: () => Promise<void>, options: { blockGone?: () => boolean } = {}) {
	// 用真的 EffectRecorder：写前意图与"意图关闭"都是被测对象，替身会把它们一起假掉。
	const facts: DriverExecutionFact[] = [];
	const packets: string[] = [];
	let notify: ((notice: ProtocolNotice) => void) | null = null;
	// startDig 时"第一条事实必须是 intent"的违规现场；断言在流程被完整 await 之后
	// 做（见 test 1 末尾）。不能在 startDig 回调里直接 expect：抛出的 AssertionError
	// 会被 runMining 的 async 流程吞掉再包成 CallFailure，一旦所属测试已结束就成了
	// file-level unhandled rejection（全套并行时偶发）。
	let intentOrderViolation: string | null = null;
	const deps = {
		guard: () => {},
		mintOp: () => "op:1",
		mintEff: () => "eff:1",
		signal: new AbortController().signal,
		canCleanup: () => false,
		bot: {
			lookAt: async () => {},
			blockAt: () => (options.blockGone?.() ? null : { name: "stone" }),
			digTime: () => 20,
			swingArm: () => {},
		},
		protocol: {
			startDig: () => {
				// 发包瞬间，这条 effect 的第一条事实必须是意图。
				if (facts[0]?.kind !== "intent") intentOrderViolation = JSON.stringify(kinds());
				packets.push("startDig");
			},
			finishDig: () => packets.push("finishDig"),
			cancelDig: () => packets.push("cancelDig"),
			subscribe: (listener: (notice: ProtocolNotice) => void) => {
				notify = listener;
				return () => {};
			},
		},
	} as unknown as BodyOperationDeps;
	const recorder = new EffectRecorder({
		record: (fact) => {
			facts.push(fact);
			return { instance: "rw:test", sequence: facts.length };
		},
		ensureDurable: async () => {},
	});
	const beforeWrite = recorder.beforeWrite.bind(recorder);
	recorder.beforeWrite = async (...args: Parameters<EffectRecorder["beforeWrite"]>) => {
		await intent();
		return beforeWrite(...args);
	};
	deps.recorder = recorder;
	const kinds = () => facts.map((fact) => fact.kind);
	return {
		deps,
		facts,
		kinds,
		packets,
		violation: () => intentOrderViolation,
		emit: (notice: ProtocolNotice) => notify?.(notice),
	};
}

test("the write intent is durable before startDig and the packet confirms it", async () => {
	const h = rig(async () => {});
	const digging = runMining(h.deps, target as never, { aim: "preserve" });
	// 真的 EffectRecorder 里 beforeWrite 还要等一次屏障：排几个 microtask 再断言。
	for (let i = 0; i < 10 && h.kinds().length < 2; i++) await Promise.resolve();
	expect(h.kinds().slice(0, 2)).toEqual(["intent", "dispatch"]);
	expect(h.packets).toContain("startDig");
	// 只有服务端方块更新能确认：客户端计时到了也只算 unknown。
	h.emit({ kind: "block", position: target.block, air: true } as never);
	expect(await digging).toMatchObject({ dispatch: "sent", completion: "met" });
	// 流程已完整收口：此刻 startDig 已经跑过，回读违规现场。
	expect(h.violation(), "startDig fired before the intent fact was recorded").toBeNull();
});

test("a refused intent sends no packet at all and stays not_sent", async () => {
	const h = rig(async () => {
		throw callFailure({
			code: "INTERNAL",
			source: "capability",
			message: "effect intent was not accepted; dispatch is blocked",
			dispatch: "not_sent",
			effects: [],
			recoverable: false,
		});
	});
	await expect(runMining(h.deps, target as never, { aim: "preserve" })).rejects.toMatchObject({
		code: "INTERNAL",
		dispatch: "not_sent",
	});
	expect(h.packets).toHaveLength(0);
	expect(h.kinds()).toEqual([]);
});

test("a target that disappeared during the intent is closed instead of digging air", async () => {
	let gone = false;
	// 意图等盘期间方块被挖掉/换了。
	const h = rig(
		async () => {
			gone = true;
		},
		{ blockGone: () => gone },
	);
	await expect(runMining(h.deps, target as never, { aim: "preserve" })).rejects.toMatchObject({
		code: "NOT_FOUND",
		dispatch: "not_sent",
	});
	// 没发 startDig，也没有只留一条 intent：意图 + 终态两条。
	expect(h.packets).toHaveLength(0);
	expect(h.kinds()).toEqual(["intent", "cleanup"]);
	expect(h.facts[1]).toMatchObject({ dispatch: "not_sent", completion: "not_met", detail: { reason: "NOT_FOUND" } });
});
