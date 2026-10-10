/** One render clock; both normal playback and author preview use Runtime.tick. */
export class VTSCompanion {
  private timer?:NodeJS.Timeout;
  private previous=0;
  constructor(private readonly render:(deltaMs:number)=>void) {}
  start():void {if(this.timer)return;this.previous=performance.now();this.timer=setInterval(()=>{const now=performance.now();const dt=now-this.previous;this.previous=now;this.render(dt);},1000/60);}
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
