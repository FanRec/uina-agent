// Review probes, not acceptance tests. Run from the repository root with tsx.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Subject } from '../../../../src/agent/loop.js';
import { ToolBroker } from '../../../../src/tools/broker.js';
import { openJsonlSession, MemorySessionStore } from '../../../../src/session/jsonl-store.js';
import { recoverRecords, projectAgentHistory } from '../../../../src/session/recovery.js';
import { NO_RUNTIME_HOOKS } from '../../../../src/runtime/noop.js';
import type { ModelProvider } from '../../../../src/core/types.js';
const tmp = await mkdtemp(join(tmpdir(), 'uina-core-audit-'));
const report: unknown[] = [];
try {
  {
    const path = join(tmp, 'blocked.jsonl');
    const {store} = await openJsonlSession(path);
    let rounds = 0;
    const provider: ModelProvider = { name: 'audit-fake', async stream(req, delta) { if (++rounds === 1) { delta({kind: 'tool_call', call:{id:'blocked-call', name:'example', args:'{}'}}); delta({kind:'finish', reason:'tool_calls'}); } else { delta({kind:'text', text:'done'}); delta({kind:'finish', reason:'stop'}); } } };
    const tools = new ToolBroker();
    let runs = 0;
    tools.register({def:{type:'function',function:{name:'example',description:'audit',parameters:{type:'object',properties:{}}}}, async run(){runs++; return 'ok';}});
    const subject = new Subject(provider, tools, {onToken(){}}, {store, runtimeHooks:{...NO_RUNTIME_HOOKS, tools:{...NO_RUNTIME_HOOKS.tools, async beforeCall(){ return {block:true,reason:'audit block'}; }}}});
    await subject.pushInput('test');
    await store.close();
    let reopen: string;
    try { const result=await openJsonlSession(path); reopen='OK'; await result.store.close(); } catch(e) {reopen=(e as Error).message;}
    report.push({case:'blocked tool then reopen',runs,rounds,history:subject.historySnapshot().map(m=>({role:m.role,status:m.status})),reopen});
  }
  {
    const path = join(tmp, 'custom-compaction.jsonl');
    const {store} = await openJsonlSession(path);
    const provider: ModelProvider = {name:'audit-fake', async stream(req, delta) {delta({kind:'text',text:'summary'});delta({kind:'finish',reason:'stop'});}};
    const subject = new Subject(provider,new ToolBroker(),{onToken(){}},{store});
    const earlier={role:'user' as const,content:'earlier message'};
    await store.appendMessage(earlier); subject.addHistory([earlier]);
    await subject.appendCustomMessage({customType:'audit-note',content:'recent extension message'});
    await subject.compact();
    await store.close();
    let reopen: string;
    try {const result=await openJsonlSession(path);reopen='OK';await result.store.close();}catch(e){reopen=(e as Error).message;}
    report.push({case:'custom retained by manual compaction then reopen',history:subject.historySnapshot().map(m=>({role:m.role,content:m.content})),reopen});
  }
  {
    const store = new MemorySessionStore();
    let cut: any[]=[];
    const appendEvent=store.appendEvent.bind(store);
    store.appendEvent=async (type,data)=>{ await appendEvent(type,data);if(type==='queue_consumed' && cut.length===0)cut=structuredClone(store.records); };
    const provider: ModelProvider={name:'audit-fake',async stream(req,delta){delta({kind:'text',text:'done'});delta({kind:'finish',reason:'stop'});}};
    const subject=new Subject(provider,new ToolBroker(),{onToken(){}},{store});
    await subject.followUp('queued-important-input');
    await subject.pushInput('resume');
    const atCut=recoverRecords(cut);
    report.push({case:'crash after durable queue_consumed before message append',prefixEvents:cut.map(r=>r.kind==='event'?r.event:r.kind),recoveredQueued:atCut.queued.map(q=>q.text),recoveredHistory:projectAgentHistory(atCut.entries),fullRunHistory:subject.historySnapshot().map(m=>m.content)});
  }
  {
    let entered!: () => void;
    const started = new Promise<void>(resolve => entered=resolve);
    let release!: () => void;
    const pending = new Promise<void>(resolve => release=resolve);
    let providedSignal: AbortSignal|undefined;
    let finished=false;
    const provider: ModelProvider={name:'audit-fake',async stream(req,delta,signal){providedSignal=signal;entered();await pending;delta({kind:'text',text:'summary'});delta({kind:'finish',reason:'stop'});}};
    const subject=new Subject(provider,new ToolBroker(),{onToken(){}},{store:new MemorySessionStore()});
    subject.addHistory([{role:'user',content:'older'},{role:'assistant',content:'recent'}]);
    const compact=subject.compact().then(()=>{finished=true;});
    await started;
    const busyWhileModelPending=subject.isBusy();
    subject.interrupt();
    await subject.waitForIdle();
    report.push({case:'manual compaction lifecycle',busyWhileModelPending,finishedAfterWaitForIdle:finished,hasAbortSignal:Boolean(providedSignal)});
    release();await compact;
  }
  console.log(JSON.stringify(report,null,2));
} finally {
  if (!resolve(tmp).startsWith(resolve(tmpdir()) + sep + 'uina-core-audit-')) throw new Error('Unexpected cleanup target');
  await rm(tmp,{recursive:true,force:true});
}
