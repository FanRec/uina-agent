/** Owner binding and independent gates. Dead bindings never regain authority. */
import { randomUUID } from "node:crypto";
import type { Origin, OwnerGate, OwnerGateReceipt, OwnerState } from "../contracts/runtime.js";
import type { Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { RecordQueue } from "./records.js";

interface OwnerOptions {
	worldOwner: Ref;
	queue: RecordQueue;
	lifetimeMs?: number;
	now?: () => number;
	onClose(): void;
	control(): OwnerGateReceipt["control"];
}
export class RuntimeOwner {
	private gates = new Set<OwnerGate>(["disabled"]);
	private revision = 0;
	private binding: { attachment: Ref; activation: Ref; expires: number } | null = null;
	private readonly expired = new Set<Ref>();
	private readonly lifetime: number;
	private readonly now: () => number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private generation = 0;
	constructor(private readonly opts: OwnerOptions) {
		this.lifetime = opts.lifetimeMs ?? 5000;
		if (!Number.isFinite(this.lifetime) || this.lifetime <= 0) throw new Error("ownerLifetimeMs must be positive");
		this.now = opts.now ?? (() => performance.now());
	}
	recover(state: { gates: string; revision: number } | undefined, unclean: boolean): void {
		if (state != null) {
			const gates: unknown = JSON.parse(state.gates);
			if (
				!Array.isArray(gates) ||
				!gates.every((g) => g === "disabled" || g === "emergency" || g === "owner_lost") ||
				!Number.isSafeInteger(state.revision) ||
				state.revision < 0
			)
				throw new Error("invalid durable owner state");
			this.gates = new Set(gates as OwnerGate[]);
			this.revision = state.revision;
		}
		// Every activation requires explicit enable, even following a clean shutdown.
		this.closeGate("disabled");
		if (unclean) this.closeGate("owner_lost");
	}
	async attach(origin: Origin): Promise<OwnerState> {
		this.expire();
		if (this.closed || origin.worldOwner !== this.opts.worldOwner)
			throw this.denial("OWNER_STATE_CHANGED", "owner identity or lifecycle changed");
		if (this.expired.has(origin.activation))
			throw this.denial("OWNER_EXPIRED", "expired activation cannot attach again");
		if (this.binding?.activation === origin.activation) return this.state();
		if (this.binding != null) {
			this.expired.add(this.binding.activation);
			this.closeGate("owner_lost");
		}
		const binding = {
			attachment: `attachment:${randomUUID()}`,
			activation: origin.activation,
			expires: this.now() + this.lifetime,
		};
		this.binding = binding;
		this.generation++;
		this.schedule();
		await this.opts.queue.flushThrough(this.opts.queue.capture());
		this.checkAttachment(binding.attachment);
		return this.state();
	}
	async heartbeat(attachment: Ref): Promise<OwnerState> {
		this.checkAttachment(attachment);
		this.binding!.expires = this.now() + this.lifetime;
		this.schedule();
		return this.state();
	}
	async setGate(request: {
		requestId: Ref;
		attachment: Ref;
		gate: OwnerGate;
		closed: boolean;
		expectedRevision?: number;
	}): Promise<OwnerGateReceipt> {
		this.checkAttachment(request.attachment, request.closed);
		if (request.gate !== "disabled" && request.gate !== "emergency" && request.gate !== "owner_lost")
			throw this.denial("INVALID_INPUT", "unknown owner gate");
		if (request.closed) this.closeGate(request.gate);
		else {
			if (request.expectedRevision == null || request.expectedRevision !== this.revision)
				throw this.denial("OWNER_STATE_CHANGED", "opening a gate requires the current gate revision");
			const next = [...this.gates].filter((g) => g !== request.gate);
			const revision = ++this.revision;
			// A repeated close still revokes admission even when gate membership is unchanged.
			const generation = this.generation;
			this.opts.queue.enqueue({ kind: "owner_state", gates: JSON.stringify(next), revision });
			try {
				await this.opts.queue.flushThrough(this.opts.queue.capture());
			} catch (err) {
				// Failed opens leave the action gate closed, including after an uncertain commit.
				return {
					requestId: request.requestId,
					state: this.state(),
					persistence: "unknown",
					control: this.opts.control(),
					error: String(err),
				};
			}
			this.checkAttachment(request.attachment);
			if (this.revision !== revision || this.generation !== generation)
				throw this.denial("OWNER_STATE_CHANGED", "owner gates changed during commit");
			this.gates.delete(request.gate);
			return {
				requestId: request.requestId,
				state: this.state(),
				persistence: "confirmed",
				control: this.opts.control(),
			};
		}
		let persistence: OwnerGateReceipt["persistence"] = "confirmed";
		let error: string | undefined;
		try {
			await this.opts.queue.flushThrough(this.opts.queue.capture());
		} catch (err) {
			persistence = "unknown";
			error = String(err);
		}
		return {
			requestId: request.requestId,
			state: this.state(),
			persistence,
			control: this.opts.control(),
			...(error == null ? {} : { error }),
		};
	}
	assertAllowed(origin?: Origin): void {
		this.expire();
		if (this.opts.queue.faultReason != null) throw this.denial("STORAGE_UNAVAILABLE", this.opts.queue.faultReason);
		if (this.closed || this.binding == null || this.now() >= this.binding.expires)
			throw this.denial("OWNER_EXPIRED", "no live owner attachment");
		if (origin != null && (origin.worldOwner !== this.opts.worldOwner || origin.activation !== this.binding.activation))
			throw this.denial("OWNER_STATE_CHANGED", "request does not belong to the current attachment");
		if (this.gates.size !== 0)
			throw this.denial("OWNER_GATE_CLOSED", `owner gates closed: ${[...this.gates].join(", ")}`);
	}
	capture(origin: Origin): number {
		this.assertAllowed(origin);
		return this.generation;
	}
	assertGeneration(origin: Origin, generation: number): void {
		this.assertAllowed(origin);
		if (this.generation !== generation) throw this.denial("OWNER_STATE_CHANGED", "owner admission generation changed");
	}
	shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer != null) clearTimeout(this.timer);
		this.timer = null;
		this.closeGate("disabled");
	}
	state(): OwnerState {
		this.expire();
		return {
			attachment: this.binding?.attachment ?? "",
			gates: [...this.gates],
			gateRevision: this.revision,
			validForMs: this.binding == null || this.closed ? 0 : Math.max(0, this.binding.expires - this.now()),
		};
	}
	private checkAttachment(attachment: Ref, allowExpired = false): void {
		this.expire();
		if (
			this.closed ||
			this.binding == null ||
			this.binding.attachment !== attachment ||
			(!allowExpired && this.now() >= this.binding.expires)
		)
			throw this.denial("OWNER_STATE_CHANGED", "attachment expired or replaced");
	}
	private expire(): void {
		if (this.binding == null || this.now() < this.binding.expires || this.expired.has(this.binding.activation)) return;
		this.expired.add(this.binding.activation);
		this.closeGate("owner_lost");
	}
	private closeGate(gate: OwnerGate): void {
		this.generation++;
		const changed = !this.gates.has(gate);
		this.gates.add(gate);
		// Revoke calls/control synchronously before enqueueing or waiting for storage.
		this.opts.onClose();
		if (changed) this.revision++;
		this.opts.queue.enqueue({ kind: "owner_state", gates: JSON.stringify([...this.gates]), revision: this.revision });
	}
	private schedule(): void {
		if (this.timer != null) clearTimeout(this.timer);
		const remaining = Math.max(1, (this.binding?.expires ?? this.now()) - this.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			this.expire();
			if (!this.closed && this.binding != null && !this.expired.has(this.binding.activation)) this.schedule();
		}, remaining);
		this.timer.unref();
	}
	private denial(code: string, message: string) {
		return callFailure({ code, message, source: "environment", dispatch: "not_sent", effects: [], recoverable: false });
	}
}
