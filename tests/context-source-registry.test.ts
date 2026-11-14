import { describe, expect, it } from "vitest";
import type { ContextRead } from "../src/core/types.js";
import { ContextSourceRegistry, validateContextSource } from "../src/extensions/context-registry.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import { guardRuntimeHooks } from "../src/runtime/guard.js";

const read = (): ContextRead => ({ modelKey: "test/mock", signal: new AbortController().signal });

describe("ContextSourceRegistry", () => {
	it("collect 返回 guidance 与动态 Source 贡献，owner 由注册方注入", async () => {
		const registry = new ContextSourceRegistry();
		registry.register("ext-a", { id: "protocol", kind: "guidance", text: "稳定指引" }, () => true);
		registry.register(
			"ext-b",
			{
				id: "state",
				kind: "observation",
				read: () => ({ text: "在线", source: { type: "ext-b.state", origin: "internal" } }),
			},
			() => true,
		);
		const { contributions, omitted } = await registry.collect(read());
		expect(contributions).toEqual([
			{ key: "ext-a::protocol", owner: "ext-a", kind: "guidance", value: { text: "稳定指引" } },
			{
				key: "ext-b::state",
				owner: "ext-b",
				kind: "observation",
				value: { text: "在线", source: { type: "ext-b.state", origin: "internal" } },
			},
		]);
		expect(omitted).toEqual([]);
	});

	it("同一激活范围重名拒绝；不同扩展同名 id 共存；注销即时撤下", async () => {
		const registry = new ContextSourceRegistry();
		const dispose = registry.register("ext-a", { id: "state", kind: "guidance", text: "A" }, () => true);
		expect(() => registry.register("ext-a", { id: "state", kind: "guidance", text: "重复" }, () => true)).toThrow(
			/重名/,
		);
		registry.register("ext-b", { id: "state", kind: "guidance", text: "B" }, () => true);
		dispose();
		const { contributions } = await registry.collect(read());
		expect(contributions.map((c) => c.key)).toEqual(["ext-b::state"]);
	});

	it("read 抛错：该 Source 记录 error 原因，其余 Source 不受影响", async () => {
		const registry = new ContextSourceRegistry();
		registry.register(
			"bad",
			{
				id: "boom",
				kind: "observation",
				read: () => {
					throw new Error("传感器断开");
				},
			},
			() => true,
		);
		registry.register("good", { id: "g", kind: "guidance", text: "正常" }, () => true);
		const { contributions, omitted } = await registry.collect(read());
		expect(contributions.map((c) => c.key)).toEqual(["good::g"]);
		expect(omitted).toEqual([
			{ key: "bad::boom", owner: "bad", id: "boom", kind: "observation", status: "error", reason: "传感器断开" },
		]);
	});

	it("read 返回 null 如实记录 empty；返回不合法形状记录 error", async () => {
		const registry = new ContextSourceRegistry();
		registry.register("x", { id: "nullish", kind: "observation", read: () => null }, () => true);
		registry.register("y", { id: "garbage", kind: "observation", read: () => 42 as never }, () => true);
		const { contributions, omitted } = await registry.collect(read());
		expect(contributions).toEqual([]);
		// 完成次序不构成承诺；按 id 归一后断言
		expect(omitted.map((o) => [o.id, o.status]).sort()).toEqual([
			["garbage", "error"],
			["nullish", "empty"],
		]);
	});

	it("注册快照在 collect 入口固定：读取期间的新注册不混入本请求（热重载不混代次）", async () => {
		const registry = new ContextSourceRegistry();
		let releaseRead!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		let oldActive = true;
		const disposeOld = registry.register(
			"old",
			{
				id: "slow",
				kind: "observation",
				read: async () => {
					await gate;
					return { text: "旧代次", source: { type: "old.slow", origin: "internal" } };
				},
			},
			() => oldActive,
		);
		const pending = registry.collect(read());
		// 读取途中旧 Source 注销、同 id 新代次注册（模拟 /reload 的卸载-重装次序）
		disposeOld();
		oldActive = false;
		registry.register("old", { id: "slow", kind: "guidance", text: "新代次" }, () => true);
		releaseRead();
		const { contributions, omitted } = await pending;
		// 已冻结的旧作用域：贡献整条省略并记录注销原因；新代次不在入口快照里，本请求不可见
		expect(contributions).toEqual([]);
		expect(omitted[0]!.status).toBe("unregistered");
		const next = await registry.collect(read());
		expect(next.contributions).toEqual([
			{ key: "old::slow", owner: "old", kind: "guidance", value: { text: "新代次" } },
		]);
	});

	it("读取途中注销：该贡献整条省略并记录 unregistered，不得半新半旧", async () => {
		const registry = new ContextSourceRegistry();
		let active = true;
		registry.register(
			"dying",
			{
				id: "state",
				kind: "observation",
				read: async () => {
					active = false; // 读取期间作用域冻结
					return { text: "过期快照", source: { type: "dying.state", origin: "internal" } };
				},
			},
			() => active,
		);
		const { contributions, omitted } = await registry.collect(read());
		expect(contributions).toEqual([]);
		expect(omitted[0]!.status).toBe("unregistered");
		expect(omitted[0]!.reason).toContain("已注销");
	});

	it("scope 过滤只收集可见 owner 的 Source", async () => {
		const registry = new ContextSourceRegistry();
		registry.register("a", { id: "g", kind: "guidance", text: "A" }, () => true);
		registry.register("b", { id: "g", kind: "guidance", text: "B" }, () => true);
		const { contributions } = await registry.collect(read(), ["b"]);
		expect(contributions.map((c) => c.value.text)).toEqual(["B"]);
	});

	it("注册边界校验拒绝空 id、空 guidance 正文、未知 kind 与保留分隔符", () => {
		expect(() => validateContextSource({ id: "  ", kind: "guidance", text: "x" } as never)).toThrow(/id/);
		expect(() => validateContextSource({ id: "g", kind: "guidance", text: "  " } as never)).toThrow(/text/);
		expect(() => validateContextSource({ id: "g", kind: "memo", text: "x" } as never)).toThrow(/kind/);
		// capability 注入种类已删除（S7.1）：旧 kind 必须被拒绝，不留两条注册事实。
		expect(() => validateContextSource({ id: "g", kind: "capability", read: () => null } as never)).toThrow(/kind/);
		expect(() => validateContextSource({ id: "g", kind: "observation" } as never)).toThrow(/read/);
		// "::" 是注册键分隔符：id 含它会让 key 无法唯一还原为 owner/id
		expect(() => validateContextSource({ id: "a::b", kind: "guidance", text: "x" } as never)).toThrow(/分隔符/);
		const registry = new ContextSourceRegistry();
		expect(() => registry.register("bad::owner", { id: "g", kind: "guidance", text: "x" }, () => true)).toThrow(/"::"/);
	});

	it("ExtensionHost 端口（provideContext → runCollectContext）与 createRuntimeHooks 导线一致", async () => {
		class Host extends ExtensionHost {}
		const host = new Host();
		const dispose = host.provideContext("ext-a", { id: "g", kind: "guidance", text: "经端口注册" }, () => true);
		const hooks = createRuntimeHooks(host);
		const collection = await hooks.context.collect(read());
		expect(collection.contributions).toEqual([
			{ key: "ext-a::g", owner: "ext-a", kind: "guidance", value: { text: "经端口注册" } },
		]);
		dispose();
		const afterDispose = await createRuntimeHooks(host).context.collect(read());
		expect(afterDispose.contributions).toEqual([]);
	});

	it("Source 结构经 guard 边界深冻结：runtimeHooks 的 collect 返回值不可变", async () => {
		class Host extends ExtensionHost {}
		const host = new Host();
		host.provideContext("a", { id: "g", kind: "guidance", text: "冻结" }, () => true);
		const hooks = guardRuntimeHooks(createRuntimeHooks(host));
		const { contributions, omitted } = await hooks.context.collect(read());
		expect(Object.isFrozen(contributions)).toBe(true);
		expect(Object.isFrozen(omitted)).toBe(true);
	});
});
