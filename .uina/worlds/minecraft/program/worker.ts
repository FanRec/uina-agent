/** One event-loop turn per guest job; each guest has an independent QuickJS runtime. */
import { parentPort } from "node:worker_threads";
import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSRuntime,
} from "quickjs-emscripten";
import type { ProgramDiagnostic } from "../contracts/program.js";
import type { JsonValue } from "../contracts/values.js";
import { PROGRAM_POLICY as P } from "./policy.js";
import { SHIM } from "./shim.js";
import type { ProgramWorkerMessage, ProgramWorkerRequest, WireDecision, WorkerInvokeResult } from "./wire.js";

if (!parentPort) throw new Error("Program worker requires parentPort");
const port = parentPort;
const send = (msg: ProgramWorkerMessage) => port.postMessage(msg);
const module = await getQuickJS();
interface Guest {
	id: number;
	parseJson: QuickJSHandle;
	runtime: QuickJSRuntime;
	ctx: QuickJSContext;
	cancel: Int32Array;
	deadline: number;
	computeTotalMs: number;
	interrupted: boolean;
	result: QuickJSHandle | null;
	shim: QuickJSHandle | null;
	shimFactory: QuickJSHandle;
	rpcs: Map<number, QuickJSDeferredPromise>;
	nextRpc: number;
	console: string[];
	telemetryCredit: boolean;
	progress: JsonValue | null;
	logs: string[];
	lastTelemetry: number;
}
const guests = new Map<number, Guest>();
function failure(code: string, message: string): ProgramDiagnostic {
	return { code, scope: "call", source: "program", message };
}
function create(id: number, cancel = new SharedArrayBuffer(4)): Guest {
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(P.guestMemoryBytes);
	runtime.setMaxStackSize(512 * 1024);
	runtime.setModuleLoader(() => {
		throw new Error("module imports are not supported");
	});
	const ctx = runtime.newContext();
	const json = ctx.getProp(ctx.global, "JSON");
	const parseJson = ctx.getProp(json, "parse");
	json.dispose();
	// No host function or capability is reachable while evaluating user declarations.
	const shimFactory = ctx.unwrapResult(ctx.evalCode(SHIM, "uina-shim.js", { type: "global" }));
	const g: Guest = {
		id,
		runtime,
		ctx,
		parseJson,
		cancel: new Int32Array(cancel),
		deadline: 0,
		computeTotalMs: 0,
		interrupted: false,
		result: null,
		shim: null,
		shimFactory,
		rpcs: new Map(),
		nextRpc: 0,
		console: [],
		telemetryCredit: true,
		progress: null,
		logs: [],
		lastTelemetry: 0,
	};
	runtime.setInterruptHandler(() => {
		const stop = Atomics.load(g.cancel, 0) !== 0 || performance.now() > g.deadline;
		if (stop) g.interrupted = true;
		return stop;
	});
	return g;
}
function begin(g: Guest): number {
	const start = performance.now();
	g.deadline = start + P.computeBurstMs;
	g.interrupted = false;
	return start;
}
function checkMemory(g: Guest): void {
	// 0.32.0's Emscripten realloc accounting undercounts growing arrays. Inspect the
	// actual managed heap at each yield in addition to the engine allocator limit.
	const usage = g.runtime.computeMemoryUsage();
	try {
		const actual = g.ctx.dump(usage) as { memory_used_size?: number };
		if ((actual.memory_used_size ?? 0) > P.guestMemoryBytes)
			throw failure("PROGRAM_MEMORY", "managed heap exceeded 32 MiB");
	} finally {
		usage.dispose();
	}
}
function readError(
	g: Guest,
	handle: QuickJSHandle,
): ProgramDiagnostic | import("../contracts/values.js").CallFailureData {
	if (Atomics.load(g.cancel, 0)) return failure("CANCELLED", "program cancelled");
	if (g.interrupted)
		return failure("PROGRAM_TIMEOUT", "continuous computation exceeded its burst budget; yield with mc.sleep(0)");
	if (g.shim) {
		const fn = g.ctx.getProp(g.shim, "errorData");
		const r = g.ctx.callFunction(fn, g.ctx.undefined, handle);
		fn.dispose();
		if (!r.error) {
			const data = JSON.parse(g.ctx.getString(r.value));
			r.value.dispose();
			if (data.source === "program" && /out of memory|stack overflow/i.test(data.message)) data.code = "PROGRAM_MEMORY";
			const location = (data.guestStack ?? []).join("\n").match(/\.js:(\d+)(?::(\d+))?/);
			if (location) {
				data.line = Number(location[1]);
				if (location[2]) data.column = Number(location[2]);
			}
			return data;
		}
		r.error.dispose();
	}
	const raw = g.ctx.dump(handle) as { message?: string; stack?: string; name?: string };
	return {
		...failure(/memory/i.test(raw.message ?? "") ? "PROGRAM_MEMORY" : "PROGRAM_ERROR", raw.message ?? String(raw)),
		guestStack: raw.stack?.split("\n").slice(0, 12),
	};
}
function dispose(g: Guest): void {
	for (const d of g.rpcs.values()) d.dispose();
	g.rpcs.clear();
	g.result?.dispose();
	g.shim?.dispose();
	g.shimFactory.dispose();
	g.parseJson.dispose();
	g.ctx.dispose();
	g.runtime.dispose();
	guests.delete(g.id);
}
function injectJson(g: Guest, value: unknown): QuickJSHandle {
	const text = g.ctx.newString(JSON.stringify(value));
	const result = g.ctx.callFunction(g.parseJson, g.ctx.undefined, text);
	text.dispose();
	return g.ctx.unwrapResult(result);
}
function flush(g: Guest, final = false): void {
	if (!g.shim) return;
	const fn = g.ctx.getProp(g.shim, "flush");
	const r = g.ctx.callFunction(fn, g.ctx.undefined);
	fn.dispose();
	if (r.error) {
		const f = readError(g, r.error);
		r.error.dispose();
		throw f;
	}
	const data = JSON.parse(g.ctx.getString(r.value)) as { progress: JsonValue | null; logs: string[] };
	r.value.dispose();
	if (data.progress !== null && Buffer.byteLength(JSON.stringify(data.progress)) > P.maxValueBytes)
		throw failure("PROGRAM_VALUE", "progress exceeds 1 MiB");
	for (const line of data.logs) g.console.push(line);
	while (Buffer.byteLength(g.console.join("\n")) > P.consoleBytes && g.console.length) g.console.shift();
	if (data.progress !== null) g.progress = data.progress;
	g.logs.push(...data.logs);
	while (Buffer.byteLength(g.logs.join("\n")) > P.consoleBytes && g.logs.length) g.logs.shift();
	if (
		!final &&
		(!g.telemetryCredit || (g.progress === null && !g.logs.length && performance.now() - g.lastTelemetry < 100))
	)
		return;
	g.telemetryCredit = false;
	g.lastTelemetry = performance.now();
	send({
		type: "telemetry",
		id: g.id,
		progress: g.progress,
		logs: g.logs,
		pendingRpcs: g.rpcs.size,
		computeTotalMs: g.computeTotalMs,
		idle: g.result !== null && !g.runtime.hasPendingJob() && g.rpcs.size === 0,
	});
	g.progress = null;
	g.logs = [];
}
function thrownResult(g: Guest, handle: QuickJSHandle): WorkerInvokeResult {
	if (g.shim && !g.interrupted && !Atomics.load(g.cancel, 0)) {
		const fn = g.ctx.getProp(g.shim, "decisionData");
		const result = g.ctx.callFunction(fn, g.ctx.undefined, handle);
		fn.dispose();
		if (!result.error) {
			const text = g.ctx.typeof(result.value) === "string" ? g.ctx.getString(result.value) : null;
			result.value.dispose();
			if (text !== null) {
				if (Buffer.byteLength(text) > P.maxValueBytes)
					return { kind: "failed", failure: failure("PROGRAM_VALUE", "decision exceeds 1 MiB") };
				return { kind: "decision", decision: JSON.parse(text) as WireDecision };
			}
		} else result.error.dispose();
	}
	return { kind: "failed", failure: readError(g, handle) };
}
function finish(g: Guest, result: WorkerInvokeResult): void {
	// Flush at most one final batch behind the one outstanding acknowledged batch.
	if (g.shim && (g.progress !== null || g.logs.length)) flush(g, true);
	if (result.kind === "failed") result.failure = { ...result.failure, consoleTail: [...g.console] };
	dispose(g); // result is emitted only after all guest handles/runtime have actually been disposed.
	send({ type: "result", id: g.id, result });
}
function checkedValue(g: Guest, handle: QuickJSHandle): JsonValue {
	const fn = g.ctx.getProp(g.shim!, "encode");
	const r = g.ctx.callFunction(fn, g.ctx.undefined, handle, g.ctx.true);
	fn.dispose();
	if (r.error) {
		const error = readError(g, r.error);
		r.error.dispose();
		throw error;
	}
	const text = g.ctx.getString(r.value);
	r.value.dispose();
	if (Buffer.byteLength(text) > P.maxValueBytes) throw failure("PROGRAM_VALUE", "JSON exceeds 1 MiB");
	return JSON.parse(text) as JsonValue;
}
function start(msg: Extract<ProgramWorkerRequest, { type: "invoke" }>): void {
	const g = create(msg.id, msg.cancel);
	guests.set(g.id, g);
	const startAt = begin(g);
	try {
		const evaluated = g.ctx.evalCode(msg.source, msg.filename, { type: "global" });
		if (evaluated.error) {
			const f = readError(g, evaluated.error);
			evaluated.error.dispose();
			finish(g, { kind: "failed", failure: f });
			return;
		}
		evaluated.value.dispose();
		const main = g.ctx.getProp(g.ctx.global, "main");
		if (g.ctx.typeof(main) !== "function") {
			main.dispose();
			finish(g, { kind: "failed", failure: failure("PROGRAM_INVALID", "expected function main(mc, input)") });
			return;
		}
		const post = g.ctx.newFunction("__uinaPost", (methodHandle, argsHandle) => {
			if (g.rpcs.size >= P.maxPendingRpcsPerGuest)
				return { error: g.ctx.newError({ name: "PROGRAM_CAPACITY", message: "too many pending host RPCs" }) };
			const method = g.ctx.getString(methodHandle),
				text = g.ctx.getString(argsHandle);
			if (Buffer.byteLength(text) > P.maxValueBytes)
				return { error: g.ctx.newError({ name: "PROGRAM_VALUE", message: "JSON exceeds 1 MiB" }) };
			const rpc = ++g.nextRpc,
				d = g.ctx.newPromise();
			g.rpcs.set(rpc, d);
			send({ type: "rpc", id: g.id, rpc, method, args: JSON.parse(text) as JsonValue });
			return d.handle;
		});
		const now = g.ctx.newFunction("__uinaNow", () => g.ctx.newNumber(performance.now()));
		const checkpoint = injectJson(g, msg.checkpoint);
		g.shim = g.ctx.unwrapResult(g.ctx.callFunction(g.shimFactory, g.ctx.undefined, post, now, checkpoint));
		post.dispose();
		now.dispose();
		checkpoint.dispose();
		const mc = g.ctx.getProp(g.shim, "mc");
		const input = injectJson(g, msg.input);
		const result = g.ctx.callFunction(main, g.ctx.undefined, mc, input);
		main.dispose();
		mc.dispose();
		input.dispose();
		if (result.error) {
			const outcome = thrownResult(g, result.error);
			result.error.dispose();
			if (
				!g.interrupted &&
				!Atomics.load(g.cancel, 0) &&
				(outcome.kind !== "failed" || outcome.failure.code !== "PROGRAM_MEMORY")
			)
				flush(g);
			finish(g, outcome);
			return;
		}
		g.result = result.value;
		g.computeTotalMs += performance.now() - startAt;
		checkMemory(g);
		flush(g);
		check(g);
		schedule();
	} catch (err) {
		if (guests.has(g.id))
			finish(g, {
				kind: "failed",
				failure:
					err && typeof err === "object" && "code" in err
						? (err as ProgramDiagnostic)
						: failure("PROGRAM_ERROR", String(err)),
			});
	}
}
function check(g: Guest): void {
	if (!g.result) return;
	const state = g.ctx.getPromiseState(g.result);
	if (state.type === "pending") return;
	if (state.type === "fulfilled") {
		try {
			const value = checkedValue(g, state.value);
			state.value.dispose();
			flush(g);
			finish(g, { kind: "returned", value });
		} catch (err) {
			if (state.value.alive) state.value.dispose();
			finish(g, { kind: "failed", failure: err as ProgramDiagnostic });
		}
	} else {
		const outcome = thrownResult(g, state.error);
		state.error.dispose();
		flush(g);
		finish(g, outcome);
	}
}
let scheduled = false;
function schedule(): void {
	if (scheduled || ![...guests.values()].some((g) => g.runtime.hasPendingJob())) return;
	scheduled = true;
	setImmediate(() => {
		scheduled = false;
		for (const g of [...guests.values()]) {
			const t = begin(g);
			try {
				if (Atomics.load(g.cancel, 0)) {
					finish(g, { kind: "failed", failure: failure("CANCELLED", "program cancelled") });
					continue;
				}
				const job = g.runtime.executePendingJobs(1);
				g.computeTotalMs += performance.now() - t;
				if (job.error) {
					const outcome = thrownResult(g, job.error);
					job.error.dispose();
					finish(g, outcome);
					continue;
				}
				checkMemory(g);
				flush(g);
				check(g);
			} catch (err) {
				if (guests.has(g.id)) finish(g, { kind: "failed", failure: err as ProgramDiagnostic });
			}
		}
		schedule();
	});
}
port.on("message", (msg: ProgramWorkerRequest) => {
	if (msg.type === "compile") {
		const g = create(-1);
		begin(g);
		const result = g.ctx.evalCode(msg.source, "program.js", { type: "global", compileOnly: true });
		if (result.error) {
			const f = readError(g, result.error);
			result.error.dispose();
			send({
				type: "compiled",
				id: msg.id,
				result: { ok: false, code: "PROGRAM_INVALID", reason: "syntax", message: f.message },
			});
		} else {
			result.value.dispose();
			send({ type: "compiled", id: msg.id, result: { ok: true, digest: msg.digest } });
		}
		dispose(g);
		return;
	}
	if (msg.type === "invoke") {
		start(msg);
		return;
	}
	const g = guests.get(msg.id);
	if (!g) return;
	if (msg.type === "telemetry_ack") {
		g.telemetryCredit = true;
		return;
	}
	begin(g);
	if (msg.type === "cancel") {
		finish(g, { kind: "failed", failure: failure("CANCELLED", "program cancelled") });
		return;
	}
	const d = g.rpcs.get(msg.rpc);
	if (!d) return;
	g.rpcs.delete(msg.rpc);
	const reply =
		!msg.reply.ok && "decision" in msg.reply
			? { ok: false, decisionJson: JSON.stringify(msg.reply.decision) }
			: msg.reply;
	const value = injectJson(g, reply);
	d.resolve(value);
	value.dispose();
	d.dispose();
	schedule();
});
send({ type: "ready" });
