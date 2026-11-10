import { Worker } from "node:worker_threads";
import type { Entry, SubmissionLookup } from "../contracts/runtime.js";
import { RpcError } from "./ipc.js";
import type {
	DeliveryAttempt,
	LedgerRequest,
	LedgerSnapshot,
	RequestCredential,
	TaskRequestSelection,
} from "./ledger-worker.js";

export class ExecutorLedger {
	private readonly worker: Worker;
	private sequence = 0;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private closing = false;
	private fault: Error | null = null;
	private closePromise: Promise<void> | null = null;
	constructor() {
		this.worker = new Worker(
			new URL(import.meta.url.endsWith(".js") ? "./ledger-worker.js" : "./ledger-worker.ts", import.meta.url),
		);
		this.worker.on("message", (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(new RpcError("STORE_UNAVAILABLE", message.error ?? "ledger operation failed"));
		});
		this.worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
		this.worker.on("exit", (code) => {
			if (!this.closing || this.pending.size) this.fail(new Error(`executor ledger exited (${code})`));
		});
	}
	private fail(error: Error): void {
		this.fault = error;
		for (const item of this.pending.values()) item.reject(error);
		this.pending.clear();
	}
	private request(
		request: LedgerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never,
	): Promise<unknown> {
		const id = ++this.sequence;
		if (this.fault) return Promise.reject(this.fault);
		if (this.closing && request.op !== "close")
			return Promise.reject(new RpcError("STORE_UNAVAILABLE", "executor ledger is closing"));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.worker.postMessage({ ...request, id });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	async open(path: string, worldOwner: string, storageId: string): Promise<LedgerSnapshot> {
		return (await this.request({ op: "open", path, worldOwner, storageId })) as LedgerSnapshot;
	}
	async launch(launch: string, activation: string): Promise<void> {
		await this.request({ op: "launch", launch, activation } as Omit<Extract<LedgerRequest, { op: "launch" }>, "id">);
	}
	async runtimeCreated(): Promise<void> {
		await this.request({ op: "runtime_created" });
	}
	async setGate(gate: string, closed: boolean): Promise<void> {
		await this.request({ op: "gate", gate, closed } as Omit<Extract<LedgerRequest, { op: "gate" }>, "id">);
	}
	async clean(launch: string): Promise<void> {
		await this.request({ op: "clean", launch } as Omit<Extract<LedgerRequest, { op: "clean" }>, "id">);
	}
	async putRequest(credential: RequestCredential): Promise<void> {
		await this.request({ op: "request_put", credential });
	}
	async getRequest(requestId: string): Promise<RequestCredential | null> {
		return (await this.request({ op: "request_get", requestId })) as RequestCredential | null;
	}
	async taskEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		if (!ids.length) return new Map();
		return new Map((await this.request({ op: "request_entries", ids })) as [string, Entry][]);
	}
	async requests(selection: TaskRequestSelection): Promise<RequestCredential[]> {
		return (await this.request({ op: "request_list", selection })) as RequestCredential[];
	}
	async refuse(requestId: string, refusal: NonNullable<RequestCredential["refusal"]>): Promise<void> {
		await this.request({ op: "request_refused", requestId, refusal });
	}
	async found(requestId: string, lookup: Extract<SubmissionLookup, { kind: "found" }>): Promise<void> {
		await this.request({ op: "request_found", requestId, lookup });
	}
	async putAttempt(attempt: DeliveryAttempt): Promise<void> {
		await this.request({ op: "attempt_put", attempt });
	}
	async attempts(keys: string[]): Promise<ReadonlyMap<string, DeliveryAttempt>> {
		if (!keys.length) return new Map();
		return new Map((await this.request({ op: "attempt_list", keys })) as [string, DeliveryAttempt][]);
	}
	close(): Promise<void> {
		return (this.closePromise ??= (async () => {
			this.closing = true;
			try {
				await this.request({ op: "close" });
			} finally {
				await this.worker.terminate();
			}
		})());
	}
}
