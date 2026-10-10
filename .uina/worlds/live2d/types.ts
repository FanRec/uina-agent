export type Live2DChannel = "mouth" | "eyes" | "gaze" | "head" | "torso";
export type SpeechPolicy = "blend" | "exclusive";
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
 return new Promise(resolve => { if(signal?.aborted) return resolve(); const abort=()=>{clearTimeout(timer);resolve();}; const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},ms); signal?.addEventListener("abort",abort,{once:true}); });
}
