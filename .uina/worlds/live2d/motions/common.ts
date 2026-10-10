import { motion, track, sequence, transform, parallel, delay, pose } from "../motion.js";
import type { AuthoredClip } from "../model-package.js";
export function nod({depth,durationMs}:{depth:number;durationMs:number}): AuthoredClip {
  return {description:"轻点头一次",definition:motion(durationMs,track("head.pitch",[[0,0],[durationMs*.38,-depth],[durationMs*.6,-depth*.85],[durationMs,0]],"baseline-offset")),entryMs:80,exitMs:140,stages:[{id:"lowered",startMs:durationMs*.3,endMs:durationMs*.65}]};
}
export function commonActions(depth=5): Record<string,AuthoredClip> {
  const n=nod({depth,durationMs:900});
  const smile:AuthoredClip={description:"轻微微笑，笑眼随模型自然变化",definition:motion(1500,track("mouth.form",[[0,0],[350,.35],[1100,.35],[1500,0]])),entryMs:80,exitMs:180,stages:[{id:"smiling",startMs:350,endMs:1100}]};
  return {
    nod:n,
    double_nod:{...n,description:"轻点头后再点头一次",definition:sequence(transform(n.definition,{intensity:.65}),n.definition),stages:[{id:"first",startMs:270,endMs:580},{id:"second",startMs:1170,endMs:1480}]},
    shake:{description:"轻轻摇头后回位",definition:motion(1500,track("head.yaw",[[0,0],[350,-7],[850,7],[1500,0]],"baseline-offset")),entryMs:100,exitMs:180,stages:[{id:"left",startMs:250,endMs:450},{id:"right",startMs:750,endMs:950}]},
    smile,
    curious:{description:"轻歪头表示好奇",definition:motion(1600,track("head.roll",[[0,0],[400,5],[1050,5],[1600,0]],"baseline-offset")),entryMs:100,exitMs:180,stages:[{id:"tilted",startMs:400,endMs:1050}]},
    greeting:{description:"微笑着轻点头打招呼",definition:parallel(smile.definition,delay(150,n.definition)),entryMs:100,exitMs:180,stages:[{id:"greeting",startMs:450,endMs:730}]},
  };
}
export const neutralGaze:AuthoredClip={description:"看向正前方",definition:pose(900,{"gaze.x":0,"gaze.y":0}),entryMs:160,exitMs:180};
