import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createMinecraftWorld } from "../.uina/worlds/minecraft/worlddef/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { BodyEndpoint } from "../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import { WorldActivation } from "../src/extensions/world-framework/world-activation.js";
import { IsolatedEnv, Scenario, UinaTestHarness } from "./harness/index.js";

test("real Host canonical append acknowledges a native Minecraft completion and closes its managed World", async () => {
	const env = await IsolatedEnv.create();
	const configPath = env.resolve("mc-config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			connection: { host: "127.0.0.1", port: 1, username: "HostReceiptTest", authMode: "offline", version: "1.21.11" },
			binding: null,
		}),
	);
	const h = await UinaTestHarness.create({
		env,
		scenario: new Scenario()
			.callTool("minecraft", { action: "chat", params: { text: "not a server test" } })
			.reply("done"),
	});
	let pi!: ExtensionAPI, ctx!: ServiceCompanionContext;
	const world = createMinecraftWorld({
		configPath,
		executorPolicy: { autoRecover: false, closeGraceMs: 3000 },
		deliveryPolicy: { pollMs: 20 },
	});
	const start = world.onStart!;
	world.onStart = async (c) => {
		ctx = c;
		await start(c);
	};
	let activation: WorldActivation | undefined;
	try {
		await h.host["extensionHost"].activateBuiltin("mc-host-test", (api) => {
			pi = api;
		});
		activation = new WorldActivation(world, {
			pi,
			runtime: { definition: world, enabled: true },
			worldName: world.name,
			notifyExposed() {},
		});
		await activation.start();
		const body = [...activation.exposed.values()][0] as BodyEndpoint;
		expect(body.bodyType).toBe("humanoid");
		expect(body.state().online).toBe(false);
		await h.send("use Minecraft chat once");
		await h.waitForIdle();
		const result = await world.actions.runs!.run(
			{ op: "list", activeOnly: false },
			{ operationIdentity: "world:minecraft/runs", signal: new AbortController().signal },
		);
		const run = (result.details as { items: { run: string; completionRef: string }[] }).items[0]!;
		expect(await ctx.delivery!.inspect(run.completionRef)).toMatchObject({
			kind: "committed",
			receipt: { channel: "tool" },
		});
		// A direct caller never creates a canonical tool result; the identical report must be delivered as input.
		const direct = await h.host.runToolDirect("minecraft", {
			action: "chat",
			params: { text: "direct result needs canonical input" },
		});
		const key = direct.receipt!.key;
		const deadline = Date.now() + 5000;
		while ((await ctx.delivery!.inspect(key)).kind !== "committed") {
			if (Date.now() > deadline) throw new Error("background completion did not enter canonical history");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(await ctx.delivery!.inspect(key)).toMatchObject({ kind: "committed", receipt: { channel: "input" } });
		await h.waitForIdle();
		await body.safeStop();
		expect(body.state().paused).toBe(true);
		await body.resume();
		expect(body.state().paused).toBe(false);
		body.interrupt?.();
		expect(body.state().paused).toBe(false);
		const pending = await h.host.runToolDirect("minecraft", {
			action: "chat",
			params: { text: "activation recovery must not replay this" },
		});
		const pendingKey = pending.receipt!.key;
		await activation.stop();
		activation = undefined;
		await h.dispose();
		const reopened = await UinaTestHarness.create({ env });
		let reopenedActivation: WorldActivation | undefined;
		try {
			await reopened.host["extensionHost"].activateBuiltin("mc-host-test", (api) => {
				pi = api;
			});
			const next = createMinecraftWorld({
				configPath,
				executorPolicy: { autoRecover: false, closeGraceMs: 3000 },
				deliveryPolicy: { pollMs: 20 },
			});
			const nextStart = next.onStart!;
			next.onStart = async (c) => {
				ctx = c;
				await nextStart(c);
			};
			reopenedActivation = new WorldActivation(next, {
				pi,
				runtime: { definition: next, enabled: true },
				worldName: next.name,
				notifyExposed() {},
			});
			await reopenedActivation.start();
			const end = Date.now() + 5000;
			while ((await ctx.delivery!.inspect(pendingKey)).kind !== "committed") {
				if (Date.now() > end) throw new Error("restart did not reconcile pending completion");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const listed = await next.actions.runs!.run(
				{ op: "list", activeOnly: false },
				{ operationIdentity: "world:minecraft/runs", signal: new AbortController().signal },
			);
			expect((listed.details as { items: unknown[] }).items).toHaveLength(3);
			await reopened.waitForIdle();
		} finally {
			await reopenedActivation?.stop();
			await reopened.dispose();
		}
	} finally {
		await activation?.stop();
		await h.dispose();
		await env.dispose();
	}
}, 20000);
