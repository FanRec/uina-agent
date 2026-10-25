import { describe, expect, test } from "vitest";
import type { BodySessionImpl } from "../../.uina/worlds/minecraft/driver/body/session.js";
import {
	awaitClosed,
	captureFailure,
	entityT,
	makeBodyHarness as makeHarness,
	openSignal,
	ownerT,
	placeT,
} from "./mc-fake-driver.js";

/**
 * D7：PlayerPort 资格闸门与 BodySession 写拒绝的确定性单测（不依赖真服/网络）。
 *
 * 以实现事实为准的规格裁剪：
 * - PlayerPort.acquire 无排队语义：资格未释放时第二次 acquire 立即 CONTROL_CONFLICT
 *   （FIFO 排队在 runtime 的 BodyLeaseQueue 层，不在本文件范围）。
 * - 屏障不成立（§10.5）绑定"会话所属连接"：同连接新资格被拒（CONTROL_INVALID），
 *   连接更换后疑虑作废。
 * - "setControlState" 不是独立操作，持续控制经 drive() 安装；chat 不占 Body（合同注释
 *   明示），close 后 chat 仍按旁路派发，不是身体写。
 * 宿主/bot/sink 替身见 mc-fake-driver.ts。
 */

// ---- 资格闸门（PlayerPort.acquire） ----

describe("PlayerPort 资格闸门", () => {
	test("并发 acquire：资格未释放时第二次授予立即 CONTROL_CONFLICT（实现为拒绝，不排队）", async () => {
		const h = makeHarness();
		const first = await h.port.acquire(ownerT(1), openSignal());
		const err = await captureFailure(h.port.acquire(ownerT(2), openSignal()));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_CONFLICT");
		expect(err.source).toBe("capability");
		expect(err.dispatch).toBe("not_sent");
		expect(err.recoverable).toBe(false);
		await first.close();
	});

	test("goto 受控独占期间拒绝新资格；Body 持有期间 goto 槽同样被拒", async () => {
		const h = makeHarness();
		expect(h.arbiter.tryClaimGoto()).toBe(true);
		const err = await captureFailure(h.port.acquire(ownerT(1), openSignal()));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_CONFLICT");
		h.arbiter.releaseGoto();
		const session = await h.port.acquire(ownerT(1), openSignal());
		expect(h.arbiter.tryClaimGoto()).toBe(false);
		await session.close();
	});

	test("close 释放后可再次授予（同 owner 与异 owner）", async () => {
		const h = makeHarness();
		const first = await h.port.acquire(ownerT(1), openSignal());
		await first.close();
		const second = await h.port.acquire(ownerT(1), openSignal());
		expect(second).toBeDefined();
		await second.close();
		const third = await h.port.acquire(ownerT(2), openSignal());
		expect(third).toBeDefined();
		await third.close();
	});

	test("acquire 信号已取消：INTERRUPTED 拒绝且端口恢复可授予", async () => {
		const h = makeHarness();
		const controller = new AbortController();
		controller.abort();
		const err = await captureFailure(h.port.acquire(ownerT(1), controller.signal));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("INTERRUPTED");
		expect(err.dispatch).toBe("not_sent");
		const session = await h.port.acquire(ownerT(1), openSignal());
		expect(session).toBeDefined();
		await session.close();
	});

	test("信号中途取消（revoke）：drive 立即拒绝，会话退役后端口可再次授予", async () => {
		const h = makeHarness();
		const controller = new AbortController();
		const first = (await h.port.acquire(ownerT(1), controller.signal)) as BodySessionImpl;
		controller.abort();
		const err = await captureFailure(first.drive({ keys: { forward: true } }, 1));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_INVALID");
		expect(err.dispatch).toBe("not_sent");
		expect(err.recoverable).toBe(false);
		await awaitClosed(first);
		const second = await h.port.acquire(ownerT(2), openSignal());
		expect(second).toBeDefined();
		await second.close();
	});
});

// ---- 停止屏障（§10.5） ----

describe("停止屏障", () => {
	test("会话带未结算写操作关闭：同连接拒绝新资格，连接更换后疑虑作废", async () => {
		// A native view update can remain pending: close must not grant another owner
		// 仍无法证明停止屏障 → barrierProven=false 锁存到当时连接。
		const h = makeHarness({
			lookAt: (): Promise<never> => new Promise(() => {}),
		});
		const first = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		// 挂起中的视角更新：尚无结束证据，不能授予同一连接的新资格。
		void first.lookAt({ x: 0, y: 64, z: 0 }).catch(() => {});
		await first.close();

		const err = await captureFailure(h.port.acquire(ownerT(2), openSignal()));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_INVALID");
		expect(err.hint).toContain("reconnect");

		// 连接更换：旧写入随旧连接消亡，疑虑作废，授予成功
		h.setConnection("conn:t2");
		const second = await h.port.acquire(ownerT(2), openSignal());
		expect(second).toBeDefined();
		await second.close();
	});
});

// ---- 资格失效后写拒绝（BodySessionImpl §5.3 写入核验） ----

describe("BodySession 资格失效后写拒绝", () => {
	test("close 后全部身体写操作 CONTROL_INVALID，且不产生任何派发事实", async () => {
		const h = makeHarness();
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		await session.close();
		const attempts: [string, () => Promise<unknown>][] = [
			["drive", () => session.drive({ keys: {} }, 1)],
			["dig", () => session.dig({ place: placeT(), block: { x: 0, y: 64, z: 0 } })],
			["attack", () => session.attack(entityT())],
			["useItem", () => session.useItem("main")],
			["endUse", () => session.endUse()],
			["equip", () => session.equip({ name: "iron_sword" }, "hand")],
			["lookAt", () => session.lookAt({ x: 0, y: 64, z: 0 })],
			["interact", () => session.interact({ target: { place: placeT(), block: { x: 0, y: 64, z: 0 } }, hand: "main" })],
		];
		for (const [name, attempt] of attempts) {
			const err = await captureFailure(attempt());
			expect(err.name, name).toBe("CallFailure");
			expect(err.code, name).toBe("CONTROL_INVALID");
			expect(err.source, name).toBe("capability");
			expect(err.dispatch, name).toBe("not_sent");
			expect(err.recoverable, name).toBe(false);
		}
		// 拒绝发生在 bot 触达之前：效果事实流保持为空（未派发、未记录）
		expect(h.facts).toEqual([]);
	});
});

// ---- chat 旁路（规格差异固化：chat 不占 Body） ----

describe("chat 旁路", () => {
	test("chat 不占 Body：无资格与 close 后均可派发，按 body.chat@1 记录", async () => {
		const h = makeHarness({
			chat: (): void => {},
			supportFeature: (): boolean => false,
		});
		// 从未 acquire 资格，chat 直接可用（1.21.11 非排队版本 → dispatch=sent）
		const receipt = await h.port.chat("hello", openSignal());
		expect(receipt.dispatch).toBe("sent");
		expect(receipt.completion).toBe("met");
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		await session.close();
		const again = await h.port.chat("again", openSignal());
		expect(again.dispatch).toBe("sent");
		expect(h.facts.some((fact) => fact.contract === "body.chat@1")).toBe(true);
	});
});
