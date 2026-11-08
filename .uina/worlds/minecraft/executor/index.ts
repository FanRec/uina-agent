/** Batch 4 managed execution session. World tools and Host delivery arrive in batch 6. */
import { type ChildProcess, type ForkOptions, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BootstrapHello,
	type CompanionInit,
	type ConnectionWaitResult,
	type ExecutionSideStatus,
	type ExecutorCloseResult,
} from "../contracts/executor.js";
import type { AssemblyPlan, DirectorySnapshot } from "../contracts/addons.js";
import { emptyAssemblyPlan } from "../addons/plan.js";
import type {
	Acceptance,
	ContinueRequest,
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
	/**
	 * 本次激活的机械对账结果。`clearedGates` 是执行域已经证明退役后自动解除的门，
	 * 模型不需要再走 `runs recover`；`blocked` 是仍然关着、需要人/模型处理的门。
	 */
	recovery: { clearedGates: ("disabled" | "owner_lost")[]; blocked: { gate: string; reason: string }[] };
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
	private closePromise: Promise<ExecutorCloseResult> | null = null;
	private closeResult: ExecutorCloseResult | null = null;
	private retiring: Promise<boolean> | null = null;
	private launching: Promise<void> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatPending = false;
	private recoveryRemaining = 1;
	private readyOnce = false;
	private lastRetirementClean = false;
	private recovery: PlatformSessionStatus["recovery"] = { clearedGates: [], blocked: [] };
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
		private readonly sessionDataDir: string,
		private readonly sharedDataDir: string,
		private readonly config: ReturnType<typeof parseExecutorConfig>,
		private readonly ownership: WindowsOwnership,
		private readonly policy: ExecutorPolicy,
		private readonly signal?: AbortSignal,
		private readonly addons: AssemblyPlan = emptyAssemblyPlan(),
	) {
		this.abortListener = () => {
			this.closing = true;
			this.phase = "closing";
			void this.close().catch(() => {});
		};
		signal?.addEventListener("abort", this.abortListener, { once: true });
	}
	static async open(options: {
		/** 所有 Profile 共享的稳定根：Native 目录 Job 唯一（v3 §4.1，I1）。 */
		ownershipDir: string;
		/** 本 Profile 的 executor.db/runtime.db/runs/exports 根。 */
		sessionDataDir: string;
		/** world-history.db 与 library/ 的共享根。 */
		sharedDataDir: string;
		config: unknown;
		/** 本次会话冻结的 Addon 装配计划（Parent 已校验 Manifest 与路径）。 */
		addons?: AssemblyPlan;
		signal?: AbortSignal;
		policy?: Partial<ExecutorPolicy>;
	}): Promise<MinecraftExecutor> {
		const config = parseExecutorConfig(options.config);
		if (options.signal?.aborted) throw new RpcError("REQUEST_CANCELLED", "activation cancelled before start");
		await mkdir(options.sessionDataDir, { recursive: true });
		const [ownershipDir, sessionDataDir, sharedDataDir] = await Promise.all([
			realpath(options.ownershipDir),
			realpath(options.sessionDataDir),
			realpath(options.sharedDataDir),
		]);
		const ownership = acquireOwnership(ownershipDir, accountKey(config));
		const session = new MinecraftExecutor(
			sessionDataDir,
			sharedDataDir,
			config,
			ownership,
			{ ...DEFAULT_POLICY, ...options.policy },
			options.signal,
			options.addons ?? emptyAssemblyPlan(),
		);
		try {
			if (!existsSync(join(sessionDataDir, "executor.db")) && existsSync(join(sessionDataDir, "runtime.db")))
				throw new RpcError(
					"EXECUTOR_IDENTITY_MISSING",
					"runtime exists without its executor identity; choose a new development data root",
				);
			const snapshot = await session.ledger.open(
				join(sessionDataDir, "executor.db"),
				`owner:${randomUUID()}`,
				`storage:${randomUUID()}`,
			);
			session.identity = snapshot.identity;
			for (const gate of snapshot.gates) session.localGates.add(gate);
			if (session.identity.runtimeCreated && !existsSync(join(sessionDataDir, "runtime.db")))
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
				sessionDataDir: this.sessionDataDir,
				sharedDataDir: this.sharedDataDir,
				config: this.config,
				addons: this.addons,
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
			// 显式激活可以清 disabled。emergency / owner_lost 是独立门，但 owner_lost 是
			// 机械性的：能走到这里说明旧执行树已被证明退役（launch 本身拒绝未退役的旧树），
			// 旧控制不可能再写世界。此时继续关着只会让模型花两轮 runs recover 做同一件事。
			// emergency 是用户主动关的门，永不自动解除。
			this.recovery = await this.reconcileGates(owner);
			this.side = (await peer.call("status", {})) as unknown as ExecutionSideStatus;
		} catch (error) {
			stopHello();
			if (!this.connection && child.connected) {
				child.disconnect();
			}
			throw error;
		}
	}
	/**
	 * 激活后的机械对账：能证明安全的门直接开，开不了的门留下具体原因。
	 *
	 * 自动解除的严格边界（public-api §7.3）：
	 * - 只在旧执行域已确认退役之后——`launch` 本身拒绝未退役的旧树，所以走到这里是证明；
	 * - 不碰 emergency（用户主动关的门）；
	 * - 门状态持久提交未确认时保持关闭，并如实回报 persistence。
	 *
	 * 这条路径替代的是"模型先 runs recover 拿 attachment、再调一次带 expected 的 recover"
	 * 这两轮纯机械往返；`runs recover` 仍然保留给显式重连与人工干预。
	 */
	private async reconcileGates(owner: OwnerState): Promise<PlatformSessionStatus["recovery"]> {
		const cleared: ("disabled" | "owner_lost")[] = [];
		const blocked: { gate: string; reason: string }[] = [];
		let current = owner;
		if (current.gates.includes("disabled")) {
			const receipt = await this.setOwnerGate("disabled", false, current.gateRevision);
			current = receipt.state;
			if (receipt.persistence === "confirmed" && !current.gates.includes("disabled")) cleared.push("disabled");
			else blocked.push({ gate: "disabled", reason: receipt.error ?? "gate state was not persisted" });
		}
		if (current.gates.includes("emergency")) {
			blocked.push({ gate: "emergency", reason: "closed by the user; never cleared automatically" });
			if (current.gates.includes("owner_lost"))
				blocked.push({ gate: "owner_lost", reason: "held closed while emergency is closed" });
			return { clearedGates: cleared, blocked };
		}
		if (current.gates.includes("owner_lost")) {
			const receipt = await this.setOwnerGate("owner_lost", false, current.gateRevision);
			current = receipt.state;
			if (receipt.persistence === "confirmed" && !current.gates.includes("owner_lost")) cleared.push("owner_lost");
			else blocked.push({ gate: "owner_lost", reason: receipt.error ?? "gate state was not persisted" });
		}
		return { clearedGates: cleared, blocked };
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
		console.error(`[mc-executor] ${this.lastFault.code}: ${this.lastFault.message}`);
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
			recovery: { clearedGates: [...this.recovery.clearedGates], blocked: [...this.recovery.blocked] },
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
	/**
	 * 活动会话的只读目录快照：descriptor / addon 状态 / 选择摘要。
	 * 连接不健康时明确失败——宿主不得把过期目录当成当前可执行能力。
	 */
	async snapshot(): Promise<DirectorySnapshot> {
		return (await this.current().peer.call("directory.snapshot", {})) as unknown as DirectorySnapshot;
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
		return this.admit("runtime.submit", request);
	}
	async continue(request: ContinueRequest): Promise<Acceptance> {
		return this.admit("runtime.continue", request);
	}
	private async admit(
		method: "runtime.submit" | "runtime.continue",
		request: RunRequest | ContinueRequest,
	): Promise<Acceptance> {
		const connection = this.current();
		if (!this.status().actionsAllowed)
			return {
				kind: "not_accepted",
				requestId: request.requestId,
				code: "OWNER_GATE_CLOSED",
				message: "owner action gate is closed",
			};
		try {
			return (await connection.peer.call(method, request)) as unknown as Acceptance;
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
	/** 入服终态回执（v3 §6.3）：等 Driver 连接真正 ready/断开/故障；open() 成功不代表入服成功。 */
	async waitGameConnection(timeoutMs: number, signal?: AbortSignal): Promise<ConnectionWaitResult> {
		return (await this.current().peer.call(
			"connection.wait",
			{ timeoutMs },
			{
				signal,
				timeoutMs: null,
			},
		)) as unknown as ConnectionWaitResult;
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
			} else {
				// 执行侧进程健康但游戏连接已断：退役重建执行域。旧 Run 不重放，旧资格全部
				// 失效；新 Companion 创建成功不代表登录成功，最终状态由 side.connection 如实报告。
				const status = await this.inspect();
				const connection = status.side?.connection;
				if (connection === "disconnected" || connection === "faulted") {
					if (!(await this.retireSide(false)))
						throw new RpcError("EXECUTOR_OWNERSHIP_UNAVAILABLE", "old tree retirement is unknown");
					await this.startLaunch(true);
				}
				// connecting/syncing：连接仍在建立，不重复连接。
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
	/**
	 * 退役三事实（v3 §6.2）：进程退役、目录 Job 释放与 Runtime 关闭是三个独立事实。
	 * 脏关闭（runtime=unclean）只影响旧 Run 的恢复语义；进程/所有权未确认时保持
	 * process=unknown/ownership=held，由调用方拒绝启动新执行域。绝不从异常文字猜判定。
	 * 已证实的结论幂等复用；未证实的结论允许重试——再次 close 就是人工恢复渠道。
	 */
	close(): Promise<ExecutorCloseResult> {
		if (this.closeResult && this.closeResult.process === "retired" && this.closeResult.ownership === "released")
			return Promise.resolve(this.closeResult);
		if (this.closePromise) return this.closePromise;
		const promise = this.runClose().then((result) => {
			this.closeResult = result;
			this.closePromise = null;
			return result;
		});
		this.closePromise = promise;
		return promise;
	}

	private async runClose(): Promise<ExecutorCloseResult> {
		this.closing = true;
		this.phase = "closing";
		this.stopHeartbeat();
		let process: ExecutorCloseResult["process"] = "retired";
		let ownership: ExecutorCloseResult["ownership"] = "released";
		let runtime: ExecutorCloseResult["runtime"] = "clean";
		const unproven = () => {
			process = "unknown";
			ownership = "held";
			runtime = "unknown";
		};
		if (this.launching) {
			if (this.connection) {
				const retired = await this.retireSide(false).then(
					() => true,
					() => {
						unproven();
						return false;
					},
				);
				if (retired) runtime = "unclean"; // 非优雅退役：Runtime 未干净关闭。
			}
			await this.launching.catch(() => {});
		}
		if (this.retiring) await this.retiring.catch(unproven);
		if (this.connection) {
			try {
				runtime = (await this.retireSide(true)) && this.lastRetirementClean ? "clean" : "unclean";
			} catch {
				unproven();
			}
		}
		if (process === "retired" && !this.connection) {
			try {
				await this.ledger.close();
			} catch {
				runtime = "unknown";
			}
			try {
				this.ownership.close();
			} catch {
				ownership = "held";
			}
			this.phase = "closed";
		} else this.phase = "faulted";
		this.signal?.removeEventListener("abort", this.abortListener);
		return { process, ownership, runtime };
	}
}
