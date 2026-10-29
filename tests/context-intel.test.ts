/**
 * 上下文检视数据链路测试：provenance 登记（聚合层）→ context_prepare 事实事件（Subject）
 * → 检视器 overlay 渲染。三层各自钉住契约，防止"登记/广播/展示"任意一环静默断链。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { RequestProjection } from "../src/core/types.js";
import { type ExtensionAPI, ExtensionRunner } from "../src/extensions/runner.js";
import type { RuntimeHooks } from "../src/runtime/hooks.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { ToolBroker } from "../src/tools/broker.js";
import { SubjectHarness } from "./harness/core/subject-harness.js";
import { IsolatedEnv, mockModel } from "./harness/index.js";

const envs: IsolatedEnv[] = [];
const runners: ExtensionRunner[] = [];

afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});

async function temp(): Promise<string> {
	const env = await IsolatedEnv.create();
	envs.push(env);
	return env.path;
}

function runner(cwd: string): ExtensionRunner {
	const value = new ExtensionRunner({ cwd, tools: new ToolBroker({ ownerId: "root" }) });
	runners.push(value);
	return value;
}

async function activate(host: ExtensionRunner, id: string, fn: (api: ExtensionAPI) => void): Promise<void> {
	await host.activateBuiltin(id, fn);
}

const baseProjection = (): RequestProjection => ({
	projectionId: "p1",
	modelKey: "mock/mock",
	messages: [
		{ role: "user", content: "one" },
		{ role: "assistant", content: "two" },
		{ role: "user", content: "three" },
	],
	tools: [],
});

describe("extension runner injection provenance", () => {
	it("registers per-extension turn.prepare contributions with extension identity", async () => {
		const host = runner(await temp());
		await activate(host, "a", (api) => {
			api.onHook("turn.prepare", () => ({
				messages: [{ role: "user", content: "hello ledger" }],
			}));
		});
		await activate(host, "b", (api) => {
			api.onHook("turn.prepare", () => ({
				systemPrompt: "CUSTOM PROMPT",
				model: mockModel({ id: "m2", name: "m2", contextWindow: 1_000 }),
				thinkingLevel: "high",
			}));
		});

		const result = await host.runTurnPrepare({ prompt: "hi", systemPrompt: "base" });
		expect(result?.systemPrompt).toBe("CUSTOM PROMPT");
		// provenance 随合并结果单一事实源返回；来源通道由读取位置决定，记录不携带通道标识。
		expect(result?.injections).toEqual([
			{ extension: "builtin:a", kind: "messages", messageCount: 1, chars: 12, preview: "hello ledger" },
			{ extension: "builtin:b", kind: "systemPrompt", chars: 13, preview: "CUSTOM PROMPT" },
			{ extension: "builtin:b", kind: "model", chars: 0, preview: "mock/m2" },
			{ extension: "builtin:b", kind: "thinkingLevel", chars: 0, preview: "high" },
		]);
	});

	it("returns fresh provenance per run without cross-run accumulation", async () => {
		const host = runner(await temp());
		await activate(host, "a", (api) => {
			api.onHook("turn.prepare", () => ({ systemPrompt: "first" }));
		});
		const first = await host.runTurnPrepare({ prompt: "", systemPrompt: "base" });
		expect(first?.injections).toHaveLength(1);

		// 第二次运行的 provenance 只反映本次运行，不跨运行累积。
		const second = await host.runTurnPrepare({ prompt: "", systemPrompt: "base" });
		expect(second?.injections).toHaveLength(1);
		expect(second?.injections[0]).toMatchObject({ extension: "builtin:a", kind: "systemPrompt" });
	});

	it("records effective transformContext steps with signed deltas and tool visibility", async () => {
		const host = runner(await temp());
		await activate(host, "x", (api) => {
			api.onHook("turn.transformContext", (projection) => ({
				projection: {
					...projection,
					messages: [...projection.messages, { role: "user", content: "injected env" }],
					tools: [
						...projection.tools,
						{
							type: "function",
							function: { name: "probe-tool", description: "probe", parameters: { type: "object", properties: {} } },
						} as never,
					],
				},
			}));
		});
		await activate(host, "y", (api) => {
			// 无贡献 handler：不产生登记（登记描述"改了什么"，不是"被询问过"）。
			api.onHook("turn.transformContext", () => undefined);
		});

		const out = await host.runTransformContext(baseProjection());
		expect(out.messages).toHaveLength(4);
		expect(out.tools).toHaveLength(1);
		expect(host.lastTransformInjections()).toEqual([
			{
				extension: "builtin:x",
				kind: "projection",
				messageCount: 1,
				chars: 12,
				preview: "消息 3→4 · 字符 +12 · 工具 +1",
			},
		]);
	});

	it("keeps the transform ledger empty when no extensions register hooks", async () => {
		const host = runner(await temp());
		await expect(host.runTurnPrepare({ prompt: "", systemPrompt: "base" })).resolves.toBeUndefined();
		const out = await host.runTransformContext(baseProjection());
		expect(out.messages).toHaveLength(3);
		expect(host.lastTransformInjections()).toEqual([]);
	});
});

describe("context_prepare event", () => {
	it("broadcasts final systemPrompt and injections once per preparation, before turn_start", async () => {
		const hooks: RuntimeHooks = {
			...NO_RUNTIME_HOOKS,
			turn: {
				...NO_RUNTIME_HOOKS.turn,
				prepare: async () => ({
					systemPrompt: "effective prompt",
					injections: [
						{
							extension: "world",
							kind: "messages",
							messageCount: 2,
							chars: 20,
							preview: "[body 快照]",
						},
					],
				}),
			},
		};
		const harness = SubjectHarness.create({ runtimeHooks: hooks });
		const events: Array<Record<string, unknown>> = [];
		harness.subject.subscribe((event) => {
			if (event.type === "context_prepare") {
				events.push({
					type: event.type,
					turnNumber: event.turnNumber,
					systemPrompt: event.systemPrompt,
					injections: [...event.injections],
				});
			} else {
				events.push({ type: event.type });
			}
		});
		await harness.run("hi");

		const prepares = events.filter((event) => event.type === "context_prepare");
		expect(prepares).toHaveLength(1);
		expect(prepares[0]).toMatchObject({ turnNumber: 1, systemPrompt: "effective prompt" });
		expect(prepares[0].injections).toHaveLength(1);

		const types = events.map((event) => event.type);
		// agent_start 只经 events.emit 进扩展总线（订阅流不可见），此断言锚定的是
		// context_prepare 相对回合事实（turn_start）的单流时序。
		expect(types.indexOf("context_prepare")).toBeLessThan(types.indexOf("turn_start"));
	});

	it("broadcasts zero-injection fact with the base prompt when no hooks exist", async () => {
		const harness = SubjectHarness.create({});
		const seen: Array<{ systemPrompt: string; injections: unknown[] }> = [];
		harness.subject.subscribe((event) => {
			if (event.type === "context_prepare") {
				seen.push({ systemPrompt: event.systemPrompt, injections: [...event.injections] });
			}
		});
		await harness.run("hi");
		expect(seen).toHaveLength(1);
		expect(seen[0].injections).toEqual([]);
		expect(seen[0].systemPrompt.length).toBeGreaterThan(0);
	});
});
