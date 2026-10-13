import type { BodyAffordance, BodyState } from "../../../../src/extensions/world-framework/seams.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { ExternalSettlementSummary } from "../external-actions.js";
/** Live2D 内部线程 seam：数据可克隆，行为引用留在主线程 adapter。 */
export interface EngineCalls {
	start: { args: undefined; result: null };
	stop: { args: undefined; result: null };
	express: { args: Record<string, unknown>; result: ToolExecutionResult };
	state: { args: Record<string, unknown>; result: ToolExecutionResult };
	costume: { args: Record<string, unknown>; result: ToolExecutionResult };
	reload: { args: undefined; result: ToolExecutionResult };
	prepareBody: { args: undefined; result: ToolExecutionResult };
	formatStatus: { args: undefined; result: string };
	diagnose: { args: undefined; result: string };
	"endpoint.safeStop": { args: undefined; result: null };
	"endpoint.resume": { args: undefined; result: null };
}
export interface EngineFires {
	"endpoint.emitCue": { cueId: string };
	"endpoint.interrupt": undefined;
	"endpoint.onFocus": { focused: boolean };
	"level.process": { rms: number; peak?: number };
	"level.reset": undefined;
}
export type EngineOp = keyof EngineCalls;
export type EngineFireOp = keyof EngineFires;
export type EngineCall<K extends EngineOp = EngineOp> = {
	t: "call";
	id: number;
	op: K;
	args: EngineCalls[K]["args"];
	signalId?: string;
};
export type EngineFire<K extends EngineFireOp = EngineFireOp> = { t: "fire"; op: K; args: EngineFires[K] };
export type MainToEngine =
	| { [K in EngineOp]: EngineCall<K> }[EngineOp]
	| { [K in EngineFireOp]: EngineFire<K> }[EngineFireOp]
	| { t: "hostEvent"; event: { type: string; channel?: string } }
	| { t: "abort"; signalId: string }
	| { t: "worldAbort"; reason: string };
export interface WireError {
	name: string;
	message: string;
	reason?: string;
	cleanup?: ExternalSettlementSummary;
	causes?: readonly WireError[];
}
export type EngineToMain =
	| { [K in EngineOp]: { t: "result"; id: number; op: K; ok: true; value: EngineCalls[K]["result"] } }[EngineOp]
	| { t: "result"; id: number; op: EngineOp; ok: false; error: WireError }
	| { t: "exposed"; name: string }
	| { t: "unexposed"; name: string }
	| { t: "sync"; state: BodyState; affordance: BodyAffordance };
export function serializeError(cause: unknown): WireError {
	const error = cause instanceof Error ? cause : new Error(String(cause));
	const facts = error as Error & { reason?: string; cleanup?: ExternalSettlementSummary };
	return {
		name: error.name,
		message: error.message,
		...(facts.reason ? { reason: facts.reason } : {}),
		...(facts.cleanup ? { cleanup: facts.cleanup } : {}),
		...(error instanceof AggregateError ? { causes: error.errors.map(serializeError) } : {}),
	};
}
export function deserializeError(error: WireError): Error {
	return Object.assign(
		error.causes ? new AggregateError(error.causes.map(deserializeError), error.message) : new Error(error.message),
		{
			name: error.name,
			...(error.reason ? { reason: error.reason } : {}),
			...(error.cleanup ? { cleanup: error.cleanup } : {}),
		},
	);
}
