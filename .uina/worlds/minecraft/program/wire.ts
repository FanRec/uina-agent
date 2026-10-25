import type { InvokeResult, ProgramDiagnostic, ProgramValidation } from "../contracts/program.js";
import type { JsonValue } from "../contracts/values.js";
export type ProgramWorkerRequest =
	| { type: "compile"; id: number; source: string; digest: string }
	| { type: "invoke"; id: number; source: string; filename: string; input: JsonValue; cancel: SharedArrayBuffer }
	| { type: "reply"; id: number; rpc: number; reply: { ok: true; value: JsonValue } | { ok: false; error: JsonValue } }
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
	| { type: "result"; id: number; result: InvokeResult }
	| { type: "fatal"; failure: ProgramDiagnostic };
