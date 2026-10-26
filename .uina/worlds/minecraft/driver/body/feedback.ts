import type {
	ControlInput,
	FeedbackFrame,
	FeedbackFrameRef,
	FeedbackStream,
	SelfState,
	ClientPhysicsStep,
} from "../../contracts/body.js";
import type { EffectReceipt, Fact, JsonValue, Ref, CallFailure } from "../../contracts/values.js";
import type { MineflayerBot } from "../mineflayer/adapter.js";
import { physicsSteps } from "../mineflayer/physics-step.js";
import { fail } from "../execution.js";

export const FEEDBACK_VALID_MS = 250;
interface Deps {
	body: Ref;
	operation: Ref;
	identity: { connection: Ref; incarnation: Ref };
	bot: MineflayerBot;
	signal: AbortSignal;
	guard(): void;
	sample(): { self: Fact<SelfState>; sensors: Record<string, Fact<JsonValue>> };
	install(input: ControlInput): void;
	validate?(input: ControlInput): void;
	clear(): void;
	closed?(): void;
	record(kind: "dispatch" | "receipt" | "cleanup", detail: JsonValue, dispatch?: "sent" | "unknown"): EffectReceipt;
}
export class FeedbackController implements FeedbackStream {
	private latest: FeedbackFrame | null = null;
	private delivered: FeedbackFrame | null = null;
	private consumed = false;
	private ended: CallFailure | null = null;
	private pending: {
		input: ControlInput;
		frame: FeedbackFrame;
		resolve(value: { receipt: EffectReceipt; appliedStep: ClientPhysicsStep }): void;
		reject(error: unknown): void;
	} | null = null;
	private waiter: { resolve(frame: FeedbackFrame): void; reject(error: unknown): void } | null = null;
	private installedUntil = 0;
	private installed = false;
	private installedView = false;
	private receipt: EffectReceipt | null = null;
	private detach: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private lastStep = performance.now();
	private readonly abort = () => this.finish(this.error("INTERRUPTED", "feedback scope retired"));
	constructor(private readonly deps: Deps) {
		this.detach = physicsSteps(deps.bot).subscribe(
			() => this.before(),
			(sequence) => this.after(sequence),
		);
		this.timer = setInterval(() => {
			this.expire();
			if (performance.now() - this.lastStep > 2000) this.finish(this.error("TIMEOUT", "client physics stalled"));
		}, 25);
		this.timer.unref();
		deps.signal.addEventListener("abort", this.abort, { once: true });
		if (deps.signal.aborted) this.abort();
	}
	private error(code: string, message: string): CallFailure {
		return fail({
			code,
			message,
			source: "environment",
			dispatch: this.installed ? "sent" : "not_sent",
			recoverable: true,
		});
	}
	private live() {
		if (this.ended) throw this.ended;
		this.deps.guard();
	}
	hasViewInput(): boolean {
		const pending = this.pending;
		return !!(
			(pending && performance.now() < pending.frame.validUntil && (pending.input.look || pending.input.lookAt)) ||
			(this.installed && this.installedView && performance.now() < this.installedUntil)
		);
	}
	private expire() {
		const now = performance.now();
		if (this.pending && now >= this.pending.frame.validUntil) {
			this.pending.reject(this.error("FRAME_EXPIRED", "feedback frame expired before application"));
			this.pending = null;
		}
		if (this.installed && now >= this.installedUntil) {
			this.deps.clear();
			this.installed = false;
			this.deps.record("cleanup", { reason: "feedback input expired" });
		}
	}
	private before() {
		let attempted: EffectReceipt | null = null;
		try {
			this.live();
			this.expire();
			if (!this.pending) return;
			this.deps.validate?.(this.pending.input);
			attempted = this.deps.record(
				"dispatch",
				{ sequence: this.pending.frame.sequence, input: this.pending.input as unknown as JsonValue },
				"unknown",
			);
			this.deps.install(this.pending.input);
			this.installed = true;
			this.installedView = !!(this.pending.input.look || this.pending.input.lookAt);
			this.installedUntil = this.pending.frame.validUntil;
			this.receipt = this.deps.record("dispatch", {
				sequence: this.pending.frame.sequence,
				sampledAt: this.pending.frame.sampledAt,
				input: this.pending.input as unknown as JsonValue,
			});
		} catch (error) {
			this.finish(
				attempted
					? fail({
							code: (error as { code?: string }).code ?? "INTERNAL",
							source: "environment",
							message: error instanceof Error ? error.message : String(error),
							dispatch: "unknown",
							effects: [attempted.effect],
							recoverable: false,
						})
					: (error as CallFailure),
			);
		}
	}
	private after(sequence: number) {
		try {
			this.live();
			this.lastStep = performance.now();
			const step = { ...this.deps.identity, sequence };
			if (this.pending && this.receipt) {
				const pending = this.pending;
				this.pending = null;
				const receipt = this.deps.record("receipt", {
					sequence: pending.frame.sequence,
					appliedStep: sequence,
					latencyMs: performance.now() - pending.frame.sampledAt,
				});
				pending.resolve({ receipt, appliedStep: step });
				this.receipt = null;
			}
			const sample = this.deps.sample();
			const now = performance.now();
			this.latest = {
				stream: this.deps.operation,
				operation: this.deps.operation,
				body: this.deps.body,
				...this.deps.identity,
				sequence,
				step,
				sampledAt: now,
				validUntil: now + FEEDBACK_VALID_MS,
				...sample,
			};
			if (this.waiter) {
				const waiter = this.waiter;
				this.waiter = null;
				waiter.resolve(this.take());
			}
		} catch (error) {
			this.finish(error as CallFailure);
		}
	}
	private take(): FeedbackFrame {
		this.delivered = this.latest!;
		this.latest = null;
		this.consumed = false;
		return structuredClone(this.delivered);
	}
	async next(after: number | null, signal: AbortSignal): Promise<FeedbackFrame> {
		this.live();
		if (this.waiter || this.pending) throw this.error("CONTROL_CONFLICT", "next/apply is already pending");
		if (after !== null && after !== this.delivered?.sequence)
			throw this.error("FRAME_STALE", "after is not the delivered sequence");
		if (signal.aborted) throw this.error("INTERRUPTED", "feedback wait cancelled");
		if (this.latest) return this.take();
		let abort!: () => void;
		try {
			return await new Promise<FeedbackFrame>((resolve, reject) => {
				this.waiter = { resolve, reject };
				abort = () => {
					this.waiter = null;
					reject(this.error("INTERRUPTED", "feedback wait cancelled"));
				};
				signal.addEventListener("abort", abort, { once: true });
			});
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	async apply(frame: FeedbackFrameRef, input: ControlInput) {
		this.live();
		this.deps.validate?.(input);
		if (
			!this.delivered ||
			frame.stream !== this.deps.operation ||
			frame.sequence !== this.delivered.sequence ||
			this.consumed
		)
			throw this.error("FRAME_STALE", "frame was not delivered by this stream or was already consumed");
		if (performance.now() >= this.delivered.validUntil) throw this.error("FRAME_EXPIRED", "feedback frame expired");
		this.consumed = true;
		return new Promise<{ receipt: EffectReceipt; appliedStep: ClientPhysicsStep }>((resolve, reject) => {
			this.pending = { frame: this.delivered!, input: structuredClone(input), resolve, reject };
		});
	}
	private finish(error: CallFailure) {
		if (this.ended) return;
		this.ended = error;
		this.detach();
		clearInterval(this.timer);
		this.deps.signal.removeEventListener("abort", this.abort);
		this.pending?.reject(error);
		this.pending = null;
		this.waiter?.reject(error);
		this.waiter = null;
		this.deps.clear();
		if (this.installed) this.deps.record("cleanup", { reason: error.message });
		this.installed = false;
		this.deps.closed?.();
	}
	async close() {
		this.finish(this.error("CONTROL_INVALID", "feedback stream closed"));
	}
}
