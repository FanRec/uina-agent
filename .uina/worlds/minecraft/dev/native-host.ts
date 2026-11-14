/** Batch 6 acceptance via the real Host/WorldTool/managed process. --model uses existing Provider config. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ModelStreamFn, RequestUsage } from "../../../../src/core/types.js";
import type { ExtensionAPI } from "../../../../src/extensions/runner.js";
import type { BodyEndpoint } from "../../../../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext, WorldEvent } from "../../../../src/extensions/world-framework/types.js";
import { WorldActivation } from "../../../../src/extensions/world-framework/world-activation.js";
import { UinaHost } from "../../../../src/host/host.js";
import type { ToolResultEvent } from "../../../../src/runtime/events.js";
import type { ExactRef, JsonValue } from "../contracts/values.js";
import { ClientHost } from "../driver/client-host.js";
import { createMinecraftWorld } from "../worlddef/index.js";
import { executionProbe } from "./execution-probe.js";
import { feedbackScenario, prepareFeedbackModelScene } from "./feedback-scenario.js";
import { DEV_SERVER, prepareModelScene } from "./harness.js";
import { libraryScenario } from "./library-scenario.js";
import { playRhythmProbe } from "./play-rhythm.js";
import { waitScenario } from "./wait-scenario.js";

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
const port = Number(process.env.MC_DEV_PORT ?? "25565");
assert(Number.isInteger(port) && port > 0 && port < 65536, "invalid MC_DEV_PORT");
const modelMode = process.argv.includes("--model");
const autonomyMode = process.argv.includes("--autonomy");
const fixedExploreMode = process.argv.includes("--fixed-explore");
const rhythmFlowMode = process.argv.includes("--rhythm-flow");
const guideFile = process.argv.find((arg) => arg.startsWith("--guide-file="))?.slice("--guide-file=".length);
const chatFlowMode = process.argv.includes("--chat-flow");
assert(!autonomyMode || modelMode, "--autonomy requires --model");
assert(!fixedExploreMode || modelMode, "--fixed-explore requires --model");
assert(!rhythmFlowMode || !modelMode, "--rhythm-flow uses the controlled Provider");
assert(!guideFile || fixedExploreMode, "--guide-file requires --fixed-explore");
const programMode = process.argv.includes("--program");
const tasksMode = process.argv.includes("--tasks");
const waitMode = process.argv.includes("--wait");
const libraryMode = process.argv.includes("--library");
const feedbackMode = process.argv.includes("--feedback");
const mapMode = process.argv.includes("--map");
if (feedbackMode && modelMode) await prepareFeedbackModelScene();
if (fixedExploreMode || rhythmFlowMode) {
	assert.equal(DEV_SERVER.username, "UinaDev", "fixed arena setup uses the isolated UinaDev player");
	await prepareModelScene("fixed-explore", async (h, command) => {
		await prepareGameScene(command, (selector, input = {}) => h.world.read({ ref: selector, input }));
	});
}
const guideOverride = guideFile ? await readFile(guideFile, "utf8") : undefined;
const root = await mkdtemp(join(tmpdir(), modelMode ? "uina-mc-model-" : "uina-mc-native-"));
console.log(`[mc-native] ${modelMode ? "REAL MODEL" : "controlled Provider, REAL Host/Paper"} data=${root}`);
const configPath = join(root, "config.json");
await writeFile(
	configPath,
	JSON.stringify({
		connection: { host: "127.0.0.1", port, username: "UinaDev", authMode: "offline", version: "1.21.11" },
		binding: { world: "dev-native-world", worldRevision: "native-host-2026-10-25" },
	}),
);
let planned: { id: string; action: string; params: Record<string, unknown> } | null = null;
let nextRequest: (() => Promise<void>) | undefined;
let modelRequests = 0;
const model: Model = {
	id: "mc-acceptance",
	name: "MC acceptance scripted Provider",
	providerId: "mc-acceptance",
	contextWindow: 128000,
};
const stream: ModelStreamFn = async (_model, _request, delta) => {
	modelRequests++;
	if (nextRequest) {
		const wait = nextRequest;
		nextRequest = undefined;
		await wait();
	}
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
const probe = executionProbe();
const rhythm = fixedExploreMode || rhythmFlowMode ? playRhythmProbe(probe) : undefined;
const calibrationUsage = new Map<string, RequestUsage>();
let calibrationBudgetHit: string | null = null;
let scenarioStarted: number | undefined;
let firstActionMs: number | undefined;
let firstObservationMs: number | undefined;
host.subscribe((event) => {
	rhythm?.onHostEvent(event);
	// 请求观测（只读）：模型开始输出即该请求已装配完成——从只读活动请求观察取消息
	// 做 eventId 匹配，替代旧 turn.transformContext 观察；onRequest 内部幂等去重。
	if (rhythm && event.type === "output_start" && event.channel === "content") {
		rhythm.onRequest({ messages: host.getRequestObservation()?.projection.messages ?? [] });
	}
	if (event.type === "usage_update") {
		calibrationUsage.set(event.usage.callId, event.usage);
		if (feedbackMode && modelMode && calibrationUsage.size >= 12) {
			calibrationBudgetHit = "12-request calibration budget reached";
			host.interrupt();
		}
	}
	if (event.type === "tool_result") {
		if (
			scenarioStarted !== undefined &&
			firstActionMs === undefined &&
			event.status === "succeeded" &&
			event.args.action === "run"
		)
			firstActionMs = Date.now() - scenarioStarted;
		if (
			scenarioStarted !== undefined &&
			firstObservationMs === undefined &&
			event.status === "succeeded" &&
			event.args.action === "observe"
		)
			firstObservationMs = Date.now() - scenarioStarted;
		results.set(event.callId, event);
		transcript.push(event);
		console.log(
			`[mc-native] tool ${event.args.action ?? event.toolName}: ${event.status} ${event.result.slice(0, 250)}`,
		);
	}
	if (event.type === "usage_update" || event.type === "error" || event.type === "output_end") transcript.push(event);
});
let pi!: ExtensionAPI, context!: ServiceCompanionContext;
const chatNotices: WorldEvent[] = [];
const world = createMinecraftWorld({ onExecutorAccess: probe.onExecutorAccess, legacyConfigPath: configPath });
const start = world.onStart!;
world.onStart = async (ctx) => {
	if (rhythm) ctx = rhythm.wrap(ctx);
	// 指南覆盖（--guide-file）：替换世界注册的 guidance 正文，注册生命周期不变。
	if (guideOverride !== undefined && ctx.provideContext) {
		const provide = ctx.provideContext;
		ctx = {
			...ctx,
			provideContext: (source) => provide(source.kind === "guidance" ? { ...source, text: guideOverride } : source),
		};
	}
	if (chatFlowMode) {
		const emitEvent = ctx.emitEvent!;
		ctx = {
			...ctx,
			emitEvent: (event) => {
				if (event.type === "minecraft_event" && event.text && JSON.parse(event.text).kind === "chat")
					chatNotices.push(event);
				return emitEvent(event);
			},
		};
	}
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
	// WorldTool adds identity fields to details; arrays remain exact in the JSON body.
	if (action === "library" && params.op === "list") return JSON.parse(reply.result) as Record<string, unknown>;
	return reply.details as Record<string, unknown>;
};
const runtimeItems = async (op: "list" | "calls", params: Record<string, unknown>) => {
	const items: Record<string, unknown>[] = [];
	let cursor: string | undefined;
	do {
		const page =
			op === "list"
				? await probe.list({ ...params, ...(cursor ? { cursor } : {}) })
				: await probe.calls(params.run, cursor);
		items.push(...(page.items as Record<string, unknown>[]));
		cursor = page.next as string | undefined;
	} while (cursor);
	return items;
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
	const details = reply.details as { kind: string; task: string };
	assert.equal(details.kind, "accepted", reply.result);
	const run = await probe.resolve(details.task);
	const result = await probe.executor().wait(run, { timeoutMs: 90000 });
	assert(result.kind === "result", JSON.stringify(result));
	return result;
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
	// 验收模式的工具可见性约束：从本测试实例的 Tool Broker 撤下非 Minecraft 工具，
	// 使请求定义、工具执行权限与预算从源头一致（不再在请求边界过滤完整投影）。
	for (const name of [...host["tools"].names()]) if (name !== "minecraft") host["tools"].remove(name);
	if (autonomyMode) {
		assert.equal((await direct("session", { op: "status" })).state, "disconnected");
		const timer = setTimeout(() => host.interrupt(), 120000);
		try {
			scenarioStarted = Date.now();
			await host.submitText(
				`有一个 Minecraft 世界在线，地址是 127.0.0.1:${port}。这是 Java 1.21.11 离线服，可用名字 Uina。`,
				"direct",
			);
			await host.waitForIdle();
		} finally {
			clearTimeout(timer);
		}
		const calls = [...results.values()];
		const reads = calls.filter(({ args }) => args.action === "tasks" && (args.params as { op?: string }).op === "get");
		const revisions = new Set(
			reads.map(({ details }) => {
				const view = details as { task?: string; revision?: number };
				return `${view.task}:${view.revision}`;
			}),
		);
		console.log(
			"[mc-native] autonomy observation",
			JSON.stringify({
				session: (await direct("session", { op: "status" })).state,
				calls: calls.length,
				taskReads: reads.length,
				repeatedTaskReads: reads.length - revisions.size,
				emptySearches: calls.filter(
					({ args, details }) => args.action === "describe" && (details as { items?: unknown[] })?.items?.length === 0,
				).length,
			}),
		);
	} else await runScenarios();
	await step("activation stop closes managed process and endpoint", async () => {
		await activation!.stop();
		activation = undefined;
	});
} catch (error) {
	console.error("[mc-native] acceptance failed", error);
	throw error;
} finally {
	await activation?.stop();
	await host.dispose();
	await writeFile(
		join(root, "report.json"),
		JSON.stringify(
			{
				mode: autonomyMode
					? "autonomy-real-model"
					: fixedExploreMode
						? "fixed-explore-real-model"
						: modelMode
							? "real-model"
							: "controlled-provider-real-paper",
				firstActionMs,
				firstObservationMs,
				passed,
				modelRequests,
				...(rhythm ? { rhythm: await rhythm.report(), guide: guideFile ?? "published" } : {}),
				usage: [...calibrationUsage.values()],
				calibrationBudgetHit,
				transcript,
			},
			null,
			2,
		),
	);
	console.log(`[mc-native] ${passed} passed; report=${join(root, "report.json")}`);
}

async function runScenarios() {
	const observe = (selector: string, input: JsonValue = {}) =>
		direct("observe", { selector, input }) as Promise<Record<string, unknown> & { value?: unknown }>;
	const offlineSource = programMode
		? await direct("describe", { selector: "collect@1", includeSource: true })
		: undefined;
	// 批25：World 不再自动入服——经 session 工具显式连接（settings 种子来自旧 config.json）。
	await step("session connect", async () => {
		const reply = (await direct("session", { op: "connect", target: { server: "default" } })) as {
			state?: string;
		};
		assert.ok(reply.state === "connected", `session connect failed: ${JSON.stringify(reply).slice(0, 300)}`);
	});
	await step("formal Host current connection", async () => {
		if (!tasksMode)
			await until(
				() => probe.executor().inspect(),
				(s) => (s.side as { connection: string })?.connection === "ready",
			);
		await observe("self@1");
	});
	if (chatFlowMode) {
		await step("only direct public address and private chat reach the Host", async () => {
			const peer = new ClientHost();
			try {
				await peer.connect({ host: "127.0.0.1", port, username: "UinaPeer", version: "1.21.11" });
				const friend = peer.bot;
				assert(peer.state === "ready" && friend);
				friend.chat("Just looking around");
				friend.chat("UinaDev_suffix is another name");
				friend.chat("@uinadev, come see this");
				await until(
					async () => chatNotices.length,
					(count) => count === 1,
				);
				friend.chat("UinaDev, see the hill");
				await until(
					async () => chatNotices.length,
					(count) => count === 2,
				);
				friend.chat("/tell UinaDev Found a cave");
				await until(
					async () => chatNotices.length,
					(count) => count === 3,
				);
				await direct("chat", { text: "@UinaDev This is my own echo" });
				await sleep(800);
				assert.deepEqual(
					chatNotices.map((event) => {
						const { ref, ...content } = JSON.parse(event.text!);
						assert.equal(ref, event.id);
						assert.equal(event.delivery, "urgent");
						return content;
					}),
					[
						{ kind: "chat", channel: "public", sender: "UinaPeer", text: "@uinadev, come see this" },
						{ kind: "chat", channel: "public", sender: "UinaPeer", text: "UinaDev, see the hill" },
						{ kind: "chat", channel: "private", sender: "UinaPeer", text: "Found a cave" },
					],
				);
				const history = await observe("events@1", { kinds: ["chat"] });
				assert(JSON.stringify(history.value).includes("Just looking around"));
			} finally {
				peer.close();
			}
		});
		return;
	}
	const command = async (text: string) => {
		await direct("chat", { text });
		await sleep(180);
	};
	if (!rhythm && !(feedbackMode && modelMode))
		await step("prepare dedicated game scene", () => prepareGameScene(command, observe));
	if (rhythmFlowMode) {
		rhythm!.watch(probe.executor());
		await runRhythmFlow();
		return;
	}
	if (fixedExploreMode) {
		rhythm!.watch(probe.executor());
		scenarioStarted = Date.now();
		const timer = setTimeout(() => host.interrupt(), 120000);
		try {
			await host.submitText("用探索能力找附近的橡木原木。探索有结果后，说说找到的位置或已经确认的结果。", "direct");
			await until(
				() => rhythm!.report(),
				(report) =>
					report.tasks.some((task) => {
						const found = task.found as { name?: string; at?: { position?: Record<string, number> } } | undefined;
						const at = found?.at?.position;
						return (
							task.replyAt != null && found?.name === "oak_log" && at?.x === 16002 && at?.y === 200 && at?.z === 16000
						);
					}),
				90_000,
			);
			await host.waitForIdle();
		} finally {
			clearTimeout(timer);
		}
	} else if (tasksMode) {
		if (!modelMode)
			await step("default tool text keeps field facts and full detail stays available", async () => {
				for (const [action, params] of [
					["session", { op: "status" }],
					["observe", { selector: "self@1" }],
					["observe", { selector: "world@1" }],
					["observe", { selector: "inventory@1" }],
				] as const) {
					const normal = await host.runToolDirect("minecraft", { action, params });
					const full = await host.runToolDirect("minecraft", { action, params: { ...params, detail: "full" } });
					assert.equal(normal.status, "succeeded");
					assert.equal(full.status, "succeeded");
					assert(Buffer.byteLength(normal.result) < Buffer.byteLength(full.result));
					const body = JSON.parse(normal.result);
					if (action === "session") {
						assert.equal(body.state, "connected");
						assert.equal(body.username, "UinaDev");
						assert.equal(body.settingsPath, undefined);
					} else assert(body.value);
					console.log(
						`[mc-native] text ${action} ${"selector" in params ? params.selector : params.op}: ${Buffer.byteLength(full.result)} → ${Buffer.byteLength(normal.result)} bytes`,
					);
				}
			});
		const get = (task: string) => direct("tasks", { op: "get", task });
		const acceptedTask = (reply: { details?: unknown }) => {
			const details = reply.details as { kind?: string; task?: string; run?: string };
			assert.equal(details.kind, "accepted", JSON.stringify(details));
			assert.equal(details.run, undefined);
			assert(typeof details.task === "string");
			return details.task;
		};
		if (modelMode) {
			await step("model discovers, recovers from a rejected selector, collects and stops", async () => {
				const timer = setTimeout(() => host.interrupt(), 120000);
				try {
					await host.submitText(
						"只用 Minecraft 正常工具。先试运行不存在的 selector missing_play@1，确认拒绝后用 describe 找采集能力，获得至少一根新原木并核实。再用 Program 持有身体等待，查询任务并用 tasks.stop 停止，确认取消后结束。",
						"direct",
					);
					await host.waitForIdle();
				} finally {
					clearTimeout(timer);
				}
				const calls = [...results.values()];
				assert(calls.some((r) => r.args.action === "describe"));
				assert(
					calls.some(
						(r) =>
							r.args.action === "tasks" && (r.args.params as { op?: string }).op === "stop" && r.status === "succeeded",
					),
				);
				const inventory = await observe("inventory@1");
				assert(((inventory.value as { counts: Record<string, number> }).counts.oak_log ?? 0) >= 1);
			});
		} else {
			await step("public Task discovery, collection and completion", async () => {
				assert.equal((await ask("describe", { selector: "collect@1" })).status, "succeeded");
				const queryAsAction = await ask("run", { selector: "self@1" });
				assert.equal(queryAsAction.status, "failed");
				assert.match(queryAsAction.result, /Use observe for this query/);
				const rejected = await ask("run", { selector: "missing_play@1" });
				assert.equal((rejected.details as { kind: string }).kind, "rejected");
				const rejectedTask = (rejected.details as { task: string }).task;
				assert.equal((await get(rejectedTask)).outcome, "not_started");
				const task = acceptedTask(await ask("run", { selector: "collect@1", input: { item: "oak_log", radius: 8 } }));
				const finished = await until(
					() => get(task),
					(view) => view.phase === "finished",
				);
				assert.equal(finished.outcome, "succeeded", JSON.stringify(finished));
				assert.equal(finished.label, "采集");
				assert.equal(finished.goal, "1 × oak_log");
				const inventory = await observe("inventory@1");
				assert.equal((inventory.value as { counts: Record<string, number> }).counts.oak_log, 1);
				const trace = await direct("tasks", { op: "trace", task });
				const completionRef = (trace.snapshot as { completionRef: string }).completionRef;
				await until(
					() => context.delivery!.inspect(completionRef),
					(state) => state.kind === "committed",
				);
				const notice = await until(
					async () => {
						const rows = (await readFile(join(root, "session.jsonl"), "utf8")).split(/\r?\n/).slice(0, -1);
						for (const line of rows) {
							if (!line.includes(task)) continue;
							const row = JSON.parse(line);
							if (row.kind !== "input" || row.input?.source?.type !== "minecraft_completion") continue;
							return JSON.parse(row.input.text) as Record<string, unknown>;
						}
						return null;
					},
					(notice) => notice !== null,
				);
				assert.equal(notice?.outcome, "succeeded");
				assert.equal((notice?.value as { acquired: number })?.acquired, 1);
				assert.equal(notice?.nextCall, undefined);
			});
			await step("continue and stop preserve the same Task identity", async () => {
				const task = acceptedTask(
					await ask("run", { code: "async function main(mc){mc.decide('next', {value:42});}" }),
				);
				const decision = await until(
					() => get(task),
					(view) => view.phase === "needs_input",
				);
				const entry = {
					code: "async function main(mc){await mc.withBody(async()=>mc.sleep(60000));return mc.checkpoint;}",
				};
				const args = { op: "continue", task, decision: decision.decision, entry };
				assert.equal(acceptedTask(await ask("tasks", args)), task);
				assert.equal((await ask("tasks", args)).status, "failed");
				await until(
					() => get(task),
					(view) => view.control === "active",
				);
				const listed = await direct("tasks", { op: "list" });
				assert((listed.items as { task: string }[]).some((item) => item.task === task));
				await direct("library", {
					op: "save",
					name: "pause_here",
					summary: "Wait here",
					source: "async function main(mc){await mc.sleep(30000);}",
				});
				const other = acceptedTask(await ask("run", { selector: "pause_here" }));
				const active = (await direct("tasks", { op: "list" })).items as { task: string; label: string }[];
				assert.equal(active.find((item) => item.label === "临时 Program")?.task, task);
				assert.equal(active.find((item) => item.label === "运行 pause_here")?.task, other);
				await direct("tasks", { op: "stop", task: other });
				assert.equal(
					(
						await until(
							() => get(other),
							(view) => view.phase === "finished",
						)
					).outcome,
					"cancelled",
				);
				assert.equal((await get(task)).control, "active");
				await direct("tasks", { op: "stop", task });
				const stopped = await until(
					() => get(task),
					(view) => view.phase === "finished",
				);
				assert.equal(stopped.outcome, "cancelled");
				await direct("session", { op: "connect", target: { server: "default", slot: "task-probe-other" } });
				const wrongProfile = await ask("tasks", { op: "get", task });
				assert.equal((wrongProfile.details as { code: string }).code, "TASK_PROFILE_MISMATCH");
				await direct("session", { op: "connect", target: { server: "default" } });
				assert.equal((await get(task)).outcome, "cancelled");
			});
		}
	} else if (feedbackMode) {
		await feedbackScenario({
			probe,
			direct,
			step,
			safeStop: async () => {
				await ([...activation!.exposed.values()][0] as BodyEndpoint).safeStop();
			},
			resume: async () => {
				await ([...activation!.exposed.values()][0] as BodyEndpoint).resume();
			},
			reopen: async () => {
				await activation!.stop();
				activation = undefined;
				activation = new WorldActivation(world, {
					pi,
					runtime: { definition: world, enabled: true },
					worldName: world.name,
					notifyExposed() {},
				});
				await activation.start();
				await until(
					() => probe.executor().inspect(),
					(r) => (r.side as { connection?: string })?.connection === "ready",
				);
			},
			model: modelMode
				? async (prompt) => {
						const timer = setTimeout(() => {
							calibrationBudgetHit = "90-second calibration budget reached";
							host.interrupt();
						}, 90000);
						try {
							await host.submitText(prompt, "direct");
							await host.waitForIdle();
							if (calibrationBudgetHit) throw new Error(calibrationBudgetHit);
							const error = transcript.find((e) => (e as { type?: string }).type === "error") as
								| { text?: string }
								| undefined;
							if (error) throw new Error(error.text ?? "model request failed");
						} finally {
							clearTimeout(timer);
						}
					}
				: undefined,
		});
	} else if (modelMode) {
		console.log(`[mc-native] real model=${host.snapshot().modelName}`);
		for (const task of mapMode
			? [
					"你在独立 Minecraft 验收区，背包里有一张空白地图。仅使用 minecraft 工具和它的短指南，按需 describe。先手持并使用（use@1）这张空白地图把它展开，然后用 observe 读取 map@1（带 image），根据返回的元数据描述：地图收到多少像素、其中多少已绘制、有没有玩家图标。如果工具结果带了图片附件，用一句话说明你是否真的看到了地图画面（例如能否分辨不同地块颜色）。不要使用服务器指令、其他工具或管理员补料。",
				]
			: waitMode
				? [
						"仅使用 minecraft 工具和它的短指南，按需 describe。实际编写并运行一个普通 JS 程序：先读 events@1 的 chat 最近窗口取得 after，再用 mc.call 的 chat@1 发送 input.text，然后用 mc.waitUntil 等固定 after 之后收到含该文本的事件，timeoutMs 为10000。main 必须声明 (mc,input)，text 从 input.text 读取，run 的 code 和 input 都放 params 内。返回 waitUntil 结果，必须实际得到 kind=met。这次 input.text 使用 uina-wait-model-first。不要使用服务器指令或其他工具。",
						"通过 tasks.trace 找到刚才确切成功的程序 Call，使用 library.save 的 from:{run,segment,call} 保存为 wait_echo，summary 简短说明用途。然后用 run.selector='wait_echo'，input.text='uina-wait-model-reused' 再运行一次，读取记录核实等待结果 kind=met。不要重写源码保存，不使用服务器指令。",
					]
				: libraryMode
					? [
							"仅使用 minecraft 工具。先 describe 所需能力，用 run.code 实际提交普通 JS：尝试制作铁镐并捕获缺料，改为采集一根附近橡木原木、制作四块木板，读库存核验。不要使用服务器指令、补料或其他工具。",
							"将刚才成功执行的程序保存为 plank_batch：查询 tasks.trace，使用 library.save 的 from:{run,segment,call} 保存确切程序 Call，不能手抄源码保存。随后用 describe 搜索并描述这个程序，用 library.get 读取源码，将脚本通过 library.update 的 source 完整替换，作一个小改动（例如在返回值增加 revision:'v2'，保留已有逻辑）。然后用 run.selector='plank_batch' 实际复用它，再采集一根原木、制作四块木板并核验。最后保存一条名为 wood_notes 的 experience，说明适用条件，describe 找到它并 library.get 读回。只使用 minecraft，不使用服务器指令。",
						]
					: programMode
						? [
								"仅使用 minecraft 工具，通过 run 的 code 提交一个普通 JS 程序：读库存，先尝试制作一把铁镐并捕获缺料错误，随后采集两根橡木原木并制作至少八块橡木木板，最后读取库存核验。自行 describe 所需能力，不使用服务器指令、补料或其他工具。必须实际提交程序，不能只逐条调用原生动作。",
								"仅使用 minecraft，通过 run 的 code 提交一个会持续等待的程序，使用 mc.sleep 和 mc.progress。获得 accepted 后显式 tasks.stop，再查询终态并读取调用记录。不要把取消工具等待当成停止，不使用服务器指令。",
							]
						: [
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
			if (waitMode) {
				const material = await direct("library", { op: "get", name: "wait_echo" });
				assert.ok((material.source as string).includes("waitUntil"));
				assert.ok(material.savedFrom, "model must save from the exact program Call");
				const runs = await runtimeItems("list", { activeOnly: false });
				let reused = false;
				for (const r of runs) {
					const calls = await runtimeItems("calls", { run: r.run });
					if (!calls.some((c) => c.ref === "wait_echo" && c.outcome === "succeeded")) continue;
					const record = await probe.record(r.run);
					const value = (record.record as { value: { value: unknown } }).value.value;
					const observed = (v: unknown): boolean => {
						if (v === null || typeof v !== "object") return false;
						const item = v as Record<string, unknown>;
						if (item.kind === "met" && item.values && typeof item.values === "object") {
							if (
								Object.values(item.values).some(
									(page) =>
										page &&
										typeof page === "object" &&
										Array.isArray((page as { events?: unknown }).events) &&
										(page as { events: { payload?: { text?: unknown } }[] }).events.some(
											(e) => typeof e.payload?.text === "string" && e.payload.text.includes("uina-wait-model-reused"),
										),
								)
							)
								return true;
						}
						return Object.values(item).some(observed);
					};
					reused ||= observed(value);
				}
				assert.ok(reused, "model must execute the named waiting program and observe the new echo");
			} else if (libraryMode) {
				const files = await direct("library", { op: "list", kind: "program" });
				const entries = files as unknown as { name: string }[];
				assert.ok(entries.some((e) => e.name === "plank_batch"));
				const material = await direct("library", { op: "get", name: "plank_batch" });
				const savedTool = transcript.find((e) => {
					const t = e as ToolResultEvent;
					const p = t.args?.params as { op?: string; name?: string; from?: unknown } | undefined;
					return (
						t.type === "tool_result" &&
						t.status === "succeeded" &&
						t.args.action === "library" &&
						p?.op === "save" &&
						p.name === "plank_batch" &&
						p.from
					);
				}) as ToolResultEvent | undefined;
				assert.ok(savedTool, "model must save from an actual program Call");
				const from = (savedTool.args.params as { from: { run: string; segment: string; call: string } }).from;
				const sourceRecord = await probe.record(from.call);
				const sourceCall = (
					sourceRecord.record as { value: { run: string; segment: string; program: { digest: string } } }
				).value;
				assert.equal(sourceCall.run, from.run);
				assert.equal(sourceCall.segment, from.segment);
				const runs = await runtimeItems("list", { activeOnly: false });
				let reused = false;
				for (const r of runs) {
					const calls = await runtimeItems("calls", { run: r.run });
					for (const c of calls)
						if (c.ref === "plank_batch") {
							const record = await probe.record(c.record);
							const call = (record.record as { value: { program: { digest: string }; outcome: string } }).value;
							reused ||=
								call.outcome === "succeeded" &&
								call.program.digest === material.digest &&
								call.program.digest !== sourceCall.program.digest;
						}
				}
				assert.ok(reused, "model must execute updated named material");
				assert.ok(
					transcript.some((e) => {
						const t = e as ToolResultEvent;
						return (
							t.type === "tool_result" &&
							t.args.action === "library" &&
							(t.args.params as { op?: string })?.op === "update" &&
							t.status === "succeeded"
						);
					}),
				);
				assert.ok(((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks >= 8);
				assert.ok(await direct("library", { op: "get", kind: "experience", name: "wood_notes" }));
			} else if (programMode) {
				assert.ok(
					transcript.some((e) => {
						const t = e as ToolResultEvent;
						return (
							t.type === "tool_result" &&
							t.args.action === "run" &&
							typeof (t.args.params as { code?: unknown })?.code === "string"
						);
					}),
					"model must actually submit JavaScript",
				);
				assert.ok(
					((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks >= 8,
					"model program must produce real planks",
				);
				const list = await probe.list({ activeOnly: false });
				const cancelled = (list.items as { run: string; phase: string; outcome?: string }[]).filter(
					(r) => r.phase === "finished" && r.outcome === "cancelled",
				);
				let stoppedProgram = false;
				for (const r of cancelled) {
					const calls = await probe.calls(r.run);
					if ((calls.items as { implementation: string }[]).some((c) => c.implementation === "program"))
						stoppedProgram = true;
				}
				assert.ok(stoppedProgram, "model must explicitly stop a Program Run");
			}
		});
	} else if (waitMode) {
		await waitScenario({ probe, direct, ask, finish, step });
	} else if (mapMode) {
		// G11 出口的真实 wire：observe map@1 经正式 WorldTool/Host 路径必须带 images 附件。
		await step("activate the blank map via the formal use@1 port", async () => {
			const r = await finish(await ask("run", { selector: "use@1", input: { item: "map" } }));
			assert.equal((r.snapshot as { outcome?: string }).outcome, "succeeded", JSON.stringify(r));
			await sleep(2500);
		});
		await step("observe map@1 through the world tool carries image attachment", async () => {
			const id = randomUUID();
			planned = { id, action: "observe", params: { selector: "map@1" } };
			await host.submitText(`Execute acceptance operation ${id}.`, "direct");
			await host.waitForIdle();
			const reply = results.get(id);
			assert.ok(reply, "no tool result for map@1");
			assert.equal(reply.status, "succeeded", reply.result.slice(0, 300));
			const value = JSON.parse(reply.result) as { value: { receivedPixels: number; image: unknown } };
			assert.ok(value.value.receivedPixels > 0, `map pixels must have arrived: ${reply.result.slice(0, 300)}`);
			assert.ok(value.value.image, "image ref must be present");
			assert.ok(
				Array.isArray(reply.images) && reply.images.length === 1 && reply.images[0].type === "image",
				"world tool result must carry the map image attachment (G11)",
			);
			assert.match(reply.images[0].mimeType, /^image\/png$/);
		});
	} else if (libraryMode) {
		await libraryScenario({ probe, dataRoot: context.worldDataDir!, direct, ask, finish, step });
	} else if (programMode) {
		const runCode = async (code: string, input: JsonValue = {}) => finish(await ask("run", { code, input }));
		const succeeded = (r: unknown) =>
			assert.equal((r as { snapshot: { outcome: string } }).snapshot.outcome, "succeeded", JSON.stringify(r));
		let collectTask: string;
		await step("Program read/call, domain correction and real collect/craft", async () => {
			const accepted = await ask("run", {
				code: `async function main(mc){
        const before=await mc.read('inventory@1');
        let missing=null;try{await mc.call('craft@1',{item:'iron_pickaxe',count:1});}catch(e){missing=e.code;}
        await mc.call('collect@1',{item:'oak_log',count:2,radius:8});
        await mc.call('craft@1',{item:'oak_planks',count:8});
        const after=await mc.read('inventory@1');mc.progress({summary:'crafted',count:after.value.counts.oak_planks});
        return {missing,before:before.value.counts,after:after.value.counts};
      }`,
			});
			collectTask = (accepted.details as { task: string }).task;
			const r = await finish(accepted);
			succeeded(r);
			assert.ok(((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks >= 8);
			const record = await probe.record(r.snapshot.run);
			assert.equal(
				(record.record as { value: { value: { missing: string } } }).value.value.missing,
				"MISSING_MATERIAL",
			);
		});
		await step("copy collect from the directory and verify its policy through Library", async () => {
			const trace = await direct("tasks", { op: "trace", task: collectTask });
			const call = (trace.calls as { items: { ref: string; record: string }[] }).items.find(
				({ ref }) => ref === "collect@1",
			);
			assert(call);
			const summary = await direct("describe", { selector: "collect@1" });
			assert.equal(summary.sourceAvailable, true);
			assert.equal(summary.programSource, undefined);
			const published = (await direct("describe", { selector: "collect@1", includeSource: true })).programSource as {
				source: string;
				digest: string;
			};
			assert.deepEqual(published, offlineSource?.programSource);
			const callEvidence = await direct("tasks", { op: "trace", task: collectTask, record: call.record });
			assert.equal(published.digest, (callEvidence.record as { value: { digest: string } }).value.digest);
			const name = "collect_copy";
			await direct("library", {
				op: "save",
				name,
				summary: "Editable copy of the published collect Program",
				source: published.source,
			});
			const saved = await direct("library", { op: "get", name });
			assert((saved.source as string).trimEnd().endsWith(published.source.trimEnd()));
			assert.match(saved.source as string, /radius = 32/);
			await command("/fill 16002 200 16000 16002 204 16000 minecraft:air");
			await command("/tp UinaDev 16000.5 200 16000.5");
			await command("/setblock 16006 200 16000 minecraft:oak_log");
			const at = { x: 16006, y: 200, z: 16000 };
			const block = async () =>
				((await observe("block@1", { at })).value as { block: { name: string } | null }).block?.name;
			await until(block, (name) => name === "oak_log");
			const count = async () =>
				((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_log ?? 0;
			const before = await count();
			for (const radius of [4, 8]) {
				const copy = await direct("library", { op: "get", name });
				await direct("library", {
					op: "update",
					name,
					expectedDigest: copy.digest,
					source: (saved.source as string).replace("radius = 32", `radius = ${radius}`),
				});
				const result = await finish(await ask("run", { selector: name, input: { item: "oak_log" } }));
				if (radius === 4) {
					assert.match(JSON.stringify(result.snapshot), /NOT_FOUND: no oak_log/);
					assert.equal(await block(), "oak_log");
				} else {
					succeeded(result);
					assert.equal(await block(), "air");
					assert.equal(await count(), before + 1);
				}
			}
		});
		await step("one named program runs independently, nested and body-delegated", async () => {
			const dir = join(context.worldDataDir!, "programs");
			await mkdir(dir, { recursive: true });
			const source = `async function main(mc,input){return mc.withBody(async b=>{await b.lookAt(input.at);return {pose:'observed'};});}`;
			await writeFile(join(dir, "pose.js"), source);
			const self = (await observe("self@1")).value as { place: { position: { x: number; y: number; z: number } } };
			const input = { at: { ...self.place.position, y: self.place.position.y + 1 } };
			succeeded(await finish(await ask("run", { selector: "pose", input })));
			succeeded(await runCode(`async function main(mc,input){return mc.call('pose',input);}`, input));
			const r = await runCode(`async function main(mc,input){return mc.withBody(b=>b.call('pose',input));}`, input);
			succeeded(r);
			const calls = await probe.calls(r.snapshot.run);
			const child = (calls.items as { ref: string; record: string }[]).find((c) => c.ref === "pose")!;
			assert.ok(child);
			const record = await probe.record(child.record);
			const material = (record.record as { value: { program: { snapshot: string; digest: string } } }).value.program;
			assert.equal(await readFile(material.snapshot, "utf8"), source);
		});
		await step("guest window reference supports consecutive confirmed take/put", async () => {
			await command("/setblock 16001 200 16001 minecraft:air");
			await command("/setblock 16001 200 16001 minecraft:chest");
			await command("/item replace block 16001 200 16001 container.0 with minecraft:dirt 4");
			const r = await runCode(`async function main(mc){return mc.withBody(async b=>{
        const w=await b.openContainer({x:16001,y:200,z:16001});await w.snapshot();
        const first=await w.click({slot:0});if(first.needsSnapshot)await w.snapshot();
        let refused=null;try{await w.close();}catch(e){refused=e.code;}
        const second=await w.click({slot:0});const after=await w.snapshot();await w.close();
        return {first,second,refused,item:after.value.slots[0].item,cursor:after.value.cursor};
      });}`);
			succeeded(r);
			const record = await probe.record(r.snapshot.run);
			assert.deepEqual(
				(record.record as { value: { value: { cursor: unknown; item: { count: number } } } }).value.value.cursor,
				null,
			);
			assert.equal((record.record as { value: { value: { item: { count: number } } } }).value.value.item.count, 4);
			assert.equal(
				(record.record as { value: { value: { refused: string } } }).value.value.refused,
				"CURSOR_NOT_EMPTY",
			);
		});
		await step("background Program completion obtains a canonical Host receipt", async () => {
			const r = await finish(
				await ask("run", { code: "async function main(mc){await mc.sleep(1800);return {done:true};}" }),
			);
			succeeded(r);
			const ref = (r.snapshot as { completionRef: string }).completionRef;
			await until(
				() => context.delivery!.inspect(ref),
				(s) => s.kind === "committed",
			);
		});
		await step("tool wait cancellation preserves Program; explicit stop retires guest", async () => {
			const abort = new AbortController();
			const pending = host.runToolDirect(
				"minecraft",
				{
					action: "run",
					params: {
						code: "async function main(mc){await mc.withBody(async b=>{await b.lookAt({x:16000,y:201,z:16000});await mc.sleep(60000);});}",
					},
				},
				abort.signal,
			);
			const timer = setTimeout(() => abort.abort(), 300);
			const reply = await pending;
			clearTimeout(timer);
			const accepted = reply.details as { kind: string; task: string };
			assert.equal(accepted.kind, "accepted", JSON.stringify(reply));
			assert.notEqual((await direct("tasks", { op: "get", task: accepted.task })).phase, "finished");
			await direct("tasks", { op: "stop", task: accepted.task });
			const stopped = await probe.executor().wait(await probe.resolve(accepted.task), { timeoutMs: 10000 });
			assert.equal((stopped.snapshot as { outcome: string }).outcome, "cancelled");
			await until(
				() => probe.executor().inspect(),
				(s) => (s.side as { program: { residentGuests: number } }).program.residentGuests === 0,
			);
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
			assert.equal((await probe.record(ref)).kind, "inline");
		});
		await step("explicit request stop and body emergency", async () => {
			const r = await ask("run", {
				selector: "goto@1",
				input: { at: { x: 16080, y: 200, z: 16000 }, tolerance: 1, maxTimeMs: 30000 },
			});
			const task = (r.details as { task: string }).task;
			await ask("tasks", { op: "stop", task });
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
			const accepted = reply.details as { kind: string; task: string };
			assert.equal(accepted.kind, "accepted", JSON.stringify(reply));
			assert.notEqual((await direct("tasks", { op: "get", task: accepted.task })).phase, "finished");
			await direct("tasks", { op: "stop", task: accepted.task });
			const stopped = await probe.executor().wait(await probe.resolve(accepted.task), { timeoutMs: 10000 });
			assert.equal((stopped.snapshot as { outcome: string }).outcome, "cancelled");
		});
	}
}

async function runRhythmFlow(): Promise<void> {
	const report = () => rhythm!.report();
	const accepted = async (delay: number) => {
		const reply = await ask("run", {
			code: `async function main(mc) { await mc.sleep(${delay}); return "rhythmProbe"; }`,
		});
		const value = reply.details as { kind: string; task: string };
		assert.equal(value.kind, "accepted", reply.result);
		return value.task;
	};
	await step("idle Host receives one completion within one second", async () => {
		const task = await accepted(600);
		const snapshot = await until(report, (r) => r.tasks.some((t) => t.task === task && t.replyAt != null));
		const row = snapshot.tasks.find((t) => t.task === task)!;
		assert(row.hostAcceptedAt! >= row.acceptedAt!, JSON.stringify(row));
		assert(row.hostAcceptedAt! - Math.max(row.durableObservedAt!, row.acceptedAt!) <= 1000, JSON.stringify(row));
		assert.equal(snapshot.completionAttempts, 1);
	});
	await step("busy Host receives completion and addressed chat, then uses fresh game facts", async () => {
		const peer = new ClientHost();
		let releaseBusy!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseBusy = resolve;
		});
		let busyTurn: Promise<unknown> | undefined;
		try {
			// The isolated dev server grants FanRec the operator role for fixture edits.
			await peer.connect({ host: DEV_SERVER.host, port, username: "FanRec", version: "1.21.11" });
			assert(peer.bot);
			const task = await accepted(2500);
			let busy = false;
			nextRequest = async () => {
				busy = true;
				await gate;
			};
			busyTurn = host.submitText("Continue the controlled test while the Program is active.", "direct");
			await until(async () => busy, Boolean);
			peer.bot.chat("/setblock 16002 200 16000 air");
			peer.bot.chat("@UinaDev is the oak log still at the marked spot?");
			const queued = await until(
				report,
				(r) => r.worldEventsAccepted === 1 && r.tasks.some((t) => t.task === task && t.hostAcceptedAt != null),
			);
			const row = queued.tasks.find((t) => t.task === task)!;
			assert.equal(
				row.modelContextAt,
				undefined,
				"queued completion reached a model request while the Provider was blocked",
			);
			assert(host.isBusy());
			releaseBusy();
			await busyTurn;
			await until(report, (r) => r.tasks.some((t) => t.task === task && t.replyAt != null));
			await host.waitForIdle();
			assert.equal((await report()).worldEventsProjected, 1);
			const reply = await ask("observe", { selector: "block@1", input: { at: { x: 16002, y: 200, z: 16000 } } });
			const value = JSON.parse(reply.result) as { value?: { block?: { name: string } } };
			assert.equal(value.value?.block?.name, "air");
			await ask("chat", { text: "The marked block is air now." });
			assert.equal((await report()).tasks.length, 2);
		} finally {
			releaseBusy();
			await busyTurn;
			peer.close();
		}
	});
	await step("server kick leaves a real disconnection fact", async () => {
		const peer = new ClientHost();
		try {
			await peer.connect({ host: DEV_SERVER.host, port, username: "FanRec", version: "1.21.11" });
			assert(peer.bot);
			peer.bot.chat("/kick UinaDev connection-fact-acceptance");
			// 用 Executor 的连接事实判定踢出，不再依赖请求前状态采样。
			const connection = await until(
				() => Promise.resolve(probe.executor().status().side?.connection ?? "unknown"),
				(state) => state !== "ready",
			);
			assert.notEqual(connection, "ready");
		} finally {
			peer.close();
		}
	});
}

async function prepareGameScene(
	command: (text: string) => Promise<void>,
	observe: (selector: ExactRef, input?: JsonValue) => Promise<{ value?: unknown }>,
): Promise<void> {
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
	if (libraryMode || waitMode || feedbackMode || mapMode) {
		await command("/time set day");
		await command("/weather clear");
		await command("/kill @e[type=!minecraft:player,distance=..64]");
	}
	await command("/clear UinaDev");
	await command("/kill @e[type=minecraft:item,distance=..16]");
	if (mapMode) {
		// map 模式场景：四象限材质平台 + 空白地图。开图交给模型/受控步骤（use@1）。
		await command("/fill 16000 199 16000 16008 199 16008 minecraft:stone");
		await command("/fill 16009 199 16000 16016 199 16008 minecraft:dirt");
		await command("/fill 16000 199 16009 16008 199 16016 minecraft:oak_planks");
		await command("/fill 16009 199 16009 16016 199 16016 minecraft:sandstone");
		await command("/give UinaDev minecraft:map 1");
		await command("/gamemode survival UinaDev");
		await sleep(600);
	} else {
		await command("/fill 16002 200 16000 16002 204 16000 minecraft:oak_log");
		await until(
			() => observe("block@1", { at: { x: 16002, y: 200, z: 16000 } }),
			(o) => (o.value as { block: { name: string } | null }).block?.name === "oak_log",
		);
		await command("/gamemode survival UinaDev");
	}
	await until(
		() => observe("self@1"),
		(o) =>
			(o.value as { onGround: boolean; place: { position: { y: number } } }).onGround === true &&
			Math.abs((o.value as { place: { position: { y: number } } }).place.position.y - 200) < 0.1,
	);
}
