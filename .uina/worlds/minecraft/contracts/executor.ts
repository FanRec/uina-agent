/** Executor/Companion wire values. Owner and execution facts stay with Runtime. */
import type { ControlRetirement, Origin, OwnerState } from "./runtime.js";
import type { JsonValue, Ref } from "./values.js";
import type { WorldAvailabilityValue } from "./world.js";

export interface ExecutorConfig {
	connection: { host: string; port: number; username: string; authMode: "offline"; version?: string };
	binding: { world: Ref; worldRevision: Ref } | null;
}

export interface CompanionInit {
	launch: Ref;
	origin: Origin;
	storageId: Ref;
	worldDataDir: string;
	config: ExecutorConfig;
	unclean: boolean;
	oldControlRetired: boolean;
	ownerLifetimeMs: number;
	localGates: ("disabled" | "emergency" | "owner_lost")[];
}

export type RetirementRequest = ControlRetirement & { launch: Ref };

export interface ExecutionSideStatus {
	launch: Ref;
	storageId: Ref;
	observedAt: string;
	authMode: "offline";
	owner: OwnerState | null;
	connection: "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	world: WorldAvailabilityValue;
	runtime: "ready" | "unavailable";
	safety: { active: null; last: null };
	program: import("./program.js").ProgramCapacity | null;
	faults: { code: string; message: string }[];
	retirement: RetirementRequest | null;
}

export interface WireError {
	code: string;
	message: string;
	failure?: JsonValue;
	detail?: JsonValue;
}

export interface GameNotice {
	ref: string;
	observedAt: string;
	payload: JsonValue;
}

export type ExecutorFrame =
	| { v: 1; launch: Ref; kind: "request"; id: number; method: string; payload: JsonValue }
	| {
			v: 1;
			launch: Ref;
			kind: "reply";
			id: number;
			method: string;
			result: { ok: true; value: JsonValue } | { ok: false; error: WireError };
	  }
	| { v: 1; launch: Ref; kind: "cancel_wait"; id: number }
	| { v: 1; launch: Ref; kind: "retire_required"; request: RetirementRequest }
	| {
			v: 1;
			launch: Ref;
			kind: "changed";
			runs: { run: Ref; revision: number }[];
			statusChanged: boolean;
			events?: GameNotice[];
	  };

export interface BootstrapHello {
	v: 1;
	kind: "hello";
	launch: Ref;
	pid: number;
	createdAt: string;
}
