import type { ExtractedCue } from "./types.js";

export const CUE_DISPATCH_SHARED = "embodiment.cue-dispatch";

export interface CueDispatcher {
	dispatch(cue: ExtractedCue): void;
}
