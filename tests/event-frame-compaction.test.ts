import { describe, expect, it } from 'vitest';
import { availableContextBudget, CONTEXT_RESERVE_TOKENS } from '../src/agent/context.js';
import { requestToolDefs } from '../src/agent/projection.js';
import { EVENT_FRAME_TOOL } from '../src/extensions/event-frames/protocol.js';
import { createEventFrameProfile } from '../src/extensions/event-frames/index.js';
import activateCompaction, { estimateStreamTokens, fingerprintMessages } from '../src/extensions/compaction/index.js';
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
   auxiliary:()=>store.state.auxiliary,onCustomEntry:e=>store.appendCustomEntry(e),emitRuntimeEvent:async()=>{},
   models:{current:()=>scenario.model,list:()=>[scenario.model],groups:()=>[],resolve:()=>scenario.model,select:async()=>{},stream:scenario.stream},
  });
  await runner.activateBuiltin('compaction',activateCompaction);
  const input=[{role:'system' as const,content:'system'},...frame('e1','OLD '.repeat(1600)),...frame('e2','current request')];
  const out=await runner.runTransformContext(input);
  expect(()=>p.validateContext!(out)).not.toThrow();
  expect(out.some(m=>m.content.startsWith('[历史摘要]'))).toBe(true);
  expect(out.some(m=>m.context?.input?.eventId==='e1')).toBe(false);
  expect(out.some(m=>m.context?.input?.eventId==='e2')).toBe(true);
  expect(scenario.calls.length).toBeGreaterThanOrEqual(1);
  expect(scenario.calls[0]!.messages.at(-1)!.content).toContain('外部事件');
  expect(scenario.calls[0]!.messages.at(-1)!.content).not.toContain('调用工具 external_event_frame');
  await runner.dispose();
 });
 it('leaves an exact-fit history alone until context-tool schema spends the budget', async () => {
  const text = 'x'.repeat(70_000);
  const messages = [{ role: 'user' as const, content: text }];
  const tokensBefore = estimateStreamTokens(messages);
  expect(tokensBefore).toBeGreaterThan(CONTEXT_RESERVE_TOKENS);
  const window = tokensBefore + CONTEXT_RESERVE_TOKENS;
  expect(availableContextBudget(window)).toBe(tokensBefore);
  const open = async (tools?: () => readonly (typeof EVENT_FRAME_TOOL)[]) => {
   const store = new MemorySessionStore();
   await store.appendMessage({ role: 'user', content: 'anchor' });
   const scenario = Scenario.create({ contextWindow: window }).reply('已压缩。');
   const runner = new ExtensionRunner({
    cwd: process.cwd(), tools: new ToolBroker(), history: () => store.state.entries,
    auxiliary: () => store.state.auxiliary, onCustomEntry: entry => store.appendCustomEntry(entry), emitRuntimeEvent: async () => {},
    models: { current: () => scenario.model, list: () => [scenario.model], groups: () => [], resolve: () => scenario.model, select: async () => {}, stream: scenario.stream },
   });
   await runner.activateBuiltin('compaction', pi => activateCompaction(pi, tools ? { tools } : {}));
   return { runner, scenario };
  };
  const plain = await open();
  try {
   const unchanged = await plain.runner.runTransformContext(messages);
   expect(unchanged).toEqual(messages);
   expect(plain.scenario.calls).toHaveLength(0);
  } finally { await plain.runner.dispose(); }
  const armed = await open(() => requestToolDefs([], [EVENT_FRAME_TOOL]));
  try {
   const trimmed = await armed.runner.runTransformContext(messages);
   expect(armed.scenario.calls.length).toBeGreaterThanOrEqual(1);
   expect(trimmed.some(message => message.content.includes('[历史摘要]'))).toBe(true);
  } finally { await armed.runner.dispose(); }
 });
});





