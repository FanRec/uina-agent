import { expect,it } from "vitest";
import { compileMotion,motion,track,pose,sequence,parallel,repeat,delay,transform,sampleMotion,withSpeech,sampleSpeechGain } from "../.uina/worlds/live2d/motion.js";
it("uses one production sampler for authored curves, timing and composition",()=>{
  const clip=compileMotion(sequence(motion(100,track("head.pitch",[[0,0],[100,-4]],"baseline-offset","linear")),delay(100,pose(100,{"head.pitch":2}))));
  expect(sampleMotion(clip,50,{"head.pitch":3})["head.pitch"]).toBe(1);
  expect(sampleMotion(clip,150,{"head.pitch":3})["head.pitch"]).toBe(-1);
  expect(sampleMotion(clip,300,{"head.pitch":3})["head.pitch"]).toBe(2);
});
it("accepts model-local controls through explicit metadata and freezes compiled values",()=>{
  const metadata={"mo.brows.raise":{channel:"eyes" as const,min:-1,max:1,neutral:0}};
  const source=track("mo.brows.raise",[[0,0],[100,.4]]), c=compileMotion(motion(100,source),metadata);
  metadata["mo.brows.raise"].neutral=.8;
  expect(sampleMotion(c,100)["mo.brows.raise"]).toBe(.4);expect(c.controls["mo.brows.raise"]!.neutral).toBe(0);
  expect(Object.isFrozen(c.tracks[0]!.keys)).toBe(true);
  expect(()=>compileMotion(motion(100,source))).toThrow("unknown axis");
});
it("validates conflicting absolute targets but permits explicit offset sums",()=>{
  expect(()=>compileMotion(parallel(pose(100,{"head.pitch":1}),pose(100,{"head.pitch":2})))).toThrow("Conflicting");
  const c=compileMotion(parallel(pose(100,{"head.pitch":1},"baseline-offset"),pose(100,{"head.pitch":2},"baseline-offset")));
  expect(sampleMotion(c,100,{"head.pitch":4})["head.pitch"]).toBe(7);
});
it("preserves speech policy through repeats and sequence holds",()=>{
  const c=compileMotion(sequence(withSpeech(pose(100,{"mouth.open":.5}),"exclusive"),pose(100,{"head.pitch":2}),pose(100,{"mouth.open":0})));
  expect(sampleSpeechGain(c,150)).toBe(0);expect(sampleSpeechGain(c,300)).toBe(1);
  expect(compileMotion(repeat(2,transform(motion(100,track("head.pitch",[[0,0],[100,2]])),{durationScale:2}))).durationMs).toBe(400);
});
it("rejects nonfinite, out-of-order and cyclic content before playback",()=>{
  expect(()=>compileMotion(motion(100,track("head.pitch",[[0,0],[100,NaN]])))).toThrow("finite");
  expect(()=>compileMotion(motion(100,track("head.pitch",[[0,0],[0,1],[100,0]])))).toThrow("increase");
  const source:{kind:"sequence";motions:unknown[]}={kind:"sequence",motions:[]};source.motions.push(source);
  expect(()=>compileMotion(source as never)).toThrow("cyclic");
});
