import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { ToolBroker } from "../src/tools/broker.js";
import type { ModelRequest, ModelStreamFn } from "../src/core/types.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import activateMemory, { MEMORY_ENTRY_TYPE } from "./helpers/memory-capability.js";
import { Scenario, mockModel, SubjectHarness } from "./harness/index.js";

/**
 * Memory 派生实验（P0 冻结概念 allowlist 的第五关实证）：
 * 一个真实的"持久记忆"能力完全经公开 pi 接缝实现——
 *   turn.prepare（systemPrompt 注入）+ turn.transformContext（上下文注入）
 *   + pi.appendEntry / pi.auxiliary（capability 私有 durable state），
 * 全程零触碰 CanonicalState / session reducer / recovery / Subject 内部。
 */
describe("Memory 派生实验：capability 零内核内碰触", () => {
	it("capability 源码 import 白名单：只允许 ExtensionAPI 类型", async () => {
		const capabilitySource = await readFile(new URL("./helpers/memory-capability.ts", import.meta.url), "utf8");
		const importLines = capabilitySource
			.split("\n")
			.filter((line) => line.trimStart().startsWith("import "))
			.map((line) => line.trim());
		expect(importLines).toEqual(['import type { ExtensionAPI } from "../../src/extensions/runner.js";']);
		// 双保险：整份源码不得出现内核内部词汇。
		for (const forbidden of ["recovery", "CanonicalState", "canonicalReplay", "Subject", "session/", "store.state", "safeTargets"]) {
			expect(capabilitySource, `不得引用 ${forbidden}`).not.toContain(forbidden);
		}
	});

	it("记忆经 auxiliary 落盘、经 prepare/transformContext 生效，且不进主线与 safeTargets", async () => {
		const store = new MemorySessionStore();
		const runner = new ExtensionRunner({
			cwd: process.cwd(),
			tools: new ToolBroker(),
			history: () => store.state.entries,
			auxiliary: () => store.state.auxiliary,
			emitRuntimeEvent: async () => {},
			onCustomEntry: (entry) => store.appendCustomEntry(entry),
		});
		await runner.activateBuiltin("memory", activateMemory);
		const hooks = createRuntimeHooks(runner);

		const requests: ModelRequest[] = [];
		const scenario = Scenario.create().reply("ack");
		const stream: ModelStreamFn = async (model, req, onDelta, signal) => {
			requests.push(req as ModelRequest);
			return scenario.stream(model, req, onDelta, signal);
		};

		const harness = SubjectHarness.create({
			model: mockModel(),
			stream,
			store,
			runtimeHooks: hooks,
		});

		// 1. 记住一条事实：/remember → pi.appendEntry → auxiliary（非主线）。
		const remember = runner.registry.getCommand("remember");
		expect(remember?.handler).toBeDefined();
		await remember!.handler!("用户偏好简洁回复");

		expect(store.state.auxiliary.map((r) => (r as { customType?: string }).customType)).toEqual([MEMORY_ENTRY_TYPE]);
		expect(store.state.entries.some((entry) => (entry as { kind: string }).kind === "custom_entry")).toBe(false);
		for (const record of store.state.auxiliary) {
			expect(store.state.safeTargets.has(record.id)).toBe(false);
		}

		// 2. 跑一回合：prepare 注入 systemPrompt，transformContext 注入记忆上下文。
		await harness.run("你好");

		expect(requests).toHaveLength(1);
		expect(requests[0]!.messages.some((m) => m.role === "system" && (m.content as string).includes("[已知记忆]"))).toBe(true);
		expect(requests[0]!.messages.some((m) => m.role === "system" && (m.content as string).includes("用户偏好简洁回复"))).toBe(true);
		expect(requests[0]!.messages.some((m) => (m.content as string).includes("[记忆上下文] 用户偏好简洁回复"))).toBe(true);

		// 3. 回溯不影响 capability 私有状态：auxiliary 只增不减，重读仍可得。
		const targetId = store.state.entries[0]!.id;
		await store.appendRewind({ id: "r1", requestId: "q1", targetId, fromId: store.state.entries.at(-1)!.id, source: "test", reason: "derivation" });
		await remember!.handler!("回溯后新增的记忆");
		expect(store.state.auxiliary).toHaveLength(2);
		expect(store.state.entries.some((entry) => (entry as { kind: string }).kind === "custom_entry")).toBe(false);

		// 4. 派生测试的零内碰是文件级断言：memory-capability.ts 的 import 白名单
		// 即第一个 it 的内容——本测试其余部分证明行为面全部经 pi 公开接缝。
	});
});
