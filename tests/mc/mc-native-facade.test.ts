import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import { RpcError } from "../../.uina/worlds/minecraft/executor/ipc.js";

test("a submit rejected before IPC dispatch retains its credential and reports not accepted", async () => {
	let credentials = 0;
	const executor = {
		status: () => ({ actionsAllowed: true, side: { launch: "launch" } }),
		ledger: {
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
		expect(result.status).toBe("failed");
		expect(result.details).toMatchObject({ kind: "not_accepted", code: "REQUEST_TOO_LARGE" });
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
let executor=await MinecraftExecutor.open({worldDataDir:root,config:{connection:{host:'127.0.0.1',port:1,username:'FacadeTest',authMode:'offline',version:'1.21.11'},binding:null},policy:{autoRecover:false,closeGraceMs:3000}});
const receipts=new Map();let emitted=0;
const ctx={signal:new AbortController().signal,delivery:{namespace:'world:minecraft',session:'session',durability:'durable',inspect:async key=>receipts.get(key)??{kind:'absent'},retire:async()=>({kind:'retired'})},onHostEvent:()=>()=>{},emitEvent:async event=>{emitted++;receipts.set(event.receipt.key,{kind:'committed',receipt:{...event.receipt,namespace:'world:minecraft',session:'session',channel:'input',record:'canonical-input'}});}};
let facade=new MinecraftFacade(executor,ctx,{shortWindowMs:2000,pollMs:20});facade.start();
const signal=new AbortController().signal;
let key,request;
try {
 const found=await facade.execute('describe',{selector:'chat@1'},signal);assert.equal(found.status,'succeeded');assert.match(found.result,/chat@1/);
 const unknownQuery=await facade.execute('observe',{selector:'position@1'},signal);assert.equal(unknownQuery.status,'failed');
 const result=await facade.execute('chat',{text:'no connection'},signal);assert.equal(result.status,'failed');assert.ok(result.receipt);key=result.receipt.key;request=result.details.requestId;
 assert.equal((await executor.rpc('runtime.readDelivery',{ref:key})).disposition,'pending');
 receipts.set(key,{kind:'committed',receipt:{...result.receipt,namespace:'world:minecraft',session:'session',channel:'tool',record:'canonical-tool'}});
 await facade.reconcile();assert.equal((await executor.rpc('runtime.readDelivery',{ref:key})).disposition,'committed');assert.equal(emitted,0);
 const retry=await facade.execute('runs',{op:'retry',request},signal);assert.equal(retry.status,'succeeded');assert.equal(retry.details.kind,'found');
 const bad=await facade.execute('run',{selector:'chat',input:{text:'no'}},signal);assert.equal(bad.status,'failed');
 const code=await facade.execute('run',{code:'throw 1'},signal);assert.equal(code.status,'failed');
 const files=await facade.execute('library',{op:'list'},signal);assert.equal(files.status,'failed');
 const before=await executor.rpc('runtime.list',{activeOnly:false});assert.equal(before.items.length,1);
 await facade.close();await executor.close();
 executor=await MinecraftExecutor.open({worldDataDir:root,config:{connection:{host:'127.0.0.1',port:1,username:'FacadeTest',authMode:'offline',version:'1.21.11'},binding:null},policy:{autoRecover:false,closeGraceMs:3000}});
 facade=new MinecraftFacade(executor,ctx,{shortWindowMs:2000,pollMs:20});facade.start();
 assert.equal((await executor.ledger.getRequest(request)).requestId,request);
 assert.equal((await executor.rpc('runtime.list',{activeOnly:false})).items.length,1);
 assert.equal((await executor.rpc('runtime.readDelivery',{ref:key})).disposition,'committed');
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
