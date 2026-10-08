import { randomUUID } from "node:crypto";
import { createWebSocketClient, type SnowLumaWebSocketClient, type WebSocketConstructor } from "./vendor/snowluma-sdk/index.js";
import type { QqConnectionConfig } from "./config.js";
import { classifyPlatformReceipt } from "./types.js";
import type { WebSocketLike } from "./vendor/snowluma-sdk/client/websocket-types.js";

/**
 * OneBot v11 正向 WebSocket 传输（SnowLuma SDK 组合层）。
 * SDK 以源码 vendor（src/vendor/snowluma-sdk，固定 commit 87527cb = v1.14.22）：
 * npm 发布包 dist 的相对导入无扩展名，纯 Node ESM 不可加载；vendor 源码与
 * 仓库快照逐字一致，经 jiti/vitest 的解析器正常工作。
 * 只包装连接、动作调用与事件/raw 订阅；无自动 reply/approve 流程。
 * 每轮连接、身份校验与动作等待都有期限。socket.send 已开始后出现超时、取消
 * 或断连时结果未知，不自动重发；当前已核验连接上的迟到回执仍经 raw 可见。
 */

export type TransportCallOutcome =
	| { readonly status: "ok"; readonly data: unknown }
	| {
			readonly status: "failed";
			readonly reason: string;
			/** rejected=平台明确拒绝；not_connected=确定未派发；timeout/connection=可能已派发，结果未知。 */
			readonly kind: "rejected" | "unconfirmed" | "timeout" | "connection" | "not_connected";
	  };

export type TransportEventHandler = (event: unknown) => void;
export type TransportStatusHandler = (status: { connected: boolean; error?: string }) => void;

export interface TransportConnectionSnapshot {
	readonly connected: boolean;
	readonly identityVerified: boolean;
	readonly selfId: string | null;
	readonly observedAt: string;
	readonly lastError: string | null;
}

/** 传输窄接口：应用层与测试只依赖此形状，不依赖 SDK 类型。 */
export interface QqTransport {
	start(signal?: AbortSignal): Promise<{ selfId: number }>;
	stop(): Promise<void>;
	call(action: string, params?: Record<string, unknown>, signal?: AbortSignal, echo?: string): Promise<TransportCallOutcome>;
	onEvent(handler: TransportEventHandler): () => void;
	onRaw(handler: TransportEventHandler): () => void;
	onStatus(handler: TransportStatusHandler): () => void;
	snapshot?(): TransportConnectionSnapshot;
}

export interface TransportOptions {
	readonly connection: QqConnectionConfig;
	/** 测试注入假 WebSocket 构造器；生产缺省。 */
	readonly webSocketFactory?: WebSocketConstructor;
	readonly expectedSelfId?: string;
}

interface ConnectionAttempt {
	readonly client: SnowLumaWebSocketClient;
	readonly abort: AbortController;
	readonly dispatched: Set<string>;
	verified: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One deadline covers connection, identity verification and the request receipt. */
async function withDeadline<T>(timeoutMs: number, signals: AbortSignal[], operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error(`QQ request timed out after ${timeoutMs}ms`)), timeoutMs);
	const signal = AbortSignal.any([...signals, deadline.signal]);
	let aborted: (() => void) | undefined;
	try {
		signal.throwIfAborted();
		return await new Promise<T>((resolve, reject) => {
			aborted = (): void => reject(signal.reason ?? new Error("QQ request aborted"));
			signal.addEventListener("abort", aborted, { once: true });
			operation(signal).then(resolve, reject);
		});
	} finally {
		clearTimeout(timer);
		if (aborted) signal.removeEventListener("abort", aborted);
	}
}

export class OneBotTransport implements QqTransport {
	private attempt: ConnectionAttempt | null = null;
	private lifetime: AbortController | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private started = false;
	private selfId: string | null = null;
	private observedAt = new Date().toISOString();
	private readonly readyWaiters = new Set<() => void>();
	private readonly statusHandlers = new Set<TransportStatusHandler>();
	private readonly eventHandlers = new Set<TransportEventHandler>();
	private readonly rawHandlers = new Set<TransportEventHandler>();
	private generation = 0;
	/** 最近一次连接失败原因（供 status 诊断）。 */
	private lastConnectionError: string | null = null;

	constructor(private readonly options: TransportOptions) {}

	onStatus(handler: TransportStatusHandler): () => void {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
	}

	onEvent(handler: TransportEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	/** 当前已核验连接的原始入站帧；迟到 echo 回执只在这里可见。 */
	onRaw(handler: TransportEventHandler): () => void {
		this.rawHandlers.add(handler);
		return () => this.rawHandlers.delete(handler);
	}

	get connectionError(): string | null {
		return this.lastConnectionError;
	}

	snapshot(): TransportConnectionSnapshot {
		const connected = this.attempt?.client.isConnected === true && this.lifetime?.signal.aborted === false;
		const identityVerified = connected && this.attempt?.verified === true;
		return { connected, identityVerified, selfId: this.selfId, observedAt: this.observedAt, lastError: this.lastConnectionError };
	}

	private publish(connected: boolean, error: string | null = this.lastConnectionError): void {
		this.lastConnectionError = error;
		this.observedAt = new Date().toISOString();
		for (const waiter of this.readyWaiters) waiter();
		for (const handler of this.statusHandlers) handler({ connected, ...(error ? { error } : {}) });
	}

	/** 连接并核验登录身份；返回平台 self_id。 */
	async start(signal?: AbortSignal): Promise<{ selfId: number }> {
		void this.stop();
		const generation = this.generation;
		const lifetime = new AbortController();
		this.lifetime = lifetime;
		this.lastConnectionError = null;
		this.reconnectAttempts = 0;
		try {
			const selfId = await this.connectAttempt(generation, signal);
			lifetime.signal.throwIfAborted();
			this.started = true;
			return { selfId };
		} catch (error) {
			if (generation === this.generation) {
				lifetime.abort(error);
				this.publish(false, errorMessage(error));
			}
			throw error;
		}
	}

	private async connectAttempt(generation: number, externalSignal?: AbortSignal): Promise<number> {
		const conn = this.options.connection;
		const lifetime = this.lifetime!;
		lifetime.signal.throwIfAborted();
		const abort = new AbortController();
		const dispatched = new Set<string>();
		const Socket = this.options.webSocketFactory ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
		let socketCreated = false;
		let attempt: ConnectionAttempt;
		// SDK request() auto-connects. A client owns exactly one socket, so a call
		// cannot silently reconnect and bypass this attempt's identity verification.
		const webSocket: WebSocketConstructor = class {
			constructor(url: string, protocols?: string | string[]) {
				if (socketCreated || abort.signal.aborted || generation !== transport.generation) throw new Error("QQ WebSocket is not open");
				socketCreated = true;
				const socket = new Socket(url, protocols);
				return {
					get readyState() { return socket.readyState; },
					close: (code?: number, reason?: string) => socket.close(code, reason),
					send: (raw: string) => {
						if (abort.signal.aborted || generation !== transport.generation || transport.attempt !== attempt) throw new Error("QQ WebSocket is not open");
						const frame = JSON.parse(raw) as { echo: string };
						dispatched.add(frame.echo);
						socket.send(raw);
					},
					addEventListener: socket.addEventListener?.bind(socket),
					removeEventListener: socket.removeEventListener?.bind(socket),
					on: socket.on?.bind(socket),
					off: socket.off?.bind(socket),
					removeListener: socket.removeListener?.bind(socket),
				} satisfies WebSocketLike;
			}
		} as WebSocketConstructor;
		const transport = this;
		const client = createWebSocketClient({
			url: conn.url,
			role: conn.role,
			accessToken: conn.accessToken,
			requestTimeoutMs: conn.requestTimeoutMs,
			reconnect: false,
			webSocket,
		});
		attempt = { client, abort, dispatched, verified: false };
		this.attempt = attempt;
		const current = (): boolean => generation === this.generation && this.attempt === attempt && !lifetime.signal.aborted;
		let closeInfo: { code?: number; reason?: string } | null = null;
		let opened = false;

		client.on("close", (info) => {
			if (!current()) return;
			closeInfo = info;
			attempt.verified = false;
			abort.abort(new Error(`QQ connection closed: code=${info.code ?? "?"} reason="${info.reason ?? ""}"`));
			this.publish(false, errorMessage(abort.signal.reason));
			if (this.started) this.scheduleReconnect(generation);
		});
		client.on("error", (error) => {
			if (!current()) return;
			this.lastConnectionError = errorMessage(error);
			this.observedAt = new Date().toISOString();
		});
		client.on("event", (event) => {
			if (!current() || !attempt.verified) return;
			for (const handler of this.eventHandlers) handler(event);
		});
		client.on("raw", (raw) => {
			if (!current() || !attempt.verified) return;
			for (const handler of this.rawHandlers) handler(raw);
		});

		try {
			return await withDeadline(conn.requestTimeoutMs, [lifetime.signal, abort.signal, ...(externalSignal ? [externalSignal] : [])], async (signal) => {
				await client.connect();
				signal.throwIfAborted();
				opened = true;
				const login = await client.request("get_login_info", undefined, { signal });
				signal.throwIfAborted();
				if (!current() || !client.isConnected) throw new Error("QQ connection changed during identity verification");
				if (classifyPlatformReceipt(login) !== "succeeded" || typeof login.data !== "object" || login.data === null) {
					throw new Error(`get_login_info 失败: ${JSON.stringify(login)}`);
				}
				const id = (login.data as { user_id?: unknown }).user_id;
				if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("get_login_info 未返回有效 user_id");
				const expected = this.options.expectedSelfId ?? this.selfId;
				if (expected !== null && expected !== undefined && expected !== String(id)) {
					const error = new Error(`QQ identity mismatch: expected=${expected}, observed=${id}`);
					lifetime.abort(error);
					throw error;
				}
				this.selfId = String(id);
				attempt.verified = true;
				this.reconnectAttempts = 0;
				this.publish(true, null);
				return id;
			});
		} catch (error) {
			abort.abort(error);
			if (this.attempt === attempt) {
				this.attempt = null;
				this.publish(false, errorMessage(error));
			}
			client.close();
			if (opened) throw error;
			const info = closeInfo as { code?: number; reason?: string } | null;
			const detail = info ? `close code=${info.code ?? "?"} reason="${info.reason ?? ""}"` : "无 close 信息";
			throw new Error(`[qq] 无法与 SnowLuma 握手（${conn.url}）：${detail}。请核对 SnowLuma OneBot 配置的 wsServers 端口/path/accessToken 与 config.json 一致，且该端点为正向 WebSocket（Uina 作客户端）。原始错误：${errorMessage(error)}`, { cause: error });
		}
	}

	private scheduleReconnect(generation: number): void {
		if (generation !== this.generation || !this.lifetime || this.lifetime.signal.aborted || this.reconnectTimer) return;
		const config = this.options.connection.reconnect;
		if (this.reconnectAttempts >= config.retries) return;
		const delay = Math.min(config.maxDelayMs, config.minDelayMs * 2 ** this.reconnectAttempts++);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (generation !== this.generation || this.lifetime?.signal.aborted) return;
			void this.connectAttempt(generation).catch(() => this.scheduleReconnect(generation));
		}, delay);
	}

	private waitForReady(signal: AbortSignal): Promise<ConnectionAttempt> {
		return new Promise((resolve, reject) => {
			const cleanup = (): void => {
				this.readyWaiters.delete(check);
				signal.removeEventListener("abort", cancelled);
			};
			const cancelled = (): void => {
				cleanup();
				reject(signal.reason ?? new Error("QQ request aborted"));
			};
			const check = (): void => {
				if (signal.aborted) return cancelled();
				if (this.attempt?.verified && this.attempt.client.isConnected) {
					cleanup();
					resolve(this.attempt);
				}
			};
			this.readyWaiters.add(check);
			signal.addEventListener("abort", cancelled, { once: true });
			check();
		});
	}

	/**
	 * 调用一个 OneBot action；不抛超时/连接错误，用结果类型表达，由上层映射 unknown。
	 * echo 可传入自定义关联值（如 operationRef），迟到回执经 raw 观察后凭它归并。
	 */
	async call(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal, echo?: string): Promise<TransportCallOutcome> {
		const lifetime = this.lifetime;
		if (!lifetime || lifetime.signal.aborted) return { status: "failed", reason: this.lastConnectionError ?? "transport stopped", kind: "not_connected" };
		let attempt: ConnectionAttempt | null = null;
		const requestEcho = echo ?? `qq:${this.generation}:${randomUUID()}`;
		try {
			const response = await withDeadline(this.options.connection.requestTimeoutMs, [lifetime.signal, ...(signal ? [signal] : [])], async (boundedSignal) => {
				attempt = await this.waitForReady(boundedSignal);
				boundedSignal.throwIfAborted();
				return attempt.client.request(action as never, params as never, { signal: boundedSignal, echo: requestEcho });
			});
			const conclusion = classifyPlatformReceipt(response);
			if (conclusion === "succeeded") return { status: "ok", data: response.data };
			return { status: "failed", reason: String(response.wording ?? `retcode=${response.retcode}`), kind: conclusion === "failed" ? "rejected" : "unconfirmed" };
		} catch (error) {
			const message = errorMessage(error);
			if (!(attempt as ConnectionAttempt | null)?.dispatched.has(requestEcho)) return { status: "failed", reason: message, kind: "not_connected" };
			const isTimeout = /timed out|timeout/i.test(message);
			return { status: "failed", reason: message, kind: isTimeout ? "timeout" : "connection" };
		} finally {
			(attempt as ConnectionAttempt | null)?.dispatched.delete(requestEcho);
		}
	}

	async stop(): Promise<void> {
		this.generation++;
		this.started = false;
		this.lifetime?.abort(new Error("QQ transport stopped"));
		this.lifetime = null;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		const attempt = this.attempt;
		this.attempt = null;
		attempt?.abort.abort(new Error("QQ transport stopped"));
		attempt?.client.close();
		this.observedAt = new Date().toISOString();
	}
}
