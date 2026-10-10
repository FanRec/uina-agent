import {expect,it} from "vitest";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { PackageProgram } from "../.uina/worlds/live2d/model-package.js";
import { fixture } from "./live2d-model-fixture.js";
const make=()=>{const f=fixture(),p=new PackageProgram(f.pkg,f.profile);return {p,d:new MotionDirector(p.adapter)};};
it("samples the authored peak exactly, with no global body filter",async()=>{
  const {p,d}=make();const c={...p.actions.nod!,entryMs:0};const done=d.play(c,{priority:50,reason:"action"});
  expect(d.compose(342)["head.pitch"]).toBeCloseTo(-5,10);d.compose(1000);d.commitFrame();expect((await done).status).toBe("completed");
});
it("allows independent controls and blocks an equal-priority unrelated resource owner",async()=>{
  const {p,d}=make();const nod=d.play(p.actions.nod!,{priority:50,reason:"head"}),smile=d.play(p.actions.smile!,{priority:50,reason:"face"});
  expect(d.getActiveLeases()).toHaveLength(2);expect(()=>d.claim(p.adapter.resourcesFor(["head.pitch"]),{priority:50,reason:"other"})).toThrow("冲突");
  d.compose(2200);d.commitFrame();await Promise.all([nod,smile]);
});
it("retains ownership until external cleanup finishes after cancellation",()=>{
  const {p,d}=make(),resources=p.adapter.resourcesFor(["head.pitch"]),lease=d.claim(resources,{priority:50,reason:"flip",cleanup:true});
  d.stop();expect(lease.signal.aborted).toBe(true);expect(d.getActiveLeases()).toContain(lease);
  expect(()=>d.claim(resources,{priority:50,reason:"next"})).toThrow("清理");lease.release();
  expect(d.claim(resources,{priority:50,reason:"next"}).released).toBe(false);
});
it("repeated replacement enters from the last presented frame and retires old actions",async()=>{
  const {p,d}=make();const first=d.play(p.actions.nod!,{priority:50,reason:"action"});d.compose(300);const current=d.frame["head.pitch"]!;
  const second=d.play(p.actions.nod!,{priority:50,reason:"action"});expect((await first).status).toBe("cancelled");
  expect(d.compose(0)["head.pitch"]).toBe(current);d.stop();expect((await second).status).toBe("cancelled");
});
it("partial preemption cancels only the affected axes and reports them",async()=>{
  const {p,d}=make(),combo=p.resolve({head:"nod",face:"smile"});const first=d.play(combo,{priority:30,reason:"cue"});d.compose(100);
  const second=d.play(p.actions.nod!,{priority:50,reason:"action"});d.compose(2000);d.commitFrame();
  expect((await first).interruptedAxes).toEqual(["head.pitch"]);await second;
});
it("a pose change under an action continues below it and becomes visible on exit",async()=>{
  const {p,d}=make();const done=d.play(p.actions.nod!,{priority:50,reason:"action"});d.compose(200);d.setPose({"head.pitch":2},200);
  d.compose(400);expect(d.getBaseline()["head.pitch"]).toBe(2);d.compose(1000);d.commitFrame();await done;
  expect(d.frame["head.pitch"]).toBe(2);
});
