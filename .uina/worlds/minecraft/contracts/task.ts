import type { RunSummary } from "./runtime.js";

export const taskHandle = (profileId: string, rootRequestId: string): string => `task:${profileId}:${rootRequestId}`;

export function taskView(task: string, snapshot: RunSummary) {
	return {
		task,
		revision: snapshot.revision,
		phase: snapshot.phase === "awaiting_decision" ? "needs_input" : snapshot.phase,
		control: snapshot.control,
		progress: snapshot.progress,
		progressComplete: snapshot.progressComplete,
		unknownEffectCount: snapshot.unknownEffectCount,
		unknownEffectsComplete: snapshot.unknownEffectsComplete,
		completionScope: snapshot.completion.scope,
		...(snapshot.phase === "waiting" ? { waiting: snapshot.waiting } : {}),
		...(snapshot.phase === "awaiting_decision" ? { decision: snapshot.decision, reason: snapshot.reason } : {}),
		...(snapshot.phase === "finished" ? { outcome: snapshot.outcome, error: snapshot.error } : {}),
	};
}
