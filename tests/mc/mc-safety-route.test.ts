import { expect, test } from "vitest";
import { safetyNeedsAttention } from "../../.uina/worlds/minecraft/companion/safety-route.js";

test("世界自己关门的取消不用说：模型本来就要走了", () => {
	expect(safetyNeedsAttention("cancelled", null)).toBe(false);
	expect(safetyNeedsAttention("cancelled", "connection")).toBe(false);
});

test("连接变了导致的失效不用说：connection/death 事实已经说了一遍", () => {
	expect(safetyNeedsAttention("invalidated", "connection")).toBe(false);
});

test("没有连接事实承担时，失效必须说", () => {
	// 抢占失败、会话关闭出错、崩溃恢复留下的未结算记录：危险触发过、脱险没跑成，
	// 没有任何别的事实会替它说这句。
	expect(safetyNeedsAttention("invalidated", null)).toBe(true);
});

test("跑完的干预一律要说，无论结果如何、起因是什么", () => {
	for (const ended of ["safe", "blocked", "timeout", "invalidated"] as const)
		expect(safetyNeedsAttention(ended, null)).toBe(true);
	for (const ended of ["safe", "blocked", "timeout"] as const)
		expect(safetyNeedsAttention(ended, "connection")).toBe(true);
});
