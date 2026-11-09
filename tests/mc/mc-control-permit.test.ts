import { describe, expect, test } from "vitest";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";

/**
 * C09 / §6.2 不变量 3：旧的 close/release 只能操作自己那次授予的资源。
 * 旧实现用两个裸布尔槽，releaseBody() 无条件清零；会话 A 的迟到 close 回调
 * 会把新 owner B 的资格一并抹掉，随后 goto 能拿到 goto 槽，与 B 并行控制同一 Bot。
 * 本文件第一条用例在旧实现下实测为红（tryClaimGoto 返回 true）。
 */
describe("Driver 控制资格的迟到退场", () => {
	test("旧会话迟到的释放不能抹掉新 owner 的资格", () => {
		const arbiter = new DriverControlArbiter();
		const first = arbiter.claim("body");
		expect(first).not.toBeNull();
		arbiter.release(first!); // A 正常退出

		const current = arbiter.claim("body");
		expect(current).not.toBeNull(); // 新 owner B 持有身体

		arbiter.release(first!); // A 的 close 回调迟到，无权释放 B

		expect(arbiter.claim("goto")).toBeNull(); // 否则 Pathfinder 与 B 并行写
		arbiter.release(current!);
		expect(arbiter.claim("goto")).not.toBeNull();
	});

	test("body 与 goto 共用唯一有效资格，重复授予被拒", () => {
		const arbiter = new DriverControlArbiter();
		const body = arbiter.claim("body");
		expect(body).not.toBeNull();
		expect(arbiter.claim("body")).toBeNull();
		expect(arbiter.claim("goto")).toBeNull();
		arbiter.release(body!);
		const goto = arbiter.claim("goto");
		expect(goto).not.toBeNull();
		expect(arbiter.claim("body")).toBeNull();
	});

	test("资格 id 单调递增且退役后不可复活", () => {
		const arbiter = new DriverControlArbiter();
		const a = arbiter.claim("body")!;
		arbiter.release(a);
		const b = arbiter.claim("goto")!;
		expect(b.id).toBeGreaterThan(a.id);
		arbiter.release(b);
		const c = arbiter.claim("body")!;
		expect(c.id).toBeGreaterThan(b.id);
		arbiter.release(a); // 已退役的 permit 复活不了，也影响不到 c
		expect(arbiter.claim("goto")).toBeNull();
	});
});
