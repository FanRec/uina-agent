import type { InvokeResult, ProgramDiagnostic, ProgramValidation } from "../contracts/program.js";
import type { DecisionRequest, JsonValue } from "../contracts/values.js";
export type WireDecision =
	| { kind: "local"; reason: string; checkpoint?: JsonValue }
	| { kind: "host"; request: DecisionRequest };
export type WorkerInvokeResult =
	| Exclude<InvokeResult, { kind: "decision" }>
	| { kind: "decision"; decision: WireDecision };
export type HostReply =
	| { ok: true; value: JsonValue }
	| { ok: false; error: JsonValue }
	| { ok: false; decision: DecisionRequest };
export type ProgramWorkerRequest =
	| { type: "compile"; id: number; source: string; digest: string }
	| {
			type: "invoke";
			id: number;
			source: string;
			filename: string;
			input: JsonValue;
			checkpoint: JsonValue | null;
			cancel: SharedArrayBuffer;
	  }
	| { type: "reply"; id: number; rpc: number; reply: HostReply }
	| { type: "cancel"; id: number }
	| { type: "telemetry_ack"; id: number };
export type ProgramWorkerMessage =
	| { type: "ready" }
	| { type: "compiled"; id: number; result: ProgramValidation }
	| { type: "rpc"; id: number; rpc: number; method: string; args: JsonValue }
	| {
			type: "telemetry";
			id: number;
			progress: JsonValue | null;
			logs: string[];
			pendingRpcs: number;
			computeTotalMs: number;
			idle: boolean;
	  }
	| { type: "result"; id: number; result: WorkerInvokeResult }
	| { type: "fatal"; failure: ProgramDiagnostic };
