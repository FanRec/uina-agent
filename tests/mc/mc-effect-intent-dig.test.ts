/**
 * G34：破坏方块的写前意图门。
 *
 * `runMining` 自己有一套 dispatch 状态机，但原来的 `dispatch = "unknown"` 只是内存
 * 标记——崩溃后连"可能已经开始挖"都没有持久证据。这里钉两件事：
 * 1. startDig 发包那一刻，意图已经是这条 effect 的第一条事实；
 * 2. 意图落不了盘就一次包都不发，失败按 not_sent 收口（不是"挖了但不知道结果"）。
 */
import { expect, test } from "vitest";
import type { BodyOperationDeps } from "../../.uina/worlds/minecraft/driver/body/operation.js";
import { runMining } from "../../.uina/worlds/minecraft/driver/body/mining.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { ProtocolNotice } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";

const target = {
	place: { world: "w", worldRevision: "r", dimension: "overworld", position: { x: 0, y: 64, z: 0 } },
	block: { x: 0, y: 64, z: 0 },
};

function rig(intent: () => Promise<void>) {
	const facts: string[] = [];
	const packets: string[] = [];
	let notify: ((notice: ProtocolNotice) => void) | null = null;
	const deps = {
		guard: () => {},
		mintOp: () => "op:1",
		mintEff: () => "eff:1",
		signal: new AbortController().signal,
		canCleanup: () => false,
		bot: {
			lookAt: async () => {},
			blockAt: () => ({ name: "stone" }),
			digTime: () => 20,
			swingArm: () => {},
		},
		protocol: {
			startDig: () => {
				expect(facts[0]).toBe("intent");
				packets.push("startDig");
			},
			finishDig: () => packets.push("finishDig"),
			cancelDig: () => packets.push("cancelDig"),
			subscribe: (listener: (notice: ProtocolNotice) => void) => {
				notify = listener;
				return () => {};
			},
		},
		recorder: {
			beforeWrite: intent,
			record: (_effect: string, _op: string, _contract: string, phase: string) => {
				facts.push(phase === "dispatch" ? "dispatch" : phase);
			},
		},
	} as unknown as BodyOperationDeps;
	return { deps, facts, packets, emit: (notice: ProtocolNotice) => notify?.(notice) };
}

test("the write intent is durable before startDig and the packet confirms it", async () => {
	const h = rig(async () => {
		h.facts.push("intent");
	});
	const digging = runMining(h.deps, target as never, { aim: "preserve" });
	await Promise.resolve();
	expect(h.facts).toEqual(["intent", "dispatch"]);
	expect(h.packets).toContain("startDig");
	// 只有服务端方块更新能确认：客户端计时到了也只算 unknown。
	h.emit({ kind: "block", position: target.block, air: true } as never);
	expect(await digging).toMatchObject({ dispatch: "sent", completion: "met" });
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
	expect(h.facts).toEqual([]);
});
