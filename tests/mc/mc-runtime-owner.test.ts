import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
function verify(source: string): void {
	const dir = mkdtempSync(join(tmpdir(), "uina-runtime-owner-"));
	const script = join(dir, "verify.mjs");
	writeFileSync(
		script,
		`
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MinecraftRuntime } from ${moduleUrl(".uina/worlds/minecraft/runtime/index.ts")};
import { PlayerPortImpl } from ${moduleUrl(".uina/worlds/minecraft/driver/body/player-port.ts")};
import { DriverControlArbiter } from ${moduleUrl(".uina/worlds/minecraft/driver/control-arbiter.ts")};
import { makeBodyBot, ownerT } from ${moduleUrl("tests/mc/mc-fake-driver.ts")};
const dbPath=${JSON.stringify(join(dir, "runtime.db"))};
const origin={worldOwner:"owner:test",activation:"act:test"};
const descriptor=ref=>({ref,summary:"owner regression",input:{},output:{},access:"act",implementation:"native",completion:{scope:"execution",description:"returned"},errors:[],requires:[],examples:[]});
const request=(id="req:test")=>({requestId:id,entry:{kind:"call",selector:"work@1",input:{}},schedule:{kind:"enqueue"}});
const options={dbPath,storageId:"storage:test",namespace:"owner",worldOwner:origin.worldOwner,world:{},playerPort:{acquire:async()=>({close:async()=>{}}),chat:async()=>{throw Error("unexpected chat");}},callables:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function enable(runtime,activation=origin.activation) {
 const state=await runtime.attach({...origin,activation});
 const receipt=await runtime.setOwnerGate({requestId:"enable",attachment:state.attachment,gate:"disabled",closed:false,expectedRevision:state.gateRevision});
 assert.equal(receipt.persistence,"confirmed"); return receipt.state;
}
function sql(fn) { const db=new DatabaseSync(dbPath); db.exec("PRAGMA busy_timeout=1000"); try {return fn(db);} finally {db.close();} }
${source}
console.log("owner regression passed");
`,
	);
	try {
		const result = execFileSync(process.execPath, ["--import", "tsx", script], {
			cwd: resolve("."),
			encoding: "utf8",
			timeout: 15000,
			windowsHide: true,
		});
		expect(result).toContain("owner regression passed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("Owner gates are independent, opening uses CAS and expired bindings cannot revive", () =>
	verify(`
let now=100;
const {runtime,start}=await MinecraftRuntime.open({...options,monotonicNow:()=>now});
assert.deepEqual(start.ownerGates,["disabled"]);
assert.equal(runtime.inspectOwner(),null);
assert.throws(()=>runtime.assertActionAllowed());
const before=await runtime.attach(origin);
assert.equal(before.validForMs,5000);
await assert.rejects(runtime.setOwnerGate({requestId:"bad",attachment:before.attachment,gate:"disabled",closed:false}),e=>e.code==="OWNER_STATE_CHANGED");
let state=await enable(runtime);
const opening=runtime.setOwnerGate({requestId:"race-open",attachment:state.attachment,gate:"disabled",closed:false,expectedRevision:state.gateRevision});
const raced=assert.rejects(opening,e=>e.code==="OWNER_STATE_CHANGED");
await runtime.setOwnerGate({requestId:"race-close",attachment:state.attachment,gate:"disabled",closed:true,expectedRevision:-1});
await raced;
state=(await runtime.setOwnerGate({requestId:"race-release",attachment:state.attachment,gate:"disabled",closed:false,expectedRevision:runtime.inspectOwner().gateRevision})).state;
const emergency=await runtime.setOwnerGate({requestId:"panic",attachment:state.attachment,gate:"emergency",closed:true,expectedRevision:-1});
assert.deepEqual(emergency.state.gates,["emergency"]);
const disabled=await runtime.setOwnerGate({requestId:"disable",attachment:state.attachment,gate:"disabled",closed:true});
const cleared=await runtime.setOwnerGate({requestId:"enable2",attachment:state.attachment,gate:"disabled",closed:false,expectedRevision:disabled.state.gateRevision});
assert.deepEqual(cleared.state.gates,["emergency"]);
assert.throws(()=>runtime.assertActionAllowed());
state=(await runtime.setOwnerGate({requestId:"release",attachment:state.attachment,gate:"emergency",closed:false,expectedRevision:cleared.state.gateRevision})).state;
let writes=0;
const bot=makeBodyBot({chat:()=>writes++,supportFeature:()=>false,look:async()=>writes++});
const port=new PlayerPortImpl({assertActionAllowed:()=>runtime.assertActionAllowed(),host:{state:"ready",identity:{connection:"c",incarnation:"i"},on:()=>()=>{}},bot:()=>bot,sink:runtime.sink,sampleSelf:()=>null,arbiter:new DriverControlArbiter(),mintBody:()=>"body:guard",mintOp:()=>"op:guard",mintEff:()=>"eff:guard"});
const body=await port.acquire(ownerT(1),new AbortController().signal);
now=5100; // Expiry is checked by the write itself before the delayed timer can run.
await assert.rejects(port.chat("late",new AbortController().signal));
await assert.rejects(body.lookAt({x:1,y:64,z:1}));
assert.equal(writes,0);
assert.equal(runtime.inspectOwner().validForMs,0);
assert.deepEqual(runtime.inspectOwner().gates,["owner_lost"]);
await assert.rejects(runtime.heartbeat(state.attachment));
const expiredClose=await runtime.setOwnerGate({requestId:"expired-stop",attachment:state.attachment,gate:"emergency",closed:true,expectedRevision:-1});
assert.equal(expiredClose.persistence,"confirmed");assert.ok(expiredClose.state.gates.includes("emergency"));
await assert.rejects(runtime.attach(origin),e=>e.code==="OWNER_EXPIRED");
const next=await runtime.attach({...origin,activation:"act:next"});
assert.notEqual(next.attachment,state.attachment);
assert.ok(next.gates.includes("owner_lost"));
await assert.rejects(runtime.setOwnerGate({requestId:"stale",attachment:state.attachment,gate:"owner_lost",closed:false,expectedRevision:next.gateRevision}));
await body.close();await runtime.close();
const reopened=(await MinecraftRuntime.open({...options,namespace:"restart",unclean:true,oldControlRetired:true})).runtime;
const recovered=await reopened.attach({...origin,activation:"act:restart"});
assert.ok(recovered.gates.includes("owner_lost"));assert.ok(recovered.gates.includes("disabled"));
await reopened.close();
await assert.rejects(MinecraftRuntime.open({...options,namespace:"wrong",worldOwner:"owner:other"}),/world_owner/);
await assert.rejects(MinecraftRuntime.open({...options,namespace:"wrong",storageId:"storage:other"}),/storage_id/);
`));

test("same-key acceptance commits once before execution; close shares one promise and waits for cleanup", () =>
	verify(`
let invoked=0,closed=false,release;
const closingBarrier=new Promise(resolve=>release=resolve);
let startedResolve;const started=new Promise(resolve=>startedResolve=resolve);
const callable={descriptor:descriptor("work@1"),invoke:ctx=>ctx.withBody(async()=>{
 invoked++;
 assert.equal(sql(db=>db.prepare("SELECT status FROM submissions WHERE request_id='req:test'").get().status),"accepted");
 startedResolve();
 await new Promise(resolve=>ctx.signal.addEventListener("abort",resolve,{once:true}));
 return "stopped";
})};
const {runtime}=await MinecraftRuntime.open({...options,callables:[callable],playerPort:{acquire:async()=>({close:async()=>{await closingBarrier;closed=true;}})}});
await enable(runtime);
const first=runtime.submit(origin,request());const duplicate=runtime.submit(origin,request());
assert.equal(first,duplicate);
const conflicting=await runtime.submit(origin,{...request(),entry:{...request().entry,input:{different:true}}});
assert.equal(conflicting.code,"REQUEST_CONFLICT");
const accepted=await first;assert.equal(accepted.kind,"accepted");await started;
assert.equal(invoked,1);assert.equal(sql(db=>db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n),1);
const close1=runtime.close();const close2=runtime.close();assert.equal(close1,close2);
assert.throws(()=>runtime.assertActionAllowed());assert.equal(runtime.availability(),"unavailable");
let completed=false;void close1.then(()=>completed=true);
await sleep(25);assert.equal(completed,false);assert.equal(closed,false);
release();await close1;assert.equal(closed,true);
assert.equal(sql(db=>db.prepare("SELECT phase FROM runs").get().phase),"finished");
assert.equal((await runtime.submit(origin,request("req:late"))).kind,"not_accepted");
let lateInvoked=0;
const next=(await MinecraftRuntime.open({...options,namespace:"stop-race",callables:[{descriptor:descriptor("work@1"),invoke:async()=>{lateInvoked++;return null;}}]})).runtime;
await enable(next);
const raced=await next.submit(origin,request("req:stop-race"));
await next.stop({requestId:"stop-race",target:{run:raced.snapshot.run}});
await next.wait(raced.snapshot.run,{timeoutMs:2000});assert.equal(lateInvoked,0);
await next.close();
`));

test("failed acceptance dispatches nothing and a failed gate write still aborts control", () =>
	verify(`
let invoked=0;
let runtime=(await MinecraftRuntime.open({...options,callables:[{descriptor:descriptor("work@1"),invoke:async()=>{invoked++;return null;}}]})).runtime;
await enable(runtime);
sql(db=>db.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT,'accept rejected'); END"));
const rejected=await runtime.submit(origin,request());assert.equal(rejected.kind,"unknown");assert.equal(invoked,0);
assert.equal(runtime.lookup("req:test").kind,"unavailable");
assert.equal((await runtime.submit(origin,{...request(),entry:{...request().entry,input:{conflict:true}}})).code,"REQUEST_CONFLICT");
assert.throws(()=>runtime.assertActionAllowed());await assert.rejects(runtime.close());
assert.equal(sql(db=>db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n),0);
sql(db=>db.exec("DROP TRIGGER fail_accept"));
let aborted=false;let enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve);
runtime=(await MinecraftRuntime.open({...options,namespace:"gate",callables:[{descriptor:descriptor("work@1"),invoke:async ctx=>{enteredResolve();await new Promise(resolve=>ctx.signal.addEventListener("abort",()=>{aborted=true;resolve();},{once:true}));return null;}}]})).runtime;
const state=await enable(runtime);
await runtime.submit(origin,request("req:gate"));await entered;await runtime.barrier.flushThrough(runtime.barrier.capture());
sql(db=>db.exec("CREATE TRIGGER fail_gate BEFORE UPDATE ON meta WHEN NEW.key='owner_gates' BEGIN SELECT RAISE(ABORT,'gate rejected'); END"));
const closing=runtime.setOwnerGate({requestId:"panic",attachment:state.attachment,gate:"emergency",closed:true,expectedRevision:-1});
assert.equal(aborted,true);assert.throws(()=>runtime.assertActionAllowed());
const receipt=await closing;assert.equal(receipt.persistence,"unknown");assert.ok(receipt.state.gates.includes("emergency"));
await assert.rejects(runtime.close());
`));

test("unretired calls request trusted retirement and old schema is rejected without migration", () =>
	verify(`
const notices=[];let enteredResolve;const entered=new Promise(resolve=>enteredResolve=resolve);
const {runtime}=await MinecraftRuntime.open({...options,requireRetirement:notice=>notices.push(notice),callables:[{descriptor:descriptor("work@1"),invoke:()=>{enteredResolve();return new Promise(()=>{});}}]});
await enable(runtime);const old=await runtime.submit(origin,request());await entered;
await assert.rejects(runtime.close(),/retire|isolation/);
assert.ok(notices.some(notice=>notice.source==="runtime"&&notice.code==="EXECUTION_DOMAIN_UNRETIRED"&&notice.subject===null));
await assert.rejects(MinecraftRuntime.open({...options,namespace:"unsafe",unclean:true,oldControlRetired:false,requireRetirement:notice=>notices.push(notice)}),/old control domain/);
let replayed=0;
const recovery=(await MinecraftRuntime.open({...options,namespace:"recovered",unclean:true,oldControlRetired:true,callables:[{descriptor:descriptor("work@1"),invoke:async()=>{replayed++;return null;}}]})).runtime;
const recoveredOwner=await recovery.attach({...origin,activation:"act:recovered"});
assert.ok(recoveredOwner.gates.includes("owner_lost"));assert.equal(replayed,0);
assert.equal(recovery.read(old.snapshot.run).phase,"finished");assert.equal(recovery.read(old.snapshot.run).control,"stopped");
await recovery.close();
sql(db=>db.exec("UPDATE meta SET value='1' WHERE key='schema_version'"));
const before=sql(db=>db.prepare("SELECT COUNT(*) AS n FROM record_log").get().n);
await assert.rejects(MinecraftRuntime.open({...options,namespace:"old"}),/schema/);
assert.equal(sql(db=>db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value),"1");
assert.equal(sql(db=>db.prepare("SELECT COUNT(*) AS n FROM record_log").get().n),before);
`));

test("closing an already-closed gate fences an in-flight open of that gate", () =>
	verify(`
const {runtime}=await MinecraftRuntime.open(options);
try {
 const state=await runtime.attach(origin);
 assert.deepEqual(state.gates,["disabled"]);
 const opening=runtime.setOwnerGate({requestId:"opening",attachment:state.attachment,gate:"disabled",closed:false,expectedRevision:state.gateRevision});
 const outcome=opening.then(()=>null,error=>error);
 const closing=await runtime.setOwnerGate({requestId:"closing",attachment:state.attachment,gate:"disabled",closed:true,expectedRevision:-1});
 const error=await outcome;
 assert.equal(error?.code,"OWNER_STATE_CHANGED");
 assert.equal(closing.persistence,"confirmed");
 assert.deepEqual(runtime.inspectOwner().gates,["disabled"]);
 assert.throws(()=>runtime.assertActionAllowed());
 assert.deepEqual(JSON.parse(sql(db=>db.prepare("SELECT value FROM meta WHERE key='owner_gates'").get().value)),["disabled"]);
} finally { await runtime.close(); }
`));
