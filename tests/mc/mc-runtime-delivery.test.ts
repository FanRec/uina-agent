import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test("fixed records, delivery acknowledgement and exports survive a real SQLite restart", () => {
	const dir = mkdtempSync(join(tmpdir(), "uina-mc-delivery-"));
	const script = join(dir, "verify.mjs");
	writeFileSync(
		script,
		`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MinecraftRuntime } from ${JSON.stringify(pathToFileURL(resolve(".uina/worlds/minecraft/runtime/index.ts")).href)};
const options={dbPath:${JSON.stringify(join(dir, "runtime.db"))}, storageId:'records',namespace:'first',worldOwner:'records-owner',world:{},playerPort:{},callables:[{descriptor:{ref:'value@1',summary:'value',input:{},output:{},access:'act',implementation:'native',completion:{scope:'execution',description:'returned'},errors:[],requires:[],examples:[]},invoke:async(ctx,input)=>{await ctx.progress({step:1});return input;}}]};
let rt=(await MinecraftRuntime.open(options)).runtime;
const origin={worldOwner:'records-owner',activation:'records-activation'};
const owner=await rt.attach(origin);
await rt.setOwnerGate({requestId:'enable',attachment:owner.attachment,gate:'disabled',closed:false,expectedRevision:owner.gateRevision});
let report, ref, queued;
try {
 const accepted=await rt.submit(origin,{requestId:'q',entry:{kind:'call',selector:'value@1',input:{text:'x'.repeat(30000)}},schedule:{kind:'enqueue'}});
 assert.equal(accepted.kind,'accepted');
 queued=await rt.readRecord(accepted.snapshot.record);
 assert.equal(queued.kind,'inline');assert.equal(queued.record.value.phase,accepted.snapshot.phase);
 const result=await rt.wait(accepted.snapshot.run,{timeoutMs:2000});assert.equal(result.kind,'result');
 ref=result.snapshot.completionRef;
 report=await rt.readRecord(ref);assert.equal(report.kind,'inline');
 assert.equal(report.record.kind,'completion');assert.equal(report.record.value.snapshot.outcome,'succeeded');
 assert.deepEqual(await rt.readRecord(accepted.snapshot.record),queued);
 assert.equal((await rt.readDelivery(ref)).disposition,'pending');
 assert.equal((await rt.pendingDeliveries()).items[0].completionRef,ref);
 assert.equal((await rt.list({activeOnly:false})).items.length,1);
 assert.equal((await rt.listCalls(accepted.snapshot.run,{})).items.length,1);
 const file=await rt.readRecord(ref,{format:'file'});assert.equal(file.kind,'file');
 const bytes=await readFile(file.file.path);assert.equal(bytes.length,file.file.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),file.file.sha256);
 assert.deepEqual(JSON.parse(bytes.toString()),report.record);
 const {writeFile}=await import('node:fs/promises');await writeFile(file.file.path,'corrupt');
 assert.deepEqual(JSON.parse((await readFile((await rt.readRecord(ref,{format:'file'})).file.path)).toString()),report.record);
 const large=await rt.submit(origin,{requestId:'large',entry:{kind:'call',selector:'value@1',input:{text:'z'.repeat(300000)}},schedule:{kind:'enqueue'}});
 const largeDone=await rt.wait(large.snapshot.run,{timeoutMs:2000});
 assert.equal((await rt.readRecord(largeDone.snapshot.completionRef)).kind,'file');
 await assert.rejects(rt.readRecord(largeDone.snapshot.completionRef,{format:'inline'}),{code:'RECORD_TOO_LARGE'});
 await rt.settleDelivery(largeDone.snapshot.completionRef,{namespace:'n',session:'s',key:largeDone.snapshot.completionRef,attempt:'large',record:'h',channel:'input'});
 await assert.rejects(rt.readRecord('missing'),{code:'NOT_FOUND'});
} finally {await rt.close();}
rt=(await MinecraftRuntime.open({...options,namespace:'second'})).runtime;
try {
 assert.deepEqual(await rt.readRecord(ref),report);
 assert.equal((await rt.readDelivery(ref)).disposition,'pending');
 await assert.rejects(rt.settleDelivery(ref,{namespace:'n',session:'s',key:'other',attempt:'a',record:'h',channel:'tool'}),{code:'RECEIPT_INVALID'});
 const receipt={namespace:'n',session:'s',key:ref,attempt:'a',record:'h',channel:'tool'};
 await rt.settleDelivery(ref,receipt);await rt.settleDelivery(ref,receipt);
 assert.equal((await rt.readDelivery(ref)).disposition,'committed');
 assert.equal((await rt.pendingDeliveries()).items.length,0);
 assert.deepEqual(await rt.readRecord(ref),report);
} finally {await rt.close();}
console.log('fixed delivery passed');
`,
	);
	try {
		expect(
			execFileSync(process.execPath, ["--import", "tsx", script], {
				cwd: resolve("."),
				encoding: "utf8",
				windowsHide: true,
				timeout: 15000,
			}),
		).toContain("fixed delivery passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed terminal transaction publishes no completion; reopening settles facts without replay", () => {
	const dir = mkdtempSync(join(tmpdir(), "uina-mc-terminal-fault-"));
	const script = join(dir, "fault.mjs");
	writeFileSync(
		script,
		`
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MinecraftRuntime} from ${JSON.stringify(pathToFileURL(resolve(".uina/worlds/minecraft/runtime/index.ts")).href)};
let invoked=0;
const options={dbPath:${JSON.stringify(join(dir, "runtime.db"))},storageId:'fault',namespace:'first',worldOwner:'fault-owner',world:{},playerPort:{},callables:[{descriptor:{ref:'work@1',summary:'work',input:{},output:{},access:'act',implementation:'native',completion:{scope:'execution',description:'returned'},errors:[],requires:[],examples:[]},invoke:async()=>{invoked++;return 1;}}]};
let rt=(await MinecraftRuntime.open(options)).runtime;
const origin={worldOwner:'fault-owner',activation:'fault-act'},owner=await rt.attach(origin);
await rt.setOwnerGate({requestId:'enable',attachment:owner.attachment,gate:'disabled',closed:false,expectedRevision:owner.gateRevision});
const db=new DatabaseSync(options.dbPath);
db.exec("CREATE TRIGGER fail_terminal BEFORE INSERT ON completions BEGIN SELECT RAISE(ABORT,'terminal rejected'); END");
const accepted=await rt.submit(origin,{requestId:'q',entry:{kind:'call',selector:'work@1',input:{}},schedule:{kind:'enqueue'}});
await assert.rejects(rt.wait(accepted.snapshot.run,{timeoutMs:100}));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM completions').get().n,0);
assert.notEqual(db.prepare('SELECT phase FROM runs').get().phase,'finished');
await assert.rejects(rt.close());
db.exec('DROP TRIGGER fail_terminal');db.close();
rt=(await MinecraftRuntime.open({...options,namespace:'restart',unclean:true,oldControlRetired:true})).runtime;
try {
 const recovered=await rt.read(accepted.snapshot.run);assert.equal(recovered.phase,'finished');assert.equal(recovered.outcome,'unknown');
 assert.equal((await rt.readDelivery(recovered.completionRef)).disposition,'pending');
 assert.equal((await rt.readRecord(recovered.completionRef)).record.kind,'completion');
 assert.equal(invoked,1);assert.equal((await rt.pendingDeliveries()).items.length,1);
}finally{await rt.close();}
console.log('terminal fault passed');
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
		).toContain("terminal fault passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
