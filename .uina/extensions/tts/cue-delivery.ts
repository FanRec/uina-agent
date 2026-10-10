import type { ExtractedCue } from "../embodiment/types.js";

interface TraceCues {
	completedIndex: number;
	finalIndex?: number;
	delivered: Map<string, Set<number>>;
	trailing: Array<{ index: number; cues: ExtractedCue[] }>;
}

/** Tracks only local, live speech traces; cancellation removes their authority immediately. */
export class PlaybackCueDelivery {
	private readonly traces = new Map<string, TraceCues>();
	private currentTrace?: string;
	constructor(private readonly dispatch: (cue: ExtractedCue) => void) {}
	begin(trace: string): void {
		this.currentTrace = trace;
		this.prune();
		this.traces.set(trace, { completedIndex: 0, delivered: new Map(), trailing: [] });
	}
	end(trace: string, finalIndex: number): void {
		const state = this.traces.get(trace);
		if (state) state.finalIndex = finalIndex;
		this.prune();
	}
	cancel(trace: string): void {
		this.traces.delete(trace);
	}
	private prune(): void {
		for (const [trace, state] of this.traces) {
			if (trace !== this.currentTrace && state.finalIndex !== undefined && state.completedIndex >= state.finalIndex)
				this.traces.delete(trace);
		}
	}
	addTrailing(trace: string, index: number, cues: ExtractedCue[]): void {
		const state = this.traces.get(trace);
		if (!state || !cues.length) return;
		if (index === 0 || state.completedIndex >= index) for (const cue of cues) this.dispatch(cue);
		else state.trailing.push({ index, cues });
	}
	receive(event: {
		kind?: string;
		trace_id: string;
		task_id?: string;
		segment_index?: number;
		detail?: Record<string, unknown>;
	}): void {
		if (event.kind === "failed" || event.kind === "cancelled") {
			this.cancel(event.trace_id);
			return;
		}
		const state = this.traces.get(event.trace_id),
			detail = event.detail;
		if (!state || !detail) return;
		const segmentIndex = event.segment_index ?? 0;
		if (!Number.isInteger(segmentIndex) || segmentIndex <= 0) return;
		if (detail.playback_started === true && Array.isArray(detail.cues) && segmentIndex > state.completedIndex) {
			const key = event.task_id ?? String(segmentIndex);
			let seen = state.delivered.get(key);
			if (!seen) state.delivered.set(key, (seen = new Set()));
			for (const cue of detail.cues as Array<{ id?: unknown; target?: unknown; index?: unknown }>) {
				if (
					typeof cue.id !== "string" ||
					typeof cue.index !== "number" ||
					!Number.isInteger(cue.index) ||
					cue.index < 0 ||
					seen.has(cue.index)
				)
					continue;
				seen.add(cue.index);
				this.dispatch({ id: cue.id, target: typeof cue.target === "string" ? cue.target : undefined, rawTag: "" });
			}
		}
		if (detail.playback_completed === true) {
			state.completedIndex = Math.max(state.completedIndex, segmentIndex);
			state.delivered.delete(event.task_id ?? String(segmentIndex));
			const ready = state.trailing.filter((tail) => state.completedIndex >= tail.index);
			state.trailing = state.trailing.filter((tail) => state.completedIndex < tail.index);
			for (const tail of ready) for (const cue of tail.cues) this.dispatch(cue);
			this.prune();
		}
	}
	reset(): void {
		this.traces.clear();
		this.currentTrace = undefined;
	}
}
