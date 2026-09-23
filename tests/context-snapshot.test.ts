import { describe, expect, mockModel, SubjectHarness, test } from "./harness/index.js";
import { UinaTestHarness } from "./harness/host/harness.js";
import { Scenario } from "./harness/provider/scenario.js";
import type { Provider } from "../src/core/types.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import type { RuntimeEvent } from "../src/runtime/events.js";

describe("ContextSnapshot", () => {
	test("启动完成后在首条输入前测量完整扩展投影，且不调用 Provider", async ({ env }) => {
		await env.writeExtension("startup-context.mjs", `
			export default function activate(uina) {
				uina.onHook("turn.transformContext", (projection) => ({
					projection: {
						...projection,
						messages: [...projection.messages, { role: "user", content: "界".repeat(2000) }],
					},
				}));
			}
		`);
		const scenario = new Scenario({ id: "mock", name: "mock", contextWindow: 50_000 });
		const uina = await UinaTestHarness.create({ env, scenario, autoStart: false });
		try {
			await uina.start();
			const context = uina.host.snapshot().context;
			const updates = uina.events.filter("context_update");

			expect(scenario.calls).toHaveLength(0);
			expect(context).toMatchObject({ basis: "idle_baseline", measurementKind: "approximate" });
			expect(context?.inputTokens).toBeGreaterThan(2_000);
			expect(updates.at(-1)?.snapshot.projectionId).toBe(context?.projectionId);
		} finally {
			await uina.dispose();
		}
	});

	test("Provider measurer 只校准 ContextSnapshot，不伪装成 RequestUsage", async ({ env }) => {
		const scenario = new Scenario({ id: "exact-model", name: "exact", providerId: "exact-provider", contextWindow: 50_000 });
		const provider: Provider = {
			id: "exact-provider",
			name: "exact",
			stream: scenario.stream,
			measureContext: () => ({ inputTokens: 4_321, kind: "exact", source: "provider-test" }),
		};
		const uina = await UinaTestHarness.create({ env, scenario, hostOptions: { provider } });
		try {
			expect(uina.host.snapshot().context).toMatchObject({
				inputTokens: 4_321,
				measurementKind: "exact",
				source: "provider-test",
			});
			expect(uina.host.subject.getRequestUsage()).toBeUndefined();
			expect(scenario.calls).toHaveLength(0);
		} finally {
			await uina.dispose();
		}
	});

	test("模型切换时迟到的旧投影测量不能覆盖当前 ContextSnapshot", async () => {
		let entered!: () => void;
		const oldEntered = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const oldRelease = new Promise<void>((resolve) => { release = resolve; });
		const extensions = new ExtensionHost();
		extensions.onHook("turn.transformContext", async (projection) => {
			if (projection.modelKey.endsWith("/old")) {
				entered();
				await oldRelease;
			}
			return undefined;
		});
		const harness = SubjectHarness.create({
			model: mockModel({ id: "old", name: "old" }),
			runtimeHooks: createRuntimeHooks(extensions),
		});
		const events: RuntimeEvent[] = [];
		harness.subscribe((event) => events.push(event));

		const stale = harness.subject.getContextSnapshot();
		await oldEntered;
		await harness.subject.setModel(mockModel({ id: "new", name: "new" }));
		release();
		await stale;

		const updates = events.filter((event): event is Extract<RuntimeEvent, { type: "context_update" }> => event.type === "context_update");
		expect(updates).toHaveLength(1);
		expect(updates[0]?.snapshot.modelKey).toMatch(/\/new$/);
		expect(harness.subject.getCurrentContextSnapshot()?.modelKey).toMatch(/\/new$/);
	});
});
