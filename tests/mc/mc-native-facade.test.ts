import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import { RpcError } from "../../.uina/worlds/minecraft/executor/ipc.js";

// Library 已收敛为宿主常驻层唯一写入口（v3 §4）；其取消/unknown 语义在 worlddef 层测试，
// 不再属于 facade→RPC 通道。

test("a submit rejected before IPC dispatch retains its credential and reports not accepted", async () => {
	let credentials = 0;
	const executor = {
		status: () => ({ actionsAllowed: true, side: { launch: "launch" } }),
		ledger: {
			refuse: async () => {},
			putRequest: async () => {
				credentials++;
			},
		},
		submit: async () => {
			throw new RpcError("REQUEST_TOO_LARGE", "too large", "not_sent");
		},
	} as unknown as MinecraftExecutor;
	const facade = new MinecraftFacade(executor, { signal: new AbortController().signal });
	const result = await facade.execute(
		"run",
		{ selector: "chat@1", input: { text: "large" } },
		new AbortController().signal,
	);
	try {
		expect(credentials).toBe(1);
		expect(result.status).toBe("not_started");
		expect(result.details).toMatchObject({ kind: "rejected", code: "REQUEST_TOO_LARGE" });
	} finally {
		await facade.close();
	}
});

test("ordinary inventory responses are compact and full or incremental reads keep their evidence", async () => {
	const fact = {
		value: { counts: { oak_log: 2 }, revision: 7, freeSlots: 5, layout: { slotCount: 46 }, slots: [1] },
		coverage: "partial",
		unknown: ["offhand unavailable"],
		source: "derived",
		observedAt: "sampled-at",
		cursor: { revision: 7 },
		evidence: ["effect:1"],
	};
	const executor = { rpc: async () => fact } as unknown as MinecraftExecutor;
	const signal = new AbortController().signal;
	const facade = new MinecraftFacade(executor, { signal });
	try {
		const selector = "inventory@1";
		const normal = await facade.execute("observe", { selector }, signal);
		expect(JSON.parse(normal.result)).toEqual({
			value: { counts: { oak_log: 2 }, revision: 7, freeSlots: 5 },
			coverage: "partial",
			unknown: ["offhand unavailable"],
			source: "derived",
			observedAt: "sampled-at",
		});
		expect(normal.details).toBe(fact);
		for (const params of [{ detail: "full" }, { input: { since: 6 } }, { input: { matching: "oak_log" } }])
			expect(JSON.parse((await facade.execute("observe", { selector, ...params }, signal)).result)).toEqual(fact);
	} finally {
		await facade.close();
	}
});

test("native facade uses durable requests and Host acknowledgement, preserves explicit unsupported branches", () => {
	const dir = mkdtempSync(join(tmpdir(), "uina-mc-facade-"));
	const url = (p: string) => JSON.stringify(pathToFileURL(resolve(p)).href);
	const script = join(dir, "facade.mjs");
	writeFileSync(
		script,
		`
import assert from 'node:assert/strict';
import { MinecraftExecutor } from ${url(".uina/worlds/minecraft/executor/index.ts")};
import { MinecraftFacade } from ${url(".uina/worlds/minecraft/executor/facade.ts")};
const root=${JSON.stringify(dir)};
let executor=await MinecraftExecutor.open({ownershipDir: root, sessionDataDir: root, sharedDataDir: root,config:{connection:{host:'127.0.0.1',port:1,username:'FacadeTest',authMode:'offline',version:'1.21.11'},binding:null},policy:{autoRecover:false,closeGraceMs:3000}});
const receipts=new Map();let emitted=0;
const deliver=event=>{emitted++;receipts.set(event.receipt.key,{kind:'committed',receipt:{...event.receipt,namespace:'world:minecraft',session:'session',channel:'input',record:'canonical-input'}});};
const ctx={signal:new AbortController().signal,delivery:{namespace:'world:minecraft',session:'session',durability:'durable',inspect:async key=>receipts.get(key)??{kind:'absent'},retire:async()=>({kind:'retired'})},onHostEvent:()=>()=>{},emitEvent:async event=>{deliver(event);return {accepted:true};},emitEvents:async events=>{for(const event of events)deliver(event);return events.map(()=>({accepted:true}));}};
let facade=new MinecraftFacade(executor,ctx,{pollMs:20});facade.start();
const signal=new AbortController().signal;
let request;
try {
 const unknownQuery=await facade.execute('observe',{selector:'position@1'},signal);assert.equal(unknownQuery.status,'failed');
 // 顶层动作只等可靠受理：未连接时任务会在后台立刻失败，但工具这一层仍然只回答"已受理"。
 const accepted=await facade.execute('chat',{text:'no connection'},signal);
 assert.equal(accepted.status,'succeeded');assert.equal(accepted.continuation,'yield');
 const reply=JSON.parse(accepted.result);
 assert.equal(reply.kind,'accepted');assert.equal(typeof reply.task,'string');request=reply.task.slice('task:local:'.length);
 // 受理结果只给句柄：进度看状态帧，结果看 minecraft_completion。
 assert.equal(reply.snapshot,undefined);assert.equal(reply.phase,undefined);
 assert.equal((await executor.ledger.getRequest(request)).requestId,request);
 const task=await facade.execute('tasks',{op:'get',task:reply.task},signal);assert.equal(task.status,'succeeded');assert.equal(task.details.task,reply.task);
 const unknownCapability=await facade.execute('run',{selector:'no-such@1',input:{}},signal);assert.equal(unknownCapability.status,'failed');assert.equal(unknownCapability.continuation,undefined);
 const code=await facade.execute('run',{code:'async function main(){return 3;}'},signal);assert.equal(code.status,'succeeded');assert.equal(code.continuation,'yield');
 const codeTask=JSON.parse(code.result).task;
 const trace=await facade.execute('tasks',{op:'trace',task:codeTask},signal);
 assert.equal(trace.status,'succeeded');
 const call=trace.details.calls.items[0];
 const sameTask=await facade.execute('tasks',{op:'trace',task:codeTask,record:call.record},signal);
 assert.equal(sameTask.status,'succeeded');
 const anotherTask=await facade.execute('tasks',{op:'trace',task:reply.task,record:call.record},signal);
 assert.equal(anotherTask.status,'failed');
 const retiredAction=await facade.execute('runs',{op:'status'},signal);assert.equal(retiredAction.status,'failed');
 const before=await executor.rpc('runtime.list',{activeOnly:false});assert.equal(before.items.length,2);
 await facade.close();await executor.close();
 executor=await MinecraftExecutor.open({ownershipDir: root, sessionDataDir: root, sharedDataDir: root,config:{connection:{host:'127.0.0.1',port:1,username:'FacadeTest',authMode:'offline',version:'1.21.11'},binding:null},policy:{autoRecover:false,closeGraceMs:3000}});
 facade=new MinecraftFacade(executor,ctx,{pollMs:20});facade.start();
 assert.equal((await executor.ledger.getRequest(request)).requestId,request);
 assert.equal((await executor.rpc('runtime.list',{activeOnly:false})).items.length,2);
}finally{await facade.close();await executor.close();}
console.log('facade passed');
`,
	);
	try {
		expect(
			execFileSync(process.execPath, ["--import", "tsx", script], {
				cwd: resolve("."),
				encoding: "utf8",
				windowsHide: true,
				timeout: 20000,
			}),
		).toContain("facade passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("顶层动作只返回受理：没有 wait 覆盖，也不再等短窗", async () => {
	const waits: unknown[] = [];
	const snapshot = {
		run: "run-1",
		rootRequestId: "q",
		segment: "s",
		revision: 1,
		record: "rec",
		completion: { scope: "execution" as const },
		phase: "running" as const,
		completionRef: "c1",
		progress: null,
		progressComplete: false,
		control: "running" as const,
		unknownEffectCount: 0,
		unknownEffects: [],
		unknownEffectsComplete: true,
	};
	const executor = {
		status: () => ({ actionsAllowed: true, side: { launch: "launch" } }),
		ledger: { putRequest: async () => {}, found: async () => {} },
		submit: async () => ({ kind: "accepted", requestId: "q", segment: "s", snapshot }),
		wait: async (...args: unknown[]) => {
			waits.push(args);
			return { kind: "accepted", snapshot };
		},
	} as unknown as MinecraftExecutor;
	const facade = new MinecraftFacade(executor, { signal: new AbortController().signal });
	const signal = new AbortController().signal;
	try {
		const plain = await facade.execute("run", { selector: "goto@1", input: {} }, signal);
		// 旧调用方仍会带 wait：schema 已经拒绝它，通道层也不再据此改变行为。
		const legacy = await facade.execute("run", { selector: "goto@1", input: {}, wait: 1200 }, signal);
		for (const reply of [plain, legacy]) {
			expect(reply.status).toBe("succeeded");
			expect(reply.continuation).toBe("yield");
			expect(JSON.parse(reply.result)).toEqual({ kind: "accepted", task: expect.stringMatching(/^task:local:/) });
		}
		// 短窗那条路径已经不存在：一次都不该去问 executor.wait。
		expect(waits).toEqual([]);
	} finally {
		await facade.close();
	}
});
