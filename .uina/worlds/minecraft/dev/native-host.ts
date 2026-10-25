/** Batch 6 acceptance via the real Host/WorldTool/managed process. --model uses existing Provider config. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
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
const programMode = process.argv.includes("--program");
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
		for (const task of programMode
			? [
					"仅使用 minecraft 工具，通过 run 的 code 提交一个普通 JS 程序：读库存，先尝试制作一把铁镐并捕获缺料错误，随后采集两根橡木原木并制作至少八块橡木木板，最后读取库存核验。自行 describe 所需能力，不使用服务器指令、补料或其他工具。必须实际提交程序，不能只逐条调用原生动作。",
					"仅使用 minecraft，通过 run 的 code 提交一个会持续等待的程序，使用 mc.sleep 和 mc.progress。获得 accepted 后显式 runs.stop，再查询终态并读取调用记录。不要把取消工具等待当成停止，不使用服务器指令。",
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
			if (programMode) {
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
				const list = await direct("runs", { op: "list", activeOnly: false });
				const cancelled = (list.items as { run: string; phase: string; outcome?: string }[]).filter(
					(r) => r.phase === "finished" && r.outcome === "cancelled",
				);
				let stoppedProgram = false;
				for (const r of cancelled) {
					const calls = await direct("runs", { op: "calls", run: r.run });
					if ((calls.items as { implementation: string }[]).some((c) => c.implementation === "program"))
						stoppedProgram = true;
				}
				assert.ok(stoppedProgram, "model must explicitly stop a Program Run");
			}
		});
	} else if (programMode) {
		const runCode = async (code: string, input: JsonValue = {}) => finish(await ask("run", { code, input }));
		const succeeded = (r: unknown) =>
			assert.equal((r as { snapshot: { outcome: string } }).snapshot.outcome, "succeeded", JSON.stringify(r));
		await step("Program read/call, domain correction and real collect/craft", async () => {
			const r = await runCode(`async function main(mc){
        const before=await mc.read('inventory@1');
        let missing=null;try{await mc.call('craft@1',{item:'iron_pickaxe',count:1});}catch(e){missing=e.code;}
        await mc.call('collect@1',{item:'oak_log',count:2,radius:8});
        await mc.call('craft@1',{item:'oak_planks',count:8});
        const after=await mc.read('inventory@1');mc.progress({summary:'crafted',count:after.value.counts.oak_planks});
        return {missing,before:before.value.counts,after:after.value.counts};
      }`);
			succeeded(r);
			assert.ok(((await observe("inventory@1")).value as { counts: Record<string, number> }).counts.oak_planks >= 8);
			const record = await direct("runs", { op: "record", ref: r.snapshot.run });
			assert.equal(
				(record.record as { value: { value: { missing: string } } }).value.value.missing,
				"MISSING_MATERIAL",
			);
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
			const calls = await direct("runs", { op: "calls", run: r.snapshot.run });
			const child = (calls.items as { ref: string; record: string }[]).find((c) => c.ref === "pose")!;
			assert.ok(child);
			const record = await direct("runs", { op: "record", ref: child.record });
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
			const record = await direct("runs", { op: "record", ref: r.snapshot.run });
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
			const accepted = reply.details as { kind: string; snapshot: { run: string }; requestId: string };
			assert.equal(accepted.kind, "accepted", JSON.stringify(reply));
			assert.notEqual((await direct("runs", { op: "status", run: accepted.snapshot.run })).phase, "finished");
			await direct("runs", { op: "stop", request: accepted.requestId });
			const stopped = await direct("runs", { op: "wait", run: accepted.snapshot.run, timeoutMs: 10000 });
			assert.equal((stopped.snapshot as { outcome: string }).outcome, "cancelled");
			await until(
				() => direct("runs", { op: "status" }),
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
