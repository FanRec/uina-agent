/** I2 through formal Host/WorldDef/managed Executor, source or dist. Uses an already running Paper. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UinaHost } from "../../../../src/host/host.js";
import type { Model, ModelStreamFn, RequestUsage } from "../../../../src/core/types.js";
import type { ToolResultEvent } from "../../../../src/runtime/events.js";
import type { ExtensionAPI } from "../../../../src/extensions/runner.js";
import { WorldActivation } from "../../../../src/extensions/world-framework/world-activation.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { createMinecraftWorld } from "../worlddef/index.js";
import type { CallRecord } from "../contracts/runtime.js";
import { i2Scenario } from "./i2-scenario.js";

const modelMode = process.argv.includes("--model");
const durationIndex = process.argv.indexOf("--duration-minutes");
const durationMinutes = durationIndex < 0 ? 0 : Number(process.argv[durationIndex + 1]);
assert.ok(Number.isFinite(durationMinutes) && durationMinutes >= 0, "--duration-minutes needs a non-negative number");
assert.ok(modelMode || durationMinutes === 0, "--duration-minutes is a real --model observation window");
const root = await mkdtemp(join(tmpdir(), modelMode ? "uina-mc-i2-model-" : "uina-mc-i2-"));
const configPath = join(root, "config.json");
const username = "UinaDev";
await writeFile(
	configPath,
	JSON.stringify({
		connection: { host: "127.0.0.1", port: 25565, username, authMode: "offline", version: "1.21.11" },
		binding: { world: "dev-i2-world", worldRevision: "i2-2026-10-26" },
	}),
);
console.log(`[mc-i2] ${modelMode ? "REAL MODEL" : "controlled Provider"}; REAL Host/Paper; data=${root}`);
console.log(
	"[mc-i2] Server is externally owned and will remain running; only UinaDev's bounded 16000 test scene is prepared.",
);
const transcript: unknown[] = [],
	observations: unknown[] = [];
let planned: { id: string; action: string; params: Record<string, unknown> } | null = null;
let providerRequests = 0,
	passed = 0;
const results = new Map<string, ToolResultEvent>();
const usage = new Map<string, RequestUsage>();
const model: Model = {
	id: "mc-i2-acceptance",
	name: "I2 controlled Provider",
	providerId: "mc-i2-acceptance",
	contextWindow: 128000,
};
const stream: ModelStreamFn = async (_model, _request, delta) => {
	providerRequests++;
	if (planned) {
		const call = planned;
		planned = null;
		delta({
			kind: "tool_call",
			call: { id: call.id, name: "minecraft", args: JSON.stringify({ action: call.action, params: call.params }) },
		});
		delta({ kind: "finish", reason: "tool_calls" });
	} else {
		delta({ kind: "text", text: "I2 operation recorded." });
		delta({ kind: "finish", reason: "stop" });
	}
};
const host = await UinaHost.create({
	cwd: root,
	sessionPath: join(root, "session.jsonl"),
	workspaceTools: false,
	...(modelMode ? {} : { model, stream }),
	profile: {
		identity: { subjectId: "mc-i2-acceptance", displayName: "MC I2 acceptance" },
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
	onError: (text) => console.error(`[mc-i2] ${text}`),
});
host.subscribe((event) => {
	if (event.type === "usage_update") usage.set(event.usage.callId, event.usage);
	if (event.type === "tool_result") {
		results.set(event.callId, event);
		transcript.push(event);
		console.log(`[mc-i2] ${event.args.action ?? event.toolName}: ${event.status} ${event.result.slice(0, 200)}`);
	}
	if (event.type === "usage_update" || event.type === "error" || event.type === "output_end") transcript.push(event);
});
let activation: WorldActivation | undefined, pi!: ExtensionAPI, context!: ServiceCompanionContext;
let interrupted = false;
const interrupt = () => {
	interrupted = true;
	host.interrupt();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 20000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (interrupted) throw new Error("I2 acceptance interrupted");
		const value = await read();
		if (check(value)) return value;
		if (Date.now() >= deadline) throw new Error(`I2 condition timed out: ${JSON.stringify(value)}`);
		await sleep(100);
	}
}
const direct = async (action: string, params: Record<string, unknown> = {}) => {
	const reply = await host.runToolDirect("minecraft", { action, params });
	assert.equal(reply.status, "succeeded", JSON.stringify(reply));
	return reply.details as Record<string, unknown>;
};
const ask = async (action: string, params: Record<string, unknown> = {}) => {
	assert.ok(!modelMode, "controlled ask is unavailable in real-model mode");
	const id = randomUUID();
	planned = { id, action, params };
	await host.submitText(`Execute I2 acceptance operation ${id}.`, "direct");
	await host.waitForIdle();
	const result = results.get(id);
	assert.ok(result, `missing I2 tool result ${id}`);
	assert.equal(result.status, "succeeded", JSON.stringify(result));
	return result.details as Record<string, unknown>;
};
const step = async (name: string, work: () => Promise<void>) => {
	await work();
	passed++;
	console.log(`[mc-i2] PASS ${name}`);
};
async function startWorld() {
	const world = createMinecraftWorld({ configPath });
	const start = world.onStart!;
	world.onStart = async (ctx) => {
		context = ctx;
		await start(ctx);
	};
	activation = new WorldActivation(world, {
		pi,
		runtime: { definition: world, enabled: true },
		worldName: world.name,
		notifyExposed() {},
	});
	await activation.start();
	await until(
		() => direct("runs", { op: "status" }),
		(s) => (s.side as { connection?: string })?.connection === "ready",
		45000,
	);
}
async function reopenWorld() {
	await activation!.stop();
	activation = undefined;
	await startWorld();
}
const observe = (selector: string, input: Record<string, unknown> = {}) => direct("observe", { selector, input });
async function prepareScene() {
	const command = (text: string) => direct("chat", { text });
	await command(`/gamemode creative ${username}`);
	await command(`/tp ${username} 16000.5 205 16000.5`);
	await until(
		() => observe("self@1"),
		(r) => Math.abs((r.value as { place: { position: { x: number } } }).place.position.x - 16000.5) < 1,
	);
	for (const at of [
		{ x: 15998, y: 199, z: 15998 },
		{ x: 16006, y: 199, z: 16004 },
	])
		await until(
			() => observe("block@1", { at }),
			(r) => (r.value as { block: unknown }).block !== null,
		);
	await command("/fill 15998 199 15998 16006 199 16004 minecraft:stone");
	for (const wall of [
		"15998 200 15998 16006 201 15998",
		"15998 200 16004 16006 201 16004",
		"15998 200 15999 15998 201 16003",
		"16006 200 15999 16006 201 16003",
	])
		await command(`/fill ${wall} minecraft:glass`);
	await command("/fill 16000 200 15999 16004 204 16002 minecraft:air");
	await command("/fill 16002 200 16000 16002 204 16000 minecraft:oak_log");
	await until(
		() => observe("block@1", { at: { x: 16002, y: 200, z: 16000 } }),
		(r) => (r.value as { block: { name: string } | null }).block?.name === "oak_log",
	);
	await command(`/tp ${username} 16000.5 200 16000.5`);
	await command(`/gamemode survival ${username}`);
	await command(`/effect give ${username} minecraft:instant_health 1 4 true`);
	await until(
		() => observe("self@1"),
		(r) => {
			const v = r.value as { onGround: boolean; place: { position: { y: number } } };
			return v.onGround && Math.abs(v.place.position.y - 200) < 0.1;
		},
	);
}
async function allItems(op: "list" | "calls", params: Record<string, unknown>) {
	const items: Record<string, unknown>[] = [];
	let cursor: string | undefined;
	do {
		const page = await direct("runs", { op, ...params, ...(cursor ? { cursor } : {}) });
		items.push(...(page.items as Record<string, unknown>[]));
		cursor = page.next as string | undefined;
	} while (cursor);
	return items;
}
async function modelScenario() {
	const baseline = ((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks ?? 0;
	const deadline = Date.now() + durationMinutes * 60000;
	console.log(
		`[mc-i2] provider=${host.snapshot().modelName}; observationMinutes=${durationMinutes}; initialPlanks=${baseline}`,
	);
	const autonomousTask = () =>
		host.submitText(
			`仅使用 minecraft 工具完成真实 I2，先阅读短指南，按需 describe。不要服务器指令、管理员补料、其他工具。留在16000附近的围栏测试区，附近原木足够本次生产；本次先完成I2，不另开探险目标。
在附近原木生存区，用普通 JS 程序建立 inventory@1 的 mc.waitUntil，等待木板比当前至少多4；让另一个程序实际采集原木、制作木板供料，不能在持有身体时等待供料。等待成功后调用 mc.decide('需要检查并续段',{tag:'i2-model',target:${baseline + 4}})，确实形成 awaiting_decision。
读取固定记录和 runs.calls；用 library.save 的 from:{run,segment,call} 保存确切程序 Call 为 i2_model_planks。library.get 读回，再用 library.update 完整 source 修改程序，支持只读 mc.checkpoint；续段时必须核对检查点和当前库存，返回 {revision:'v2',checkpoint:mc.checkpoint,inventory:实际库存}。通过 runs.continue {run,decision,entry:{selector:'i2_model_planks'}} 在同一 Run 建新段，核实 named Call 使用修改后的材料，并保留原检查点。不要用新 run 替代 continue。
随后提交一个持有身体、持续 waitUntil 等待的程序。持有身体的最小形状是 async function main(mc){return mc.withBody(async()=>mc.waitUntil({inv:{ref:'inventory@1'}},()=>false));}；先用 runs.status 确认 control=active。普通 withBody 外的 waitUntil 是 control=none，不能抢占它。确认 accepted 和等待后，显式 runs.stop 并核实 cancelled。再提交一个身体持有等待者，用 run.schedule={kind:'preempt_current',expectedRun:等待者Run} 提交替代程序，核实旧者取消且替代程序成功。完成后核实真实库存比初始至少多8块木板（初始${baseline}），可以再采集制作，不要只复述计划。
${durationMinutes > 0 ? `本次观察窗口截至 ${new Date(deadline).toISOString()}。核心I2完成后，自主选择当前现场能完成的后续生存目标，利用实际观察与通知推进；需要判断时用decide和continue，不做空转、重复探测或虚构工作。可保存有条件的经验。` : "完成后简短报告实际结果与记录引用。"}`,
			"direct",
		);
	const modelGoal = async (text: string) => {
		await host.submitText(text, "direct");
		await host.waitForIdle();
		const failure = transcript.find((event) => (event as { type?: string }).type === "error") as
			| { text?: string }
			| undefined;
		if (failure) throw new Error(failure.text ?? "real model failed");
	};
	const task =
		durationMinutes > 0
			? autonomousTask()
			: (async () => {
					await modelGoal(`仅用 minecraft 工具，在围栏测试区完成I2第一阶段。当前库存木板${baseline}，绝对目标${baseline + 4}。
先用普通JS程序 mc.waitUntil 等待 inventory@1 木板至少${baseline + 4}，等待必须在withBody外；成功后必须执行 mc.decide('材料已备齐',{tag:'i2-model',target:${baseline + 4}})，不要用return代替decide。这个程序先返回accepted后，再运行另一个程序实际collect原木并craft木板供料。核实等待者确实进入awaiting_decision。只完成这一阶段，报告run/decision引用后停止，不探险、不移动出围栏，不继续其他阶段。`);
					const pending = (await allItems("list", { activeOnly: true })).find(
						(run) => run.phase === "awaiting_decision",
					);
					assert.ok(pending, "model stage1 did not create a pending decision");
					await modelGoal(`I2第二阶段：当前真实持久事实是 Run ${pending.run}、Segment ${pending.segment}、Decision ${pending.decision} 待处理。
用runs.calls找该Run确切程序Call，然后library.save通过from:{run,segment,call}保存为i2_model_planks。library.get读回，再library.update完整source修改该文件：新main必须读取只读mc.checkpoint和实际inventory，返回{revision:'v2',checkpoint:mc.checkpoint,inventory:实际库存}。
必须用runs.continue在原Run消费上述decision，entry:{selector:'i2_model_planks'}，不另开run代替续段。核实新段成功且保留tag='i2-model'检查点。只做这一阶段，完成后报告并停止。`);
					await modelGoal(`I2第三阶段：只用minecraft，在围栏内核实库存至少${baseline + 8}木板，不足则正常collect/craft补足，不用管理员命令。
然后验证身体停止与抢占。持有身体的已知API形状是 async function main(mc){return mc.withBody(async()=>{await mc.sleep(600000);});}。先提交这样的持有者，runs.status确认control=active，再runs.stop并核实cancelled。
再提交同样的身体持有者，确认control=active，用run.schedule={kind:'preempt_current',expectedRun:该持有者run}提交一个读取inventory并返回的替代程序，核实旧者cancelled、替代者succeeded。普通withBody外的waitUntil是control=none，不可抢占它。任务结束后停止剩余活动程序，简短报告事实并结束，不做探险或额外等待。`);
				})();

	let modelFailure: unknown;
	const settled = task.catch((error) => {
		modelFailure = error;
	});
	// One real autonomous request; genuine Runtime notifications may wake the Host.
	// The observer never synthesizes model replies or repeatedly injects canned tasks.
	while (Date.now() < deadline) {
		if (interrupted) throw new Error("I2 observation interrupted");
		if (modelFailure) throw modelFailure;
		const current = {
			at: new Date().toISOString(),
			inventory: (await observe("inventory@1")).value,
			platform: await direct("runs", { op: "status" }),
		};
		observations.push(current);
		await sleep(Math.min(10000, deadline - Date.now()));
	}
	if (durationMinutes > 0) host.interrupt();
	await settled;
	if (modelFailure) throw modelFailure;
	await host.waitForIdle();
	const requestError = transcript.find((event) => (event as { type?: string }).type === "error") as
		| { text?: string }
		| undefined;
	if (requestError) throw new Error(`real model request failed: ${requestError.text ?? "see transcript"}`);
	await step("real model material, continuation, inventory and explicit control outcomes", async () => {
		const tools = transcript.filter((e): e is ToolResultEvent => (e as { type?: string }).type === "tool_result");
		const saved = tools.find(
			(t) =>
				t.status === "succeeded" &&
				t.args.action === "library" &&
				(t.args.params as { op?: string; name?: string }).op === "save" &&
				(t.args.params as { name?: string }).name === "i2_model_planks",
		);
		assert.ok(saved, "model did not save exact material");
		const from = (saved.args.params as { from?: { run: string; segment: string; call: string } }).from;
		assert.ok(from, "model material must use save-from");
		const original = (await direct("runs", { op: "record", ref: from.call, format: "inline" })).record as {
			value: CallRecord;
		};
		assert.equal(original.value.run, from.run);
		assert.equal(original.value.segment, from.segment);
		const material = await direct("library", { op: "get", name: "i2_model_planks" });
		assert.notEqual(material.digest, original.value.program?.digest, "model did not modify saved material");
		assert.ok(
			tools.some(
				(t) =>
					t.args.action === "runs" && (t.args.params as { op?: string }).op === "continue" && t.status === "succeeded",
			),
			"model did not continue",
		);
		const runs = await allItems("list", { activeOnly: false });
		let resumed = false,
			decision = false,
			cancelled = false;
		for (const run of runs) {
			const calls = await allItems("calls", { run: run.run });
			cancelled ||= run.outcome === "cancelled" && calls.some((c) => c.implementation === "program");
			for (const call of calls) {
				if (call.implementation !== "program") continue;
				const fixed = (await direct("runs", { op: "record", ref: call.call, format: "inline" })).record as {
					value: CallRecord;
				};
				decision ||= fixed.value.decisionRequest?.code === "NEEDS_DECISION";
				if (
					call.ref === "i2_model_planks" &&
					call.outcome === "succeeded" &&
					fixed.value.program?.digest !== original.value.program?.digest
				) {
					// A later edit or segment cannot change the source/result of this exact Call.
					const returned = fixed.value.value as { revision?: string; checkpoint?: { tag?: string } } | undefined;
					resumed ||=
						returned?.revision === "v2" &&
						returned?.checkpoint?.tag === "i2-model" &&
						new Set(calls.filter((c) => c.parent === null).map((c) => c.segment)).size >= 2;
				}
			}
		}
		assert.ok(decision && resumed, "model did not preserve a real decision checkpoint in the named continuation");
		assert.ok(cancelled, "model did not cancel a real Program");
		assert.ok(
			tools.some(
				(t) => t.args.action === "runs" && (t.args.params as { op?: string }).op === "stop" && t.status === "succeeded",
			),
			"model did not explicitly stop",
		);
		assert.ok(
			tools.some(
				(t) =>
					t.args.action === "run" &&
					(t.args.params as { schedule?: { kind?: string } }).schedule?.kind === "preempt_current" &&
					t.status === "succeeded",
			),
			"model did not explicitly preempt",
		);
		const preemption = tools.find(
			(t) =>
				t.args.action === "run" &&
				(t.args.params as { schedule?: { kind?: string } }).schedule?.kind === "preempt_current" &&
				t.status === "succeeded",
		)!;
		const previousRun = (preemption.args.params as { schedule: { expectedRun: string } }).schedule.expectedRun;
		const replacementRun = (preemption.details as { snapshot: { run: string } }).snapshot.run;
		assert.equal((await direct("runs", { op: "status", run: previousRun })).outcome, "cancelled");
		await until(
			() => direct("runs", { op: "status", run: replacementRun }),
			(r) => r.phase === "finished",
			90000,
		);
		assert.equal((await direct("runs", { op: "status", run: replacementRun })).outcome, "succeeded");
		const finalPlanks =
			((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks ?? 0;
		const observedPlanks = observations.map(
			(sample) => (sample as { inventory?: { counts?: Record<string, number> } }).inventory?.counts?.oak_planks ?? 0,
		);
		const peakPlanks = Math.max(finalPlanks, ...observedPlanks);
		console.log(
			`[mc-i2] production initial=${baseline}, observedPeak=${peakPlanks}, final=${finalPlanks}; later losses remain separate facts`,
		);
		assert.ok(peakPlanks >= baseline + 8, "model did not produce eight observed real planks");
	});
	await step("real model records survive full managed reopen without execution replay", async () => {
		for (const run of await allItems("list", { activeOnly: true })) {
			if (run.phase !== "awaiting_decision") {
				await direct("runs", { op: "stop", run: run.run });
				await until(
					() => direct("runs", { op: "status", run: run.run }),
					(r) => r.phase === "finished",
				);
			}
		}
		await host.waitForIdle();
		const runs = await allItems("list", { activeOnly: false });
		const before = new Map<string, string[]>();
		for (const run of runs)
			before.set(run.run as string, (await allItems("calls", { run: run.run })).map((c) => c.call as string).sort());
		const inventory = ((await observe("inventory@1")).value as { counts: Record<string, number> }).counts;
		await reopenWorld();
		for (const run of runs) {
			assert.deepEqual(
				(await allItems("calls", { run: run.run })).map((c) => c.call as string).sort(),
				before.get(run.run as string),
			);
			const restored = await direct("runs", { op: "status", run: run.run });
			assert.equal(restored.phase, run.phase);
			if (run.phase === "awaiting_decision") assert.equal(restored.decision, run.decision);
		}
		assert.deepEqual(((await observe("inventory@1")).value as { counts: Record<string, number> }).counts, inventory);
	});
}
let failure: unknown;
try {
	await host.start();
	await host["extensionHost"].activateBuiltin("mc-i2-acceptance", (api) => {
		pi = api;
		// This acceptance task explicitly exercises Minecraft alone. Keep unrelated
		// shell/session tools out of the model request through the public hook.
		if (modelMode)
			api.onHook("turn.transformContext", (projection) => ({
				projection: { ...projection, tools: projection.tools.filter((tool) => tool.function.name === "minecraft") },
			}));
	});
	await startWorld();
	await step("bounded dedicated survival scene is observed", prepareScene);
	if (modelMode) await modelScenario();
	else
		await i2Scenario({
			direct: ask,
			step,
			until,
			reopen: reopenWorld,
		});
} catch (error) {
	failure = error;
	throw error;
} finally {
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", interrupt);
	host.interrupt();
	try {
		await activation?.stop();
	} finally {
		await host.dispose();
		await writeFile(
			join(root, "report.json"),
			JSON.stringify(
				{
					mode: modelMode ? "real-model" : "controlled-provider-real-paper",
					passed,
					controlledProviderRequests: modelMode ? null : providerRequests,
					observedUsageRequests: usage.size,
					usage: [...usage.values()],
					durationMinutes,
					model: host.snapshot().modelName,
					worldDataDir: context?.worldDataDir,
					failure: failure ? String(failure) : null,
					observations,
					transcript,
				},
				null,
				2,
			),
		);
		console.log(
			`[mc-i2] ${passed} passed; report=${join(root, "report.json")}; externally owned Paper remains running`,
		);
	}
}
