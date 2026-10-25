import type { ExecutorFrame, WireError } from "../contracts/executor.js";
import type { JsonValue } from "../contracts/values.js";
import { methods, validateFrame, type RpcMethod } from "./protocol.js";

export interface WireEndpoint {
	send(value: JsonValue, done: (error: Error | null) => void): void;
	onMessage(listener: (value: unknown) => void): () => void;
	onDisconnect(listener: () => void): () => void;
}
export class RpcError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly dispatch: "not_sent" | "unknown" = "not_sent",
		public readonly failure?: JsonValue,
	) {
		super(message);
		this.name = "RpcError";
	}
}
interface Pending {
	method: RpcMethod;
	sent: boolean;
	wireId?: number;
	resolve(value: JsonValue): void;
	reject(error: Error): void;
	dispose(): void;
}
interface Outgoing {
	value: JsonValue;
	bytes: number;
	id?: number;
	dispatch?(): void;
}
export interface RpcPeerOptions {
	launch: string;
	endpoint: WireEndpoint;
	handleRequest?: (method: RpcMethod, payload: JsonValue, signal: AbortSignal) => unknown | Promise<unknown>;
	onNotification?: (frame: Extract<ExecutorFrame, { kind: "changed" | "retire_required" }>) => void;
	onFault?: (error: Error) => void;
	limits?: { frameBytes: number; queuedBytes: number };
}

function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value == null) return value === null;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	const valid = (Array.isArray(value) ? value : Object.values(value)).every((item) => jsonValue(item, seen));
	seen.delete(value);
	return valid;
}
function toWireError(error: unknown): WireError {
	const err = error as { code?: unknown; message?: unknown; source?: unknown };
	const failure =
		err?.source != null && jsonValue({ ...err, message: err.message })
			? ({ ...err, message: err.message } as JsonValue)
			: undefined;
	return {
		code: typeof err?.code === "string" ? err.code : "INTERNAL",
		message: typeof err?.message === "string" ? err.message : String(error),
		...(failure === undefined ? {} : { failure }),
	};
}

/** Per launch. One send callback in flight bounds bytes already handed to Node. */
export class RpcPeer {
	private readonly limits: { frameBytes: number; queuedBytes: number };
	private readonly pending = new Map<number, Pending>();
	private readonly running = new Map<number, { method: RpcMethod; abort: AbortController }>();
	private normal: Outgoing[] = [];
	private control: Outgoing[] = [];
	private queuedBytes = 0;
	private sending = false;
	private nextId = 0;
	private nextWireId = 0;
	private readonly wirePending = new Map<number, number>();
	private lastIncoming = 0;
	private closed = false;
	private readonly detach: (() => void)[];
	constructor(private readonly options: RpcPeerOptions) {
		this.limits = options.limits ?? { frameBytes: 8 * 1024 * 1024, queuedBytes: 16 * 1024 * 1024 };
		this.detach = [
			options.endpoint.onMessage((value) => this.receive(value)),
			options.endpoint.onDisconnect(() => this.fault("EXECUTOR_UNAVAILABLE", "private IPC disconnected")),
		];
	}

	call(
		method: RpcMethod,
		payload: unknown,
		options: { signal?: AbortSignal; timeoutMs?: number | null } = {},
	): Promise<JsonValue> {
		const spec = methods.get(method)!;
		if (this.closed) return Promise.reject(new RpcError("EXECUTOR_UNAVAILABLE", "private IPC is closed"));
		if (options.signal?.aborted)
			return Promise.reject(new RpcError("REQUEST_CANCELLED", "request cancelled before send"));
		if (!jsonValue(payload) || !spec.input(payload))
			return Promise.reject(new RpcError("INVALID_INPUT", `${method} arguments rejected`));
		const id = ++this.nextId;
		const frame: ExecutorFrame = { v: 1, launch: this.options.launch, kind: "request", id, method, payload };
		return new Promise((resolve, reject) => {
			const cancel = () => {
				const pending = this.pending.get(id);
				if (pending == null) return;
				this.removeQueued(id);
				this.finish(
					id,
					new RpcError("REQUEST_CANCELLED", "only this read/wait was cancelled", pending.sent ? "unknown" : "not_sent"),
				);
				if (pending.sent)
					this.enqueue({ v: 1, launch: this.options.launch, kind: "cancel_wait", id: pending.wireId! }, true);
			};
			const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
			const timer =
				timeoutMs === null
					? null
					: setTimeout(() => {
							const pending = this.pending.get(id);
							if (pending == null) return;
							this.removeQueued(id);
							this.finish(
								id,
								new RpcError("RPC_TIMEOUT", `${method} reply deadline elapsed`, pending.sent ? "unknown" : "not_sent"),
							);
							if (pending.sent && spec.cancellable)
								this.enqueue({ v: 1, launch: this.options.launch, kind: "cancel_wait", id: pending.wireId! }, true);
						}, timeoutMs);
			if (spec.cancellable) options.signal?.addEventListener("abort", cancel, { once: true });
			this.pending.set(id, {
				method,
				sent: false,
				resolve,
				reject,
				dispose: () => {
					if (timer) clearTimeout(timer);
					options.signal?.removeEventListener("abort", cancel);
				},
			});
			try {
				this.enqueue(
					frame,
					method === "shutdown" ||
						method === "runtime.heartbeat" ||
						method === "runtime.stop" ||
						method === "runtime.setOwnerGate",
					id,
					() => {
						const p = this.pending.get(id);
						frame.id = ++this.nextWireId;
						if (p) {
							p.sent = true;
							p.wireId = frame.id;
							this.wirePending.set(frame.id, id);
						}
					},
				);
			} catch (error) {
				this.finish(id, error as Error);
			}
		});
	}

	notify(frame: Extract<ExecutorFrame, { kind: "changed" | "retire_required" }>): void {
		if (!this.closed) this.enqueue(frame, frame.kind === "retire_required");
	}
	async drain(): Promise<void> {
		while (!this.closed && (this.sending || this.control.length || this.normal.length))
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const detach of this.detach) detach();
		for (const [id, pending] of this.pending)
			this.finish(
				id,
				new RpcError("EXECUTOR_UNAVAILABLE", "private IPC closed", pending.sent ? "unknown" : "not_sent"),
			);
		for (const item of this.running.values()) item.abort.abort();
		this.running.clear();
		this.normal = [];
		this.control = [];
		this.queuedBytes = 0;
	}
	private finish(id: number, error?: Error, value?: JsonValue): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.dispose();
		if (pending.wireId !== undefined) this.wirePending.delete(pending.wireId);
		if (error) pending.reject(error);
		else pending.resolve(value!);
	}
	private removeQueued(id: number): void {
		for (const name of ["normal", "control"] as const)
			this[name] = this[name].filter((item) => {
				if (item.id !== id) return true;
				this.queuedBytes -= item.bytes;
				return false;
			});
	}
	private enqueue(frame: ExecutorFrame, priority: boolean, id?: number, dispatch?: () => void): void {
		if (this.closed) throw new RpcError("EXECUTOR_UNAVAILABLE", "private IPC closed");
		const value = frame as unknown as JsonValue;
		const bytes = Buffer.byteLength(JSON.stringify(value));
		if (bytes > this.limits.frameBytes) throw new RpcError("REQUEST_TOO_LARGE", "IPC frame exceeds the byte budget");
		if (!priority && this.queuedBytes + bytes > this.limits.queuedBytes)
			throw new RpcError("TRANSPORT_BUSY", "IPC ordinary queue is full");
		(priority ? this.control : this.normal).push({ value, bytes, id, dispatch });
		this.queuedBytes += bytes;
		this.pump();
	}
	private pump(): void {
		if (this.sending || this.closed) return;
		const item = this.control.shift() ?? this.normal.shift();
		if (!item) return;
		this.sending = true;
		item.dispatch?.();
		try {
			this.options.endpoint.send(item.value, (error) => {
				this.sending = false;
				this.queuedBytes -= item.bytes;
				if (error) this.fault("EXECUTOR_UNAVAILABLE", error.message);
				else this.pump();
			});
		} catch (error) {
			this.sending = false;
			this.fault("EXECUTOR_UNAVAILABLE", String(error));
		}
	}
	private receive(value: unknown): void {
		if (this.closed) return;
		if (
			!jsonValue(value) ||
			Buffer.byteLength(JSON.stringify(value)) > this.limits.frameBytes ||
			!validateFrame(value)
		) {
			this.fault("PROTOCOL_ERROR", "invalid IPC frame");
			return;
		}
		const frame = value as unknown as ExecutorFrame;
		if (frame.launch !== this.options.launch) {
			this.fault("PROTOCOL_ERROR", "IPC launch mismatch");
			return;
		}
		if (frame.kind === "reply") {
			const localId = this.wirePending.get(frame.id);
			const pending = localId === undefined ? undefined : this.pending.get(localId);
			if (!pending) {
				if (frame.id > this.nextWireId) this.fault("PROTOCOL_ERROR", "reply for an unknown request");
				return;
			}
			if (
				pending.method !== frame.method ||
				(frame.result.ok && !methods.get(pending.method)!.output(frame.result.value))
			) {
				this.fault("PROTOCOL_ERROR", "reply method/result mismatch");
				return;
			}
			if (frame.result.ok) this.finish(localId!, undefined, frame.result.value);
			else
				this.finish(
					localId!,
					new RpcError(
						frame.result.error.code,
						frame.result.error.message,
						pending.sent ? "unknown" : "not_sent",
						frame.result.error.failure,
					),
				);
		} else if (frame.kind === "request") {
			const spec = methods.get(frame.method);
			if (!spec || frame.id <= this.lastIncoming || !this.options.handleRequest) {
				this.fault("PROTOCOL_ERROR", "invalid method/request sequence");
				return;
			}
			this.lastIncoming = frame.id;
			if (!spec.input(frame.payload)) {
				this.reply(frame, {
					ok: false,
					error: { code: "INVALID_INPUT", message: `${frame.method} arguments rejected` },
				});
				return;
			}
			const abort = new AbortController();
			this.running.set(frame.id, { method: frame.method as RpcMethod, abort });
			void this.invoke(frame, abort.signal);
		} else if (frame.kind === "cancel_wait") {
			const running = this.running.get(frame.id);
			if (running && methods.get(running.method)!.cancellable) running.abort.abort();
		} else {
			if (frame.kind === "retire_required" && frame.request.launch !== frame.launch) {
				this.fault("PROTOCOL_ERROR", "retirement launch mismatch");
				return;
			}
			this.options.onNotification?.(frame);
		}
	}
	private async invoke(frame: Extract<ExecutorFrame, { kind: "request" }>, signal: AbortSignal): Promise<void> {
		try {
			const raw = await this.options.handleRequest!(frame.method as RpcMethod, frame.payload, signal);
			const value = raw === undefined ? null : raw;
			if (!jsonValue(value) || !methods.get(frame.method)!.output(value))
				throw new RpcError("PROTOCOL_ERROR", `${frame.method} produced invalid result`);
			this.reply(frame, { ok: true, value });
		} catch (error) {
			this.reply(frame, { ok: false, error: toWireError(error) });
		} finally {
			this.running.delete(frame.id);
		}
	}
	private reply(
		frame: Extract<ExecutorFrame, { kind: "request" }>,
		result: Extract<ExecutorFrame, { kind: "reply" }>["result"],
	): void {
		if (this.closed) return;
		try {
			this.enqueue(
				{ v: 1, launch: frame.launch, kind: "reply", id: frame.id, method: frame.method, result },
				frame.method === "runtime.heartbeat" ||
					frame.method === "shutdown" ||
					frame.method === "runtime.setOwnerGate" ||
					frame.method === "runtime.stop",
			);
		} catch (error) {
			if ((error as RpcError).code === "REQUEST_TOO_LARGE" || (error as RpcError).code === "TRANSPORT_BUSY") {
				this.enqueue(
					{
						v: 1,
						launch: frame.launch,
						kind: "reply",
						id: frame.id,
						method: frame.method,
						result: {
							ok: false,
							error: {
								code: (error as RpcError).code === "REQUEST_TOO_LARGE" ? "QUERY_RESULT_TOO_LARGE" : "TRANSPORT_BUSY",
								message: "reply exceeds transport budget; narrow the query or read a smaller record",
							},
						},
					},
					true,
				);
			} else this.fault("PROTOCOL_ERROR", String(error));
		}
	}
	private fault(code: string, message: string): void {
		if (this.closed) return;
		for (const [id, pending] of this.pending)
			this.finish(id, new RpcError(code, message, pending.sent ? "unknown" : "not_sent"));
		this.close();
		this.options.onFault?.(new RpcError(code, message));
	}
}
