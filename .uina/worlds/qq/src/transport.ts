import { createWebSocketClient, type SnowLumaWebSocketClient, type WebSocketConstructor } from "./vendor/snowluma-sdk/index.js";
import type { QqConnectionConfig } from "./config.js";
import { classifyPlatformReceipt } from "./types.js";

/**
 * OneBot v11 正向 WebSocket 传输（SnowLuma SDK 组合层）。
 * SDK 以源码 vendor（src/vendor/snowluma-sdk，固定 commit 87527cb = v1.14.22）：
 * npm 发布包 dist 的相对导入无扩展名，纯 Node ESM 不可加载；vendor 源码与
 * 仓库快照逐字一致，经 jiti/vitest 的解析器正常工作。
 * 只包装连接、动作调用与事件/raw 订阅；无自动 reply/approve 流程。
 * 超时由 SDK 的 pending 期限表达：request 抛错可能是"请求未到达"也可能是
 * "已到达但回执迟到"——上层不得把 failed 推成确定未执行，迟到回执走 raw。
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

/** 传输窄接口：应用层与测试只依赖此形状，不依赖 SDK 类型。 */
export interface QqTransport {
	start(): Promise<{ selfId: number }>;
	stop(): Promise<void>;
	call(action: string, params?: Record<string, unknown>, signal?: AbortSignal, echo?: string): Promise<TransportCallOutcome>;
	onEvent(handler: TransportEventHandler): () => void;
	onRaw(handler: TransportEventHandler): () => void;
	onStatus(handler: TransportStatusHandler): () => void;
}

export interface TransportOptions {
	readonly connection: QqConnectionConfig;
	/** 测试注入假 WebSocket 构造器；生产缺省。 */
	readonly webSocketFactory?: WebSocketConstructor;
}

export class OneBotTransport implements QqTransport {
	private client: SnowLumaWebSocketClient | null = null;
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

	/** 所有原始入站帧；迟到 echo 回执只在这里可见。 */
	onRaw(handler: TransportEventHandler): () => void {
		this.rawHandlers.add(handler);
		return () => this.rawHandlers.delete(handler);
	}

	get connectionError(): string | null {
		return this.lastConnectionError;
	}

	/** 连接并核验登录身份；返回平台 self_id。 */
	async start(): Promise<{ selfId: number }> {
		const generation = ++this.generation;
		const conn = this.options.connection;
		const client = createWebSocketClient({
			url: conn.url,
			role: conn.role,
			accessToken: conn.accessToken,
			requestTimeoutMs: conn.requestTimeoutMs,
			reconnect: {
				retries: conn.reconnect.retries,
				minDelayMs: conn.reconnect.minDelayMs,
				maxDelayMs: conn.reconnect.maxDelayMs,
			},
			...(this.options.webSocketFactory ? { webSocket: this.options.webSocketFactory } : {}),
		});
		this.client = client;

		client.on("close", () => {
			if (generation !== this.generation) return;
			for (const handler of this.statusHandlers) handler({ connected: false, error: this.lastConnectionError ?? undefined });
		});
		client.on("error", (error) => {
			if (generation !== this.generation) return;
			this.lastConnectionError = error instanceof Error ? error.message : String(error);
		});
		client.on("event", (event) => {
			if (generation !== this.generation) return;
			for (const handler of this.eventHandlers) handler(event);
		});
		client.on("raw", (raw) => {
			if (generation !== this.generation) return;
			for (const handler of this.rawHandlers) handler(raw);
		});

		/** 连接阶段捕获握手关闭信息，失败时让 token/path 不匹配可见。 */
		let closeInfo: { code?: number; reason?: string } | null = null;
		const recordClose = (info: { code?: number; reason?: string }) => {
			closeInfo = info;
		};
		client.on("close", recordClose);

		try {
			await client.connect();
		} catch (error) {
			const info = closeInfo as { code?: number; reason?: string } | null;
			const detail = info ? `close code=${info.code ?? "?"} reason="${info.reason ?? ""}"` : "无 close 信息";
			throw new Error(
				`[qq] 无法与 SnowLuma 握手（${conn.url}）：${detail}。请核对 SnowLuma OneBot 配置的 wsServers 端口/path/accessToken 与 config.json 一致，且该端点为正向 WebSocket（Uina 作客户端）。原始错误：${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		} finally {
			client.off("close", recordClose);
		}
		if (generation !== this.generation) throw new Error("传输已在本轮连接期间被停止");
		const login = await client.request("get_login_info");
		if (login.status !== "ok" || typeof login.data !== "object" || login.data === null) {
			throw new Error(`get_login_info 失败: ${JSON.stringify(login)}`);
		}
		const data = login.data as { user_id?: unknown };
		if (typeof data.user_id !== "number") {
			throw new Error(`get_login_info 未返回 user_id: ${JSON.stringify(login.data)}`);
		}
		for (const handler of this.statusHandlers) handler({ connected: true });
		return { selfId: data.user_id };
	}

	/**
	 * 调用一个 OneBot action；不抛超时/连接错误，用结果类型表达，由上层映射 unknown。
	 * echo 可传入自定义关联值（如 operationRef），迟到回执经 raw 观察后凭它归并。
	 */
	async call(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal, echo?: string): Promise<TransportCallOutcome> {
		const client = this.client;
		if (!client) return { status: "failed", reason: "transport stopped", kind: "not_connected" };
		try {
			const response = await client.request(action as never, params as never, { signal, ...(echo ? { echo } : {}) });
			const conclusion = classifyPlatformReceipt(response);
			if (conclusion === "succeeded") return { status: "ok", data: response.data };
			return { status: "failed", reason: String(response.wording ?? `retcode=${response.retcode}`), kind: conclusion === "failed" ? "rejected" : "unconfirmed" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// SDK 在发送前检查 socket 状态："not open" 是确定未派发；其余（发送后断开/超时）结果未知。
			if (/not open/i.test(message)) return { status: "failed", reason: message, kind: "not_connected" };
			const isTimeout = /timed out|timeout/i.test(message);
			return { status: "failed", reason: message, kind: isTimeout ? "timeout" : "connection" };
		}
	}

	async stop(): Promise<void> {
		this.generation++;
		this.client?.close();
		this.client = null;
	}
}
