import { commonActions, neutralGaze } from "../../motions/common.js";
import { motion, track } from "../../motion.js";
import type { ModelPackage, VisualAcceptance } from "../../model-package.js";
import type { ModelRig } from "../../model-adapter.js";
export function moPackage(rig:ModelRig,acceptance?:VisualAcceptance):ModelPackage {
  const actions=commonActions(5);
  return {name:"MO",rig,actions,acceptance,
    fragments:{head:{nod:actions.nod!,shake:actions.shake!,curious:actions.curious!},face:{smile:actions.smile!},gaze:{user:neutralGaze}},
    poses:{
      neutral:{description:"正常中性姿态",values:{},transitionMs:350},
      attentive:{description:"轻抬头、注视前方",values:{"head.pitch":1.5,"gaze.x":0,"gaze.y":0},transitionMs:500},
      listening:{description:"轻歪头倾听",values:{"head.roll":2,"gaze.x":0,"gaze.y":0},transitionMs:550},
    },
    background:{blink:{intervalMs:4700,clip:{description:"自然双眼眨眼",definition:motion(280,
      track("eyes.left.open",[[0,1],[90,0],[130,0],[280,1]]),track("eyes.right.open",[[0,1],[90,0],[130,0],[280,1]])),entryMs:0,exitMs:0,atomic:true,stages:[{id:"closed",startMs:85,endMs:150}]}}},
    speech:{points:[[0,0],[.004,0],[.02,.25],[.06,.7],[.15,1],[1,1]],attackMs:25,releaseMs:85,staleMs:120},
    costumes:[],
  };
}
