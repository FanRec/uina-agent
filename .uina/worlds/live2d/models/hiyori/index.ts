import { nod } from "../../motions/common.js";
import type { ModelPackage, VisualAcceptance } from "../../model-package.js";
import type { ModelRig } from "../../model-adapter.js";
export function hiyoriPackage(rig:ModelRig,acceptance?:VisualAcceptance):ModelPackage {
  const clip=nod({depth:4,durationMs:950});
  return {name:"Hiyori",rig,acceptance,actions:{nod:clip},fragments:{head:{nod:clip},gaze:{},face:{}},poses:{neutral:{description:"正常中性姿态",values:{},transitionMs:350}},costumes:[]};
}
