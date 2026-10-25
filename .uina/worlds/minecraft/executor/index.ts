/** Batch 4 managed execution session. World tools and Host delivery arrive in batch 6. */
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootstrapHello, CompanionInit, ExecutionSideStatus } from "../contracts/executor.js";
import type {
	Acceptance,
	OwnerGateReceipt,
	OwnerState,
	RunRequest,
	RunSummary,
	RunWaitReply,
	StopCommand,
	StopReceipt,
	SubmissionLookup,
} from "../contracts/runtime.js";
import type { JsonValue, Observation } from "../contracts/values.js";
import { accountKey, parseExecutorConfig } from "./config.js";
import { RpcError, RpcPeer, type WireEndpoint } from "./ipc.js";
import { ExecutorLedger } from "./ledger.js";
import type { LedgerSnapshot } from "./ledger-worker.js";
import { acquireOwnership, type ManagedProcess, type WindowsOwnership } from "./platform/index.js";
import type { RpcMethod } from "./protocol.js";
import { validateHello } from "./protocol.js";

export interface ExecutorPolicy {
	heartbeatIntervalMs: number;
	ownerLifetimeMs: number;
	heartbeatDeadlineMs: number;
	handshakeMs: number;
	closeGraceMs: number;
	retirementMs: number;
	autoRecover: boolean;
}
const DEFAULT_POLICY: ExecutorPolicy = {
	heartbeatIntervalMs: 1000,
	ownerLifetimeMs: 5000,
	heartbeatDeadlineMs: 5000,
	handshakeMs: 10_000,
	closeGraceMs: 400,
	retirementMs: 1000,
	autoRecover: true,
};

export interface PlatformSessionStatus {
	phase: "starting" | "ready" | "faulted" | "closing" | "closed";
	actionsAllowed: boolean;
	accountKey: string;
	side: ExecutionSideStatus | null;
	lastKnown: ExecutionSideStatus | null;
	fault: { code: string; message: string } | null;
	policy: ExecutorPolicy;
	diagnostics: { tail: string; discardedBytes: number };
}
interface Connection {
	launch: string;
	child: ChildProcess;
	process: ManagedProcess;
	peer: RpcPeer | null;
	attachment: string | null;
	lastHeartbeat: number;
}

function endpoint(child: ChildProcess): WireEndpoint {
	return {
		send(value, done) {
			if (!child.connected) {
				done(new Error("child IPC disconnected"));
				return;
			}
			child.send(value as object, (error: Error | null) => done(error));
		},
		onMessage(listener) {
			child.on("message", listener);
			return () => {
				child.off("message", listener);
			};
		},
		onDisconnect(listener) {
			child.on("disconnect", listener);
			return () => {
				child.off("disconnect", listener);
			};
		},
	};
}

export class MinecraftExecutor {
	readonly ledger = new ExecutorLedger();
	private identity!: LedgerSnapshot["identity"];
	private readonly localGates = new Set<"disabled" | "emergency" | "owner_lost">();
	private connection: Connection | null = null;
	private side: ExecutionSideStatus | null = null;
	private lastKnown: ExecutionSideStatus | null = null;
	private phase: PlatformSessionStatus["phase"] = "starting";
	private lastFault: PlatformSessionStatus["fault"] = null;
	private closing = false;
	private closePromise: Promise<void> | null = null;
	private retiring: Promise<boolean> | null = null;
	private launching: Promise<void> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatPending = false;
	private recoveryRemaining = 1;
	private readyOnce = false;
	private lastRetirementClean = false;
	private tail = Buffer.alloc(0);
	private discardedBytes = 0;
	private readonly listeners = new Set<(events: import("../contracts/executor.js").GameNotice[]) => void>();
	subscribe(listener: (events: import("../contracts/executor.js").GameNotice[]) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private readonly activation = `activation:${randomUUID()}`;
	private readonly abortListener: () => void;
	private constructor(
		private readonly root: string,
		private readonly config: ReturnType<typeof parseExecutorConfig>,
		private readonly ownership: WindowsOwnership,
		private readonly policy: ExecutorPolicy,
		private readonly signal?: AbortSignal,
	) {
		this.abortListener = () => {
			this.closing = true;
			this.phase = "closing";
			void this.close().catch(() => {});
		};
		signal?.addEventListener("abort", this.abortListener, { once: true });
	}
	static async open(options: {
		worldDataDir: string;
		config: unknown;
		signal?: AbortSignal;
		policy?: Partial<ExecutorPolicy>;
	}): Promise<MinecraftExecutor> {
		const config = parseExecutorConfig(options.config);
		if (options.signal?.aborted) throw new RpcError("REQUEST_CANCELLED", "activation cancelled before start");
		await mkdir(options.worldDataDir, { recursive: true });
		const root = await realpath(options.worldDataDir);
		const ownership = acquireOwnership(root, accountKey(config));
		const session = new MinecraftExecutor(
			root,
			config,
			ownership,
			{ ...DEFAULT_POLICY, ...options.policy },
			options.signal,
		);
		try {
			if (!existsSync(join(root, "executor.db")) && existsSync(join(root, "runtime.db")))
				throw new RpcError(
					"EXECUTOR_IDENTITY_MISSING",
					"runtime exists without its executor identity; choose a new development data root",
				);
			const snapshot = await session.ledger.open(
				join(root, "executor.db"),
				`owner:${randomUUID()}`,
				`storage:${randomUUID()}`,
			);
			session.identity = snapshot.identity;
			for (const gate of snapshot.gates) session.localGates.add(gate);
			if (session.identity.runtimeCreated && !existsSync(join(root, "runtime.db")))
				throw new RpcError("STORAGE_ID_CHANGED", "previously initialized Runtime database is missing");
			await session.startLaunch(snapshot.previous != null && !snapshot.previous.clean);
			return session;
		} catch (error) {
			session.closing = true;
			if (session.closePromise) await session.closePromise.catch(() => {});
			else {
				await session.retireSide(false).catch(() => false);
				await session.ledger.close().catch(() => {});
				if (ownership.activeProcesses().directory === 0 && ownership.activeProcesses().account === 0) ownership.close();
			}
			options.signal?.removeEventListener("abort", session.abortListener);
			throw error;
		}
	}
	private checkLifecycle(): void {
		if (this.closing || this.signal?.aborted) throw new RpcError("EXECUTOR_UNAVAILABLE", "activation is closing");
	}
	private appendLog(chunk: Buffer | string): void {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const tail = Buffer.concat([this.tail, data]);
		const discarded = Math.max(0, tail.length - 65536);
		this.discardedBytes += discarded;
		this.tail = tail.subarray(discarded);
	}
	private startLaunch(unclean: boolean): Promise<void> {
		if (this.launching) return this.launching;
		const task = this.launch(unclean);
		this.launching = task;
		void task
			.finally(() => {
				if (this.launching === task) this.launching = null;
			})
			.catch(() => {});
		return task;
	}
	private async launch(unclean: boolean): Promise<void> {
		this.checkLifecycle();
		if (this.connection || this.ownership.activeProcesses().directory || this.ownership.activeProcesses().account)
			throw new RpcError("EXECUTOR_OWNERSHIP_UNAVAILABLE", "old execution tree is not proven retired");
		this.phase = "starting";
		const launch = `launch:${randomUUID()}`;
		await this.ledger.launch(launch, this.activation);
		this.checkLifecycle();
		const source = !import.meta.url.endsWith(".js");
		const bootstrap = fileURLToPath(
			new URL(source ? "../companion/bootstrap.ts" : "../companion/bootstrap.js", import.meta.url),
		);
		const forkOptions: ForkOptions & { windowsHide: boolean } = {
			execPath: process.execPath,
			execArgv: source ? ["--import", "tsx"] : [],
			serialization: "json",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			windowsHide: true,
			detached: true,
		};
		const child = fork(bootstrap, [launch], forkOptions);
		// Spawn errors may arrive after a missing-PID rollback has removed the hello listener.
		child.on("error", (error: Error) => this.appendLog(`bootstrap process error: ${error.message}\n`));
		child.stdout!.on("data", (chunk: Buffer) => this.appendLog(chunk));
		child.stderr!.on("data", (chunk: Buffer) => this.appendLog(chunk));
		let stopHello = () => {};
		const helloPromise = new Promise<BootstrapHello>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new RpcError("HANDSHAKE_TIMEOUT", "bootstrap hello timed out"));
			}, this.policy.handshakeMs);
			const message = (value: unknown) => {
				cleanup();
				if (!validateHello(value) || (value as BootstrapHello).launch !== launch)
					reject(new RpcError("PROTOCOL_ERROR", "invalid bootstrap hello"));
				else resolve(value as BootstrapHello);
			};
			const failed = (error?: unknown) => {
				cleanup();
				reject(new RpcError("EXECUTOR_UNAVAILABLE", `bootstrap failed before hello: ${String(error)}`));
			};
			const cleanup = () => {
				clearTimeout(timer);
				child.off("message", message);
				child.off("error", failed);
				child.off("exit", failed);
			};
			stopHello = cleanup;
			child.once("message", message);
			child.once("error", failed);
			child.once("exit", failed);
		});
		// Attach a rejection observer before native open so startup rollback never leaves an unhandled hello.
		void helloPromise.catch(() => {});
		try {
			if (!child.pid) throw new RpcError("EXECUTOR_UNAVAILABLE", "bootstrap has no process id");
			const processHandle = this.ownership.openProcess(child.pid);
			const connection: Connection = {
				launch,
				child,
				process: processHandle,
				peer: null,
				attachment: null,
				lastHeartbeat: performance.now(),
			};
			this.connection = connection;
			const hello = await helloPromise;
			this.checkLifecycle();
			if (processHandle.identity.pid !== hello.pid || processHandle.identity.createdAt !== hello.createdAt)
				throw new RpcError("PROTOCOL_ERROR", "bootstrap exact process identity mismatch");
			this.ownership.assign(processHandle);
			const peer = new RpcPeer({
				launch,
				endpoint: endpoint(child),
				onFault: (error) => this.onSideFault(connection, error),
				onNotification: (frame) => {
					if (this.connection !== connection || this.closing) return;
					if (frame.kind === "changed")
						for (const listener of this.listeners) {
							try {
								listener(frame.events ?? []);
							} catch {
								/* Consumer errors do not affect physical control. */
							}
						}
					if (frame.kind === "retire_required")
						this.onSideFault(connection, new RpcError(frame.request.code, frame.request.detail));
				},
			});
			connection.peer = peer;
			const init: CompanionInit = {
				launch,
				origin: { worldOwner: this.identity.worldOwner, activation: this.activation },
				storageId: this.identity.storageId,
				worldDataDir: this.root,
				config: this.config,
				unclean,
				oldControlRetired: true,
				ownerLifetimeMs: this.policy.ownerLifetimeMs,
				localGates: [...this.localGates],
			};
			this.side = (await peer.call("init", init, {
				timeoutMs: this.policy.handshakeMs,
			})) as unknown as ExecutionSideStatus;
			if (this.side.storageId !== this.identity.storageId)
				throw new RpcError("STORAGE_ID_CHANGED", "companion Runtime identity mismatch");
			await this.ledger.runtimeCreated();
			this.identity.runtimeCreated = true;
			this.checkLifecycle();
			const owner = (await peer.call("runtime.attach", {})) as unknown as OwnerState;
			connection.attachment = owner.attachment;
			this.side.owner = owner;
			this.phase = "ready";
			this.lastFault = null;
			this.readyOnce = true;
			this.startHeartbeat(connection);
			// Explicit activation may clear disabled only. Emergency/owner_lost remain independent.
			if (owner.gates.includes("disabled")) await this.setOwnerGate("disabled", false, owner.gateRevision);
			this.side = (await peer.call("status", {})) as unknown as ExecutionSideStatus;
		} catch (error) {
			stopHello();
			if (!this.connection && child.connected) {
				child.disconnect();
			}
			throw error;
		}
	}
	private startHeartbeat(connection: Connection): void {
		this.stopHeartbeat();
		this.lastRetirementClean = false;
		connection.lastHeartbeat = performance.now();
		this.heartbeatTimer = setInterval(() => {
			if (this.connection !== connection || this.closing) return;
			if (performance.now() - connection.lastHeartbeat >= this.policy.heartbeatDeadlineMs) {
				this.onSideFault(connection, new RpcError("EXECUTOR_UNAVAILABLE", "main-thread heartbeat deadline elapsed"));
				return;
			}
			if (this.heartbeatPending) return;
			this.heartbeatPending = true;
			void connection
				.peer!.call(
					"runtime.heartbeat",
					{ attachment: connection.attachment },
					{ timeoutMs: this.policy.heartbeatDeadlineMs },
				)
				.then(async (value) => {
					if (this.connection !== connection || this.closing) return;
					connection.lastHeartbeat = performance.now();
					if (this.side) this.side.owner = value as unknown as OwnerState;
					const fresh = await connection.peer!.call("status", {});
					if (this.connection === connection && !this.closing) this.side = fresh as unknown as ExecutionSideStatus;
				})
				.catch((error: Error) => this.onSideFault(connection, error))
				.finally(() => {
					this.heartbeatPending = false;
				});
		}, this.policy.heartbeatIntervalMs);
	}
	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		this.heartbeatPending = false;
	}
	private onSideFault(connection: Connection, error: Error): void {
		if (this.connection !== connection || this.closing || this.phase === "faulted") return;
		this.stopHeartbeat();
		this.lastKnown = this.side;
		this.side = null;
		this.phase = "faulted";
		this.lastFault = { code: error instanceof RpcError ? error.code : "EXECUTOR_UNAVAILABLE", message: error.message };
		void this.retireSide(false)
			.then(async (retired) => {
				if (
					retired &&
					!this.closing &&
					this.phase !== "ready" &&
					this.readyOnce &&
					this.policy.autoRecover &&
					this.recoveryRemaining > 0
				) {
					this.recoveryRemaining--;
					try {
						await this.startLaunch(true);
					} catch (nextError) {
						this.phase = "faulted";
						this.lastFault = { code: "EXECUTOR_UNAVAILABLE", message: String(nextError) };
						await this.retireSide(false);
					}
				}
			})
			.catch((retireError: unknown) => {
				this.lastFault = { code: "EXECUTOR_OWNERSHIP_UNAVAILABLE", message: String(retireError) };
			});
	}
	private current(): Connection & { peer: RpcPeer } {
		this.checkLifecycle();
		if (this.phase !== "ready" || !this.connection?.peer)
			throw new RpcError("EXECUTOR_UNAVAILABLE", "execution connection is not ready");
		return this.connection as Connection & { peer: RpcPeer };
	}
	status(): PlatformSessionStatus {
		const gates = this.side?.owner?.gates;
		return {
			phase: this.phase,
			actionsAllowed:
				this.phase === "ready" && this.localGates.size === 0 && gates?.length === 0 && !this.side?.retirement,
			accountKey: accountKey(this.config),
			side: this.side,
			lastKnown: this.lastKnown,
			fault: this.lastFault,
			policy: { ...this.policy },
			diagnostics: { tail: this.tail.toString("utf8"), discardedBytes: this.discardedBytes },
		};
	}
	async inspect(): Promise<PlatformSessionStatus> {
		const connection = this.current();
		const side = (await connection.peer.call("status", {})) as unknown as ExecutionSideStatus;
		if (this.connection !== connection) throw new RpcError("EXECUTOR_UNAVAILABLE", "connection changed during status");
		this.side = side;
		if (side.retirement) this.onSideFault(connection, new RpcError(side.retirement.code, side.retirement.detail));
		return this.status();
	}
	async setOwnerGate(
		gate: "disabled" | "emergency" | "owner_lost",
		closed: boolean,
		expectedRevision?: number,
	): Promise<OwnerGateReceipt> {
		if (closed) this.localGates.add(gate);
		const local = closed ? this.ledger.setGate(gate, true) : null;
		if (local) void local.catch(() => {});
		let connection: Connection & { peer: RpcPeer };
		try {
			connection = this.current();
		} catch (error) {
			if (local) await local.catch(() => {});
			throw error;
		}
		const remote = connection.peer.call("runtime.setOwnerGate", {
			requestId: randomUUID(),
			attachment: connection.attachment,
			gate,
			closed,
			...(expectedRevision === undefined ? {} : { expectedRevision }),
		});
		let receipt: OwnerGateReceipt;
		try {
			receipt = (await remote) as unknown as OwnerGateReceipt;
		} catch (error) {
			if (local) await local.catch(() => {});
			throw error;
		}
		try {
			if (local) await local;
			else await this.ledger.setGate(gate, false);
			if (!closed) this.localGates.delete(gate);
		} catch (error) {
			receipt = { ...receipt, persistence: "unknown", error: `executor gate intent not persisted: ${String(error)}` };
		}
		if (this.connection === connection && this.side) this.side.owner = receipt.state;
		return receipt;
	}
	async submit(request: RunRequest): Promise<Acceptance> {
		const connection = this.current();
		if (!this.status().actionsAllowed)
			return {
				kind: "not_accepted",
				requestId: request.requestId,
				code: "OWNER_GATE_CLOSED",
				message: "owner action gate is closed",
			};
		try {
			return (await connection.peer.call("runtime.submit", request)) as unknown as Acceptance;
		} catch (error) {
			if (error instanceof RpcError) {
				const refusal = error.failure;
				if (refusal && typeof refusal === "object" && !Array.isArray(refusal) && refusal.dispatch === "not_sent")
					return { kind: "not_accepted", requestId: request.requestId, code: error.code, message: error.message };
				if (error.dispatch === "unknown")
					return { kind: "unknown", requestId: request.requestId, reason: `${error.code}: ${error.message}` };
			}
			throw error;
		}
	}
	async lookup(requestId: string): Promise<SubmissionLookup> {
		return (await this.current().peer.call("runtime.lookup", { requestId })) as unknown as SubmissionLookup;
	}
	async read(run: string): Promise<RunSummary> {
		return (await this.current().peer.call("runtime.read", { run })) as unknown as RunSummary;
	}
	async readRecord(
		ref: string,
		options: { format?: import("../contracts/runtime.js").RecordFormat } = {},
	): Promise<import("../contracts/runtime.js").RecordReply> {
		return await this.rpc("runtime.readRecord", { ref, ...options });
	}
	async rpc<T>(method: RpcMethod, payload: unknown, signal?: AbortSignal): Promise<T> {
		return (await this.current().peer.call(method, payload, { signal })) as T;
	}
	async resumeEmergency(expected: { attachment: string; gateRevision: number }): Promise<OwnerGateReceipt> {
		const connection = this.current();
		if (connection.attachment !== expected.attachment)
			throw new RpcError("OWNER_STATE_CHANGED", "emergency owner changed");
		return this.setOwnerGate("emergency", false, expected.gateRevision);
	}
	async retireControl(): Promise<void> {
		if (!(await this.retireSide(false)))
			throw new RpcError("EXECUTOR_OWNERSHIP_UNAVAILABLE", "control retirement unconfirmed");
		this.phase = "faulted";
	}
	async observe<T>(selector: string, input: JsonValue = {}): Promise<Observation<T>> {
		return (await this.current().peer.call("observe", { selector, input })) as unknown as Observation<T>;
	}
	async wait(
		run: string,
		options: { afterRevision?: number; timeoutMs?: number } = {},
		signal?: AbortSignal,
	): Promise<RunWaitReply> {
		return (await this.current().peer.call(
			"runtime.wait",
			{ run, ...options },
			{ signal, timeoutMs: null },
		)) as unknown as RunWaitReply;
	}
	async stop(command: StopCommand): Promise<StopReceipt> {
		return (await this.current().peer.call("runtime.stop", command)) as unknown as StopReceipt;
	}
	async recover(expected?: { attachment: string; gateRevision: number }): Promise<PlatformSessionStatus> {
		this.checkLifecycle();
		if (expected) {
			const connection = this.current();
			if (connection.attachment !== expected.attachment)
				throw new RpcError("OWNER_STATE_CHANGED", "recovery attachment changed");
			await this.setOwnerGate("owner_lost", false, expected.gateRevision);
		} else {
			if (this.retiring) await this.retiring;
			if (this.launching) {
				await this.launching;
				return await this.inspect();
			}
			if (this.phase !== "ready") {
				if (!(await this.retireSide(false)))
					throw new RpcError("EXECUTOR_OWNERSHIP_UNAVAILABLE", "old tree retirement is unknown");
				await this.startLaunch(true);
			}
		}
		return await this.inspect();
	}
	private retireSide(graceful: boolean): Promise<boolean> {
		if (this.retiring) return this.retiring;
		const connection = this.connection;
		if (!connection)
			return Promise.resolve(
				this.ownership.activeProcesses().directory === 0 && this.ownership.activeProcesses().account === 0,
			);
		this.stopHeartbeat();
		const task = (async () => {
			let clean = false;
			if (graceful && connection.peer) {
				const gracefulClose = (async () => {
					if (!connection.attachment) return false;
					const local = this.ledger.setGate("disabled", true);
					void local.catch(() => {});
					const receipt = (await connection.peer!.call(
						"runtime.setOwnerGate",
						{ requestId: randomUUID(), attachment: connection.attachment, gate: "disabled", closed: true },
						{ timeoutMs: null },
					)) as unknown as OwnerGateReceipt;
					await local;
					await connection.peer!.call("shutdown", {}, { timeoutMs: null });
					return receipt.persistence === "confirmed";
				})();
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					clean = await Promise.race([
						gracefulClose.catch(() => false),
						new Promise<false>((resolve) => {
							timer = setTimeout(() => resolve(false), this.policy.closeGraceMs);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			}
			if (!clean) {
				if (this.ownership.activeProcesses().directory > 0) this.ownership.terminate();
				else connection.process.terminate();
			}
			let retired = await this.ownership.waitRetired(connection.process, this.policy.retirementMs);
			if (!retired && clean) {
				clean = false;
				if (this.ownership.activeProcesses().directory > 0) this.ownership.terminate();
				else connection.process.terminate();
				retired = await this.ownership.waitRetired(connection.process, this.policy.retirementMs);
			}
			connection.peer?.close();
			if (!retired) {
				this.phase = "faulted";
				throw new RpcError("EXECUTOR_OWNERSHIP_UNAVAILABLE", "exact process/job retirement could not be confirmed");
			}
			if (clean) await this.ledger.clean(connection.launch);
			connection.process.close();
			if (this.connection === connection) {
				this.lastKnown = this.side ?? this.lastKnown;
				this.side = null;
				this.connection = null;
			}
			this.lastRetirementClean = clean;
			return true;
		})();
		// Retirement and a clean Runtime shutdown are separate facts.
		this.retiring = task;
		void task
			.finally(() => {
				if (this.retiring === task) this.retiring = null;
			})
			.catch(() => {});
		return task;
	}
	close(): Promise<void> {
		return (this.closePromise ??= (async () => {
			this.closing = true;
			this.phase = "closing";
			this.stopHeartbeat();
			let clean = true;
			let error: unknown;
			try {
				if (this.launching) {
					if (this.connection) await this.retireSide(false);
					await this.launching.catch(() => {});
				}
				if (this.retiring) await this.retiring;
				if (this.connection) {
					await this.retireSide(true);
					clean = this.lastRetirementClean;
				}
			} catch (cause) {
				error = cause;
			}
			if (!this.connection) {
				try {
					await this.ledger.close();
				} catch (cause) {
					error ??= cause;
				}
				this.ownership.close();
				this.phase = "closed";
			} else this.phase = "faulted";
			this.signal?.removeEventListener("abort", this.abortListener);
			if (error) throw error;
			if (!clean)
				throw new RpcError(
					"EXECUTION_DOMAIN_UNRETIRED",
					"process tree was terminated; Runtime requires recovery on next activation",
				);
		})());
	}
}
