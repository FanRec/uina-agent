/** Record references are tested against the owning SQLite boundary, never mutable engine views. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test("effect identity follows new evidence while old record bytes and owner stay fixed", () => {
	const dir = mkdtempSync(join(tmpdir(), "uina-mc-refs-"));
	const script = join(dir, "refs.mjs");
	writeFileSync(
		script,
		`
import assert from 'node:assert/strict';
import {MinecraftRuntime} from ${JSON.stringify(pathToFileURL(resolve(".uina/worlds/minecraft/runtime/index.ts")).href)};
let rt, first, second;
const options={dbPath:${JSON.stringify(join(dir, "runtime.db"))},storageId:'refs',namespace:'first',worldOwner:'refs-owner',world:{},playerPort:{acquire:async()=>({close:async()=>{}})},callables:[{descriptor:{ref:'effect@1',summary:'effect',input:{},output:{},access:'act',implementation:'native',completion:{scope:'capability',description:'observed'},errors:[],requires:[],examples:[]},invoke:ctx=>ctx.withBody(async()=>{
 const fact={effect:'eff:ref',operation:'op:ref',contract:'body.mine@1',observedAt:'2026-10-25T00:00:00.000Z',kind:'dispatch',dispatch:'sent',completion:'unknown',evidence:[]};
 rt.sink.record(fact);first=await rt.readRecord('eff:ref');
 rt.sink.record({...fact,kind:'receipt',completion:'met',evidence:['evidence:1']});second=await rt.readRecord('eff:ref');return {removed:1};
})}]};
rt=(await MinecraftRuntime.open(options)).runtime;
const origin={worldOwner:'refs-owner',activation:'refs-act'},owner=await rt.attach(origin);
await rt.setOwnerGate({requestId:'enable',attachment:owner.attachment,gate:'disabled',closed:false,expectedRevision:owner.gateRevision});
try {
 const accepted=await rt.submit(origin,{requestId:'q',entry:{kind:'call',selector:'effect@1',input:{}},schedule:{kind:'enqueue'}});
 const done=await rt.wait(accepted.snapshot.run,{timeoutMs:2000});assert.equal(done.snapshot.outcome,'succeeded');
 assert.equal(first.record.value.latest.completion,'unknown');assert.equal(second.record.value.latest.completion,'met');
 assert.notEqual(first.record.record,second.record.record);assert.deepEqual(first.record.value.owner,second.record.value.owner);
 assert.deepEqual(await rt.readRecord(first.record.record),first);
 await assert.rejects(rt.readRecord('rec:missing'),{code:'NOT_FOUND'});
}finally{await rt.close();}
rt=(await MinecraftRuntime.open({...options,namespace:'second'})).runtime;
try {assert.deepEqual(await rt.readRecord(first.record.record),first);assert.deepEqual(await rt.readRecord('eff:ref'),second);}finally{await rt.close();}
console.log('fixed refs passed');
`,
	);
	try {
		expect(
			execFileSync(process.execPath, ["--import", "tsx", script], {
				cwd: resolve("."),
				encoding: "utf8",
				windowsHide: true,
				timeout: 10000,
			}),
		).toContain("fixed refs passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
