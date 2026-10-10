import { expect,it } from "vitest";
import { compileModelAdapter } from "../.uina/worlds/live2d/model-adapter.js";
import { PackageProgram } from "../.uina/worlds/live2d/model-package.js";
import { compileMotion,motion,track } from "../.uina/worlds/live2d/motion.js";
import { fixture } from "./live2d-model-fixture.js";
it("requires manual curves; missing input, wrong identity and duplicate outputs fail compilation",()=>{
  const {profile,rig}=fixture();
  expect(()=>compileModelAdapter(profile,{...rig,modelID:"other"})).toThrow("身份");
  rig.bindings["head.pitch"]![0]!.points=[];
  expect(()=>compileModelAdapter(profile,rig)).toThrow("曲线");
  const f=fixture();f.profile.mappings=[...f.profile.mappings,{...f.profile.mappings[0]!}];
  expect(()=>compileModelAdapter(f.profile,f.rig)).toThrow("重复输出");
});
it("encodes each active input once and leaves unowned VTS parameters alone",()=>{
  const {profile,rig}=fixture();const p=compileModelAdapter(profile,rig);const values=p.encode({...p.neutral,"head.pitch":4});
  expect(values.find(v=>v.id==="drive:head.pitch")!.value).toBe(4);
  expect(new Set(values.map(v=>v.id)).size).toBe(values.length);expect(values.some(v=>v.id.includes("torso"))).toBe(false);
  expect(()=>p.encode({...p.neutral,"head.pitch":100})).toThrow("范围");
});
it("rejects shared-input authority and unexplained fanout",()=>{
  const f=fixture();f.profile.mappings[1]!.input=f.profile.mappings[0]!.input;f.rig.bindings["head.pitch"]![0]!.input=f.profile.mappings[0]!.input;
  expect(()=>compileModelAdapter(f.profile,f.rig)).toThrow("跟随关系");
  f.rig.bindings["head.yaw"]![0]!.followers=["head.pitch"];
  expect(()=>compileModelAdapter(f.profile,f.rig)).toThrow("共用输入");
});
it("accepts declared physics followers without inventing independently writable axes",()=>{
  const f=fixture();f.profile.physicsGroups=[{id:"follow",inputs:[{id:"head.pitch",weight:100}],outputs:[{id:"torso.pitch",weight:100,scale:1}]}];
  f.rig.bindings["head.pitch"]![0]!.physicsFollowers=["torso.pitch"];
  const p=compileModelAdapter(f.profile,f.rig);expect(p.resources["head.pitch"]).toContain("effect:torso.pitch");expect(p.rig.controls["torso.pitch"]).toBeUndefined();
  f.rig.bindings["head.pitch"]![0]!.physicsFollowers=[];expect(()=>compileModelAdapter(f.profile,f.rig)).toThrow("跟随关系");
});
it("binds reachable offsets to actual baseline rather than rejecting every nonzero offset",()=>{
  const {profile,rig}=fixture();const p=compileModelAdapter(profile,rig),c=compileMotion(motion(100,track("head.pitch",[[0,0],[100,-4]],"baseline-offset")),rig.controls);
  expect(()=>p.validateMotion(c,{...p.neutral,"head.pitch":2})).not.toThrow();
  expect(()=>p.validateMotion(c,{...p.neutral,"head.pitch":-29})).toThrow("当前姿态");
});
it("isolates active expression ownership to affected controls",()=>{
  const f=fixture();const p=compileModelAdapter(f.profile,f.rig);
  f.profile.sources=[{file:"smile.exp3.json",kind:"expression",parameters:["mouth.form"]}];
  expect(p.blockedAxes(f.profile)).toEqual([]);f.profile.activeExpressions=["smile.exp3.json"];
  expect(p.blockedAxes(f.profile)).toEqual(["mouth.form"]);expect(p.encode(p.neutral,p.blockedAxes(f.profile)).some(v=>v.id==="drive:mouth.form")).toBe(false);
});
it("publishes only matching content and control acceptance and resolves model fragments",()=>{
  const f=fixture();let p=new PackageProgram(f.pkg,f.profile);expect(p.published).toBe(true);
  expect(p.resolve({head:"nod",face:"smile"}).motion.axes).toEqual(expect.arrayContaining(["head.pitch","mouth.form"]));
  expect(()=>p.resolve({face:"nod"})).toThrow("模型目录");expect(()=>p.resolve({motion:"nod",intensity:1} as never)).toThrow("旧");
  f.pkg.actions.nod!.exitMs++;p=new PackageProgram(f.pkg,f.profile);expect(p.published).toBe(false);
});
