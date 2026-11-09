/**
 * 写前意图把"读快照"和"发包"之间插进了一次等盘；窗口前态检查（§7.7）不会替调用方
 * 续期。这条用最小替身直接钉住 `runToss` 的次序：意图之后必须重新取一次快照，
 * 否则第一次点击必然拿旧 revision 撞 CONFLICT（真服上就是 `drop@1` 报冲突）。
 */
import { expect, test } from "vitest";
import type { ItemValue } from "../../.uina/worlds/minecraft/contracts/body.js";
import { runToss } from "../../.uina/worlds/minecraft/driver/body/inventory.js";

const stack = { name: "stone", count: 3 } as unknown as ItemValue;

function rig() {
	let revision = 1;
	const snapshots: number[] = [];
	const clicks: number[] = [];
	const facts: string[] = [];
	// itemAt 按槽位下标取值：铺满 45 格，把 3 块石头放在主背包第 12 格里。
	const snapshot = (rev: number) => ({
		revision: rev,
		cursor: null as ItemValue | null,
		slots: Array.from({ length: 45 }, (_unused, slot) => ({ slot, item: slot === 12 ? stack : null })),
	});
	const deps = {
		guard: () => {},
		mintOp: () => "op:1",
		mintEff: () => "eff:1",
		recorder: {
			// 意图落盘期间"服务端又同步了一次"：revision 往前走一格。
			beforeWrite: async () => {
				facts.push("intent");
				revision++;
			},
			record: (_effect: string, _op: string, _contract: string, phase: string) => facts.push(phase),
		},
		window: {
			snapshot: async () => {
				snapshots.push(revision);
				return { value: snapshot(revision) };
			},
			click: async (input: { expectedRevision: number }) => {
				clicks.push(input.expectedRevision);
				return {
					effect: "eff:click",
					dispatch: "sent" as const,
					completion: "met" as const,
					evidence: [],
					confirmed: snapshot(revision),
					needsSnapshot: false,
				};
			},
		},
	} as unknown as Parameters<typeof runToss>[0];
	return { deps, clicks, snapshots, facts };
}

test("runToss re-reads the window after the intent, so the first click is not stale", async () => {
	const h = rig();
	const outcome = await runToss(h.deps, { name: "stone" }, 3);
	expect(h.facts[0]).toBe("intent");
	// 意图前读到 1，意图后被刷新到 2；第一次点击必须用 2。
	expect(h.snapshots.slice(0, 2)).toEqual([1, 2]);
	expect(h.clicks[0]).toBe(2);
	expect(outcome.removed).toEqual({ stone: 3 });
});
