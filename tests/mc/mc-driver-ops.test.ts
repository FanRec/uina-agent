import { describe, expect, test } from "vitest";
import { captureFailure, makeBodyHarness, openSignal, ownerT } from "./mc-fake-driver.js";
import type { BodySessionImpl } from "../../.uina/worlds/minecraft/driver/body/session.js";
import { scopedBody } from "../../.uina/worlds/minecraft/runtime/scoped-body.js";
import { EventEmitter } from "node:events";

/**
 * 身体写操作的语义回归（driver.md §7）。
 *
 * drive 中断必须撤销键位和所属使用状态。
 * 采矿/牌面确认与库存选择分别由 mc-body-confirmation、mc-player-inventory 覆盖。
 */

describe("drive：任何退出路径都撤销输入", () => {
	test("a delegated drive once failure releases its own item use without closing the ancestor body", async () => {
		const events = new EventEmitter();
		const h = makeBodyHarness({
			on: events.on.bind(events),
			removeListener: events.removeListener.bind(events),
			setControlState: () => {},
			heldItem: { name: "bow", count: 1 },
		});
		const session = await h.port.acquire(ownerT(1), openSignal());
		const view = scopedBody(session, { signal: openSignal(), owner: ownerT(2), guard: () => {} });
		const pending = captureFailure(view.player.drive({ keys: {}, use: { mode: "once", hand: "main" } }, 1));
		await new Promise((r) => setTimeout(r, 10));
		events.emit("physicsTick");
		expect((await pending).code).toBe("INTERNAL");
		expect(h.bot.usingHeldItem).toBe(true);
		await view.close();
		expect(h.bot.usingHeldItem).toBe(false);
		expect((session as BodySessionImpl).sessionState).toBe("active");
		expect(h.facts.find((f) => f.contract === "body.endUse@1")?.owner).toEqual(ownerT(2));
		await session.close();
	});
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
		expect(deactivated).toBe(0);
		expect(h.facts.some((f) => f.kind === "cleanup" && f.contract === "body.endUse@1")).toBe(true);
	});
});
