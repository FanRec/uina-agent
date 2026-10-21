import { describe, expect, test } from "vitest";
import { projectAvailability } from "../../.uina/worlds/minecraft/world/index.js";
import { makeFactsHarness } from "./mc-fake.js";

/**
 * 可用性三态回归（public-api §5）。
 *
 * 历史缺陷：facts.sample 对"断线"和"尚未连接"都抛同一个 WRONG_STATE，World 一律
 * 映射成 starting —— 断线被读成"还在起步"，调用方会一直等一个不会到来的 ready。
 */

const BINDING = { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" };

function availabilityOf(facts: ReturnType<typeof makeFactsHarness>["facts"]) {
	return projectAvailability({
		probeCurrent: () => {
			facts.sample(() => null);
		},
		historyState: { state: "ready" },
		binding: BINDING,
	});
}

describe("World 可用性投影", () => {
	test("能同步采样：current=ready", () => {
		const h = makeFactsHarness();
		expect(availabilityOf(h.facts).current).toEqual({ state: "ready" });
	});

	test("从未连接：current=starting（还会变好）", () => {
		const h = makeFactsHarness({ state: "connecting" });
		expect(availabilityOf(h.facts).current).toEqual({ state: "starting" });
	});

	test("断线：current=unavailable 并带原因，不再报 starting", () => {
		const h = makeFactsHarness();
		expect(availabilityOf(h.facts).current.state).toBe("ready");
		h.disconnect();
		const current = availabilityOf(h.facts).current;
		expect(current.state).toBe("unavailable");
		expect(current.reason).toContain("disconnected");
	});

	test("故障（faulted）同样映射为 unavailable", () => {
		const h = makeFactsHarness();
		h.setState("faulted");
		expect(availabilityOf(h.facts).current.state).toBe("unavailable");
	});

	test("历史侧 unavailable 携带原因，binding 恒为已绑定", () => {
		const view = projectAvailability({
			probeCurrent: () => {},
			historyState: { state: "unavailable", reason: "storage fatal: disk full" },
			binding: BINDING,
		});
		expect(view.history).toEqual({ state: "unavailable", reason: "storage fatal: disk full" });
		expect(view.binding).toEqual({ state: "bound", ...BINDING });
	});
});
