import { describe, expect, it } from 'vitest';
import { createEventFrameProfile } from '../src/extensions/event-frames/index.js';
import activateCompaction, { fingerprintMessages } from '../src/extensions/compaction/index.js';
import { ExtensionRunner } from '../src/extensions/runner.js';
import { ToolBroker } from '../src/tools/broker.js';
import { MemorySessionStore } from '../src/session/jsonl-store.js';
import { Scenario } from './harness/provider/scenario.js';

const p = createEventFrameProfile().projection;
const frame = (id: string, text: string) => p.convertToLlm!([{ role:'user', id, content:text,
 input:{ eventId:id, source:{kind:'user',type:'terminal',origin:'external'} } }]);
describe('event frame compaction',()=>{
 it('fingerprints provenance as well as text',()=>{
  const a=frame('e1','hello'), b=structuredClone(a);
  b[0]!.context!.input!.source!.actor={relation:'unknown'};
  expect(fingerprintMessages(a)).not.toBe(fingerprintMessages(b));
 });
 it('keeps the newest frame and summarizes complete old frames as external evidence',async()=>{
  const store=new MemorySessionStore(); await store.appendMessage({role:'user',content:'anchor'});
  const scenario=Scenario.create({contextWindow:2400}).reply('旧发言来自外界，尚未核验。');
  const runner=new ExtensionRunner({cwd:process.cwd(),tools:new ToolBroker(),history:()=>store.state.entries,
   auxiliary:()=>store.state.auxiliary,onCustomEntry:e=>store.appendCustomEntry(e),
   models:{current:()=>scenario.model,list:()=>[scenario.model],groups:()=>[],resolve:()=>scenario.model,select:async()=>{},stream:scenario.stream},
  });
  await runner.activateBuiltin('compaction',activateCompaction);
  const input=[{role:'system' as const,content:'system'},...frame('e1','OLD '.repeat(1600)),...frame('e2','current request')];
  const out=await runner.runTransformContext(input);
  expect(()=>p.validateContext!(out)).not.toThrow();
  expect(out.some(m=>m.context?.input?.eventId==='e2')).toBe(true);
  expect(scenario.calls.length).toBeGreaterThanOrEqual(1);
  expect(scenario.calls[0]!.messages.at(-1)!.content).toContain('外部事件');
  expect(scenario.calls[0]!.messages.at(-1)!.content).not.toContain('调用工具 external_event_frame');
  await runner.dispose();
 });
});





