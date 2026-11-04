/** 离线 Program 校验：与在线 ProgramPort 共用同一 worker compile 路径，不写第二套编译器（v3 §4）。 */
import { Worker } from "node:worker_threads";
import type { ProgramValidation, ResolvedProgram } from "../contracts/program.js";
import { programError } from "../library/program-source.js";
import type { ProgramWorkerMessage, ProgramWorkerRequest } from "./wire.js";

export interface ProgramValidator {
	validate(program: ResolvedProgram): Promise<ProgramValidation>;
	close(): Promise<void>;
}

export function createProgramValidator(): ProgramValidator {
	let worker: Worker | null = null;
	let closed = false;
	let next = 0;
	const pending = new Map<number, { resolve(value: ProgramValidation): void; reject(error: Error): void }>();
	const failAll = (reason: string): void => {
		worker = null;
		for (const q of pending.values())
			q.reject(programError("PROGRAM_RETIRED", `program validator unavailable: ${reason}`));
		pending.clear();
	};
	function spawn(): Promise<Worker> {
		const file = import.meta.url.endsWith(".js") ? "./worker-entry.js" : "./worker-entry.ts";
		const w = new Worker(new URL(file, import.meta.url), { execArgv: [] });
		return new Promise<Worker>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				void w.terminate();
				reject(new Error("program validator startup timed out"));
			}, 10_000);
			const onMessage = (msg: ProgramWorkerMessage) => {
				if (msg.type !== "ready") return;
				cleanup();
				resolve(w);
			};
			const onFailure = (cause: unknown) => {
				cleanup();
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			};
			const cleanup = () => {
				clearTimeout(timer);
				w.off("message", onMessage);
				w.off("error", onFailure);
				w.off("exit", onFailure);
			};
			w.on("message", onMessage);
			w.on("error", onFailure);
			w.on("exit", onFailure);
		});
	}
	async function ensure(): Promise<Worker> {
		if (closed) programError("PROGRAM_RETIRED", "program validator is closed");
		if (!worker) {
			const w = await spawn();
			w.on("message", (msg: ProgramWorkerMessage) => {
				if (msg.type !== "compiled") return;
				const pendingCompile = pending.get(msg.id);
				pending.delete(msg.id);
				pendingCompile?.resolve(msg.result);
			});
			// 就绪后的故障：拒掉在途编译并复位，下次 validate 重新拉起。
			w.on("error", (error: Error) => {
				if (worker === w) failAll(error.message);
			});
			w.on("exit", (code: number) => {
				if (worker === w) failAll(`worker exited ${code}`);
			});
			worker = w;
		}
		return worker;
	}
	return {
		validate: async (program) => {
			const w = await ensure();
			const id = ++next;
			return new Promise<ProgramValidation>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				w.postMessage({
					type: "compile",
					id,
					source: program.source,
					digest: program.digest,
				} satisfies ProgramWorkerRequest);
			});
		},
		close: async () => {
			if (closed) return;
			closed = true;
			const w = worker;
			failAll("validator closed");
			await w?.terminate();
		},
	};
}
