import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";

// 上游 lib/goto.js 空路径语义（补丁后）：noPath/timeout 的空 best 路径按对应
// 错误名拒绝；partial 的空 best 只是"还没搜到"，继续等待——旧实现对任何空路径
// path_update 都 resolve 成功（假到达）。
const require = createRequire(import.meta.url);
// lib/goto.js 的 module.exports 就是 goto 函数本体
const gotoFn = require("mineflayer-pathfinder/lib/goto.js") as (bot: unknown, goal: unknown) => Promise<void>;

function fakeBot(): { bot: EventEmitter; goal: object } {
	const bot = new EventEmitter();
	const goal = { id: "goal" };
	(bot as EventEmitter & { pathfinder: object }).pathfinder = {
		setGoal: (g: unknown) => {
			bot.emit("goal_updated", g, false);
		},
	};
	return { bot, goal };
}

async function settled(promise: Promise<void>, ms = 20): Promise<"settled" | "pending"> {
	const winner = await Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
	]);
	return winner;
}

describe("patched goto.js empty-path semantics", () => {
	test("partial with empty best path keeps waiting", async () => {
		const { bot, goal } = fakeBot();
		const promise = gotoFn(bot, goal);
		bot.emit("path_update", { status: "partial", path: [] });
		expect(await settled(promise)).toBe("pending");
		// 最终以 goal_reached 收束（模拟搜索成功后到达）
		bot.emit("goal_reached", goal);
		await expect(promise).resolves.toBeUndefined();
	});

	test("noPath with empty best path rejects NoPath (was a false success)", async () => {
		const { bot, goal } = fakeBot();
		const promise = gotoFn(bot, goal);
		bot.emit("path_update", { status: "noPath", path: [] });
		await expect(promise).rejects.toMatchObject({ name: "NoPath" });
	});

	test("timeout with empty best path rejects Timeout", async () => {
		const { bot, goal } = fakeBot();
		const promise = gotoFn(bot, goal);
		bot.emit("path_update", { status: "timeout", path: [] });
		await expect(promise).rejects.toMatchObject({ name: "Timeout" });
	});

	test("non-empty noPath still rejects NoPath", async () => {
		const { bot, goal } = fakeBot();
		const promise = gotoFn(bot, goal);
		bot.emit("path_update", { status: "noPath", path: [{ x: 1, y: 64, z: 1 }] });
		await expect(promise).rejects.toMatchObject({ name: "NoPath" });
	});
});
