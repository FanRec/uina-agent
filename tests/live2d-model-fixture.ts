import { AXES } from "../.uina/worlds/live2d/motion-axes.js";
import type { ModelProfile } from "../.uina/worlds/live2d/model-profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/model-adapter.js";
import { moPackage } from "../.uina/worlds/live2d/models/mo/index.js";
import { contentDigest } from "../.uina/worlds/live2d/model-package.js";
import { VTSClient, type WebSocketLike } from "../.uina/worlds/live2d/vts-client.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
export function fixture() {
  const controls=Object.fromEntries(["head.yaw","head.pitch","head.roll","gaze.x","gaze.y","mouth.form","mouth.open","eyes.left.open","eyes.right.open"].map(id=>[id,{...AXES[id as keyof typeof AXES]}]));
  controls["mouth.form"]={...controls["mouth.form"]!,min:0};
  const rig:ModelRig={version:2,modelID:"fixture",controls,bindings:Object.fromEntries(Object.entries(controls).map(([id,m])=>[id,[{parameter:id,input:`drive:${id}`,points:m.neutral>m.min&&m.neutral<m.max?[[m.min,m.min],[m.neutral,m.neutral],[m.max,m.max]]:[[m.min,m.min],[m.max,m.max]],followers:[],physicsFollowers:[],smoothing:0}]])),external:{blink:"uina",breath:"none"}};
  const profile:ModelProfile={modelID:"fixture",modelName:"fixture",controlFingerprint:"test-controls",mappings:Object.entries(controls).map(([id,m])=>({input:`drive:${id}`,output:id,inputMin:m.min,inputMax:m.max,outputMin:m.min,outputMax:m.max,smoothing:0})),parameterRanges:Object.fromEntries(Object.entries(controls).map(([id,m])=>[id,{min:m.min,max:m.max,defaultValue:m.neutral}])),inputs:Object.entries(controls).map(([id,m])=>({name:`drive:${id}`,min:m.min,max:m.max,defaultValue:m.neutral})),physicsOutputs:[],physicsGroups:[],sources:[],activeExpressions:[]};
  const pkg=moPackage(rig);pkg.acceptance={contentDigest:contentDigest(pkg),controlFingerprint:profile.controlFingerprint!,evidence:"fixture-author-review"};
  return {rig,profile,pkg};
}
export class Device implements WebSocketLike {
  readyState=1;onopen:WebSocketLike["onopen"]=null;onclose:WebSocketLike["onclose"]=null;onerror:WebSocketLike["onerror"]=null;onmessage:WebSocketLike["onmessage"]=null;
  requests:{requestID:string;messageType:string;data:Record<string,unknown>}[]=[];
  accept=true;
  position={positionX:0,positionY:0,rotation:0,size:1};
  constructor(readonly profile:ModelProfile) {}
  send(raw:string,cb?:(err?:Error)=>void):void {
    const r=JSON.parse(raw);this.requests.push(r);cb?.();let data:unknown={};
    if(r.messageType==="AuthenticationRequest")data={authenticated:true};
    if(r.messageType==="CurrentModelRequest")data={modelLoaded:true,modelID:this.profile.modelID,timeSinceModelLoaded:10,modelPosition:this.position};
    if(r.messageType==="InputParameterListRequest")data={defaultParameters:this.profile.inputs};
    if(r.messageType==="Live2DParameterListRequest")data={parameters:Object.entries(this.profile.parameterRanges!).map(([name,m])=>({name,min:m.min,max:m.max,defaultValue:m.defaultValue ?? (m as unknown as {neutral:number}).neutral}))};
    if(r.messageType==="MoveModelRequest")this.position={...this.position,...Object.fromEntries(Object.entries(r.data).filter(([k])=>Object.hasOwn(this.position,k)))};
    if(r.messageType==="InjectParameterDataRequest"&&!this.accept)return;
    this.reply(r.requestID,r.messageType.replace("Request","Response"),data);
  }
  reply(requestID:string,messageType:string,data:unknown={}):void {this.onmessage?.({data:JSON.stringify({requestID,messageType,data})});}
  close():void {this.readyState=3;this.onclose?.({});}
  get injections(){return this.requests.filter(r=>r.messageType==="InjectParameterDataRequest");}
}
export async function flush():Promise<void> {for(let i=0;i<40;i++)await Promise.resolve();}
export async function connectedRuntime(published=true) {
  const f=fixture();if(!published)delete f.pkg.acceptance;
  const device=new Device(f.profile),client=new VTSClient({token:"fixture",webSocketFactory:()=>device,profileLoader:async()=>f.profile});
  const runtime=new Live2DRuntime({vtsClient:client,packageLoader:async()=>f.pkg});
  client.connect();device.onopen?.({});await flush();await runtime.synchronize();
  return {...f,device,client,runtime};
}
