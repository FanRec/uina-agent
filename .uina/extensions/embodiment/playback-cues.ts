import type { ExtractedCue } from "./types.js";

export const CUE_DISPATCH_SHARED = "embodiment.cue-dispatch";
export const CUE_PLAYBACK_OWNER_SHARED = "voice.cue-playback-owner";
export interface CueDispatcher {
	dispatch(cue: ExtractedCue): void;
}
export interface CuePlaybackOwner {
	ownsOutput(event?: object): boolean;
}

/** Both consumers make the same decision even when an earlier handler changes voice health. */
export function createCueOutputOwnership(eligible: () => boolean): CuePlaybackOwner {
	const decisions = new WeakMap<object, boolean>();
	return {
		ownsOutput(event) {
			if (!event) return eligible();
			const previous = decisions.get(event);
			if (previous !== undefined) return previous;
			const owned = eligible();
			decisions.set(event, owned);
			return owned;
		},
	};
}
