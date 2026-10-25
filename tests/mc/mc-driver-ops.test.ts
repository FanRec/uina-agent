import { describe, expect, test } from "vitest";
import type { DriverExecutionFact } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { captureFailure, makeBodyHarness, openSignal, ownerT, placeT } from "./mc-fake-driver.js";
import type { BodySessionImpl } from "../../.uina/worlds/minecraft/driver/body/session.js";

/**
 * 身体写操作的语义回归（driver.md §7）。
 *
 * 三个历史缺陷：
 * 1. dig 完成写"server block update confirmed"，但上游在 finishDigging 本地置空即 resolve，
 *    服务端 block update 根本没被观察；dig 失败时又按 dispatch=sent 记（start 可能没发）。
 * 2. drive 只在成功路径撤销键位/释放 hold；停滞看门狗或中断退出时键位留在按下状态，
 *    客户端会一直朝那个方向走。
 * 3. equip 静默忽略 ItemSelector.components，选出的物品可能与要求语义不同。
 */

const TARGET = { place: placeT(), block: { x: 0, y: 64, z: 0 } };

function factsOf(facts: DriverExecutionFact[], kind: string): DriverExecutionFact[] {
	return facts.filter((f) => f.kind === kind);
}

function digBot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		blockAt: () => ({ name: "stone", position: { x: 0, y: 64, z: 0 } }),
		digTime: () => 500,
		targetDigBlock: null,
		stopDigging: () => {},
		...overrides,
	};
}

describe("dig：完成语义如实", () => {
	test("成功：dispatch=sent，完成合同写客户端本地置空，不再声称服务端确认", async () => {
		const h = makeBodyHarness(digBot({ dig: async () => {} }));
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		const receipt = await session.dig(TARGET);
		expect(receipt).toMatchObject({ dispatch: "sent", completion: "met" });

		const receiptFacts = factsOf(h.facts, "receipt");
		expect(receiptFacts).toHaveLength(1);
		const detail = receiptFacts[0]?.detail as Record<string, unknown>;
		// 旧文案 "server block update confirmed" 声称观察到了服务端确认，实际没有
		expect(String(detail.completionContract)).not.toContain("confirmed");
		expect(String(detail.completionContract)).toContain("client world");
		expect(detail.confirmedBy).toBe("client_block_update");
		expect(factsOf(h.facts, "dispatch")[0]?.dispatch).toBe("sent");
		await session.close();
	});

	test("失败：start 包是否发出无法区分，如实记 unknown 而不是 sent", async () => {
		const h = makeBodyHarness(digBot({ dig: async () => Promise.reject(new Error("look at failed")) }));
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		const err = await captureFailure(session.dig(TARGET));
		expect(err.code).toBe("INTERRUPTED");
		expect(err.dispatch).toBe("unknown");
		// 事实层面也不能假称已派发
		expect(factsOf(h.facts, "dispatch")[0]?.dispatch).toBe("unknown");
		expect(factsOf(h.facts, "receipt")).toHaveLength(0);
		await session.close();
	});
});

describe("drive：任何退出路径都撤销输入", () => {
	test("中断退出：键位全部复位，hold 蓄力释放并留下清理事实", async () => {
		const pressed = new Map<string, boolean>();
		let deactivated = 0;
		const h = makeBodyHarness({
			// physicsTick 订阅面：本用例不推进物理步，只验证中断退出路径
			on: () => {},
			removeListener: () => {},
			setControlState: (key: string, value: boolean) => {
				pressed.set(key, value);
			},
			heldItem: { name: "bow", count: 1 },
			activateItem: () => {
				(h.bot as unknown as { usingHeldItem: boolean }).usingHeldItem = true;
			},
			deactivateItem: () => {
				(h.bot as unknown as { usingHeldItem: boolean }).usingHeldItem = false;
				deactivated += 1;
			},
		});
		const bot = h.bot as unknown as { usingHeldItem: boolean };
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		const pending = captureFailure(
			session.drive({ keys: { forward: true, sprint: true }, use: { mode: "hold", hand: "main" } }, 10),
		);
		// 让 drive 进入物理步等待，再中断
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(pressed.get("forward")).toBe(true);
		expect(bot.usingHeldItem).toBe(true);
		await session.close();
		const err = await pending;
		expect(err.name).toBe("CallFailure");
		// 关键：无论失败原因，键位与蓄力都不许残留
		expect(pressed.get("forward")).toBe(false);
		expect(pressed.get("sprint")).toBe(false);
		expect(bot.usingHeldItem).toBe(false);
		expect(deactivated).toBe(1);
		expect(h.facts.some((f) => f.kind === "cleanup" && f.contract === "body.endUse@1")).toBe(true);
	});
});

describe("equip：未实现的匹配条件显式拒绝", () => {
	test("带 components：INVALID_INPUT 且零事实（在 mint 之前拒绝）", async () => {
		const h = makeBodyHarness({ inventory: { slots: [] } });
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		const err = await captureFailure(session.equip({ name: "iron_sword", components: { damage: 1 } }, "hand"));
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.source).toBe("input");
		expect(err.dispatch).toBe("not_sent");
		expect(h.facts).toEqual([]);
		await session.close();
	});
});
