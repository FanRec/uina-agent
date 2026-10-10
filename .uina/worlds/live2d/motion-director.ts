import type { AxisValues } from "./motion-axes.js";
import { sampleMotion, sampleSpeechGain, smooth } from "./motion.js";
import type { AdapterProgram } from "./model-adapter.js";
import type { CompiledClip } from "./model-package.js";
import type { SpeechPolicy } from "./types.js";

export interface PlaybackOutcome { status: "completed" | "cancelled"; interruptedAxes: readonly string[]; }
export class ResourceLease {
  readonly controller=new AbortController();
  readonly signal=this.controller.signal;
  released=false;
  constructor(readonly id:string,readonly resources:Set<string>,readonly priority:number,readonly reason:string,readonly cleanup:boolean,private readonly remove:()=>void) {}
  cancel():void { this.controller.abort(); }
  release():void { if(this.released)return; this.released=true;this.remove(); }
}
const overlaps=(a:Set<string>|readonly string[],b:Set<string>)=>[...a].some(r=>b.has(r) && !r.startsWith("effect:") || r.startsWith("output:") && b.has(`effect:${r.slice(7)}`) || r.startsWith("effect:") && b.has(`output:${r.slice(7)}`));
interface Playback {
  clip:CompiledClip; lease:ResourceLease; axes:Set<string>; baseline:AxisValues; from:AxisValues; ageMs:number;
  speech?:SpeechPolicy; resolve:(outcome:PlaybackOutcome)=>void; unbind:()=>void; interrupted:Set<string>;
}
interface Fade { from:number; ageMs:number; durationMs:number; }
export interface FrameContribution { leaseID:string; axes:readonly string[]; ageMs:number; stages:readonly string[]; }
/** Samples authored motion directly. Resource ownership, not anatomical channels, governs conflicts. */
export class MotionDirector {
  private readonly leases=new Set<ResourceLease>();
  private readonly playbacks=new Set<Playback>();
  private readonly fades=new Map<string,Fade>();
  private counter=0;
  private poseValues:AxisValues;
  private poseTransition?:{from:AxisValues;to:AxisValues;ageMs:number;durationMs:number};
  private readonly holds=new Map<ResourceLease,AxisValues>();
  private completed:Playback[]=[];
  private contributions:FrameContribution[]=[];
  frame:AxisValues;
  constructor(readonly adapter:AdapterProgram) { this.poseValues={...adapter.neutral};this.frame={...this.poseValues}; }
  getBaseline():AxisValues { return {...this.base()}; }
  getActiveLeases():readonly ResourceLease[] {return [...this.leases];}
  private base():AxisValues {
    const t=this.poseTransition; if(!t)return {...this.poseValues};
    const w=t.durationMs? smooth(t.ageMs/t.durationMs):1;
    return Object.fromEntries(Object.keys(this.poseValues).map(id=>[id,t.from[id]!+(t.to[id]!-t.from[id]!)*w]));
  }
  setPose(values:AxisValues,transitionMs:number):void {
    const target={...this.adapter.neutral,...values};this.adapter.validateFrame(target);
    this.poseTransition={from:this.base(),to:target,ageMs:0,durationMs:transitionMs};this.poseValues=target;
  }
  claim(resources:readonly string[],options:{priority:number;reason:string;signal?:AbortSignal;cleanup?:boolean;atomic?:boolean}):ResourceLease {
    if(options.signal?.aborted)throw new Error("动作已取消");
    const requested=new Set(resources);
    const conflicts=[...this.leases].filter(l=>overlaps(requested,l.resources));
    for(const l of conflicts) {
      if(l.cleanup){l.cancel();throw new Error("资源正在执行外部清理");}
      if(l.priority>options.priority || (l.priority===options.priority && l.reason!==options.reason)) throw new Error("资源冲突");
    }
    for(const l of conflicts) {
      const p=[...this.playbacks].find(p=>p.lease===l);
      if(!p || p.clip.atomic!==false) {l.cancel();l.release();continue;}
      const interrupted=[...p.axes].filter(a=>overlaps(this.adapter.resources[a]!,requested));
      for(const a of interrupted) {p.axes.delete(a);p.interrupted.add(a);this.fades.set(a,{from:this.frame[a]!,ageMs:0,durationMs:p.clip.exitMs});}
      l.resources.clear();for(const r of this.adapter.resourcesFor([...p.axes]))l.resources.add(r);
      if(!p.axes.size){l.cancel();l.release();}
    }
    const lease=new ResourceLease(`play-${++this.counter}`,requested,options.priority,options.reason,!!options.cleanup,()=>{this.leases.delete(lease);this.holds.delete(lease);});
    this.leases.add(lease);
    if(options.cleanup)this.holds.set(lease,{...this.frame});
    return lease;
  }
  play(clip:CompiledClip,options:{priority:number;reason:string;signal?:AbortSignal;speech?:SpeechPolicy;onStart?:(lease:ResourceLease)=>void}):Promise<PlaybackOutcome> {
    const baseline=this.base();this.adapter.validateMotion(clip.motion,baseline);
    const lease=this.claim(this.adapter.resourcesFor(clip.motion.axes),options);
    const from={...this.frame};for(const axis of clip.motion.axes)this.fades.delete(axis);
    try {options.onStart?.(lease);}catch(error){lease.release();throw error;}
    return new Promise(resolve=>{
      const abort=()=>this.finish(p,"cancelled");
      const externalAbort=()=>lease.cancel();
      const p:Playback={clip,lease,axes:new Set(clip.motion.axes),baseline,from,ageMs:0,speech:options.speech,resolve,interrupted:new Set(),unbind:()=>{lease.signal.removeEventListener("abort",abort);options.signal?.removeEventListener("abort",externalAbort);}};
      this.playbacks.add(p);lease.signal.addEventListener("abort",abort,{once:true});options.signal?.addEventListener("abort",externalAbort,{once:true});
      if(options.signal?.aborted)lease.cancel();
    });
  }
  private finish(p:Playback,status:PlaybackOutcome["status"]):void {
    if(!this.playbacks.delete(p))return;
    p.unbind();
    if(status==="cancelled")for(const a of p.axes)this.fades.set(a,{from:this.frame[a]!,ageMs:0,durationMs:p.clip.exitMs});
    p.lease.release();p.resolve({status,interruptedAxes:[...p.interrupted]});
  }
  compose(deltaMs:number,mouthOpen=0):AxisValues {
    if(!Number.isFinite(deltaMs)||deltaMs<0)throw new Error("非法渲染时间");
    if(this.poseTransition){this.poseTransition.ageMs+=deltaMs;if(this.poseTransition.ageMs>=this.poseTransition.durationMs)this.poseTransition=undefined;}
    const frame=this.base();let speechGain=1;this.contributions=[];this.completed=[];
    for(const [axis,fade] of this.fades) {fade.ageMs+=deltaMs;const w=fade.durationMs?smooth(fade.ageMs/fade.durationMs):1;frame[axis]=fade.from+(frame[axis]!-fade.from)*w;if(w===1)this.fades.delete(axis);}
    for(const p of this.playbacks) {
      p.ageMs+=deltaMs;
      const values=sampleMotion(p.clip.motion,p.ageMs,p.baseline);
      const entry=p.clip.entryMs?smooth(p.ageMs/p.clip.entryMs):1;
      const exit=p.ageMs<=p.clip.motion.durationMs?0:(p.clip.exitMs?smooth((p.ageMs-p.clip.motion.durationMs)/p.clip.exitMs):1);
      for(const a of p.axes) { const value=p.from[a]!+(values[a]!-p.from[a]!)*entry;frame[a]=value+(frame[a]!-value)*exit; }
      if(p.axes.has("mouth.open")){const gain=(p.speech ?? p.clip.speech)==="exclusive"?0:sampleSpeechGain(p.clip.motion,p.ageMs);speechGain=1+(gain-1)*entry*(1-exit);}
      const weight=entry*(1-exit);
      if(weight>0)this.contributions.push({leaseID:p.lease.id,axes:[...p.axes],ageMs:p.ageMs,stages:(p.clip.stages ?? []).filter(s=>p.ageMs>=s.startMs&&p.ageMs<=s.endMs).map(s=>s.id)});
      if(p.ageMs>=p.clip.motion.durationMs+p.clip.exitMs)this.completed.push(p);
    }
    if(Object.hasOwn(frame,"mouth.open"))frame["mouth.open"]!+=(1-frame["mouth.open"]!)*mouthOpen*speechGain;
    for(const [lease,held] of this.holds)for(const [axis,value] of Object.entries(held))if(this.adapter.resources[axis]!.some(r=>lease.resources.has(r)))frame[axis]=value;
    this.adapter.validateFrame(frame);this.frame=frame;return {...frame};
  }
  getFrameContributions():readonly FrameContribution[] {return this.contributions;}
  /** Called after sending the final sampled frame; completion never precedes its contribution accounting. */
  commitFrame():void {for(const p of this.completed)this.finish(p,"completed");this.completed=[];}
  cancelAxes(axes:readonly string[]):void {
    for(const p of [...this.playbacks])if([...p.axes].some(a=>axes.includes(a)))p.lease.cancel();
  }
  stop():void {for(const l of [...this.leases])l.cancel();for(const l of [...this.leases])if(!l.cleanup)l.release();this.fades.clear();this.contributions=[];this.completed=[];this.poseTransition=undefined;}
  hasReason(reason:string):boolean {return [...this.leases].some(l=>l.reason===reason);}
}
