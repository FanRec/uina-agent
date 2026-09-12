import type { AgentMessage, Model } from "./types.js";
/** Input data is an immutable snapshot. The runtime alone commits the resulting cut. */
export interface CompactionRequest {
	readonly reason: "manual" | "automatic";
	readonly history: readonly AgentMessage[];
	readonly suggestedKeepFrom: number;
	readonly tokensBefore: number;
	readonly model: Model;
	readonly instruction?: string;
}
export interface CompactionProposal {
	readonly summary: string;
	/** Index in request.history; history.length means keep no old messages. */
	readonly keepFrom: number;
}
/** undefined explicitly delegates to the default algorithm; errors never do. */
export type Compactor = (request: CompactionRequest, signal: AbortSignal) => Promise<CompactionProposal | undefined>;

/** A synchronous policy check: no network work on the turn preparation path. */
export interface CompactionCheck {
	readonly historyLength: number;
	readonly tokensBefore: number;
	readonly model: Model;
	readonly defaultDecision: boolean;
}
export type CompactionTrigger = (input: CompactionCheck) => boolean | undefined;
