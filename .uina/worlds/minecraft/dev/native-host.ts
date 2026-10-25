/** Batch 6 acceptance via the real Host/WorldTool/managed process. --model uses existing Provider config. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UinaHost } from "../../../../src/host/host.js";
import type { Model, ModelStreamFn } from "../../../../src/core/types.js";
import type { ToolResultEvent } from "../../../../src/runtime/events.js";
import { WorldActivation } from "../../../../src/extensions/world-framework/world-activation.js";
import type { ExtensionAPI } from "../../../../src/extensions/runner.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { BodyEndpoint } from "../../../../src/extensions/world-framework/seams.js";
import { createMinecraftWorld } from "../worlddef/index.js";
import type { JsonValue } from "../contracts/values.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 15000): Promise<T> {
	const end = Date.now() + ms;
	while (true) {
		const value = await read();
		if (check(value)) return value;
		if (Date.now() > end) throw new Error(`condition timed out: ${JSON.stringify(value)}`);
		await sleep(100);
	}
}
const modelMode = process.argv.includes("--model");
const root = await mkdtemp(join(tmpdir(), modelMode ? "uina-mc-model-" : "uina-mc-native-"));
console.log(`[mc-native] ${modelMode ? "REAL MODEL" : "controlled Provider, REAL Host/Paper"} data=${root}`);
const configPath = join(root, "config.json");
await writeFile(
	configPath,
	JSON.stringify({
		connection: { host: "127.0.0.1", port: 25565, username: "UinaDev", authMode: "offline", version: "1.21.11" },
		binding: { world: "dev-native-world", worldRevision: "native-host-2026-10-25" },
	}),
);
let planned: { id: string; action: string; params: Record<string, unknown> } | null = null;
let modelRequests = 0;
const model: Model = {
	id: "mc-acceptance",
	name: "MC acceptance scripted Provider",
	providerId: "mc-acceptance",
	contextWindow: 128000,
};
const stream: ModelStreamFn = async (_model, _req, delta) => {
	modelRequests++;
	if (planned) {
		const call = planned;
		planned = null;
		delta({
			kind: "tool_call",
			call: { id: call.id, name: "minecraft", args: JSON.stringify({ action: call.action, params: call.params }) },
		});
		delta({ kind: "finish", reason: "tool_calls" });
	} else {
		delta({ kind: "text", text: "Acceptance tool result recorded." });
		delta({ kind: "finish", reason: "stop" });
	}
};
const host = await UinaHost.create({
	cwd: root,
	sessionPath: join(root, "session.jsonl"),
	workspaceTools: false,
	...(modelMode ? {} : { model, stream }),
	profile: {
		identity: { subjectId: "mc-acceptance", displayName: "MC acceptance" },
		personaText: "",
		root,
		settingsDir: root,
		resources: {
			workspace: root,
			memoryRoot: join(root, "memory"),
			stateRoot: join(root, "state"),
			appDataRoot: root,
			cacheRoot: join(root, "cache"),
		},
		sessions: { sessionId: randomUUID(), journalPath: join(root, "session.jsonl") },
	},
	onError: (text) => console.error(`[mc-native] ${text}`),
});
const results = new Map<string, ToolResultEvent>();
const transcript: unknown[] = [];
host.subscribe((event) => {
	if (event.type === "tool_result") {
		results.set(event.callId, event);
		transcript.push(event);
		console.log(
			`[mc-native] tool ${event.args.action ?? event.toolName}: ${event.status} ${event.result.slice(0, 250)}`,
		);
	}
	if (event.type === "usage_update" || event.type === "error" || event.type === "output_end") transcript.push(event);
});
let pi!: ExtensionAPI, context!: ServiceCompanionContext;
const world = createMinecraftWorld({ configPath });
const start = world.onStart!;
world.onStart = async (ctx) => {
	context = ctx;
	await start(ctx);
};
let activation: WorldActivation | undefined;
let passed = 0;
const step = async (name: string, work: () => Promise<void>) => {
	await work();
	passed++;
	console.log(`[mc-native] PASS ${name}`);
};
const direct = async (action: string, params: Record<string, unknown> = {}) => {
	const reply = await host.runToolDirect("minecraft", { action, params });
	if (reply.status !== "succeeded") throw new Error(JSON.stringify(reply));
	return reply.details as Record<string, unknown>;
};
const ask = async (action: string, params: Record<string, unknown>) => {
	const id = randomUUID();
	planned = { id, action, params };
	await host.submitText(`Execute acceptance operation ${id}.`, "direct");
	await host.waitForIdle();
	const reply = results.get(id);
	assert.ok(reply, `no tool result for ${id}`);
	return reply;
};
const finish = async (reply: ToolResultEvent) => {
	const details = reply.details as { kind: string; snapshot: { run: string }; requestId: string };
	if (details.kind === "result") return details;
	assert.equal(details.kind, "accepted", reply.result);
	const result = await ask("runs", { op: "wait", run: details.snapshot.run, timeoutMs: 90000 });
	return result.details as { kind: string; snapshot: { run: string; outcome?: string; completionRef?: string } };
};
try {
	await host.start();
	await host["extensionHost"].activateBuiltin("mc-native-acceptance", (api) => {
		pi = api;
	});
	activation = new WorldActivation(world, {
		pi,
		runtime: { definition: world, enabled: true },
		worldName: world.name,
		notifyExposed() {},
	});
	await activation.start();
	const observe = (selector: string, input: JsonValue = {}) => direct("observe", { selector, input });
	await step("formal Host current connection", async () => {
		await until(
			() => direct("runs", { op: "status" }),
			(s) => (s.side as { connection: string })?.connection === "ready",
		);
		await observe("self@1");
	});
	const command = async (text: string) => {
		await direct("chat", { text });
		await sleep(180);
	};
	await step("prepare dedicated game scene", async () => {
		await command("/gamemode creative UinaDev");
		await command("/tp UinaDev 16000.5 205 16000.5");
		await until(
			() => observe("block@1", { at: { x: 16000, y: 199, z: 16000 } }),
			(o) => (o.value as { block: unknown })?.block != null,
		);
		for (const at of [
			{ x: 15996, y: 199, z: 15996 },
			{ x: 16090, y: 199, z: 16004 },
		])
			await until(
				() => observe("block@1", { at }),
				(o) => (o.value as { block: unknown })?.block != null,
			);
		await command("/fill 15996 199 15996 16090 199 16004 minecraft:stone");
		await command("/fill 15996 200 15996 16030 204 16004 minecraft:air");
		await until(
			() => observe("block@1", { at: { x: 16000, y: 199, z: 16000 } }),
			(o) => (o.value as { block: { name: string } | null }).block?.name === "stone",
		);
		await command("/tp UinaDev 16000.5 200 16000.5");
		await command("/clear UinaDev");
		await command("/fill 16002 200 16000 16002 204 16000 minecraft:oak_log");
		await until(
			() => observe("block@1", { at: { x: 16002, y: 200, z: 16000 } }),
			(o) => (o.value as { block: { name: string } | null }).block?.name === "oak_log",
		);
		await command("/gamemode survival UinaDev");
		await until(
			() => observe("self@1"),
			(o) =>
				(o.value as { onGround: boolean; place: { position: { y: number } } }).onGround === true &&
				Math.abs((o.value as { place: { position: { y: number } } }).place.position.y - 200) < 0.1,
		);
	});
	if (modelMode) {
		console.log(`[mc-native] real model=${host.snapshot().modelName}`);
		for (const task of [
			"你在独立 Minecraft 生存验收区，附近有原木。仅使用 minecraft 工具和它的指南，自行发现需要的能力，采集两根原木并制作至少八块橡木木板。不要使用服务器指令、其他工具或管理员补料。完成后核对库存。",
			"尝试制作一把铁镐，先核对缺料。如果当前材料不足，说明具体差额，然后改为采集原木、制作工作台及一把木镐，并核实实际产物。不要使用服务器指令或管理员补料。",
			"查询你的位置，开始向 x 正方向四十格的导航。工具返回 accepted 后立即显式停止它，等待停止结论并读取固定记录。不要通过取消工具等待代替停止，不使用服务器指令。",
		]) {
			await host.submitText(task, "direct");
			await host.waitForIdle();
			console.log(
				`[mc-native] calibration checkpoint inventory=${JSON.stringify((await observe("inventory@1")).value)}`,
			);
		}
		await step("real model checkpoints captured", async () => {
			assert.ok(transcript.some((e) => (e as { type?: string }).type === "tool_result"));
		});
	} else {
		await step("discover from the actual descriptor catalogue", async () => {
			const r = await ask("describe", { selector: "collect@1" });
			assert.equal(r.status, "succeeded");
			assert.match(r.result, /collect@1/);
		});
		await step("collect and craft through WorldTool, verify actual inventory", async () => {
			let r = await finish(
				await ask("run", { selector: "collect@1", input: { item: "oak_log", count: 1, radius: 8 } }),
			);
			assert.equal((r.snapshot as { outcome?: string }).outcome, "succeeded", JSON.stringify(r));
			r = await finish(await ask("run", { selector: "craft@1", input: { item: "oak_planks", count: 4 } }));
			assert.equal((r.snapshot as { outcome?: string }).outcome, "succeeded", JSON.stringify(r));
			assert.equal(((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks, 4);
		});
		await step("missing materials remain failed in the fixed report", async () => {
			const r = await finish(await ask("run", { selector: "craft@1", input: { item: "iron_pickaxe", count: 1 } }));
			assert.equal((r.snapshot as { outcome?: string }).outcome, "failed");
		});
		await step("background completion is canonical and fixed record is readable", async () => {
			const r = await ask("run", {
				selector: "goto@1",
				input: { at: { x: 16020, y: 200, z: 16000 }, tolerance: 1, maxTimeMs: 30000 },
			});
			assert.equal((r.details as { kind: string }).kind, "accepted", r.result);
			const final = await finish(r);
			const ref = (final.snapshot as { completionRef: string }).completionRef;
			await until(
				() => context.delivery!.inspect(ref),
				(s) => s.kind === "committed",
			);
			assert.equal((await ask("runs", { op: "record", ref })).status, "succeeded");
		});
		await step("explicit request stop and body emergency", async () => {
			const r = await ask("run", {
				selector: "goto@1",
				input: { at: { x: 16080, y: 200, z: 16000 }, tolerance: 1, maxTimeMs: 30000 },
			});
			const request = (r.details as { requestId: string }).requestId;
			await ask("runs", { op: "stop", request });
			const final = await finish(r);
			assert.equal((final.snapshot as { outcome?: string }).outcome, "cancelled");
			const body = [...activation!.exposed.values()][0] as BodyEndpoint;
			await body.safeStop();
			assert.equal(body.state().paused, true);
			await body.resume();
			assert.equal(body.state().paused, false);
		});
		await step("cancelling the tool wait preserves the accepted Run", async () => {
			const abort = new AbortController();
			const waiting = host.runToolDirect(
				"minecraft",
				{
					action: "run",
					params: { selector: "goto@1", input: { at: { x: 16080, y: 200, z: 16000 }, tolerance: 1, maxTimeMs: 30000 } },
				},
				abort.signal,
			);
			const timer = setTimeout(() => abort.abort(), 150);
			const reply = await waiting;
			clearTimeout(timer);
			const accepted = reply.details as { kind: string; snapshot: { run: string }; requestId: string };
			assert.equal(accepted.kind, "accepted", JSON.stringify(reply));
			assert.notEqual((await direct("runs", { op: "status", run: accepted.snapshot.run })).phase, "finished");
			await direct("runs", { op: "stop", request: accepted.requestId });
			const stopped = await direct("runs", { op: "wait", run: accepted.snapshot.run, timeoutMs: 10000 });
			assert.equal((stopped.snapshot as { outcome: string }).outcome, "cancelled");
		});
	}
	await step("activation stop closes managed process and endpoint", async () => {
		await activation!.stop();
		activation = undefined;
	});
} finally {
	await activation?.stop();
	await host.dispose();
	await writeFile(
		join(root, "report.json"),
		JSON.stringify(
			{ mode: modelMode ? "real-model" : "controlled-provider-real-paper", passed, modelRequests, transcript },
			null,
			2,
		),
	);
	console.log(`[mc-native] ${passed} passed; report=${join(root, "report.json")}`);
}
