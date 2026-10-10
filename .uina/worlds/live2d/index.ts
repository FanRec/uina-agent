import type { ActionContext, WorldDef } from "../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import { Live2DRuntime } from "./runtime.js";
import type { ExpressParams } from "./model-package.js";
const strings={head:{type:"string"},gaze:{type:"string"},face:{type:"string"}};
export function createLive2DApp():WorldDef {
 let runtime:Live2DRuntime|undefined;
 const call=(run:(runtime:Live2DRuntime,args:Record<string,unknown>,ctx:ActionContext)=>Promise<ToolExecutionResult>)=>async(args:Record<string,unknown>,ctx:ActionContext)=>runtime?run(runtime,args,ctx):{result:"Live2D 尚未启动。",status:"failed" as const,details:{effectStatus:"not_started"}};
 return {name:"live2d",description:"当前模型手工发布的 Live2D 动作与姿态。日常表达使用 <cue id='动作名'/>；用 status 查看实际目录。",defaultState:{enabled:true},
  async onStart(ctx){if(runtime)await runtime.stop();runtime=new Live2DRuntime();await runtime.start(ctx);},
  async onStop(){const old=runtime;runtime=undefined;await old?.stop();},
  actions:{
   express:{description:"播放当前模型动作或组合当前模型发布的片段。名称来自 status；不支持旧强度、节奏和留存参数。",parameters:{type:"object",additionalProperties:false,properties:{motion:{type:"string"},...strings,beats:{type:"array",items:{type:"object",additionalProperties:false,properties:strings}},atomic:{type:"boolean"},speech:{type:"string",enum:["blend","exclusive"]}}},run:call((r,a,c)=>r.executeExpress(a as ExpressParams,c))},
   pose:{description:"设置当前模型的持续姿态；限时结束回到 neutral。",parameters:{type:"object",additionalProperties:false,properties:{name:{type:"string"},duration_ms:{type:"number",minimum:0}},required:["name"]},run:call((r,a,c)=>r.executePose(String(a.name),Number(a.duration_ms ?? 0),c))},
   costume:{description:"执行模型包登记的外观操作；list 只列出登记项。",parameters:{type:"object",additionalProperties:false,properties:{item:{type:"string"}},required:["item"]},run:call((r,a,c)=>r.executeCostume(String(a.item),c))},
   flip:{description:"整模型旋转并核实归位。取消后等待归位清理，不附带隐含表情。",run:call((r,_,c)=>r.executeFlip(c))},
   status:{description:"读取设备就绪、当前模型目录、暂停状态和动作证据。",run:call(async r=>({result:r.formatStatus(),status:"succeeded"}))},
   diagnose:{description:"作者诊断：读取实际模型事实与输出诊断，不修改配置。",run:call(async r=>({result:JSON.stringify({runtime:r.diagnostics(),profile:r.vtsClient.getModelProfile()},null,2),status:"succeeded"}))},
   preview:{description:"作者预览当前模型草稿。走同一生产路径；停止后使用 body resume 恢复。",parameters:{type:"object",additionalProperties:false,properties:{motion:{type:"string"},pose:{type:"string"},control:{type:"string"},keys:{type:"array",items:{type:"array",items:{type:"number"},minItems:2,maxItems:2}},repeat:{type:"integer",minimum:1},background:{type:"boolean"},stop:{type:"boolean"},rms:{type:"number",minimum:0,maximum:1}}},run:call((r,a,c)=>r.preview(a as Parameters<Live2DRuntime["preview"]>[0],c))},
   reload:{description:"显式重新加载当前 VTS 模型并重新核验控制配置。",run:call(async r=>{try{await r.vtsClient.reloadCurrentModel();return {result:"已请求重新加载，需查询 status 等待事实就绪。",status:"succeeded",details:{effectStatus:"accepted"}};}catch(e){return {result:String(e),status:"unknown"};}})},
  },
 };
}
export default createLive2DApp();
