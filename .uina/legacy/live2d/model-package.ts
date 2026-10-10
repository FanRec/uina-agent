import { createHash } from "node:crypto";
import type { AxisValues } from "./motion-axes.js";
import { compileMotion, parallel, sequence, type CompiledMotion, type MotionDefinition } from "./motion.js";
import { compileModelAdapter, type AdapterProgram, type ModelRig } from "./model-adapter.js";
import type { ModelProfile } from "./model-profile.js";
import type { SpeechPolicy } from "./types.js";

export interface AuthoredClip {
  description: string;
  definition: MotionDefinition;
  atomic?: boolean;
  speech?: SpeechPolicy;
  entryMs: number;
  exitMs: number;
  stages?: readonly { id: string; startMs: number; endMs: number }[];
}
export interface VisualAcceptance {
  /** Digest of rig and all content, not a boolean carried across content edits. */
  contentDigest: string;
  controlFingerprint: string;
  evidence: string;
}
export interface ModelPackage {
  name: string;
  rig: ModelRig;
  actions: Readonly<Record<string, AuthoredClip>>;
  fragments: Readonly<Record<"head" | "gaze" | "face", Readonly<Record<string, AuthoredClip>>>>;
  poses: Readonly<Record<string, { description: string; values: AxisValues; transitionMs: number }>>;
  background?: { blink?: { clip: AuthoredClip; intervalMs: number }; thinking?: AuthoredClip; idle?: AuthoredClip };
  speech?: { points: readonly (readonly [number,number])[]; attackMs: number; releaseMs: number; staleMs: number };
  costumes: readonly { id: string; description: string; hotkeyID: string; resources: readonly string[] }[];
  acceptance?: VisualAcceptance;
}
export interface ExpressParams { motion?: string; head?: string; gaze?: string; face?: string; beats?: readonly { head?: string; gaze?: string; face?: string }[]; atomic?: boolean; speech?: SpeechPolicy; }
export interface CompiledClip extends Omit<AuthoredClip,"definition"> { motion: CompiledMotion; }
export function contentDigest(pkg: ModelPackage): string {
  const {acceptance:_,...content}=pkg;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
export class PackageProgram {
  readonly adapter: AdapterProgram;
  readonly actions: Readonly<Record<string,CompiledClip>>;
  readonly fragments: Readonly<Record<string,Readonly<Record<string,CompiledClip>>>>;
  readonly background: { blink?: CompiledClip; thinking?: CompiledClip; idle?: CompiledClip };
  readonly digest: string;
  readonly published: boolean;
  constructor(readonly pkg: ModelPackage, profile: ModelProfile) {
    this.adapter=compileModelAdapter(profile,pkg.rig);
    const compile=(clip:AuthoredClip):CompiledClip=>{
      if(![clip.entryMs,clip.exitMs].every(x=>Number.isFinite(x)&&x>=0)) throw new Error("非法作者交接时长");
      const motion=compileMotion(clip.definition,pkg.rig.controls);
      this.adapter.validateMotion(motion,this.adapter.neutral);
      for(const s of clip.stages ?? []) if(!s.id || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs<0 || s.endMs<=s.startMs || s.endMs>motion.durationMs) throw new Error("非法关键阶段");
      const {definition:_,...rest}=clip; return Object.freeze({...rest,motion});
    };
    this.actions=Object.freeze(Object.fromEntries(Object.entries(pkg.actions).map(([id,c])=>[id,compile(c)])));
    this.fragments=Object.freeze(Object.fromEntries(Object.entries(pkg.fragments).map(([kind,items])=>[kind,Object.freeze(Object.fromEntries(Object.entries(items).map(([id,c])=>[id,compile(c)])))])));
    this.background={};
    for(const kind of ["blink","thinking","idle"] as const) { const c=kind==="blink"?pkg.background?.blink?.clip:pkg.background?.[kind]; if(c) this.background[kind]=compile(c); }
    for(const p of Object.values(pkg.poses)) { this.adapter.validateFrame(p.values); if(!Number.isFinite(p.transitionMs)||p.transitionMs<0) throw new Error("非法姿态过渡"); }
    if(!pkg.poses.neutral) throw new Error("模型缺少 neutral 姿态");
    if(pkg.speech) {
      const s=pkg.speech;
      if(!pkg.rig.controls["mouth.open"] || s.points.length<2 || ![s.attackMs,s.releaseMs,s.staleMs].every(n=>Number.isFinite(n)&&n>0)) throw new Error("嘴型配置无效");
      s.points.forEach((p,i)=>{if(!p.every(Number.isFinite)||p[0]<0||p[0]>1||p[1]<0||p[1]>1||(i>0&&p[0]<=s.points[i-1]![0]))throw new Error("嘴型曲线无效");});
    }
    this.digest=contentDigest(pkg);
    this.published=!!pkg.acceptance && pkg.acceptance.contentDigest===this.digest && pkg.acceptance.controlFingerprint===profile.controlFingerprint && !!pkg.acceptance.evidence;
  }
  resolve(args:ExpressParams): CompiledClip {
    const keys=Object.keys(args);
    if(keys.some(k=>!["motion","head","gaze","face","beats","atomic","speech"].includes(k))) throw new Error("旧强度/节奏/留存参数已移除，请使用模型目录中的具体版本");
    if(args.motion) {
      if(args.beats||args.head||args.gaze||args.face) throw new Error("motion 与片段组合互斥");
      const action=this.actions[args.motion]; if(!action) throw new Error(`动作不在模型目录: ${args.motion}`); return action;
    }
    const fragment=(beat:{head?:string;gaze?:string;face?:string})=>{
      const clips:CompiledClip[]=[];
      for(const kind of ["head","gaze","face"] as const) { const id=beat[kind]; if(id) { const c=this.fragments[kind]?.[id]; if(!c) throw new Error(`片段不在模型目录: ${kind}.${id}`); clips.push(c); } }
      if(!clips.length) throw new Error("缺少模型动作或片段");
    };
    // Compose original authored definitions, never flatten compiled sequence semantics.
    const definitions=(beat:{head?:string;gaze?:string;face?:string})=>{
      fragment(beat); return parallel(...(["head","gaze","face"] as const).flatMap(kind=>{const id=beat[kind]; return id?[this.pkg.fragments[kind][id]!.definition]:[];}));
    };
    if(args.beats && (args.head||args.gaze||args.face)) throw new Error("beats 与顶层片段互斥");
    const definition=args.beats?sequence(...args.beats.map(definitions)):definitions(args);
    const motion=compileMotion(definition,this.pkg.rig.controls);
    return {description:"模型片段编排",motion,atomic:false,entryMs:120,exitMs:180};
  }
}
