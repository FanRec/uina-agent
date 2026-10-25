import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import type {
	ProgramPort,
	ProgramSegmentScope,
	ProgramHostApi,
	ProgramCapacity,
	ProgramValidation,
	InvokeResult,
	ResolvedProgram,
} from "../contracts/program.js";
import { parseProgramSource, programError, validateProgramName } from "../library/program-source.js";
import { PROGRAM_POLICY as P } from "./policy.js";
import type { ProgramWorkerRequest, ProgramWorkerMessage } from "./wire.js";

interface Active {
	run: string;
	segment: string;
	call: string;
	host: ProgramHostApi;
	cancel: Int32Array;
	signal: AbortSignal;
	detach(): void;
	resolve(value: InvokeResult): void;
	pending: Map<number, string>;
	compute: number;
	since: number;
	retiring: boolean;
	telemetry: Promise<void>;
	idle: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
export interface ProgramOptions {
	dataRoot: string;
	loadProgram(name: string): Promise<ResolvedProgram>;
	/** Synchronously seal affected Runtime admissions before Worker retirement starts. */
	onWorkerFault?: (calls: string[], reason: string) => void;
	onChanged?: () => void;
}
export async function createProgram(options: ProgramOptions): Promise<ProgramPort> {
	const active = new Map<number, Active>();
	const compiles = new Map<number, { resolve(value: ProgramValidation): void; reject(error: Error): void }>();
	let next = 0,
		closed = false,
		worker: Worker | null = null,
		retiring: Promise<void> | null = null;
	let ready: Promise<void>;
	const resultFailure = (code: string, message: string, scope: "call" | "worker" = "call"): InvokeResult => ({
		kind: "failed",
		failure: { code, message, scope, source: "program" },
	});
	function send(msg: ProgramWorkerRequest): void {
		if (!worker) throw new Error("Program worker unavailable");
		worker.postMessage(msg);
	}
	async function settle(id: number, result: InvokeResult): Promise<void> {
		const a = active.get(id);
		if (!a) return;
		a.detach();
		clearTimeout(a.timer);
		await a.telemetry;
		active.delete(id);
		a.resolve(result);
		options.onChanged?.();
	}
	function abort(id: number): void {
		const a = active.get(id);
		if (!a || a.retiring) return;
		a.retiring = true;
		Atomics.store(a.cancel, 0, 1);
		worker?.postMessage({ type: "cancel", id } satisfies ProgramWorkerRequest);
		// Interrupts normally acknowledge in one burst. A missing disposal acknowledgement is a Worker fault.
		a.timer = setTimeout(() => void fault("guest did not acknowledge retirement"), P.retireGraceMs);
	}
	async function fault(reason: string): Promise<void> {
		if (retiring) return retiring;
		const old = worker;
		worker = null;
		const affected = [...active.entries()];
		const cancelledBeforeFault = new Set(affected.filter(([, a]) => a.signal.aborted).map(([id]) => id));
		options.onWorkerFault?.(
			affected.map(([, a]) => a.call),
			reason,
		);
		retiring = (async () => {
			for (const a of active.values()) {
				Atomics.store(a.cancel, 0, 1);
				a.retiring = true;
			}
			for (const q of compiles.values()) q.reject(new Error(`Program worker failed: ${reason}`));
			compiles.clear();
			if (old) await old.terminate();
			for (const [id] of affected)
				await settle(id, resultFailure(cancelledBeforeFault.has(id) ? "CANCELLED" : "PROGRAM_CRASH", reason, "worker"));
		})();
		await retiring;
		retiring = null;
	}
	function spawn(): Promise<void> {
		const file = import.meta.url.endsWith(".js") ? "./worker-entry.js" : "./worker-entry.ts";
		const w = new Worker(new URL(file, import.meta.url), { execArgv: [] });
		worker = w;
		return new Promise<void>((resolve, reject) => {
			let started = false;
			w.on("message", (msg: ProgramWorkerMessage) => {
				if (worker !== w) return;
				if (msg.type === "ready") {
					started = true;
					resolve();
					return;
				}
				if (msg.type === "fatal") {
					void fault(msg.failure.message);
					return;
				}
				if (msg.type === "compiled") {
					compiles.get(msg.id)?.resolve(msg.result);
					compiles.delete(msg.id);
					return;
				}
				const a = active.get(msg.id);
				if (!a) return;
				if (msg.type === "result") {
					void settle(msg.id, msg.result);
					return;
				}
				if (msg.type === "telemetry") {
					a.compute = msg.computeTotalMs;
					a.idle = msg.idle;
					options.onChanged?.();
					a.telemetry = a.telemetry
						.then(async () => {
							if (msg.progress != null)
								await a.host.progress({ value: msg.progress as import("../contracts/values.js").Progress });
							for (const text of msg.logs) await a.host.log({ level: "log", text });
						})
						.catch(() => abort(msg.id))
						.finally(() => {
							if (worker === w && active.get(msg.id) === a) send({ type: "telemetry_ack", id: msg.id });
						});
					return;
				}
				if (a.retiring || a.signal.aborted) return;
				const allowed = ["call", "read", "sleep", "acquireBody", "releaseBody", "handleOp", "closeHandle"] as const;
				const method = allowed.find((m) => m === msg.method);
				if (!method) {
					abort(msg.id);
					return;
				}
				a.pending.set(msg.rpc, method);
				a.idle = false;
				a.since = performance.now();
				options.onChanged?.();
				const invoke = a.host[method] as (args: JsonValue) => Promise<unknown>;
				void Promise.resolve()
					.then(() => invoke(msg.args))
					.then((value) => {
						const json = plain(value);
						if (Buffer.byteLength(JSON.stringify(json)) > P.maxValueBytes)
							throw Object.assign(new Error("host value exceeds 1 MiB"), { code: "PROGRAM_VALUE" });
						return { ok: true as const, value: json };
					})
					.catch((error: unknown) => {
						const e = error as Error & Record<string, unknown>;
						return {
							ok: false as const,
							error: plain({
								code: e.code ?? "PROGRAM_ERROR",
								source: e.source ?? "program",
								message: e.message ?? String(e),
								dispatch: e.dispatch ?? "not_sent",
								effects: e.effects ?? [],
								recoverable: e.recoverable ?? false,
								...(e.hint ? { hint: e.hint } : {}),
								...(e.progress ? { progress: e.progress } : {}),
							}),
						};
					})
					.then((reply) => {
						a.pending.delete(msg.rpc);
						a.since = performance.now();
						options.onChanged?.();
						if (active.get(msg.id) !== a || a.retiring || a.signal.aborted || worker !== w) return;
						send({ type: "reply", id: msg.id, rpc: msg.rpc, reply });
					});
			});
			w.on("error", (err: Error) => {
				if (!started) reject(err);
				if (worker === w) void fault(err.message);
			});
			w.on("exit", (code) => {
				if (!started) reject(new Error(`Program worker exited ${code}`));
				if (worker === w) void fault(`Program worker exited ${code}`);
			});
		});
	}
	ready = spawn();
	await ready;
	async function ensure(): Promise<void> {
		if (closed) programError("PROGRAM_RETIRED", "Program service is closed");
		if (retiring) await retiring;
		if (!worker) ready = spawn();
		await ready;
	}
	function snapshotPath(run: string, digest: string): string {
		if (!/^[a-f0-9]{64}$/.test(digest)) programError("PROGRAM_INVALID", "invalid snapshot digest");
		return join(options.dataRoot, "runs", encodeURIComponent(run), "sources", `${digest}.js`);
	}
	const port: ProgramPort = {
		resolve: async (source) =>
			"code" in source ? parseProgramSource(source.code, null) : options.loadProgram(source.name),
		validate: async (program) => {
			await ensure();
			const id = ++next;
			return new Promise<ProgramValidation>((resolve, reject) => {
				compiles.set(id, { resolve, reject });
				send({ type: "compile", id, source: program.source, digest: program.digest });
			});
		},
		writeSnapshot: async ({ run, program }) => {
			const path = snapshotPath(run, program.digest);
			const { dirname } = await import("node:path");
			await mkdir(dirname(path), { recursive: true });
			try {
				const existing = await readFile(path, "utf8");
				if (existing !== program.source) programError("PROGRAM_CONFLICT", "snapshot digest has different bytes");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
				const temp = `${path}.${randomUUID()}.tmp`;
				try {
					await writeFile(temp, program.source, { flag: "wx" });
					await rename(temp, path);
				} finally {
					await rm(temp, { force: true });
				}
			}
			return { digest: program.digest, path };
		},
		readSnapshot: async ({ run, digest }) => {
			const path = snapshotPath(run, digest);
			try {
				const source = await readFile(path, "utf8");
				if (createHash("sha256").update(source).digest("hex") !== digest)
					programError("PROGRAM_CONFLICT", "snapshot bytes changed");
				return { source, path };
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw e;
			}
		},
		openSegment: (request) => {
			const cache = new Map<string, Promise<ResolvedProgram>>();
			if (request.entry?.name) cache.set(request.entry.name, Promise.resolve(request.entry));
			const controller = new AbortController();
			const cancelSegment = () => controller.abort();
			request.signal.addEventListener("abort", cancelSegment, { once: true });
			if (request.signal.aborted) controller.abort();
			const pending = new Set<Promise<InvokeResult>>();
			const scope: ProgramSegmentScope = {
				resolve: (name) => {
					if (controller.signal.aborted) return Promise.reject(new Error("program segment retired"));
					validateProgramName(name);
					const key = name.toLowerCase();
					let result = cache.get(key);
					if (!result) {
						result = port.resolve({ name });
						cache.set(key, result);
						void result.catch(() => cache.delete(key));
					}
					return result;
				},
				invoke: async (req) => {
					await ensure();
					if (controller.signal.aborted || req.signal.aborted)
						return resultFailure("CANCELLED", "program scope retired");
					if (Buffer.byteLength(JSON.stringify(req.input)) > P.maxValueBytes)
						return resultFailure("PROGRAM_VALUE", "input exceeds 1 MiB");
					if (active.size >= P.maxResidentGuests)
						return resultFailure("PROGRAM_CAPACITY", "32 resident guests are already active");
					const id = ++next,
						cancel = new Int32Array(new SharedArrayBuffer(4));
					const promise = new Promise<InvokeResult>((resolve) => {
						const stop = () => abort(id);
						active.set(id, {
							...request,
							call: req.call,
							host: req.host,
							cancel,
							signal: req.signal,
							resolve,
							pending: new Map(),
							detach: () => {
								req.signal.removeEventListener("abort", stop);
								controller.signal.removeEventListener("abort", stop);
							},
							compute: 0,
							since: performance.now(),
							retiring: false,
							telemetry: Promise.resolve(),
							idle: false,
						});
						req.signal.addEventListener("abort", stop, { once: true });
						controller.signal.addEventListener("abort", stop, { once: true });
						send({
							type: "invoke",
							id,
							source: req.program.source,
							filename: snapshotPath(request.run, req.program.digest),
							input: req.input,
							cancel: cancel.buffer as SharedArrayBuffer,
						});
					});
					pending.add(promise);
					options.onChanged?.();
					try {
						return await promise;
					} finally {
						pending.delete(promise);
					}
				},
				close: async () => {
					controller.abort();
					request.signal.removeEventListener("abort", cancelSegment);
					await Promise.all([...pending]);
					cache.clear();
					return { state: "retired", stoppedAt: new Date().toISOString() };
				},
			};
			return scope;
		},
		capacity: (): ProgramCapacity => ({
			observedAt: new Date().toISOString(),
			workerCount: worker ? 1 : 0,
			maxResidentGuests: P.maxResidentGuests,
			residentGuests: active.size,
			maxPendingRpcsPerGuest: P.maxPendingRpcsPerGuest,
			workers: worker ? [{ id: "worker:1", state: retiring ? "stopping" : "active", guests: active.size }] : [],
			calls: [...active.values()].map((a) => ({
				run: a.run,
				segment: a.segment,
				call: a.call,
				worker: "worker:1",
				state: a.retiring ? "retiring" : a.pending.size || a.idle ? "waiting" : "running",
				pendingRpcs: a.pending.size,
				idleMs: a.pending.size ? 0 : performance.now() - a.since,
				computeTotalMs: a.compute,
				...(a.pending.size || a.idle
					? {
							waiting: {
								kind:
									a.pending.size === 0
										? ("idle" as const)
										: [...a.pending.values()].every((v) => v === "sleep")
											? ("sleep" as const)
											: ("host_call" as const),
								method: [...a.pending.values()][0],
								sinceMs: a.since,
							},
						}
					: {}),
			})),
		}),
		close: async () => {
			if (closed) return;
			closed = true;
			await fault("Program service closed");
		},
	};
	return port;
}
