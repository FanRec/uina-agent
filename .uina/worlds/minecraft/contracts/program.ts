/**
 * Program 执行合同与只读程序材料。
 *
 * 唯一定义来源：docs/proposals/mc/modules/program.md §7 与 library.md §5。
 * Library 文件管理合同归 library.ts；决策/等待/反馈按后续批次接入。
 */

import type { JsonValue } from "./values.js";
import type { ProgramHeader } from "./library.js";

/** 程序以 {name} 或 {code} 提交；Runtime 受理时解析成确切字节。 */
export type SourceRequest = { name: string } | { code: string };

/** Library 程序文件头解析出的可选契约与描述。 */
export interface ResolvedProgram {
	name: string | null;
	origin: "library" | "code";
	source: string;
	digest: string;
	header: ProgramHeader;
}
export interface SnapshotRef {
	digest: string;
	path: string;
}
export interface HandleRef {
	handle: string;
	kind: "body" | "window" | "stream";
}
export interface ProgramDiagnostic {
	code: string;
	scope: "call" | "worker";
	source: import("./values.js").CallFailureData["source"];
	message: string;
	line?: number;
	column?: number;
	guestStack?: string[];
	consoleTail?: string[];
	hint?: string;
}
export type ProgramValidation =
	| { ok: true; digest: string }
	| {
			ok: false;
			code: "PROGRAM_INVALID";
			reason: "syntax" | "encoding" | "size" | "header";
			message: string;
			line?: number;
			column?: number;
	  };
export type InvokeResult =
	| { kind: "returned"; value: JsonValue }
	| {
			kind: "failed";
			failure: ProgramDiagnostic | import("./values.js").CallFailureData;
	  };
export type ProgramRetirement = { state: "retired"; stoppedAt: string } | { state: "unknown"; detail: string };
export interface ProgramHostApi {
	call(input: { selector: string; args: JsonValue; delegateBody?: boolean; handle?: string }): Promise<JsonValue>;
	read(input: { targets: Record<string, { ref: string; input?: JsonValue }> }): Promise<{
		values: Record<string, JsonValue>;
		versions: Record<string, string | null>;
		unknown: Record<string, string[]>;
	}>;
	sleep(input: { ms: number }): Promise<null>;
	progress(input: { value: import("./values.js").Progress }): Promise<null>;
	acquireBody(input: Record<string, never>): Promise<HandleRef>;
	releaseBody(input: { handle: string }): Promise<null>;
	handleOp(input: { handle: string; op: string; args: JsonValue }): Promise<JsonValue | HandleRef>;
	closeHandle(input: { handle: string }): Promise<null>;
	log(input: { level: "log" | "info" | "warn" | "error"; text: string }): Promise<null>;
}
export interface ProgramCapacity {
	observedAt: string;
	workerCount: number;
	maxResidentGuests: number;
	residentGuests: number;
	maxPendingRpcsPerGuest: number;
	workers: { id: string; state: "active" | "stopping" | "unknown"; guests: number }[];
	calls: {
		run: string;
		segment: string;
		call: string;
		worker: string;
		state: "running" | "waiting" | "retiring" | "unknown";
		pendingRpcs: number;
		waiting?: { kind: "host_call" | "world_change" | "sleep" | "idle"; method?: string; sinceMs: number };
		idleMs: number;
		computeTotalMs: number;
	}[];
}
export interface ProgramSegmentScope {
	resolve(name: string): Promise<ResolvedProgram>;
	invoke(request: {
		call: string;
		program: ResolvedProgram;
		input: JsonValue;
		checkpoint: JsonValue | null;
		host: ProgramHostApi;
		signal: AbortSignal;
	}): Promise<InvokeResult>;
	close(reason: "finished" | "decide" | "stop" | "failed"): Promise<ProgramRetirement>;
}
export interface ProgramPort {
	resolve(source: SourceRequest): Promise<ResolvedProgram>;
	validate(program: ResolvedProgram): Promise<ProgramValidation>;
	writeSnapshot(request: { run: string; program: ResolvedProgram }): Promise<SnapshotRef>;
	readSnapshot(request: { run: string; digest: string }): Promise<{ source: string; path: string } | null>;
	openSegment(request: {
		run: string;
		segment: string;
		entry?: ResolvedProgram;
		signal: AbortSignal;
	}): ProgramSegmentScope;
	capacity(): ProgramCapacity;
	close(): Promise<void>;
}
