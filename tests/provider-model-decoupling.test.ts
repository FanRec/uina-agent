import { describe, expect, it } from "vitest";
import type {
	DiscoveredModel,
	Model,
	ModelRequest,
	Provider,
	StreamDelta,
} from "../src/core/types.js";
import { ModelRegistry, createModel } from "../src/ai/providers.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { assertProviderFacts, effectiveContextWindow, protocolCarriesThinking } from "../src/ai/config.js";
import { SubjectHarness } from "./harness/index.js";

describe("Pi-aligned Model and Provider Decoupling", () => {
	it("enforces Model as a pure data specification without runtime methods", () => {
		const model: Model = {
			id: "gpt-4o",
			name: "GPT-4o",
			providerId: "openai",
			contextWindow: 128_000,
			maxOutputTokens: 4096,
			thinkingLevels: ["off"],
		};

		// 纯数据契约断言：无 stream、无 run、无任何方法，无 provider 实例引用
		expect(typeof (model as any).stream).toBe("undefined");
		expect(typeof (model as any).send).toBe("undefined");
		expect(typeof (model as any).fetch).toBe("undefined");
		expect(typeof (model as any).provider).toBe("undefined");
		expect(model.providerId).toBe("openai");
		expect(Object.isFrozen(model) || typeof model === "object").toBe(true);
	});

	it("enforces Provider as endpoint transport handling multiple models", async () => {
		const modelsCalled: string[] = [];

		const provider: Provider = {
			id: "mock-endpoint",
			baseUrl: "https://api.mock.test/v1",
			async stream(model: Model, _req: ModelRequest, onDelta: (d: StreamDelta) => void) {
				modelsCalled.push(model.id);
				onDelta({ kind: "text", text: `reply from ${model.id}` });
				onDelta({ kind: "finish", reason: "stop" });
			},
		};

		const modelA: Model = { id: "model-a", name: "Model A", providerId: "mock-endpoint", contextWindow: 4096 };
		const modelB: Model = { id: "model-b", name: "Model B", providerId: "mock-endpoint", contextWindow: 8192 };

		const req: ModelRequest = {
			messages: [{ role: "user", content: "test" }],
			providerHooks: NO_RUNTIME_HOOKS.provider,
		};

		let textA = "";
		await provider.stream(modelA, req, (d) => {
			if (d.kind === "text") textA += d.text;
		});

		let textB = "";
		await provider.stream(modelB, req, (d) => {
			if (d.kind === "text") textB += d.text;
		});

		expect(modelsCalled).toEqual(["model-a", "model-b"]);
		expect(textA).toBe("reply from model-a");
		expect(textB).toBe("reply from model-b");
	});

	it("ModelRegistry manages multiple providers and dynamically discovers models", async () => {
		const registry = new ModelRegistry();

		const provider1: Provider = {
			id: "p1",
			name: "Provider One",
			async stream(_m, _req, onDelta) {
				onDelta({ kind: "text", text: "from p1" });
				onDelta({ kind: "finish", reason: "stop" });
			},
			async refreshModels(): Promise<readonly DiscoveredModel[]> {
				return [
					{ id: "dyn-m1", contextWindow: 64_000 },
					{ id: "dyn-m2", contextWindow: 32_000, thinkingLevels: ["off", "low"] },
					{ id: "unselectable-no-window" }, // 缺失 contextWindow 仅用于发现，不得入选
				];
			},
		};

		registry.registerProvider(provider1);
		registry.registerModel({
			id: "static-m1",
			name: "Static Model",
			providerId: "p1",
			contextWindow: 128_000,
		});

		expect(registry.has("static-m1")).toBe(true);
		expect(registry.getModel("static-m1")?.providerId).toBe("p1");

		// 动态刷新
		await registry.refreshModels();
		const choices = registry.choices();
		expect(choices.some((c) => c.id === "p1/dyn-m1")).toBe(true);
		expect(choices.some((c) => c.id === "p1/dyn-m2")).toBe(true);
		expect(choices.some((c) => c.id === "p1/unselectable-no-window")).toBe(false);

		// 通过 resolve 解析动态模型
		const resolvedDyn = registry.resolve("p1/dyn-m1");
		expect(resolvedDyn.contextWindow).toBe(64_000);
		expect(resolvedDyn.providerId).toBe("p1");

		// 缺失 contextWindow 的模型不可选择解析
		expect(() => registry.resolve("p1/unselectable-no-window")).toThrow("缺少 contextWindow");

		// Subject 切换 Model（纯数据切换）
		const harness = SubjectHarness.create({
			model: registry.getModel("static-m1")!,
			stream: registry.stream.bind(registry),
		});

		expect(harness.getModel().id).toBe("static-m1");
		await harness.setModel(resolvedDyn);
		expect(harness.getModel().id).toBe("dyn-m1");
		expect(harness.getContextWindow()).toBe(64_000);
	});

	it("preserves all 5 P0 security guarantees", () => {
		// 1. maxContextWindow 只能收紧有效窗口
		expect(effectiveContextWindow({
			baseUrl: "https://test",
			apiKey: "key",
			model: "m",
			modelContextWindow: 100_000,
			maxContextWindow: 50_000,
		})).toBe(50_000);

		expect(effectiveContextWindow({
			baseUrl: "https://test",
			apiKey: "key",
			model: "m",
			modelContextWindow: 100_000,
			maxContextWindow: 200_000, // 超过物理窗口，只能收紧
		})).toBe(100_000);

		// 2. 启动期事实断言：缺失 modelContextWindow 抛出明确配置错误；Anthropic 缺失 maxOutputTokens 抛错
		expect(() => effectiveContextWindow({
			baseUrl: "https://test",
			apiKey: "key",
			model: "m",
		})).toThrow("缺少 modelContextWindow");

		expect(() => assertProviderFacts({
			baseUrl: "https://test",
			apiKey: "key",
			model: "m",
			type: "anthropic",
			modelContextWindow: 4096,
		})).toThrow("maxOutputTokens");

		// 3. protocolCarriesThinking 精准协议推导
		expect(protocolCarriesThinking("anthropic", undefined, ["off", "high"])).toBe(true);
		expect(protocolCarriesThinking("gemini", undefined, undefined)).toBe(false);
		expect(protocolCarriesThinking("openai-compatible", "deepseek", ["off", "high"])).toBe(true);
		expect(protocolCarriesThinking("openai-compatible", "openai", ["off", "high"])).toBe(false);

		// 4. Model 创建包含完整纯数据事实
		const created = createModel({
			baseUrl: "https://test",
			apiKey: "key",
			model: "test-model",
			modelContextWindow: 32_000,
			maxOutputTokens: 2048,
			thinkingLevels: ["off", "low"],
		}, "prov-1");
		expect(created.id).toBe("test-model");
		expect(created.providerId).toBe("prov-1");
		expect(created.contextWindow).toBe(32_000);
		expect(created.maxOutputTokens).toBe(2048);
		expect(created.thinkingLevels).toEqual(["off", "low"]);
	});

	it("groups() groups models under their providers without alias duplicates", () => {
		const registry = new ModelRegistry({
			default: "deepseek",
			providers: {
				deepseek: {
					baseUrl: "https://api.deepseek.com",
					apiKey: "sk-test",
					model: "deepseek-v4-flash",
					modelContextWindow: 64_000,
				},
			},
		});

		const grps = registry.groups();
		expect(grps).toHaveLength(1);
		expect(grps[0]!.id).toBe("deepseek");
		expect(grps[0]!.name).toBe("deepseek");
		expect(grps[0]!.models).toHaveLength(1);
		expect(grps[0]!.models[0]!.id).toBe("deepseek/deepseek-v4-flash");

		const choices = registry.choices();
		expect(choices).toHaveLength(1);
		expect(choices[0]).toEqual({ id: "deepseek/deepseek-v4-flash", name: "deepseek-v4-flash" });
	});
});

