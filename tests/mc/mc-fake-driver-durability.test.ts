/**
 * 共享 harness 的写前屏障必须由测试显式确认。
 *
 * 原实现是 `async ensureDurable() {}`，任何走 `beforeWrite()` 的用例都会默认拿到
 * "已持久"，屏障时序在测试里等于不存在。改成受控门闩后，"忘了 ack"会挂起成红，
 * 而不是悄悄变成假绿。
 */
import { describe, expect, test, vi } from "vitest";
import { makeBodyHarness } from "./mc-fake-driver.js";

describe("共享 harness 的持久屏障", () => {
	test("默认不放行：没有显式确认前 ensureDurable 不 resolve", async () => {
		const h = makeBodyHarness();
		let settled = false;
		void h.sink.ensureDurable({ instance: "rw:t1", sequence: 1 }).then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		h.acknowledgeDurability();
		await vi.waitFor(() => expect(settled).toBe(true));
	});
});
