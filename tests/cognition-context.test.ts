/**
 * 认知扩展阶段 C / M5：最小召回与瞬态记忆块。
 *
 * 不变量：
 * 1. 自动召回确定性（不调用模型）：取最新用户输入文本 → 中文片段匹配；
 * 2. 无关不注入：无命中时返回 undefined，不输出空模板；
 * 3. 注入量 ≤ memoryBudgetTokens（估算），pinned 优先，超预算内容跳过；
 * 4. 瞬态块不落 journal（transformContext 每请求从当前记录重新生成）；
 * 5. retire/forget 后旧命中被版本与抑制检查排除；
 * 6. scope 由绑定注入：private 内容不出现在其他作用域；
 * 7. 注册为非 tail transformContext（记忆线索在尾帧之前，备忘 §3.1）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type MemoryStore } from "../src/extensions/cognition/memory.js";
import { createContextInjector } from "../src/extensions/cognition/context.js";

let root: string;
let store: MemoryStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "uina-cognition-ctx-"));
	store = createMemoryStore({
		subjectId: "alice",
		memoryRoot: join(root, "memory"),
		stateRoot: join(root, "state"),
		sessionId: "default",
		validateSource: async () => true,
	});
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

const seed = async () => {
	await store.write({
		op: "create",
		record: {
			type: "note",
			basis: "reported",
			title: "Alice 的回复偏好",
			body: "Alice 在该私聊中明确要求先给结论，再按需要展开。",
			scope: { spaceId: "private:alice" },
			sources: [{ sessionId: "default" }],
			pinned: false,
		},
	});
};

describe("M5 召回：相关性与确定性", () => {
	it("相关输入召回偏好并注入；无关输入返回 undefined（不输出空模板）", async () => {
		await seed();
		const injector = createContextInjector({ store, scope: { spaceId: "private:alice" } });

		const related = await injector([
			{ role: "system", content: "契约" },
			{ role: "user", content: "Alice 喜欢什么样的回复格式？" },
		]);
		expect(related).toBeDefined();
		const injected = related!.messages.at(-1)!;
		expect(injected.role).toBe("user");
		expect(String(injected.content)).toContain("先给结论");
		expect(String(injected.content)).toContain("记忆线索");
		// 带 memoryId/scope 的内部信息块，不拼成 system 事实
		expect(String(injected.content)).not.toContain("role\": \"system");

		const unrelated = await injector([
			{ role: "system", content: "契约" },
			{ role: "user", content: "今天天气如何" },
		]);
		expect(unrelated).toBeUndefined();
	});

	it("不修改既有消息数组（纯函数；注入块在末尾）", async () => {
		await seed();
		const injector = createContextInjector({ store, scope: { spaceId: "private:alice" } });
		const original = [{ role: "user", content: "回复偏好" }] as unknown as readonly { role: string; content: unknown }[];
		const snapshot = [...original];
		const result = await injector(original);
		expect(result).toBeDefined();
		expect(original).toEqual(snapshot);
		expect(result!.messages.length).toBe(original.length + 1);
	});

	it("中文片段直接匹配（无分词、无模型）", async () => {
		await seed();
		const injector = createContextInjector({ store, scope: { spaceId: "private:alice" } });
		// 中文无空格查询按整串做子串匹配（备忘 §3.4 偏精确）：查询取正文的连续片段。
		const result = await injector([{ role: "user", content: "先给结论" }]);
		expect(result).toBeDefined();
		expect(String(result!.messages.at(-1)!.content)).toContain("Alice 的回复偏好");
	});
});

describe("M5 召回：scope 隔离与版本排除", () => {
	it("private scope 记录不出现在其他作用域的注入", async () => {
		await seed();
		const injector = createContextInjector({ store, scope: { spaceId: "project:x" } });
		expect(await injector([{ role: "user", content: "回复偏好" }])).toBeUndefined();
	});

	it("retire/forget 后旧命中被排除", async () => {
		const created = await store.write({
			op: "create",
			record: { type: "note", basis: "reported", title: "旧偏好", body: "曾经喜欢长文", scope: {}, sources: [{ sessionId: "default" }], pinned: false },
		});
		if (created.status !== "committed") throw new Error("expected committed");
		const injector = createContextInjector({ store, scope: {} });
		expect(await injector([{ role: "user", content: "喜欢长文" }])).toBeDefined();

		const retired = await store.write({ op: "retire", id: created.id, expectedHash: created.hash, reason: "过时" });
		expect(retired.status).toBe("committed");
		expect(await injector([{ role: "user", content: "喜欢长文" }])).toBeUndefined();

		await store.forget(created.id);
		expect(await injector([{ role: "user", content: "喜欢长文" }])).toBeUndefined();
	});
});

describe("M5 召回：预算", () => {
	it("pinned 优先；超预算内容跳过，总注入量受预算约束", async () => {
		// 两条记录，预算只够一条。
		await store.write({
			op: "create",
			record: { type: "note", basis: "reported", title: "普通记录甲", body: "关于部署流程的说明，内容足够长以占据预算空间。".repeat(6), scope: {}, sources: [{ sessionId: "default" }], pinned: false },
		});
		await store.write({
			op: "create",
			record: { type: "note", basis: "reported", title: "锚点记录乙", body: "乙的锚点内容", scope: {}, sources: [{ sessionId: "default" }], pinned: true },
		});
		const injector = createContextInjector({ store, scope: {}, budgetTokens: 60 });

		const result = await injector([{ role: "user", content: "部署 锚点" }]);
		expect(result).toBeDefined();
		const text = String(result!.messages.at(-1)!.content);
		expect(text).toContain("锚点记录乙");
		expect(text).not.toContain("普通记录甲");
	});
});

describe("M5 装配：activateCognition（Host 接线）", () => {
	it("pi.subject 缺失时明确失败（不降级为静默无记忆）", async () => {
		const { activateCognition } = await import("../src/extensions/cognition/context.js");
		// stub pi：无 subject 绑定 → 激活必须拒绶。
		const stubPi = {} as unknown as import("../src/extensions/runner.js").ExtensionAPI;
		expect(() => activateCognition(stubPi)).toThrow(/subject/);
	});

	it("profile 模式下激活：三工具注册 + transformContext 注入真实生效于模型请求", async () => {
		// activateCognition 第一版绑定主体全局 scope；种子用全局记录验证端到端注入。
		await store.write({
			op: "create",
			record: { type: "note", basis: "reported", title: "Alice 的回复偏好", body: "先给结论，再按需要展开。", scope: {}, sources: [{ sessionId: "default" }], pinned: false },
		});
		const { MemorySessionStore } = await import("../src/session/jsonl-store.js");
		const { ExtensionRunner } = await import("../src/extensions/runner.js");
		const { ToolBroker } = await import("../src/tools/broker.js");
		const { activateCognition } = await import("../src/extensions/cognition/context.js");
		const { createRuntimeHooks } = await import("../src/extensions/runtime-hooks.js");
		const { SubjectHarness, Scenario, mockModel } = await import("./harness/index.js");
		type ModelRequest = import("../src/core/types.js").ModelRequest;
		type ModelStreamFn = import("../src/core/types.js").ModelStreamFn;

		const sessionStore = new MemorySessionStore();
		const runnerBroker = new ToolBroker();
		const runner = new ExtensionRunner({
			cwd: root,
			tools: runnerBroker,
			subjectBinding: { subjectId: "alice", sessionId: "default", memoryRoot: join(root, "memory"), stateRoot: join(root, "state") },
			history: () => sessionStore.state.entries,
			auxiliary: () => sessionStore.state.auxiliary,
			emitRuntimeEvent: async () => {},
		});
		await runner.activateBuiltin("cognition", (pi) => activateCognition(pi));

		// 三工具已注册进 ToolBroker。
		expect(runnerBroker.has("memory_search")).toBe(true);
		expect(runnerBroker.has("memory_read")).toBe(true);
		expect(runnerBroker.has("memory_write")).toBe(true);

		// 跑一回合：注入块出现在模型请求中（非 tail 相位，在消息流内）。
		const requests: ModelRequest[] = [];
		const scenario = Scenario.create().reply("ack");
		const stream: ModelStreamFn = async (model, req, onDelta, signal) => {
			requests.push(req as ModelRequest);
			return scenario.stream(model, req, onDelta, signal);
		};
		const harness = SubjectHarness.create({ model: mockModel(), stream, store: sessionStore, runtimeHooks: createRuntimeHooks(runner) });
		// 匹配器合同（§3.4）：无空格中文整串子串匹配，宁可漏；含正文连续片段才能命中。
		await harness.run("先给结论");

		expect(requests).toHaveLength(1);
		const flat = JSON.stringify(requests[0]!.messages);
		expect(flat).toContain("记忆线索");
		expect(flat).toContain("先给结论");
	});
});
