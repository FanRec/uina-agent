import { ToolBroker } from '../../../../src/tools/broker.ts';
import { createExecCommandTool } from '../../../../src/extensions/runtime-tools/exec-command/index.ts';
import { JobRegistry } from '../../../../src/extensions/jobs/registry.ts';
import { SubagentRegistry } from '../../../../src/extensions/subagents/registry.ts';
import { DefaultAgentFactory } from '../../../../src/agent/runtime.ts';
async function main() {
 const broker = new ToolBroker(); broker.register(createExecCommandTool());
 const result = await broker.execute(broker.prepare('exec_command', {command:'exit 7'}));
 console.log('SHELL_FAILURE', JSON.stringify({outer:result.status,inner:JSON.parse(result.result)}));
 const jobs = new JobRegistry(); let release!: (outcome:any)=>void; let producerDone=false;
 const id = jobs.start({ownerId:'root', label:'cancel throws', source:{extension:'review'}, start:()=>({cancel(){throw new Error('cancel transport unavailable')}, done:new Promise<any>(r=>{release=r})})});
 jobs.cancel(id,'root'); const secondCancel=jobs.cancel(id,'root'); await jobs.close();
 console.log('CANCEL_FAILURE',JSON.stringify({status:jobs.get(id,'root').status,secondCancel,producerDone,closeResolved:true}));
 producerDone=true; release({status:'completed'}); await new Promise(r=>setTimeout(r,0));
 console.log('LATER_CONFIRMED',JSON.stringify({status:jobs.get(id,'root').status,producerDone}));
 const notices:any[]=[];
 const registry=new SubagentRegistry({factory:new DefaultAgentFactory(), provider:{name:'review',thinkingLevels:['off'],async stream(req,emit,signal){await new Promise<void>(r=>signal?.addEventListener('abort',()=>r(),{once:true}));}},createTools:()=>new ToolBroker(),notify:async(text,data)=>{notices.push({text,data})}});
 const child=registry.start({ownerId:'root',label:'busy child',prompt:'first'}); await new Promise(r=>setTimeout(r,0));
 await registry.send(child.id,'root','second');
 console.log('BUSY_CHILD_AFTER_SEND',JSON.stringify(registry.get(child.id,'root')));
 await registry.close();
 const waitingNotices:any[]=[];
 const waiting=new SubagentRegistry({factory:new DefaultAgentFactory(),provider:{name:'review',thinkingLevels:['off'],async stream(req,emit){emit({kind:'text',text:'done'});emit({kind:'finish',reason:'stop'});}},createTools:()=>new ToolBroker(),notify:async(text,data)=>{waitingNotices.push({text,data})}});
 const completed=waiting.start({ownerId:'root',label:'normal response',prompt:'first'}); await new Promise(r=>setTimeout(r,10));
 console.log('NORMAL_CHILD_RESPONSE',JSON.stringify({snapshot:waiting.get(completed.id,'root'),notices:waitingNotices})); await waiting.close();
}
main().catch(error=>{console.error(error);process.exitCode=1});
