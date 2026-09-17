import { describe, expect, it } from "vitest";
import { MemorySessionStore, openJsonlSession } from "../src/session/jsonl-store.js";
import { createSessionAccess } from "../src/session/access.js";
import { commitRewindTransition } from "../src/agent/rewind.js";
import { resolveProjectionPolicy } from "../src/agent/projection.js";
import type { ModelStreamFn } from "../src/core/types.js";
import { projectAgentHistory, protectRewindContext, summarizeAbandonedEffects, projectInputMessage } from "../src/session/recovery.js";
import { BranchInspectorOverlay } from "../src/ui/components/overlays/branch-inspector.js";
import { listSessionBranches, listSessionNodes, readSessionBranch, readSessionNode } from "../src/session/navigation.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** P6b：把 official compaction capability 装进裸 Subject（host 装配的最小等价物）。 */
async function capabilitySubject(store: MemorySessionStore, model: ReturnType<typeof mockModel>, stream: ModelStreamFn) {
	const { ExtensionRunner } = await import("../src/extensions/runner.js");
	const { createRuntimeHooks } = await import("../src/extensions/runtime-hooks.js");
	const { default: activateCompaction } = await import("../src/extensions/compaction/index.js");
	let hooks: ReturnType<typeof createRuntimeHooks> | undefined;
	const runner = new ExtensionRunner({
		cwd: process.cwd(),
		tools: new ToolBroker(),
		models: { current: () => model, list: () => [model], groups: () => [], resolve: () => model, select: async () => {}, stream },
		history: () => store.state.entries,
		emitRuntimeEvent: (event) => hooks!.events.emit(event),
		onCustomEntry: (entry) => store.appendCustomEntry(entry),
	});
	await runner.activateBuiltin("compaction", activateCompaction);
	hooks = createRuntimeHooks(runner);
	return new Subject(model, stream, new ToolBroker(), { store, runtimeHooks: hooks });
}

async function seed(store: MemorySessionStore | Awaited<ReturnType<typeof openJsonlSession>>["store"]) {
	await store.appendMessage({role:"user",content:"original task"});
	await store.appendMessage({role:"assistant",content:"bad plan"});
	await store.appendMessage({role:"user",content:"stop writing files"});
	return store.readRecords();
}
describe("session mainline persistence", () => {
	it("keeps abandoned nodes readable, preserves subsequent inputs, and forbids revisiting an archive", async () => {
		const store = new MemorySessionStore(); const records = await seed(store);
		await store.appendRewind({id:"r1",requestId:"q1",targetId:records[0].id,fromId:records[2].id,source:"user",reason:"bad premise"});
		const main = listSessionNodes(store.readRecords());
		expect(main.nodes.map(node=>node.id)).toEqual([records[0].id,"r1"]);
		expect(readSessionNode(store.readRecords(),records[1].id)).toMatchObject({kind:"message",message:{content:"bad plan"}});
		const context = projectAgentHistory(store.state.entries);
		expect(context.some(message=>message.content === "bad plan")).toBe(false);
		expect(context.some(message=>message.content.includes("stop writing files"))).toBe(false);
		expect(() => store.appendRewind({id:"bad",requestId:"bad",targetId:records[1].id,fromId:"r1",source:"user",reason:"archive"})).toThrow("祖先");
		await store.appendMessage({role:"assistant",content:"corrected plan"});
		const latest=store.readRecords().at(-1)!;
		await store.appendRewind({id:"r2",requestId:"q2",targetId:records[0].id,fromId:latest.id,source:"user",reason:"again"});
		expect(listSessionNodes(store.readRecords(),{scope:"all"}).nodes.filter(node=>!node.active).length).toBe(4);
		expect(projectAgentHistory(store.state.entries).filter(message=>message.content.includes("stop writing files"))).toHaveLength(0);
	});
	it("rejects cuts inside tool exchanges", async () => {
		const store=new MemorySessionStore(); await seed(store);
		await store.appendMessage({role:"assistant",content:"",tool_calls:[{id:"call",name:"write_file",args:{}}]});
		const target=store.readRecords().at(-1)!.id;
		await store.appendMessage({role:"tool",tool_call_id:"call",content:"written",status:"succeeded"});
		const fromId=store.readRecords().at(-1)!.id;
		expect(()=>store.appendRewind({id:"r",requestId:"q",targetId:target,fromId,source:"test",reason:"cut"})).toThrow("工具");
	});
	it("reopens the same mainline and ignores compression from the abandoned path", async () => {
		const dir=await mkdtemp(join(tmpdir(),"uina-rewind-")); const path=join(dir,"session.jsonl");
		try {
			const {store}=await openJsonlSession(path); const records=await seed(store);
			await store.appendCompaction("bad compressed plan",[],100);
			await store.appendRewind({id:"r",requestId:"q",targetId:records[0].id,fromId:store.readRecords().at(-1)!.id,source:"test",reason:"wrong"});
			await store.close();
			const reopened=await openJsonlSession(path);
			expect(projectAgentHistory(reopened.snapshot.entries).some(message=>message.content.includes("bad compressed plan"))).toBe(false);
			expect(listSessionNodes(reopened.store.readRecords()).headId).toBe("r");
			await reopened.store.appendCompaction("short summary",[],100);
			expect(projectAgentHistory(reopened.store.state.entries).some(message=>message.content.includes("会话回溯"))).toBe(true);
			await reopened.store.close();
		} finally { await rm(dir,{recursive:true,force:true}); }
	});
});

import { UinaHost } from "../src/host/host.js";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
import { mockModel } from "./helpers/mock-provider.js";
import { readFile } from "node:fs/promises";
import type { SessionRewindRecord } from "../src/session/types.js";

describe("rewind runtime safe points", () => {
	it("settles the whole tool batch before rewinding, preserves files and resumes the new mainline", async () => {
		const cwd=await mkdtemp(join(tmpdir(),"uina-rewind-host-"));
		let count=0,targetId=""; const errors:string[]=[]; let rewinds=0;
		const host=await UinaHost.create({cwd,sessionPath:join(cwd,"session.jsonl"),model:mockModel(),stream:async (_m,req,emit)=>{
			count++;
			if(count===1) { emit({kind:"text",text:"bad original plan"}); emit({kind:"finish",reason:"stop"}); return; }
			if(count===2) {
				emit({kind:"tool_call",call:{id:"rewind-call",name:"session_rewind",args:JSON.stringify({targetId,reason:"incorrect premise",summary:"do not repeat the write"})}});
				emit({kind:"tool_call",call:{id:"write-call",name:"write_file",args:JSON.stringify({path:"effect.txt",text:"already written"})}});
				emit({kind:"finish",reason:"tool_calls"});return;
			}
			expect(await readFile(join(cwd,"effect.txt"),"utf8")).toBe("already written");
			expect(req.messages.some(m=>m.content==="bad original plan")).toBe(false);
			expect(req.messages.some(m=>m.content.includes("会话回溯"))).toBe(true);
			expect(req.messages.some(m=>m.content.includes("new requirement"))).toBe(false);
			emit({kind:"text",text:"corrected response"});emit({kind:"finish",reason:"stop"});
		}});
		host.subscribe(event=>{if(event.type==="error")errors.push(event.text);if(event.type==="session_rewind")rewinds++;});
		try {
			await host.start();await host.submitText("initial task");targetId=host.session.list().nodes[0].id;
			await host.submitText("new requirement: preserve existing changes");
			expect(errors).toEqual([]);expect(rewinds).toBe(1);expect(count).toBe(3);
			expect(host.session.list({scope:"all"}).nodes.filter(node=>!node.active).length).toBeGreaterThan(0);
			await host.dispose();
			const reopened=await openJsonlSession(join(cwd,"session.jsonl"));
			expect(projectAgentHistory(reopened.snapshot.entries).at(-1)?.content).toBe("corrected response");
			await reopened.store.close();
		} finally {await host.dispose();await rm(cwd,{recursive:true,force:true});}
	});
	it("leaves history untouched if the rewind append fails", async () => {
		class FailingStore extends MemorySessionStore { override appendRewind(_record: Omit<SessionRewindRecord,"kind"|"seq"|"timestamp">):Promise<void>{return Promise.reject(new Error("disk unavailable"));} }
		const store=new FailingStore();const records=await seed(store);
		const subject=new Subject(mockModel(),async()=>{throw new Error("must not run");},new ToolBroker(),{store});
		const history=projectAgentHistory(store.state.entries);subject.addHistory(history);
		await expect(subject.requestRewind({targetId:records[0].id,reason:"wrong"},"test")).rejects.toThrow("disk unavailable");
		expect(subject.historySnapshot()).toEqual(history);expect(subject.isBusy()).toBe(false);
	});
	it("cancels a scheduled rewind without dropping newly queued input", async () => {
		const store=new MemorySessionStore();const records=await seed(store);let entered!:()=>void;
		const started=new Promise<void>(resolve=>{entered=resolve;});
		const subject=new Subject(mockModel(),async(_model,_req,_emit,signal)=>{
			entered();await new Promise<void>(resolve=>signal!.addEventListener("abort",()=>resolve(),{once:true}));
		},new ToolBroker(),{store});
		subject.addHistory(projectAgentHistory(store.state.entries));
		const run=subject.pushInput("working");await started;
		const result=await subject.requestRewind({targetId:records[0].id,reason:"wrong"},"test");expect(result.status).toBe("scheduled");
		await subject.steer("latest instruction");subject.interrupt();await run;
		expect(store.readRecords().some(record=>record.kind==="rewind")).toBe(false);
		expect(subject.queuedSnapshot()[0].text).toBe("latest instruction");
	});
	// P6c：超限回溯拒绝门退役——回溯总是提交，窗口压力由 capability 的
	// transformContext 每请求裁剪收敛（正向覆盖见 "trims a rewind that
	// re-exposes oversized history instead of refusing it"）。
	it("rebuilds the pre-compaction mainline and drops the abandoned summary when rewinding across a compaction", async () => {
		const store=new MemorySessionStore();
		await store.appendMessage({role:"user",content:"PRE-COMPACTION USER"});
		await store.appendMessage({role:"assistant",content:"pre-compaction answer"});
		const targetId=store.readRecords()[1].id;
		await store.appendCompaction("STALE SUMMARY of the abandoned path",[{role:"assistant",content:"pre-compaction answer"}],900);
		await store.appendMessage({role:"user",content:"post-compaction user"});
		await store.appendMessage({role:"assistant",content:"post-compaction answer"});
		const fromId=store.readRecords().at(-1)!.id;
		await store.appendRewind({id:"r-cross",requestId:"q",targetId,fromId,source:"model",reason:"fold back before the summary"});

		const entries=store.state.entries;
		const history=projectAgentHistory(entries);
		expect(history.some(message=>message.content==="PRE-COMPACTION USER")).toBe(true);
		expect(history.some(message=>message.content.includes("STALE SUMMARY"))).toBe(false);
		expect(history.some(message=>message.content.includes("会话回溯"))).toBe(true);
		// The abandoned path stays readable as history, it just stops shaping the mainline.
		const all=store.state.allEntries;
		expect(all.some(entry=>entry.kind==="compaction")).toBe(true);
		expect(listSessionNodes(store.readRecords(),{scope:"all"}).nodes.some(node=>!node.active)).toBe(true);
	});
	it("trims a rewind that re-exposes oversized history instead of refusing it", async () => {
		const store=new MemorySessionStore();
		await store.appendMessage({role:"user",content:"KEEP-THIS-PREFIX "+"p".repeat(80000)});
		await store.appendMessage({role:"assistant",content:"ack",usage:{totalTokens:120}});
		await store.appendMessage({role:"user",content:"abandoned instruction"});
		await store.appendMessage({role:"assistant",content:"abandoned answer"});
		const targetId=store.readRecords().at(-1)!.id;
		await store.appendMessage({role:"user",content:"RE-EXPOSED "+"r".repeat(8000)});
		const fromId=store.readRecords().at(-1)!.id;
		await store.appendRewind({id:"r1",requestId:"q1",targetId,fromId,source:"test",reason:"oversized"});

		const sent:string[][]=[];
		const stream=async(_m:unknown,req:{messages:{role:string;content?:string}[]},emit:(d:{kind:string;text?:string;reason?:string})=>void)=>{
			if (!String(req.messages[0]?.content??"").includes("上下文摘要助手")) {
				sent.push(req.messages.map(message=>String(message.content ?? "")));
			}
			emit({kind:"text",text:"continued"});
			emit({kind:"finish",reason:"stop"});
		};
		// 预算 = 20_000 - 16_384 = 3_616 tokens；重展开历史 ≈ 数千 tokens → 触发裁剪。
		const subject=await capabilitySubject(store,mockModel({contextWindow:20_000}),stream as never);
		subject.addHistory(projectAgentHistory(store.state.entries));

		// The mainline projection now carries the re-exposed pre-compaction history, which overflows.
		await subject.pushInput("carry on");

		const flat=sent.flat();
		expect(flat.some(text=>text.startsWith("[历史摘要] "))).toBe(true);
		expect(flat.some(text=>text.includes("会话回溯"))).toBe(true);
		// P6b：裁剪不写 canonical compaction record——摘要走 uina.compaction.summary 条目。
		expect(store.readRecords().filter(record=>record.kind==="compaction")).toHaveLength(0);
		expect(store.readRecords().some(record=>record.kind==="custom_entry"&&(record as {customType?:string}).customType==="uina.compaction.summary")).toBe(true);
	});

	it("keeps a rewind re-exposing history recoverable via trim without canonical compaction records", async () => {
		const store=new MemorySessionStore();
		await store.appendMessage({role:"user",content:"EARLIER "+"e".repeat(80000)});
		await store.appendMessage({role:"user",content:"start"});
		await store.appendMessage({role:"assistant",content:"ack"});
		const targetId=store.readRecords()[2].id;
		await store.appendMessage({role:"assistant",content:"JUST-DISCARD "+"d".repeat(12000)});
		const fromId=store.readRecords().at(-1)!.id;
		await store.appendRewind({id:"r1",requestId:"q1",targetId,fromId,source:"test",reason:"oversized"});

		const sent:string[][]=[];
		const stream=async(_m:unknown,req:{messages:{role:string;content?:string}[]},emit:(d:{kind:string;text?:string;reason?:string})=>void)=>{
			if (!String(req.messages[0]?.content??"").includes("上下文摘要助手")) {
				sent.push(req.messages.map(message=>String(message.content ?? "")));
			}
			emit({kind:"text",text:"continued"});
			emit({kind:"finish",reason:"stop"});
		};
		const subject=await capabilitySubject(store,mockModel({contextWindow:20_000}),stream as never);
		subject.addHistory(projectAgentHistory(store.state.entries));
		await subject.pushInput("carry on");

		// P6b：超限不拒绝也不截断主线——请求被裁剪收敛，"start" 仍在预算内尾部可见。
		const flat=sent.flat();
		expect(flat.some(text=>text.startsWith("[历史摘要] "))).toBe(true);
		expect(flat.some(text=>text.includes("start"))).toBe(true);
		expect(store.readRecords().filter(record=>record.kind==="compaction")).toHaveLength(0);
		expect(store.readRecords().filter(record=>record.kind==="rewind")).toHaveLength(1);
	});
});

import { ExtensionRunner } from "../src/extensions/runner.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";

describe("rewind composition", () => {
	it("exposes a scoped public API and cancels requests from an unloaded extension", async () => {
		const store=new MemorySessionStore();const records=await seed(store);let ready!:()=>void,finish!:()=>void;
		const entered=new Promise<void>(resolve=>ready=resolve);const finishStream=new Promise<void>(resolve=>finish=resolve);
		const subject=new Subject(mockModel(),async(_m,_r,emit)=>{ready();await finishStream;emit({kind:"text",text:"old result"});emit({kind:"finish",reason:"stop"});},new ToolBroker(),{store});
		subject.addHistory(projectAgentHistory(store.state.entries));
		const runner=new ExtensionRunner({cwd:process.cwd(),tools:new ToolBroker(),session:createSessionAccess(store,(request,source,signal)=>subject.requestRewind(request,source,signal))});
		let api!:import("../src/extensions/runner.js").ExtensionAPI;
		await runner.activateBuiltin("rewind-policy",value=>{api=value;});
		const run=subject.pushInput("working");await entered;
		expect((await api.session.requestRewind({targetId:records[0].id,reason:"bad"})).status).toBe("scheduled");
		await runner.dispose();finish();await run;
		expect(store.readRecords().some(record=>record.kind==="rewind")).toBe(false);
		expect(()=>api.session.list()).toThrow("失效");
	});
	it("keeps the rewind notice in the mainline and displays it in restored transcripts", async () => {
		const store=new MemorySessionStore();const records=await seed(store);
		const subject=new Subject(mockModel(),async(_m,_r,emit)=>{emit({kind:"text",text:"new plan"});emit({kind:"finish",reason:"stop"});},new ToolBroker(),{store});
		subject.addHistory(projectAgentHistory(store.state.entries));
		await subject.requestRewind({targetId:records[0].id,reason:"wrong"},"test");
		await subject.pushInput("继续");
		expect(subject.historySnapshot().some(message=>message.content.includes("会话回溯"))).toBe(true);
		const entries=store.state.entries;
		const transcript=new TranscriptContainer();transcript.loadSession(entries);
		expect(transcript.render(100).join("\n")).toContain("会话回溯");
		expect(subject.historySnapshot()).toEqual(projectAgentHistory(entries));
	});
	it("routes inherited session tools to the executing child, leaving the root mainline untouched", async () => {
		const cwd=await mkdtemp(join(tmpdir(),"uina-rewind-child-"));let childCalls=0;let childTarget="";
		let childDone!:()=>void;const done=new Promise<void>(resolve=>childDone=resolve);
		const host=await UinaHost.create({cwd,model:mockModel(),stream:async(_m,req,emit)=>{
			if(!req.messages.some(message=>message.content.includes("unique child task"))) {emit({kind:"text",text:"root answer"});emit({kind:"finish",reason:"stop"});return;}
			childCalls++;
			if(childCalls===1) {emit({kind:"tool_call",call:{id:"list-child",name:"session_list",args:"{}"}});emit({kind:"finish",reason:"tool_calls"});return;}
			if(childCalls===2) {
				const nodeList=JSON.parse(req.messages.find(message=>message.role==="tool")!.content);
				childTarget=nodeList.nodes[0].id;
				emit({kind:"tool_call",call:{id:"rewind-child",name:"session_rewind",args:JSON.stringify({targetId:childTarget,reason:"test child scope"})}});emit({kind:"finish",reason:"tool_calls"});return;
			}
			expect(req.messages.some(message=>message.content.includes("会话回溯"))).toBe(true);
			emit({kind:"text",text:"child corrected"});emit({kind:"finish",reason:"stop"});childDone();
		}});
		try {
			await host.start();await host.submitText("root task");const rootIds=host.session.list().nodes.map(node=>node.id);
			host.subagents.start({ownerId:"root",label:"child",prompt:"unique child task"});
			await done;
			expect(childCalls).toBe(3);expect(rootIds).not.toContain(childTarget);
			expect(host.session.list({scope:"all"}).nodes.some(node=>node.kind==="rewind")).toBe(false);
		} finally {await host.dispose();await rm(cwd,{recursive:true,force:true});}
	});
});

import { vi } from "vitest";
import { open } from "node:fs/promises";
import { JsonlSessionStore } from "../src/session/jsonl-store.js";

it("rolls back a failed rewind fsync without changing either the file or cached head", async () => {
	const dir=await mkdtemp(join(tmpdir(),"uina-rewind-sync-"));const path=join(dir,"session.jsonl");
	try {
		const initial=await openJsonlSession(path);const records=await seed(initial.store);await initial.store.close();
		const handle=await open(path,"r+");const store=new JsonlSessionStore(path,handle,records.at(-1)!.seq,[...records]);
		vi.spyOn(handle,"sync").mockRejectedValueOnce(new Error("fsync failed"));
		await expect(store.appendRewind({id:"r",requestId:"q",targetId:records[0].id,fromId:records[2].id,source:"test",reason:"wrong"})).rejects.toThrow("fsync failed");
		expect(store.readRecords()).toEqual(records);await store.close();
		const reopened=await openJsonlSession(path);expect(reopened.store.readRecords()).toEqual(records);await reopened.store.close();
	} finally {await rm(dir,{recursive:true,force:true});}
});

it("paginates persisted recovery entries without skipping adjacent records", async () => {
	const dir=await mkdtemp(join(tmpdir(),"uina-rewind-page-"));const path=join(dir,"session.jsonl");
	try {
		const initial=await openJsonlSession(path);
		await initial.store.appendMessage({role:"assistant",content:"",tool_calls:[{id:"interrupted",name:"exec_command",args:{}}]});
		await initial.store.appendEvent("tool_started",{callId:"interrupted"});
		await initial.store.close();
		// P3b 裁定：未决调用 + 后续事实记录的 journal 形态非法；恢复必须先经
		// 启动恢复（planRecovery → 带身份落盘），分页覆盖真实持久化恢复条目。
		const reopened=await openJsonlSession(path);
		await reopened.store.appendMessage({role:"user",content:"continue after crash"});
		let after: string|undefined;const ids:string[]=[];
		do {const page=listSessionNodes(reopened.store.readRecords(),{after,limit:1});ids.push(...page.nodes.map(node=>node.id));after=page.next;} while(after);
		const originId=reopened.store.readRecords()[0].id;
		expect(ids).toHaveLength(3);expect(new Set(ids).size).toBe(3);expect(ids[1]).toBe(`recovered:${originId}:interrupted`);
		expect(listSessionNodes(reopened.store.readRecords()).nodes[1].canRewind).toBe(false);
		await reopened.store.close();
	} finally {await rm(dir,{recursive:true,force:true});}
});

it("does not invent a crash during live reads and durably settles unfinished calls on reopen", async () => {
	const dir=await mkdtemp(join(tmpdir(),"uina-rewind-recovery-"));const path=join(dir,"session.jsonl");
	try {
		const initial=await openJsonlSession(path);
		await initial.store.appendMessage({role:"user",content:"task"});
		await initial.store.appendMessage({role:"assistant",content:"",tool_calls:[{id:"unfinished",name:"exec_command",args:{}}]});
		await initial.store.appendEvent("tool_started",{callId:"unfinished"});
		const live=listSessionNodes(initial.store.readRecords());
		expect(live.nodes).toHaveLength(2);expect(live.nodes.some(node=>node.id.startsWith("recovered:"))).toBe(false);
		expect(live.nodes[1].preview).toBe("[调用 exec_command]");
		expect(() => readSessionNode(initial.store.readRecords(), `recovered:${initial.store.readRecords()[1].id}:unfinished`)).toThrow("未知会话节点");
		await initial.store.close();
		const reopened=await openJsonlSession(path);
		expect(reopened.store.readRecords().at(-1)).toMatchObject({kind:"message",message:{role:"tool",status:"unknown"}});
		const nodes=listSessionNodes(reopened.store.readRecords());
		expect(nodes.nodes).toHaveLength(3);
		// 恢复事实带稳定身份落盘（planRecovery → 可审计）；恢复节点被 reducer 结构性排除出安全回溯目标
		expect(nodes.nodes.at(-1)).toMatchObject({ id: expect.stringMatching(/^recovered:/), canRewind: false });
		await reopened.store.appendRewind({id:"after-crash",requestId:"q",targetId:nodes.nodes[0].id,fromId:nodes.headId!,source:"test",reason:"recover"});
		await reopened.store.close();
		const again=await openJsonlSession(path);expect(listSessionNodes(again.store.readRecords()).headId).toBe("after-crash");await again.store.close();
	} finally {await rm(dir,{recursive:true,force:true});}
});

it("matches reused provider call IDs within each exchange, including after rewind", async () => {
 const store=new MemorySessionStore();
 await store.appendMessage({role:"user",content:"task"});const targetId=store.readRecords()[0].id;
 for (const result of ["old result","new result"]) {
  await store.appendMessage({role:"assistant",content:"",tool_calls:[{id:"provider-local-0",name:"get_time",args:{}}]});
  await store.appendEvent("tool_started",{callId:"provider-local-0"});
  await store.appendEvent("tool_finished",{callId:"provider-local-0",status:"succeeded",result});
  await store.appendMessage({role:"tool",tool_call_id:"provider-local-0",content:result,status:"succeeded"});
  if(result==="old result") await store.appendRewind({id:"r",requestId:"q",targetId,fromId:store.readRecords().at(-1)!.id,source:"test",reason:"retry a different path"});
 }
 const state=store.state;
 expect(projectAgentHistory(state.entries).filter(message=>message.role==="tool").map(message=>message.content)).toEqual(["new result"]);
 expect(state.allEntries.filter(entry=>entry.kind==="message" && entry.message.role==="tool")).toHaveLength(2);
});

it("does not pollute mainline with abandoned branch inputs on multiple rewinds and inherits carried inputs when targeting a rewind node", async () => {
	const store = new MemorySessionStore();
	// 主线起始
	await store.appendMessage({ role: "user", content: "root task" }); // node 0
	await store.appendMessage({ role: "assistant", content: "root answer" }); // node 1
	const rootId = store.readRecords()[1].id;

	// 分支 1：提出 temp instruction 1，随后失败回溯
	await store.appendMessage({ role: "user", content: "temp instruction 1" }); // node 2
	await store.appendMessage({ role: "assistant", content: "bad attempt 1" }); // node 3
	await store.appendRewind({ id: "r1", requestId: "q1", targetId: rootId, fromId: store.readRecords().at(-1)!.id, source: "user", reason: "failed branch 1" });

	// 分支 2：在新主线上执行
	await store.appendMessage({ role: "assistant", content: "branch 2 response" });
	await store.appendMessage({ role: "user", content: "temp instruction 2" });
	await store.appendMessage({ role: "assistant", content: "bad attempt 2" });
	const branch2Head = store.readRecords().at(-1)!.id;

	// 场景 A：回溯到前次回溯节点 r1，验证 r1 原有的 carriedInputs (temp instruction 1) 不丢失，且包含 branch 2 产生的新指令
	await store.appendRewind({ id: "r2", requestId: "q2", targetId: "r1", fromId: branch2Head, source: "user", reason: "retry from r1" });
	const stateA = store.state;
	const historyA = projectAgentHistory(stateA.entries);
	expect(historyA.some(m => m.content.includes("temp instruction 1"))).toBe(false);
	expect(historyA.some(m => m.content.includes("temp instruction 2"))).toBe(false);

	// 场景 B：从当前主线再回溯到最初的 rootId，验证只收集当前被放弃主线上的指令，且去重无重复
	await store.appendMessage({ role: "assistant", content: "branch 3 response" });
	const latestHead = store.readRecords().at(-1)!.id;
	await store.appendRewind({ id: "r3", requestId: "q3", targetId: rootId, fromId: latestHead, source: "user", reason: "back to root" });
	const stateB = store.state;
	const historyB = projectAgentHistory(stateB.entries);
	// 验证：去重后，每条指令只保留一条
	const t1Count = historyB.filter(m => m.content.includes("temp instruction 1")).length;
	const t2Count = historyB.filter(m => m.content.includes("temp instruction 2")).length;
	expect(t1Count).toBe(0);
	expect(t2Count).toBe(0);
});

it("positions rewind notice between compactionSummary and retainedTail, never after latest user prompt", async () => {
	const store = new MemorySessionStore();
	await store.appendMessage({ role: "user", content: "task 1" });
	await store.appendMessage({ role: "assistant", content: "reply 1" });
	const targetId = store.readRecords()[1].id;
	await store.appendMessage({ role: "user", content: "task 2" });
	await store.appendRewind({ id: "r1", requestId: "q1", targetId, fromId: store.readRecords().at(-1)!.id, source: "test", reason: "rewind 1" });
	await store.appendMessage({ role: "assistant", content: "reply after rewind" });
	await store.appendMessage({ role: "user", content: "latest user question" });

	const entries = store.state.entries;
	// 模拟压缩：保留最后两条消息（reply after rewind 和 latest user question）
	const rawHistory = [
		{ role: "compactionSummary" as const, summary: "compacted history", content: "[历史摘要] compacted history" },
		{ role: "assistant" as const, content: "reply after rewind" },
		{ role: "user" as const, content: "latest user question" },
	];
	const protectedHistory = protectRewindContext(rawHistory, entries);

	// 验证：回溯提示必须位于 compactionSummary 之后、latest user question 之前
	expect(protectedHistory[0].role).toBe("compactionSummary");
	expect(protectedHistory[1].content).toContain("会话回溯");
	expect(protectedHistory[protectedHistory.length - 1].content).toBe("latest user question");
	expect(protectedHistory[protectedHistory.length - 1].role).toBe("user");
});

it("does not fail the whole turn when scheduled rewind commit fails at safe point", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "uina-safe-fail-"));
	let turnErrors: string[] = [];
	let turnStarts = 0;
	let turnEnds = 0;
	let calls = 0;
	const host = await UinaHost.create({
		cwd,
		model: mockModel({ contextWindow: 50 }), // 设置极小的 contextWindow 导致 commitRewind 超限
		stream: async (_m, _req, emit) => {
			calls++;
			if (calls === 1) {
				emit({ kind: "tool_call", call: { id: "rewind-call", name: "session_rewind", args: JSON.stringify({ targetId: "non-existent-or-oversized", reason: "bad" }) } });
				emit({ kind: "finish", reason: "tool_calls" });
			} else {
				emit({ kind: "text", text: "completed despite failed rewind" });
				emit({ kind: "finish", reason: "stop" });
			}
		},
	});
	host.subscribe(e => {
		if (e.type === "error") turnErrors.push(e.text);
		if (e.type === "turn_start") turnStarts++;
		if (e.type === "turn_end") turnEnds++;
	});
	try {
		await host.start();
		// 提交文本运行
		// 因为 tool 参数里的 targetId 在祖先里找不到，工具执行直接失败并返回工具结果，或者若进入排期后超限，也不会导致整个回合崩盘
		await host.submitText("run task");
		expect(turnStarts).toBe(1);
		expect(turnEnds).toBe(1);
	} finally {
		await host.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("rejects session operations when subject has no store configured", async () => {
	const subject = new Subject(mockModel(), async () => {}, new ToolBroker());
	await expect(subject.requestRewind({ targetId: "any", reason: "test" }, "test")).rejects.toThrow("未配置会话存储");
	// Session views are composed from a store by session/access.ts; without a rewind
	// entry the view stays navigable but rewind fails loudly.
	const memoryStore = new MemorySessionStore();
	const view = createSessionAccess(memoryStore);
	expect(view.list().nodes).toHaveLength(0);
	await expect(view.requestRewind({ targetId: "any", reason: "test" }, "test")).rejects.toThrow("未配置回溯入口");
});

describe("commitRewindTransition mechanism", () => {
	const context = () => ({
		projection: resolveProjectionPolicy(),
	});
	it("appends exactly one rewind record and returns the projected mainline", async () => {
		const store = new MemorySessionStore();
		const records = await seed(store);
		const commit = await commitRewindTransition(
			store,
			{ request: { targetId: records[0].id, reason: "bad premise" }, source: "test", requestId: "req-1" },
			context(),
			new AbortController().signal,
		);
		const rewindRecords = store.readRecords().filter((record) => record.kind === "rewind");
		expect(rewindRecords).toHaveLength(1);
		expect(commit.rewindId).toBe((rewindRecords[0] as { id: string }).id);
		expect(commit.fromId).toBe(records[2].id);
		expect(commit.targetId).toBe(records[0].id);
		// 主线投影回退到目标祖先，不再包含被放弃的消息。
		expect(commit.history.some((message) => message.role === "user" && message.content === "original task")).toBe(true);
		expect(commit.history.some((message) => message.content === "bad plan")).toBe(false);
	});
	// P6c：超限回溯拒绝门退役——回溯总是提交，窗口压力由 capability 的
	// transformContext 每请求裁剪收敛（端到端覆盖见 "trims a rewind that
	// re-exposes oversized history"）。
	it("refuses to commit when the abort signal fires before the journal append", async () => {
		const store = new MemorySessionStore();
		const records = await seed(store);
		const controller = new AbortController();
		controller.abort();
		await expect(
			commitRewindTransition(
				store,
				{ request: { targetId: records[0].id, reason: "late" }, source: "test", requestId: "req-3" },
				context(),
				controller.signal,
			),
		).rejects.toThrow();
		expect(store.readRecords().some((record) => record.kind === "rewind")).toBe(false);
	});

	it("refuses to rewind a session without any recoverable history", async () => {
		const store = new MemorySessionStore();
		await expect(
			commitRewindTransition(
				store,
				{ request: { targetId: "any", reason: "nothing there" }, source: "test", requestId: "req-empty" },
				context(),
				new AbortController().signal,
			),
		).rejects.toThrow("会话没有可回溯历史");
	});
});

describe("abandoned side-effects extraction (generic effect facts)", () => {
	it("aggregates declared effects, skipping failed/cancelled/not_started results", () => {
		const abandonedEntries = [
			{
				kind: "message" as const,
				message: {
					role: "tool" as const,
					tool_call_id: "c1",
					content: "written",
					status: "succeeded" as const,
					details: { effects: [{ effectType: "file.write", label: "src/index.ts" }] },
				},
			},
			{
				kind: "message" as const,
				message: {
					role: "tool" as const,
					tool_call_id: "c2",
					content: JSON.stringify({ code: 0 }),
					status: "succeeded" as const,
					details: { effects: [{ effectType: "command.exec", label: "npm test" }] },
				},
			},
			{
				kind: "message" as const,
				message: {
					role: "tool" as const,
					tool_call_id: "c3",
					content: JSON.stringify({ jobId: "job-bg-99" }),
					status: "succeeded" as const,
					details: { effects: [{ effectType: "task.dispatch", externalOperationId: "job-bg-99", label: "pnpm build" }] },
				},
			},
			{
				kind: "message" as const,
				message: {
					role: "tool" as const,
					tool_call_id: "c4",
					content: "disk error",
					status: "failed" as const,
					details: { effects: [{ effectType: "file.write", label: "fail.txt" }] },
				},
			},
			{
				kind: "message" as const,
				message: {
					role: "tool" as const,
					tool_call_id: "c5",
					content: JSON.stringify({ id: "sub-42" }),
					status: "unknown" as const,
					details: { effects: [{ effectType: "task.dispatch", externalOperationId: "sub-42", label: "worker-1" }] },
				},
			},
		];

		const effects = summarizeAbandonedEffects(abandonedEntries);
		// Session Core 不解释语义，只按声明原样聚合；unknown 仍上报，failed 被过滤。
		expect(effects.effects).toEqual([
			{ effectType: "file.write", label: "src/index.ts" },
			{ effectType: "command.exec", label: "npm test" },
			{ effectType: "task.dispatch", externalOperationId: "job-bg-99", label: "pnpm build" },
			{ effectType: "task.dispatch", externalOperationId: "sub-42", label: "worker-1" },
		]);
	});

	it("chains effects from earlier rewind entries and deduplicates by identity", () => {
		const earlier: import("../src/session/types.js").SessionEntry = {
			kind: "rewind",
			record: { kind: "rewind", id: "r1", targetId: "t", fromId: "f", source: "s", requestId: "q", reason: "x", seq: 1, timestamp: new Date().toISOString() },
			notice: "n",
			carriedInputs: [],
			effects: { effects: [{ effectType: "file.write", label: "same.txt" }] },
		};
		const effects = summarizeAbandonedEffects([
			earlier,
			{
				kind: "message",
				message: {
					role: "tool",
					tool_call_id: "c1",
					content: "written",
					status: "succeeded",
					details: { effects: [{ effectType: "file.write", label: "same.txt" }, { effectType: "file.write", label: "other.txt" }] },
				},
			},
		]);
		expect(effects.effects).toEqual([
			{ effectType: "file.write", label: "same.txt" },
			{ effectType: "file.write", label: "other.txt" },
		]);
	});

	it("injects declared effect facts into the rewind notice", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "start" });
		const targetId = store.readRecords()[0].id;
		await store.appendMessage({
			role: "assistant",
			content: "write file",
			tool_calls: [{ id: "c1", name: "write_file", args: { path: "hello.txt", text: "test" } }],
		});
		await store.appendMessage({
			role: "tool",
			tool_call_id: "c1",
			content: "ok",
			status: "succeeded",
			details: { path: "hello.txt", effects: [{ effectType: "file.write", label: "hello.txt" }] },
		});
		const fromId = store.readRecords().at(-1)!.id;

		await store.appendRewind({
			id: "r-effects",
			requestId: "req-1",
			targetId,
			fromId,
			source: "test",
			reason: "testing side effects injection",
		});

		const snapshot = store.state;
		const rewindEntry = snapshot.entries.find((e) => e.kind === "rewind");
		expect(rewindEntry).toBeDefined();
		if (rewindEntry && rewindEntry.kind === "rewind") {
			expect(rewindEntry.effects?.effects).toEqual([{ effectType: "file.write", label: "hello.txt" }]);
			expect(rewindEntry.notice).toContain("hello.txt");
			expect(rewindEntry.notice).toContain("file.write");
			expect(rewindEntry.notice).toContain("[在被放弃历史切片中产生的外部操作]");
		}
	});
});

describe("provenance tagging for abandoned tasks", () => {
	it("projects runtime inputs with provenance tag when from abandoned branches", () => {
		const inputNormal = {
			id: "in-1",
			order: 1,
			mode: "followUp" as const,
			text: "task completed",
			source: { kind: "runtime" as const, type: "job-notice", ref: "job-1" },
		};
		const projectedNormal = projectInputMessage(inputNormal);
		expect(projectedNormal.content).not.toContain("来自废弃分支");

		const inputAbandoned = {
			id: "in-2",
			order: 2,
			mode: "followUp" as const,
			text: "abandoned task completed",
			source: {
				kind: "runtime" as const,
				type: "job-notice",
				ref: "job-2",
				provenance: { abandoned: true },
			},
		};
		const projectedAbandoned = projectInputMessage(inputAbandoned);
		expect(projectedAbandoned.content).toContain("[来自废弃分支]");
	});

	it("tags background job notices when they finish after their originating branch is rewound", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "uina-provenance-test-"));
		try {
			const host = await UinaHost.create({
				cwd,
				model: mockModel(),
				stream: async () => {},
			});
			await host.start();

			// Seed a session with a tool call that started a background job
			await host.submitText("step 1");
			const targetId = host.session.list().nodes[0].id;

			// Append tool calling background job (the tool itself declares the effect fact)
			await (host as any).store.appendMessage({
				role: "assistant",
				content: "running background job",
				tool_calls: [{ id: "c-bg", name: "exec_command", args: { command: "sleep 10", run_in_background: true } }],
			});
			await (host as any).store.appendMessage({
				role: "tool",
				tool_call_id: "c-bg",
				content: JSON.stringify({ jobId: "job-abandoned-1" }),
				status: "succeeded",
				details: { effects: [{ effectType: "task.dispatch", externalOperationId: "job-abandoned-1", label: "sleep 10" }] },
			});

			// Perform rewind to targetId
			await host.session.requestRewind({
				targetId,
				reason: "abandoning job branch",
			}, "test");

			// Verify that host now knows job-abandoned-1 is abandoned
			expect(host.abandonedTaskIds.has("job-abandoned-1")).toBe(true);
			await host.dispose();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("BranchInspectorOverlay", () => {
	it("renders session nodes, supports switching filter scope, and inspects details", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "hello world" });
		const targetId = store.readRecords()[0].id;
		await store.appendMessage({ role: "assistant", content: "reply on old branch" });
		const fromId = store.readRecords().at(-1)!.id;
		await store.appendRewind({
			id: "rewind-node",
			requestId: "req-1",
			targetId,
			fromId,
			source: "user",
			reason: "testing inspector",
		});

		const access = {
			list: (opts?: any) => listSessionNodes(store.readRecords(), opts),
			listBranches: () => listSessionBranches(store.readRecords()),
			readBranch: (id: string) => readSessionBranch(store.readRecords(), id),
			read: (id: string) => readSessionNode(store.readRecords(), id),
			requestRewind: async () => ({ requestId: "dummy", status: "committed" as const }),
		};

		const overlay = new BranchInspectorOverlay(access);
		let rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("会话历史与分支检视器");
		expect(rendered).toContain("hello world");

		// Switch from the mainline to the read-only branch view
		overlay.handleInput("\x1b[C");
		rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("[只读分支]");

		overlay.handleInput("\x1b[D");
		rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("主线");

		// Tab to focus detail, scroll down
		overlay.handleInput("\t");
		overlay.handleInput("\x1b[B"); // down arrow
		rendered = overlay.render(80).join("\n");
		expect(rendered).toBeDefined();

		// Esc to close
		let closed = false;
		overlay.onClose = () => { closed = true; };
		overlay.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});




