import type { ActionContext, ServiceCompanionContext } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { BODY_ENDPOINT_EXPOSED_PREFIX, VOICE_LEVEL_SINK_EXPOSED_PREFIX, type BodyEndpoint } from "./contracts.js";
import { VTSClient, type MotionInjectionEvidence } from "./vts-client.js";
import { PackageProgram, type CompiledClip, type ExpressParams, type ModelPackage } from "./model-package.js";
import { MotionDirector, type ResourceLease } from "./motion-director.js";
import { VTSCompanion } from "./companion.js";
import { AudioObserver } from "./audio-observer.js";
import { performModelFlip } from "./model-motion.js";
import { loadModelPackage } from "./models/index.js";
import { compileMotion, motion, repeat, track } from "./motion.js";
import type { ModelProfile } from "./model-profile.js";

type Observation=ReturnType<VTSClient["observeMotionInjections"]>;
const ok=(result:string,details:Record<string,unknown>={}):ToolExecutionResult=>({result,status:"succeeded",details});
const rejected=(reason:string,message:string,cancelled=false):ToolExecutionResult=>({result:message,status:cancelled?"cancelled":"failed",details:{reason,effectStatus:"not_started"}});
/** Owns every product entrypoint and pause state. No producer can bypass this runtime. */
export class Live2DRuntime {
  readonly vtsClient:VTSClient;
  readonly companion:VTSCompanion;
  readonly endpoint:BodyEndpoint;
  director?:MotionDirector;
  program?:PackageProgram;
  private audio?:AudioObserver;
  private readonly packageLoader:(profile:ModelProfile)=>Promise<ModelPackage|undefined>;
  private initializing?:Promise<void>;
  private profileVersion="";
  private loadedGeneration=-1;
  private fault?:string;
  private timerEnabled=false;
  private paused=false;
  private stopping?:Promise<void>;
  private readonly cleanups:(()=>void)[]=[];
  private readonly externalTasks=new Set<Promise<unknown>>();
  private readonly pendingEffects=new Set<string>();
  private readonly observations=new Map<string,{main:Observation;stages:Map<string,Observation>}>();
  private heldFrame?:Record<string,number>;
  private poseName="neutral";
  private poseRemaining?:number;
  private elapsed=0;
  private nextBlink=0;
  private backgroundEnabled=true;
 private authorSession=false;
  private focused=true;
  private thinking=false;
  private lastCue?:{id:string;state:"received"|"started"|"finished"|"rejected";reason?:string;at:string};
  private lastFrame?:{logical:Record<string,number>;encoded:readonly {id:string;value:number}[];deltaMs:number};
  constructor(options:{vtsClient?:VTSClient;packageLoader?:(profile:ModelProfile)=>Promise<ModelPackage|undefined>}={}) {
    this.vtsClient=options.vtsClient ?? new VTSClient();this.packageLoader=options.packageLoader ?? loadModelPackage;
    this.companion=new VTSCompanion(dt=>this.tick(dt));
    this.vtsClient.setConnectionChangeListener(connected=>{
      this.director?.stop();this.program=undefined;this.profileVersion="";this.audio?.reset();this.heldFrame=undefined;
      if(connected){void this.synchronize();if(this.timerEnabled)this.companion.start();}else this.companion.stop();
    });
    this.endpoint={bodyId:"live2d",bodyType:"avatar_2d",state:()=>({online:this.vtsClient.isConnected(),paused:this.paused,fault:this.fault ?? this.vtsClient.getFault()}),
      affordance:()=>({bodyId:"live2d",bodyType:"avatar_2d",description:"当前模型手工验收的动作与姿态。",cues:this.catalog()}),
      supportsCue:id=>this.catalog().some(c=>c.id===id),emitCue:id=>this.emitCue(id),safeStop:()=>this.safeStop(),resume:()=>this.resume(),
      onFocus:focused=>{this.focused=focused;if(!focused){this.thinking=false;this.director?.cancelAxes(this.program?.background.thinking?.motion.axes ?? []);}},formatStatus:()=>this.formatStatus()};
  }
  async synchronize():Promise<void> {
    if(this.initializing)return this.initializing;
    const profile=this.vtsClient.getModelProfile(), generation=this.vtsClient.getModelGeneration();
    if(!profile || !this.vtsClient.isConnected())return;
    const version=`${generation}:${profile.controlFingerprint ?? profile.fingerprint ?? profile.modelID}`;
    if(version===this.profileVersion)return;
    this.initializing=(async()=>{
      try {
        const pkg=await this.packageLoader(profile);
        if(generation!==this.vtsClient.getModelGeneration() || !this.vtsClient.isConnected())return;
        this.director?.stop();this.director=undefined;this.program=undefined;this.audio=undefined;
        this.profileVersion=version;this.loadedGeneration=generation;
        if(!pkg){this.fault="当前模型未手工适配";return;}
        const program=new PackageProgram(pkg,profile);this.program=program;this.director=new MotionDirector(program.adapter);
        this.audio=pkg.speech?new AudioObserver(pkg.speech):undefined;this.poseName="neutral";this.poseRemaining=undefined;this.elapsed=0;
        this.nextBlink=pkg.background?.blink?.intervalMs ?? Infinity;this.fault=undefined;
        if(this.paused)this.heldFrame={...program.adapter.neutral};
      } catch(error){this.program=undefined;this.director=undefined;this.fault=error instanceof Error?error.message:String(error);}
    })().finally(()=>{this.initializing=undefined;});
    return this.initializing;
  }
  private catalog():{id:string;description:string}[] {
    const p=this.program, profile=this.vtsClient.getModelProfile();if(!p?.published || !profile || this.paused || !this.vtsClient.isConnected())return [];
    const blocked=p.adapter.blockedAxes(profile);
    return [...Object.entries(p.actions).filter(([,c])=>!c.motion.axes.some(a=>blocked.includes(a))).map(([id,c])=>({id,description:c.description})),
      ...Object.entries(p.pkg.poses).filter(([,v])=>!Object.keys(v.values).some(a=>blocked.includes(a))).map(([id,p])=>({id,description:p.description}))];
  }
  private gate(signal?:AbortSignal,author=false):ToolExecutionResult|undefined {
    if(signal?.aborted)return rejected("cancelled","动作已取消。",true);
    if(this.paused || this.stopping)return rejected("paused","Uina 身体驱动已暂停，请先恢复。 ");
    if(!this.vtsClient.isConnected())return rejected("model_not_ready",this.vtsClient.getFault() ?? "设备事实尚未就绪。");
    if(!this.program || !this.director)return rejected("unadapted",this.fault ?? "模型未适配。");
    if(!author && !this.program.published)return rejected("draft","此模型包尚未完成当前版本的真实画面验收；请使用作者预览。");
    return;
  }
  private async prepare(signal?:AbortSignal,author=false):Promise<ToolExecutionResult|undefined> {
    await this.vtsClient.validateModelFiles();await this.synchronize();return this.gate(signal,author);
  }
  async executeExpress(args:ExpressParams,ctx:Pick<ActionContext,"signal">):Promise<ToolExecutionResult> {
    const failed=await this.prepare(ctx.signal);if(failed)return failed;
    try{return await this.play(this.program!.resolve(args),ctx.signal,50,"action",false,args);}
    catch(error){return rejected("invalid_motion",String(error));}
  }
  private async play(clip:CompiledClip,signal:AbortSignal|undefined,priority:number,reason:string,author:boolean,args:ExpressParams={}):Promise<ToolExecutionResult> {
    const failed=this.gate(signal,author);if(failed)return failed;
    const p=this.program!, d=this.director!, profile=this.vtsClient.getModelProfile()!,generation=this.loadedGeneration;
    if(clip.motion.axes.some(a=>p.adapter.blockedAxes(profile).includes(a)))return rejected("external_source","活动外部表情与动作目标冲突。");
    let id:string|undefined;
    const chosen={...clip,atomic:args.atomic ?? clip.atomic ?? true};
    try {
      const outcome=await d.play(chosen,{priority,reason,signal,speech:args.speech,onStart:lease=>{
        id=lease.id;this.observations.set(id,{main:this.vtsClient.observeMotionInjections(id),stages:new Map((clip.stages ?? []).map(s=>[s.id,this.vtsClient.observeMotionInjections(`${id}:${s.id}`)]))});
        if(reason==="cue" && this.lastCue)this.lastCue.state="started";
      }});
      const obs=this.observations.get(id!)!;this.observations.delete(id!);
      const transmission=outcome.status==="cancelled"?obs.main.snapshot():await obs.main.finish();
      const stages:Record<string,MotionInjectionEvidence>={};for(const [name,o] of obs.stages)stages[name]=outcome.status==="cancelled"?o.snapshot():await o.finish();
      obs.main.close();for(const o of obs.stages.values())o.close();
      const missing=p.adapter.inputsFor(clip.motion.axes.filter(a=>!outcome.interruptedAxes.includes(a))).filter(input=>!transmission.acceptedInputs.includes(input));
      const details={transmission,stages,missingInputs:missing,interruptedAxes:outcome.interruptedAxes,partial:outcome.interruptedAxes.length>0};
      if(outcome.status==="cancelled")return {result:"动作已取消或被抢占。",status:"cancelled",details:{...details,effectStatus:"cancelled"}};
      if(generation!==this.vtsClient.getModelGeneration() || transmission.generation!==this.vtsClient.getInjectionStats().generation || !transmission.accepted || transmission.failed || transmission.filtered || missing.length || Object.values(stages).some(s=>!s.accepted))return {result:"时间线结束，但模型代次、输入或关键阶段的呈现证据不足。",status:"unknown",details:{...details,effectStatus:"unknown"}};
      return ok("动作时间线结束，VTS 已接受动作贡献及声明的关键阶段；这不等于完整画面轨迹确认。",{...details,effectStatus:"accepted",verification:"input_accepted"});
    }catch(error){return rejected(signal?.aborted?"cancelled":"motion_not_started",String(error),signal?.aborted);}
    finally{if(id){const obs=this.observations.get(id);if(obs){obs.main.close();for(const o of obs.stages.values())o.close();this.observations.delete(id);}}}
  }
  async executePose(name:string,durationMs:number,ctx:Pick<ActionContext,"signal">,author=false):Promise<ToolExecutionResult> {
    const failed=await this.prepare(ctx.signal,author);if(failed)return failed;
    const pose=this.program!.pkg.poses[name];if(!pose)return rejected("unknown_pose",`姿态不在模型目录: ${name}`);
    if(!Number.isFinite(durationMs)||durationMs<0)return rejected("invalid_duration","姿态时长必须为非负有限值。");
    const profile=this.vtsClient.getModelProfile()!;if(Object.keys(pose.values).some(a=>this.program!.adapter.blockedAxes(profile).includes(a)))return rejected("external_source","姿态与活动外部来源冲突。");
    this.director!.setPose(pose.values,pose.transitionMs);this.poseName=name;this.poseRemaining=durationMs>0?durationMs+pose.transitionMs:undefined;
    return ok(`本地姿态意图已设置: ${name}`,{verification:"local_intent",effectStatus:"applied"});
  }
  private emitCue(id:string):void {
    this.lastCue={id,state:"received",at:new Date().toISOString()};
    const ctx={signal:new AbortController().signal};
    const run=async()=>{const failure=await this.prepare(ctx.signal);if(failure)return failure;
      if(this.program!.pkg.poses[id])return this.executePose(id,0,ctx);
      const c=this.program!.actions[id];return c?this.play(c,ctx.signal,30,"cue",false):rejected("unknown_cue",`动作不在模型目录: ${id}`);};
    void run().then(result=>{if(this.lastCue?.id===id){this.lastCue.state=result.status==="succeeded"?"finished":"rejected";this.lastCue.reason=result.result;}},error=>{if(this.lastCue?.id===id){this.lastCue.state="rejected";this.lastCue.reason=String(error);}});
  }
  processLevel(level:{rms:number;peak?:number}):void {if(!this.paused&&!this.stopping&&this.program?.published)this.audio?.processLevel(level);}
  resetAudio():void {this.audio?.reset();}
  tick(deltaMs:number):void {
    if(!this.vtsClient.isConnected())return;
    if(!this.program || !this.director){void this.synchronize();return;}
    if(!this.program.published && !this.authorSession)return;
    try {
      const profile=this.vtsClient.getModelProfile()!,blocked=this.program.adapter.blockedAxes(profile);
      this.director.cancelAxes(blocked);
      let frame:Record<string,number>;
      if(this.paused)frame=this.heldFrame ?? this.program.adapter.neutral;
      else {
        this.elapsed+=deltaMs;
        if(this.poseRemaining!==undefined){this.poseRemaining-=deltaMs;if(this.poseRemaining<=0){const p=this.program.pkg.poses.neutral!;this.director.setPose(p.values,p.transitionMs);this.poseName="neutral";this.poseRemaining=undefined;}}
        if((this.program.published||this.authorSession)&&this.backgroundEnabled&&this.focused){
          const blink=this.program.background.blink;
          if(blink&&this.elapsed>=this.nextBlink){this.nextBlink=this.elapsed+this.program.pkg.background!.blink!.intervalMs;if(!this.director.hasReason("blink"))void this.play(blink,undefined,10,"blink",false);}
          if(this.thinking&&this.program.background.thinking&&!this.director.hasReason("thinking"))void this.play(this.program.background.thinking,undefined,20,"thinking",false);
          if(this.program.background.idle&&!this.director.hasReason("idle"))void this.play(this.program.background.idle,undefined,10,"idle",false);
        }
        frame=this.director.compose(deltaMs,(this.program.published||this.authorSession)?this.audio?.tick(deltaMs) ?? 0:0);
      }
      const encoded=this.program.adapter.encode(frame,blocked);
      const contributions=this.paused?[]:this.director.getFrameContributions().flatMap(c=>[
        {leaseID:c.leaseID,inputs:this.program!.adapter.inputsFor(c.axes.filter(a=>!blocked.includes(a)))},
        ...c.stages.map(stage=>({leaseID:`${c.leaseID}:${stage}`,inputs:this.program!.adapter.inputsFor(c.axes.filter(a=>!blocked.includes(a)))})),
      ]);
      this.vtsClient.injectParameters(encoded,contributions);this.lastFrame={logical:frame,encoded,deltaMs};this.director.commitFrame();
    }catch(error){this.fault=String(error);this.director.stop();this.paused=true;this.heldFrame={...this.director.frame};}
  }
  async safeStop():Promise<void> {
    if(this.stopping)return this.stopping;
    this.paused=true;this.heldFrame=this.director?{...this.director.frame}:undefined;this.thinking=false;this.audio?.reset();this.director?.stop();
    this.stopping=(async()=>{const outcomes=await Promise.allSettled([...this.externalTasks]);if(outcomes.some(o=>o.status==="rejected")||this.pendingEffects.size)throw new Error("Uina 已暂停，外部效果或归位清理尚未确认");})().finally(()=>{this.stopping=undefined;});
    return this.stopping;
  }
  async resume():Promise<void> {if(this.stopping)await this.stopping;this.paused=false;this.heldFrame=undefined;this.audio?.reset();this.nextBlink=this.elapsed+(this.program?.pkg.background?.blink?.intervalMs ?? Infinity);}
  async executeCostume(item:string,ctx:Pick<ActionContext,"signal">):Promise<ToolExecutionResult> {
    const failed=await this.prepare(ctx.signal);if(failed)return failed;
    const costumes=this.program!.pkg.costumes;if(item==="list")return ok(JSON.stringify(costumes));
    const costume=costumes.find(c=>c.id===item);if(!costume)return rejected("unknown_costume","只允许模型包登记的外观操作。");
    if(!this.vtsClient.getAvailableHotkeys().some(h=>h.hotkeyID===costume.hotkeyID))return rejected("hotkey_missing","登记热键不在当前模型。");
    let lease:ResourceLease;try{lease=this.director!.claim(costume.resources,{priority:50,reason:"costume",signal:ctx.signal,cleanup:true});}catch(e){return rejected("resource_conflict",String(e));}
    const cancel=()=>lease.cancel();ctx.signal.addEventListener("abort",cancel,{once:true});
    const task=(async()=>{await Promise.resolve();if(lease.signal.aborted||ctx.signal.aborted)return rejected("cancelled","热键触发前已取消。",true);
      this.pendingEffects.add(costume.id);
      try {await this.vtsClient.triggerHotkey(costume.hotkeyID);return ok("VTS 接受了外观热键；最终状态尚未确认。",{effectStatus:"accepted"});}
      catch(error){return {result:String(error),status:"unknown" as const,details:{effectStatus:"unknown"}};}
    })();this.externalTasks.add(task);
    try{return await task;}finally{this.externalTasks.delete(task);ctx.signal.removeEventListener("abort",cancel);lease.release();}
  }
  async executeFlip(ctx:Pick<ActionContext,"signal">):Promise<ToolExecutionResult> {
    const failed=await this.prepare(ctx.signal);if(failed)return failed;
    let lease:ResourceLease;try{lease=this.director!.claim(["model:transform",...this.program!.adapter.resourcesFor(Object.keys(this.program!.pkg.rig.controls))],{priority:50,reason:"flip",signal:ctx.signal,cleanup:true});}catch(e){return rejected("resource_conflict",String(e));}
    const abort=()=>lease.cancel();ctx.signal.addEventListener("abort",abort,{once:true});
    const task=performModelFlip(this.vtsClient,lease.signal).then(result=>{
      if(result.cleanupFailed)throw new Error("模型归位未确认");return result;
    });this.externalTasks.add(task);
    try {const result=await task;return {result:result.aborted?"翻转取消，原位置已核实恢复。":"翻转结束，原位置已核实恢复。",status:result.aborted?"cancelled":"succeeded",details:{effectStatus:result.aborted?"cancelled":"accepted",restoration:"confirmed"}};}
    catch(error){return {result:String(error),status:"unknown",details:{effectStatus:"unknown"}};}
    finally{this.externalTasks.delete(task);ctx.signal.removeEventListener("abort",abort);lease.release();}
  }
  async preview(args:{motion?:string;pose?:string;control?:string;keys?:readonly (readonly [number,number])[];repeat?:number;background?:boolean;stop?:boolean;rms?:number},ctx:Pick<ActionContext,"signal">):Promise<ToolExecutionResult> {
    if(args.stop){try{await this.safeStop();return ok("作者预览已停止，Uina 输入保持。");}catch(e){return {result:String(e),status:"unknown"};}}
    const failed=await this.prepare(ctx.signal,true);if(failed)return failed;
    this.authorSession=true;
    if(args.background!==undefined)this.backgroundEnabled=args.background;
    if(args.rms!==undefined){this.audio?.processLevel({rms:args.rms});return ok("作者音频电平已设置；后续按同一嘴型路径处理。");}
    if(args.pose)return this.executePose(args.pose,0,ctx,true);
    let clip:CompiledClip;
    try {
      if(args.control){const keys=args.keys;if(!keys?.length)throw new Error("控制预览必须给出手工区间关键帧");clip={description:"单控制作者预览",motion:compileMotion(motion(keys.at(-1)![0],track(args.control as `${string}.${string}`,keys)),this.program!.pkg.rig.controls),entryMs:0,exitMs:180};}
      else {clip=this.program!.actions[args.motion ?? ""]!;if(!clip)throw new Error("动作不在当前模型草稿");}
      if(args.repeat!==undefined){if(!args.motion)throw new Error("重复预览需要模型动作名");clip={...clip,motion:compileMotion(repeat(args.repeat,this.program!.pkg.actions[args.motion!]!.definition),this.program!.pkg.rig.controls),stages:undefined};}
      return await this.play(clip,ctx.signal,50,"preview",true);
    }catch(error){return rejected("invalid_preview",String(error));}
  }
  diagnostics():Record<string,unknown> {return {connection:this.vtsClient.getConnectionStatus(),modelGeneration:this.vtsClient.getModelGeneration(),paused:this.paused,model:this.program?.pkg.name,published:this.program?.published ?? false,digest:this.program?.digest,fault:this.fault,draftActions:Object.keys(this.program?.actions ?? {}),available:this.catalog(),pose:this.poseName,lastCue:this.lastCue,lastFrame:this.lastFrame,injections:this.vtsClient.getInjectionStats(),pendingExternal:[...this.pendingEffects]};}
  formatStatus():string {return JSON.stringify(this.diagnostics(),null,2);}
  async start(ctx?:ServiceCompanionContext):Promise<void> {
    this.timerEnabled=true;this.vtsClient.connect();if(this.vtsClient.isConnected())this.companion.start();
    if(ctx?.expose){this.cleanups.push(ctx.expose(BODY_ENDPOINT_EXPOSED_PREFIX+"live2d",this.endpoint),ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX+"live2d",{processLevel:(level:{rms:number;peak?:number})=>this.processLevel(level),reset:()=>this.resetAudio()}));}
    if(ctx?.onHostEvent)this.cleanups.push(ctx.onHostEvent(event=>{if(this.paused)return;if(event.type==="output_update")this.thinking=event.channel==="thinking";if(event.type==="turn_end"||event.type==="turn_start")this.thinking=false;if(event.type==="turn_aborted"){this.thinking=false;this.director?.stop();this.audio?.reset();}}));
  }
  async stop():Promise<void> {try{await this.safeStop();}finally{this.timerEnabled=false;this.companion.stop();for(const cleanup of this.cleanups.splice(0).reverse())cleanup();this.vtsClient.disconnect();}}
}
