import type { ModelPackage } from "./model-package.js";
/** Only audio is filtered. RMS response is explicitly authored by the selected model. */
export class AudioObserver {
  private level=0;
  private age=Infinity;
  private envelope=0;
  constructor(private readonly config:NonNullable<ModelPackage["speech"]>) {}
  processLevel(event:{rms:number;peak?:number}):void {this.level=Number.isFinite(event.rms)?Math.max(0,Math.min(1,event.rms)):0;this.age=0;}
  reset():void {this.level=0;this.age=Infinity;this.envelope=0;}
  tick(deltaMs:number):number {
    this.age+=deltaMs;const rms=this.age>this.config.staleMs?0:this.level;const points=this.config.points;
    let target=points.at(-1)![1];
    if(rms<=points[0]![0])target=points[0]![1];
    else for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!;if(rms<=b[0]){target=a[1]+(b[1]-a[1])*(rms-a[0])/(b[0]-a[0]);break;}}
    const tau=target>this.envelope?this.config.attackMs:this.config.releaseMs;
    this.envelope+=(target-this.envelope)*(1-Math.exp(-deltaMs/tau));return this.envelope;
  }
}
