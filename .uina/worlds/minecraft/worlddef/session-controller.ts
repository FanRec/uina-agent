/**
 * 唯一会话生命周期拥有者（v3 §6）：串行 connect/disconnect（单一 transition 槽）、
 * 并行游戏操作、visit/Body 端点与状态聚合。Run/Owner/ClientHost 的真实状态仍由
 * Executor 拥有；Controller 只保存 active、transition、closing、lastError。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BODY_ENDPOINT_EXPOSED_PREFIX } from "../../../../src/extensions/world-framework/seams.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { ExecutorCloseResult } from "../contracts/executor.js";
import { MinecraftFacade } from "../executor/facade.js";
import { MinecraftExecutor, type ExecutorPolicy } from "../executor/index.js";
import { RpcError } from "../executor/ipc.js";
import { createBodyEndpoint } from "./body-endpoint.js";
import {
	type ConnectTarget,
	type ProfileIdentity,
	type WorldAssociation,
	ensureIdentityFile,
	executorConfigFromIdentity,
	listProfiles,
	migrateLegacyRoot,
	profileDir,
	profileId,
	readObservedFile,
	readSettings,
	resolveTarget,
	seedSettingsFromLegacy,
	writeObservedFile,
} from "./session-identity.js";

/** 入服等待上限；超时按当前连接事实判失败，不用时间兜底伪装成功。 */
const CONNECT_TIMEOUT_MS = 30_000;

export interface SessionStatus {
	state: "disconnected" | "connecting" | "syncing" | "connected" | "disconnecting" | "faulted";
	active: null | {
		profileId: string;
		visitId: string;
		target: ProfileIdentity;
		connection: "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
		actualUsername: string | null;
		actualUuid: string | null;
		worldAssociation: WorldAssociation;
		executorPhase: "starting" | "ready" | "faulted" | "closing" | "closed";
		actionsAllowed: boolean;
		ownerGates: string[];
		history: "opening" | "ready" | "unavailable";
	};
	operation: null | { kind: "connect" | "disconnect" | "close"; id: string };
	lastError: { code: string; message: string } | null;
	settingsPath: string;
	libraryPath: string;
}

interface ActiveSession {
	profileId: string;
	visitId: string;
	identity: ProfileIdentity;
	sessionDataDir: string;
	worldAssociation: WorldAssociation;
	executor: MinecraftExecutor;
	facade: MinecraftFacade;
	actualUsername: string | null;
	actualUuid: string | null;
	detachBody: () => void;
}

export interface SessionControllerOptions {
	/** 稳定 MC 根：ownershipDir 与 sharedDataDir 同一根（v3 §4.1）。 */
	minecraftRoot: string;
	ctx: ServiceCompanionContext;
	/** Body 端点注册（worlddef 已校验 ctx.expose 存在）。 */
	expose: NonNullable<ServiceCompanionContext["expose"]>;
	executorPolicy?: Partial<ExecutorPolicy>;
	deliveryPolicy?: { shortWindowMs?: number; pollMs?: number };
	/** 旧布局迁移读取的世界包 config.json；可缺席。 */
	legacyConfig?: unknown;
	connectTimeoutMs?: number;
}

function response(value: unknown, status: ToolExecutionResult["status"] = "succeeded"): ToolExecutionResult {
	return { status, result: JSON.stringify(value), details: value };
}

function notConnected(action: string): ToolExecutionResult {
	return response(
		{
			code: "NOT_CONNECTED",
			message: `Minecraft action ${action} needs an active session; use session {op:"connect"} first`,
			nextCall: { action: "session", params: { op: "status" } },
		},
		"not_started",
	);
}

export class SessionController {
	private active: ActiveSession | null = null;
	/** 退役未确认的旧执行域；重试 close 是唯一恢复渠道，不设时间兜底。 */
	private blocked: MinecraftExecutor | null = null;
	private transition: { kind: "connect" | "disconnect" | "close"; id: string } | null = null;
	private settleTransition: (() => void) | null = null;
	private transitionSettled: Promise<void> | null = null;
	private closing = false;
	private closePromise: Promise<void> | null = null;
	private lastError: { code: string; message: string } | null = null;

	constructor(private readonly options: SessionControllerOptions) {}

	/** 旧布局迁移与 settings 种子；在持有任何执行域之前执行。 */
	static async create(options: SessionControllerOptions): Promise<SessionController> {
		const migration = await migrateLegacyRoot(options.minecraftRoot, options.legacyConfig ?? null);
		if (migration.reason) console.warn(`[mc-world] legacy migration skipped: ${migration.reason}`);
		await seedSettingsFromLegacy(options.minecraftRoot, options.legacyConfig ?? null);
		return new SessionController(options);
	}

	/** 当前活动会话摘要；宿主 Library 的 from 保存等只读路由使用。 */
	get session(): { executor: MinecraftExecutor; sessionDataDir: string; profileId: string; visitId: string } | null {
		if (!this.active) return null;
		const { executor, sessionDataDir, profileId, visitId } = this.active;
		return { executor, sessionDataDir, profileId, visitId };
	}

	status(): SessionStatus {
		const executor = this.active?.executor ?? null;
		const st = executor?.status() ?? null;
		const side = st?.side ?? null;
		let state: SessionStatus["state"];
		if (this.transition?.kind === "connect") state = "connecting";
		else if (this.transition?.kind === "disconnect" || this.transition?.kind === "close") state = "disconnecting";
		else if (this.blocked) state = "faulted";
		else if (!st) state = "disconnected";
		else if (st.phase === "faulted") state = "faulted";
		else
			switch (side?.connection) {
				case "ready":
					state = "connected";
					break;
				case "syncing":
					state = "syncing";
					break;
				case "connecting":
					state = "connecting";
					break;
				default:
					// IPC 正常但 Bot 失联，或执行域正在重建：如实显示断开。
					state = "disconnected";
			}
		const historyState = side?.world.history.state;
		return {
			state,
			active:
				this.active && st
					? {
							profileId: this.active.profileId,
							visitId: this.active.visitId,
							target: this.active.identity,
							connection: st.phase === "starting" ? "connecting" : (side?.connection ?? "connecting"),
							actualUsername: this.active.actualUsername,
							actualUuid: this.active.actualUuid,
							worldAssociation: this.active.worldAssociation,
							executorPhase: st.phase,
							// 顶层可受理 = 客户端实际 ready + Executor 允许 + 无管理切换（不保证每个能力环境可用）。
							actionsAllowed: state === "connected" && st.actionsAllowed && !this.transition,
							ownerGates: [...(side?.owner?.gates ?? [])],
							history:
								historyState === "ready" || historyState === "read_only"
									? "ready"
									: historyState === "unavailable"
										? "unavailable"
										: "opening",
						}
					: null,
			operation: this.transition ? { ...this.transition } : null,
			lastError: this.lastError,
			settingsPath: join(this.options.minecraftRoot, "settings.json"),
			libraryPath: join(this.options.minecraftRoot, "library"),
		};
	}

	async list() {
		return await listProfiles(this.options.minecraftRoot);
	}

	async connect(input: ConnectTarget, signal: AbortSignal): Promise<SessionStatus> {
		if (this.closing) throw new RpcError("WORLD_DISABLED", "Minecraft session controller is closing");
		if (this.transition)
			throw new RpcError("SESSION_BUSY", `a ${this.transition.kind} operation is already in progress`);
		if (signal.aborted) throw new RpcError("REQUEST_CANCELLED", "connect cancelled before any effect");
		// 输入侧解析发生在管理槽之前：坏输入不进入管理状态、也不记入 lastError。
		const settings = await readSettings(join(this.options.minecraftRoot, "settings.json"));
		const resolved = resolveTarget(input, settings);
		const tx = this.beginTransition("connect");
		try {
			this.lastError = null;
			const id = profileId(resolved.identity);
			let proceed = true;
			// 同 Profile 且连接仍活着（含重生 syncing）→ 幂等返回；不重连、不绕 Owner Gate。
			if (this.active?.profileId === id) {
				const st = this.active.executor.status();
				if (st.phase === "ready" && ["ready", "syncing", "connecting"].includes(st.side?.connection ?? "")) {
					proceed = false;
				}
			}
			if (proceed) {
				// 旧域收口从这一步开始不可被工具取消打断；完成后由下方取消点决定是否继续新建。
				await this.retireActive();
				await this.confirmBlocked();
				if (signal.aborted || this.closing) proceed = false;
			}
			if (proceed) await this.openVisit(resolved, id, signal);
		} catch (error) {
			const e = error as { code?: string; message?: string };
			this.lastError = { code: e.code ?? "CONNECT_FAILED", message: e.message ?? String(error) };
			throw error;
		} finally {
			this.endTransition(tx);
		}
		// 状态在槽位释放后聚合，避免把进行中的管理操作显示成结果。
		return this.status();
	}

	async disconnect(signal: AbortSignal): Promise<SessionStatus> {
		if (this.closing) throw new RpcError("WORLD_DISABLED", "Minecraft session controller is closing");
		if (this.transition)
			throw new RpcError("SESSION_BUSY", `a ${this.transition.kind} operation is already in progress`);
		if (signal.aborted) throw new RpcError("REQUEST_CANCELLED", "disconnect cancelled before any effect");
		const tx = this.beginTransition("disconnect");
		try {
			this.lastError = null;
			await this.retireActive();
			await this.confirmBlocked();
		} catch (error) {
			const e = error as { code?: string; message?: string };
			this.lastError = { code: e.code ?? "DISCONNECT_FAILED", message: e.message ?? String(error) };
			throw error;
		} finally {
			this.endTransition(tx);
		}
		return this.status();
	}

	/** 游戏动作只作用于当前会话；无活动会话或管理切换中一律 NOT_CONNECTED。 */
	async execute(action: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		if (!this.active || this.transition) return notConnected(action);
		return await this.active.facade.execute(action, params, signal);
	}

	/** World onStop 的最终所有权收口：等待管理操作收口、退役活跃域，不因 SESSION_BUSY 跳过。 */
	close(): Promise<void> {
		return (this.closePromise ??= (async () => {
			this.closing = true;
			const errors: unknown[] = [];
			while (this.transitionSettled) await this.transitionSettled.catch(() => {});
			if (this.active) {
				try {
					await this.retireActive();
				} catch (error) {
					errors.push(error);
				}
			}
			if (this.blocked) {
				try {
					await this.confirmBlocked();
				} catch (error) {
					errors.push(error);
					throw new AggregateError(errors, "Minecraft session controller close failed");
				}
			}
			if (errors.length) throw new AggregateError(errors, "Minecraft session controller close failed");
		})());
	}

	private beginTransition(kind: "connect" | "disconnect" | "close"): { kind: string; id: string } {
		if (this.transition)
			throw new RpcError("SESSION_BUSY", `a ${this.transition.kind} operation is already in progress`);
		this.transitionSettled = new Promise<void>((resolve) => {
			this.settleTransition = resolve;
		});
		const tx = { kind, id: randomUUID() };
		this.transition = tx;
		return tx;
	}

	private endTransition(tx: { kind: string; id: string }): void {
		if (this.transition !== tx) return;
		this.transition = null;
		this.settleTransition?.();
		this.settleTransition = null;
		this.transitionSettled = null;
	}

	private blockedError(result: ExecutorCloseResult): RpcError {
		return new RpcError(
			"SESSION_BLOCKED",
			`old execution domain not proven retired: process=${result.process} ownership=${result.ownership}; retry session.connect to re-confirm`,
		);
	}

	/** blocked 引用的重试收口：人再次发起 connect/disconnect 就是恢复渠道，不靠超时放行。 */
	private async confirmBlocked(): Promise<void> {
		if (!this.blocked) return;
		const result = await this.blocked.close();
		if (result.process !== "retired" || result.ownership !== "released") throw this.blockedError(result);
		this.blocked = null;
	}

	/** 收口当前会话：先摘 Body 端点、停交付与新受理，再退役并核对三事实；未确认保留引用转 blocked。 */
	private async retireActive(): Promise<void> {
		const active = this.active;
		if (!active) return;
		this.active = null;
		try {
			active.detachBody();
			await active.facade.close();
			const closed = await active.executor.close();
			if (closed.process !== "retired" || closed.ownership !== "released") {
				this.blocked = active.executor;
				throw this.blockedError(closed);
			}
		} catch (error) {
			// 端点已摘除；执行域引用必须保留在 blocked，不能让下一次 connect 误以为没有旧客户端。
			this.blocked ??= active.executor;
			throw error;
		}
	}

	private async openVisit(
		resolved: ReturnType<typeof resolveTarget>,
		profile: string,
		signal: AbortSignal,
	): Promise<void> {
		const dir = profileDir(this.options.minecraftRoot, profile);
		await ensureIdentityFile(dir, resolved.identity);
		let candidate: MinecraftExecutor | null = null;
		try {
			candidate = await MinecraftExecutor.open({
				ownershipDir: this.options.minecraftRoot,
				sessionDataDir: dir,
				sharedDataDir: this.options.minecraftRoot,
				config: executorConfigFromIdentity(resolved.identity),
				// 生命周期信号收口新建中的执行域；工具等待取消不是执行域信号。
				signal: this.options.ctx.signal,
				policy: { ...this.options.executorPolicy, autoRecover: false },
			});
			const waited = await candidate.waitGameConnection(this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, signal);
			if (waited.state !== "ready")
				throw new RpcError(
					"CONNECT_FAILED",
					`game connection did not become ready: state=${waited.state}${waited.reason ? ` reason=${waited.reason}` : ""}`,
				);
			if (waited.username !== resolved.identity.principal.username)
				throw new RpcError(
					"IDENTITY_MISMATCH",
					`server login name ${JSON.stringify(waited.username)} differs from requested offline username`,
				);
			// 已保存的非空 UUID 出现矛盾即拒用旧 Profile；不猜 UUID、不中途改绑。
			const observed = await readObservedFile(dir);
			if (observed?.lastVisit?.uuid && waited.uuid && observed.lastVisit.uuid !== waited.uuid)
				throw new RpcError(
					"PROFILE_IDENTITY_CONFLICT",
					"observed server UUID differs from a previous visit on this profile; choose a new slot",
				);
			const visitId = randomUUID();
			await writeObservedFile(dir, {
				schemaVersion: 1,
				lastVisit: { visitId, at: new Date().toISOString(), username: waited.username, uuid: waited.uuid },
			});
			const facade = new MinecraftFacade(candidate, this.options.ctx, this.options.deliveryPolicy);
			const body = createBodyEndpoint(candidate, `minecraft:${visitId}`);
			const detachBody = this.options.expose(`${BODY_ENDPOINT_EXPOSED_PREFIX}${body.bodyId}`, body);
			facade.start();
			this.active = {
				profileId: profile,
				visitId,
				identity: resolved.identity,
				sessionDataDir: dir,
				worldAssociation: resolved.worldAssociation,
				executor: candidate,
				facade,
				actualUsername: waited.username,
				actualUuid: waited.uuid,
				detachBody,
			};
			candidate = null;
		} catch (error) {
			// 半初始化候选域退役；不吞所有权退役失败。
			if (candidate) {
				const closed = await candidate.close().catch((closeError: unknown) => {
					this.blocked = candidate;
					throw closeError instanceof Error ? closeError : new Error(String(closeError));
				});
				if (closed.process !== "retired" || closed.ownership !== "released") {
					this.blocked = candidate;
					throw this.blockedError(closed);
				}
			}
			throw error;
		}
	}
}

export { response as sessionResponse, notConnected as sessionNotConnected };
