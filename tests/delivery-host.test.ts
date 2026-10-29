import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { ServiceCompanionContext, WorldDef } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { IsolatedEnv, Scenario, UinaTestHarness } from "./harness/index.js";

describe("Host delivery binding", () => {
	it("binds world input and tool to one namespace and restores receipts after a real Host restart", async () => {
		const env = await IsolatedEnv.create();
		const scenario = new Scenario().callTool("deliveryworld", { action: "report" }).reply("done");
		const h = await UinaTestHarness.create({ env, scenario });
		let pi!: ExtensionAPI, ctx!: ServiceCompanionContext;
		const def: WorldDef = {
			name: "deliveryworld",
			description: "delivery world",
			onStart(c) {
				ctx = c;
			},
			actions: {
				report: {
					description: "report",
					run: () => ({ result: "fixed report", status: "succeeded", receipt: { key: "tool", attempt: "t1" } }),
				},
			},
		};
		let activation!: WorldActivation;
		try {
			await h.host["extensionHost"].activateBuiltin("delivery-producer", (api) => {
				pi = api;
			});
			activation = new WorldActivation(def, {
				pi,
				runtime: { definition: def, enabled: true },
				worldName: def.name,
				notifyExposed() {},
			});
			await activation.start();
			expect(ctx.delivery!.durability).toBe("durable");
			await ctx.emitEvent!({
				id: "i1",
				type: "completion",
				origin: "internal",
				channel: "world",
				text: "input report",
				receipt: { key: "input", attempt: "i1" },
			});
			await h.waitForIdle();
			expect(await ctx.delivery!.inspect("input")).toMatchObject({ kind: "committed", receipt: { channel: "input" } });
			// The first model turn used the real registered WorldTool.
			expect(await ctx.delivery!.inspect("tool")).toMatchObject({ kind: "committed", receipt: { channel: "tool" } });
			expect(await pi.delivery("other").inspect("tool")).toEqual({ kind: "absent" });
			const original = ctx.delivery!;
			await activation.stop();
			await h.dispose();
			const reopened = await UinaTestHarness.create({ env });
			try {
				await reopened.host["extensionHost"].activateBuiltin("delivery-producer", (api) => {
					pi = api;
				});
				const port = pi.delivery("world:deliveryworld");
				expect(port.namespace).toBe(original.namespace);
				expect(port.session).toBe(original.session);
				expect(await port.inspect("tool")).toEqual(await original.inspect("tool"));
				const nextSession = await UinaTestHarness.create({
					env,
					hostOptions: { sessionPath: env.resolve("next-session.jsonl") },
				});
				try {
					const nextPort = nextSession.host.subject.delivery(original.namespace);
					expect(nextPort.session).not.toBe(original.session);
					expect(await nextPort.inspect("tool")).toEqual({ kind: "absent" });
					await nextSession.host.subject.accept(
						{
							id: "new-presentation",
							text: "same fixed report",
							mode: "followUp",
							source: { kind: "runtime", type: "completion" },
							receipt: { key: "tool", attempt: "new-presentation" },
						},
						{ namespace: original.namespace, isActive: () => true },
					);
					expect(await nextPort.inspect("tool")).toMatchObject({
						kind: "committed",
						receipt: { session: nextPort.session, channel: "input" },
					});
				} finally {
					await nextSession.dispose();
				}
			} finally {
				await reopened.dispose();
			}
		} finally {
			await h.dispose();
			await env.dispose();
		}
	});

	it("does not acknowledge direct tool execution and identifies memory sessions as volatile", async () => {
		const h = await UinaTestHarness.create({ hostOptions: { sessionPath: undefined } });
		try {
			let pi!: ExtensionAPI;
			await h.host["extensionHost"].activateBuiltin("producer", (api) => {
				pi = api;
				api.registerTool({
					def: {
						type: "function",
						function: { name: "direct_receipt", description: "direct", parameters: { type: "object", properties: {} } },
					},
					run: async () => ({ result: "report", status: "succeeded", receipt: { key: "k", attempt: "a" } }),
				});
			});
			expect(pi.delivery().durability).toBe("volatile");
			await h.host.runToolDirect("direct_receipt", {});
			expect(await pi.delivery().inspect("k")).toEqual({ kind: "absent" });
		} finally {
			await h.dispose();
		}
	});
});
