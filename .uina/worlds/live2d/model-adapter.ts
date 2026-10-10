import type { ControlTable, AxisValues } from "./motion-axes.js";
import { sampleMotion, type CompiledMotion } from "./motion.js";
import type { ModelProfile, ModelMapping } from "./model-profile.js";
import type { VTSParamValue } from "./vts-client.js";

export interface RigTarget {
  parameter: string;
  input: string;
  points: readonly (readonly [number, number])[];
  /** Exact direct fanout other than the reference output. */
  followers: readonly string[];
  /** Transitive, nonzero physics outputs accepted by the author. */
  physicsFollowers: readonly string[];
  smoothing: number;
}
export interface ModelRig {
  version: 2;
  modelID: string;
  controls: ControlTable;
  bindings: Readonly<Record<string, readonly RigTarget[]>>;
  external: { blink: "vts" | "uina" | "none"; breath: "vts" | "none" };
}
interface Binding { axis: string; target: RigTarget; mapping: ModelMapping; }
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
export function physicsFollowers(profile: ModelProfile, outputs: readonly string[]): string[] {
  const seen = new Set(outputs), result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of profile.physicsGroups ?? []) {
      if (!g.inputs.some(i => i.weight !== 0 && seen.has(i.id))) continue;
      for (const o of g.outputs) if (o.weight !== 0 && !seen.has(o.id)) { result.add(o.id); seen.add(o.id); changed = true; }
    }
  }
  return [...result].sort();
}
function linear(points: readonly (readonly [number,number])[], value: number): number {
  for (let i=1;i<points.length;i++) { const a=points[i-1]!, b=points[i]!; if(value <= b[0]) return a[1]+(b[1]-a[1])*(value-a[0])/(b[0]-a[0]); }
  return points.at(-1)![1];
}
export class AdapterProgram {
  readonly neutral: AxisValues;
  readonly resources: Readonly<Record<string, readonly string[]>>;
  constructor(readonly rig: ModelRig, private readonly bindings: readonly Binding[]) {
    this.neutral=Object.freeze(Object.fromEntries(Object.entries(rig.controls).map(([id,m])=>[id,m.neutral])));
    this.resources=Object.freeze(Object.fromEntries(Object.keys(rig.controls).map(id=>[id,Object.freeze([...new Set(bindings.filter(b=>b.axis===id).flatMap(b=>[
      `input:${b.target.input}`, ...[b.target.parameter,...b.target.followers].map(p=>`output:${p}`), ...b.target.physicsFollowers.map(p=>`effect:${p}`),
    ]))])])));
  }
  resourcesFor(axes: readonly string[]): string[] { return [...new Set(axes.flatMap(a=>this.resources[a] ?? []))]; }
  inputsFor(axes: readonly string[]): string[] { return [...new Set(this.bindings.filter(b=>axes.includes(b.axis)).map(b=>b.target.input))]; }
  validateFrame(frame: AxisValues): void {
    for (const [id,value] of Object.entries(frame)) { const m=this.rig.controls[id]; if(!m || !Number.isFinite(value) || value<m.min-1e-8 || value>m.max+1e-8) throw new Error(`控制超出手工范围: ${id}=${value}`); }
  }
  validateMotion(motion: CompiledMotion, baseline: AxisValues): void {
    for(const id of motion.axes) if(!this.rig.controls[id]) throw new Error(`模型未提供控制: ${id}`);
    // Curves are bounded between keys. Include every segment boundary and conservative offset sums.
    for(const id of motion.axes) {
      const tracks=motion.tracks.filter(t=>t.axis===id), m=this.rig.controls[id]!;
      const boundaries=[...new Set([0,motion.durationMs,...tracks.flatMap(t=>[t.startMs,t.endMs,t.holdUntilMs])])].sort((a,b)=>a-b);
      for(const [i,start] of boundaries.entries()) {
        const end=boundaries[i+1] ?? start, mid=(start+end)/2;
        const active=tracks.filter(t=>t.startMs<=mid && mid<t.holdUntilMs);
        const latest=Math.max(...tracks.filter(t=>t.startMs<=mid).map(t=>t.holdUntilMs));
        const selected=active.length?active:tracks.filter(t=>t.startMs<=mid && t.holdUntilMs===latest);
        const absolute=selected.find(t=>t.space==="absolute");
        let lo=absolute?Math.min(...absolute.keys.map(k=>k.value)):baseline[id] ?? m.neutral;
        let hi=absolute?Math.max(...absolute.keys.map(k=>k.value)):lo;
        for(const t of selected.filter(t=>t.space==="baseline-offset")) { lo+=Math.min(...t.keys.map(k=>k.value)); hi+=Math.max(...t.keys.map(k=>k.value)); }
        if(lo<m.min || hi>m.max) throw new Error(`当前姿态不适用: ${id} 可达 [${lo}, ${hi}]`);
      }
    }
    for(const time of [0,motion.durationMs,...motion.tracks.flatMap(t=>t.keys.map(k=>t.startMs+k.atMs))]) this.validateFrame(sampleMotion(motion,time,baseline));
  }
  blockedAxes(profile: ModelProfile): string[] {
    const active=new Set((profile.sources ?? []).filter(s=>s.kind==="expression" && (profile.activeExpressions===undefined || profile.activeExpressions.includes(s.file))).flatMap(s=>s.parameters));
    return Object.keys(this.rig.controls).filter(a=>this.resources[a]!.some(r=>(r.startsWith("output:") || r.startsWith("effect:")) && active.has(r.slice(7))));
  }
  encode(frame: AxisValues, blocked: readonly string[]=[]): readonly VTSParamValue[] {
    this.validateFrame(frame);
    return this.bindings.filter(b=>!blocked.includes(b.axis)).map(b=>{
      const value=frame[b.axis] ?? this.neutral[b.axis]!;
      const output=linear(b.target.points,value), m=b.mapping;
      return {id:m.input,value:m.inputMin+(output-m.outputMin)*(m.inputMax-m.inputMin)/(m.outputMax-m.outputMin),weight:1};
    });
  }
}
export function compileModelAdapter(profile: ModelProfile, rig: ModelRig): AdapterProgram {
  if(rig.version!==2 || rig.modelID!==profile.modelID) throw new Error("手工 rig 版本或模型身份不匹配");
  const inputs=new Set<string>(), outputs=new Set<string>(), bindings: Binding[]=[];
  for(const [axis,meta] of Object.entries(rig.controls)) {
    if(![meta.min,meta.max,meta.neutral].every(Number.isFinite) || meta.min>=meta.max || meta.neutral<meta.min || meta.neutral>meta.max) throw new Error(`非法控制范围: ${axis}`);
    const targets=rig.bindings[axis]; if(!targets?.length) throw new Error(`缺少手工绑定: ${axis}`);
    for(const target of targets) {
      if(inputs.has(target.input)) throw new Error(`多个主动控制共用输入: ${target.input}`); inputs.add(target.input);
      const maps=profile.mappings.filter(m=>m.output===target.parameter);
      if(maps.length!==1 || maps[0]!.input!==target.input) throw new Error(`绑定未核验或重复输出: ${target.parameter}`);
      const mapping=maps[0]!, range=profile.parameterRanges?.[target.parameter], input=profile.inputs?.find(i=>i.name===target.input);
      if(!range || !input || mapping.useBlinking || mapping.useBreathing || profile.physicsOutputs.includes(target.parameter)) throw new Error(`目标范围/输入/来源未核验: ${target.parameter}`);
      if(![mapping.inputMin,mapping.inputMax,mapping.outputMin,mapping.outputMax].every(Number.isFinite) || mapping.inputMin===mapping.inputMax || mapping.outputMin===mapping.outputMax || mapping.smoothing!==target.smoothing) throw new Error(`绑定范围或平滑不匹配: ${target.parameter}`);
      const fanout=profile.mappings.filter(m=>m.input===target.input && !m.useBlinking && !m.useBreathing && m.output!==target.parameter).map(m=>m.output);
      if(!same(fanout,target.followers) || !same(physicsFollowers(profile,[target.parameter,...fanout]),target.physicsFollowers)) throw new Error(`跟随关系变化: ${axis}`);
      for(const p of [target.parameter,...fanout]) { if(outputs.has(p)) throw new Error(`多个主动控制写输出: ${p}`); outputs.add(p); }
      const points=target.points, sign=Math.sign((points?.at(-1)?.[1] ?? 0)-(points?.[0]?.[1] ?? 0));
      if(!points || points.length<2 || !sign || points[0]![0]!==meta.min || points.at(-1)![0]!==meta.max || !points.some(p=>p[0]===meta.neutral)) throw new Error(`缺少完整手工曲线: ${axis}`);
      for(const [i,p] of points.entries()) {
        const v=mapping.inputMin+(p[1]-mapping.outputMin)*(mapping.inputMax-mapping.inputMin)/(mapping.outputMax-mapping.outputMin);
        if(p.length!==2 || !p.every(Number.isFinite) || p[0]<meta.min || p[0]>meta.max || p[1]<range.min || p[1]>range.max || p[1]<Math.min(mapping.outputMin,mapping.outputMax) || p[1]>Math.max(mapping.outputMin,mapping.outputMax) || v<input.min || v>input.max || (i>0 && (p[0]<=points[i-1]![0] || sign*(p[1]-points[i-1]![1])<=0))) throw new Error(`非法手工曲线: ${axis}`);
      }
      bindings.push({axis,target,mapping:Object.freeze({...mapping})});
    }
  }
  for(const id of Object.keys(rig.bindings)) if(!rig.controls[id]) throw new Error(`未声明控制: ${id}`);
  // An explicitly driven output cannot simultaneously be another control's physics follower.
  for(const b of bindings) for(const follower of b.target.physicsFollowers) if(outputs.has(follower)) throw new Error(`物理跟随与主动控制冲突: ${follower}`);
  return new AdapterProgram(rig,Object.freeze(bindings));
}
