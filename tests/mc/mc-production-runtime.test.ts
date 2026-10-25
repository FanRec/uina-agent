import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// SQLite's worker must run in a real Node process, as in mc-runtime-settlement.test.ts.
// Only the server/window boundary is replaced; RuntimeEngine, BodyLeaseQueue and
// RecordQueue are the production objects assembled by MinecraftRuntime.open.
const url = (path: string): string => pathToFileURL(resolve(path)).href;
const imports = `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MinecraftRuntime } from ${JSON.stringify(url(".uina/worlds/minecraft/runtime/index.ts"))};
import { buildRegistryKnowledge } from ${JSON.stringify(url(".uina/worlds/minecraft/driver/facts/knowledge.ts"))};
import { makeHarness, registry } from ${JSON.stringify(url("tests/mc/mc-capability-harness.ts"))};
import { WindowFixture, furnaceLayout, stack } from ${JSON.stringify(url("tests/mc/mc-window-fixture.ts"))};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
 const deadline = Date.now() + 7000;
 while (!predicate()) { assert.ok(Date.now() < deadline, label); await sleep(5); }
}
const descriptor = ref => ({ref,summary:"production integration",input:{},output:{},access:"act",implementation:"native",completion:{scope:"capability",description:"observed"},errors:[],requires:[],examples:[]});
const knowledge = buildRegistryKnowledge({...registry,
 itemsByName:{...registry.itemsByName,raw_iron:{id:903,name:"raw_iron",stackSize:64},iron_ingot:{id:904,name:"iron_ingot",stackSize:64},coal:{id:896,name:"coal",stackSize:64}},
 items:{...registry.items,903:{id:903,name:"raw_iron",stackSize:64},904:{id:904,name:"iron_ingot",stackSize:64},896:{id:896,name:"coal",stackSize:64}}
});
// Keep the actual knowledge route, but use a one-tick server recipe in this fixture.
for (const recipe of knowledge.recipesFor("iron_ingot")) if(recipe.station==="furnace") recipe.cookTicks=1;
const at = {x:11,y:64,z:10};
`;

function runCase(kind: "owned" | "delegated" | "cancel"): void {
	const dir = mkdtempSync(join(tmpdir(), "uina-production-runtime-"));
	const dbPath = join(dir, "runtime.db");
	const script = join(dir, "verify.mjs");
	writeFileSync(
		script,
		imports +
			`
const kind = ${JSON.stringify(kind)};
const wanted = kind === "cancel" ? 65 : 3;
const slots = Array.from({length:39},()=>null);
slots[3]=stack("raw_iron",Math.min(64,wanted));
if(wanted>64) slots[4]=stack("raw_iron",wanted-64);
slots[5]=stack("coal",9);
const state={blocks:new Map([["11,64,10",{name:"furnace",properties:{}}]]),inventory:{slots:[],counts:{},selectedSlot:0}};
function sync(window) {
 const player=window.layout.regions.find(r=>r.name==="player").slots;
 state.inventory.slots=player.flatMap((slot,index)=>window.item(slot)?[{slot:9+index,...structuredClone(window.item(slot))}]:[]);
 state.inventory.counts={};
 for(const item of state.inventory.slots) state.inventory.counts[item.name]=(state.inventory.counts[item.name]??0)+item.count;
}
let allowCook=false, cooked=0, opens=0, closes=0, active=0, acquires=0;
const window=new WindowFixture("minecraft:furnace",furnaceLayout(),slots,{
 afterClick: sync,
 beforeSnapshot:w=>{
  w.properties={"0":w.item(1)==null?0:100,"1":1600,"2":0,"3":1};
  const input=w.item(0);
  if(allowCook && input && (kind!=="cancel" || cooked<64)) {
   const amount=input.count;
   w.set(0,null); w.set(2,stack("iron_ingot",(w.item(2)?.count??0)+amount));
   cooked+=amount; w.revision++; sync(w);
  }
 }
});
sync(window);
const fixture=makeHarness(state,{knowledge,openWindow:()=>window});
const session = () => ({
 async runScoped(scope,work){scope.guard();return work();},
 async openContainer(){opens++;return window;},
 async close(){closes++;active--;},
 async lookAt(){return {effect:"eff:look",dispatch:"sent",completion:"met",evidence:[]};}
});
const callables=[fixture.callable("smelt@1"),
 {descriptor:descriptor("other@1"),invoke:ctx=>ctx.withBody(async()=>"other completed")},
 {descriptor:descriptor("delegated@1"),invoke:ctx=>ctx.withBody(scope=>scope.call("smelt@1",{item:"iron_ingot",count:wanted,fuel:"coal",at,maxTimeMs:10000}))}
];
const options={dbPath:${JSON.stringify(dbPath)},storageId:"production@1",namespace:"production",worldOwner:"owner:production",world:fixture.ctx.world,
 playerPort:{acquire:async()=>{assert.equal(active,0,"overlapping body lease");active++;acquires++;return session();},chat:async()=>{throw Error("unexpected chat");}},callables};
const runtime=(await MinecraftRuntime.open(options)).runtime;
const owner=await runtime.attach({worldOwner:"owner:production",activation:"act:production"});
await runtime.setOwnerGate({requestId:"enable",attachment:owner.attachment,gate:"disabled",closed:false,expectedRevision:owner.gateRevision});
async function submit(selector,input={}) {
 const reply=await runtime.submit({worldOwner:"owner:production",activation:"act:production"},{requestId:"req:"+selector+":"+Date.now(),entry:{kind:"call",selector,input},schedule:{kind:"enqueue"}});
 assert.equal(reply.kind,"accepted"); return reply.snapshot.run;
}
async function finish(run) {
 const reply=await runtime.wait(run,{timeoutMs:10000});
 assert.equal(reply.kind,"result");assert.equal(reply.snapshot.phase,"finished");return reply.snapshot;
}
let stopped, saved;
try {
 const run=await submit(kind==="delegated"?"delegated@1":"smelt@1",{item:"iron_ingot",count:wanted,fuel:"coal",at,maxTimeMs:10000});
 await until(()=>window.item(0)?.count===Math.min(64,wanted)&&window.item(1)!=null,"furnace loaded");
 await sleep(50);
 assert.ok(window.closed>0,"smelt must close its window while awaiting server cooking");
 if(kind==="delegated") {
  assert.equal(active,1,"delegated smelt must retain ancestor lease");
  const other=await submit("other@1");
  await sleep(50);assert.notEqual((await runtime.read(other)).phase,"finished","second body must wait for ancestor");
  allowCook=true;
  assert.equal((await finish(run)).outcome,"succeeded");
  assert.equal((await finish(other)).outcome,"succeeded");
  assert.equal(acquires,2,"delegated calls reuse ancestor body");
 } else if(kind==="owned") {
  assert.equal(active,0,"owned body must be released during cooking");
  const other=await submit("other@1");
  assert.equal((await finish(other)).outcome,"succeeded");
  assert.notEqual((await runtime.read(run)).phase,"finished","other body completed before smelting");
  allowCook=true;
  assert.equal((await finish(run)).outcome,"succeeded");
 } else {
  allowCook=true;
  await until(()=>state.inventory.counts.iron_ingot===64&&window.item(0)?.count===1,"second batch loaded after first harvest");
  await until(()=>active===0,"second cooking wait released body");
  await runtime.stop({requestId:"stop:production",target:{run}});
  stopped=await finish(run);assert.equal(stopped.outcome,"cancelled");
  const counts={opens,clicks:window.clicks};
  await sleep(500);
  assert.deepEqual({opens,clicks:window.clicks},counts,"stopped wait must never reopen or click");
  assert.equal(state.inventory.counts.iron_ingot,64);
  assert.equal(window.item(0)?.count,1);
  saved=(await runtime.readRecord(stopped.record)).record;
 }
 if(kind!=="cancel") {
  assert.equal(cooked,3);assert.equal(state.inventory.counts.iron_ingot,3);
  assert.equal(window.item(0),null);assert.equal(window.item(2),null);
 }
 assert.equal(active,0,"all owned body scopes closed");
 assert.equal(window.cursor,null,"cursor empty");
} finally {await runtime.close();}
if(kind==="cancel") {
 const db=new DatabaseSync(options.dbPath);
 try {
  const calls=db.prepare("SELECT progress,error FROM calls WHERE ref='smelt@1'").all();
  const runs=db.prepare("SELECT progress,error FROM runs WHERE run=?").all(stopped.run);
  for(const row of [...calls,...runs]) {
   const progress=JSON.parse(row.progress);
   assert.deepEqual(progress.produced,{iron_ingot:64});
   assert.equal(progress.loaded.input.count,65);
   assert.equal(progress.remaining,1);
  }
  assert.deepEqual(JSON.parse(calls[0].error).progress,JSON.parse(calls[0].progress));
  assert.equal(calls.length,1);assert.equal(runs.length,1);
 } finally {db.close();}
 const reopened=(await MinecraftRuntime.open({...options,namespace:"reopened"})).runtime;
 try {assert.deepEqual((await reopened.read(stopped.run)),stopped);assert.deepEqual((await reopened.readRecord(stopped.record)).record,saved);}
 finally {await reopened.close();}
}
console.log("production runtime "+kind+" passed");
`,
	);
	try {
		const output = execFileSync(process.execPath, ["--import", "tsx", script], {
			cwd: resolve("."),
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
		});
		expect(output).toContain(`production runtime ${kind} passed`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("owned smelt closes its window and lets another Run use the body while waiting", () => runCase("owned"), 20000);
test("delegated smelt closes its window and retains the ancestor body lease", () => runCase("delegated"), 20000);
test(
	"stop during a later smelt batch persists cumulative Call/Run progress and prevents reopening",
	() => runCase("cancel"),
	20000,
);
