/**
 * 多前端同步协议与客户端（平台中立，无 IO）。
 *
 * 线上有两个动词：observe（snapshot/fact）与 intent。连接生命周期 = 同步生命周期：
 * 快照是唯一修复原语，重连即快照，无游标（TCP 内消息有序不丢，进程内同步派发不丢）。
 * 协议是产品、传输是一次性的：消息语义不携带任何传输特征。
 *
 * 本模块只做三件事：消息形状（编解码 + 结构校验，两个方向共用一份合同）、
 * 注入式传输接口、SyncClient 状态机（connect → hello → snapshot(restore) → tail）。
 * 意图词表见 actions.ts；服务端策略（鉴权/限流/背压）属网关，不在这里。
 */

import type { HostEventRecord, HostSnapshot } from "../host/events.js";
import type { PresentationIntent } from "./actions.js";
import type { PresentationController } from "./controller.js";
import { toReadableError } from "./copy.js";
import type { PresentationNode } from "./projection.js";
import type { TrajectoryNode } from "./trajectory.js";

export const SYNC_PROTOCOL_VERSION = 1;

/** 线上视图：与 PresentationView 同构的纯 JSON 形状。 */
export interface SyncView {
	readonly transcript: readonly PresentationNode[];
	readonly trajectory: readonly TrajectoryNode[];
	readonly session?: HostSnapshot;
}

/** 客户端 → 网关。hello 是唯一握手；意图无 ack（fire-and-forget，结果以事实回流）。 */
export type SyncClientMessage =
	| {
			readonly v: typeof SYNC_PROTOCOL_VERSION;
			readonly kind: "hello";
			readonly auth: string;
			readonly client: string;
			readonly capabilities: readonly string[];
	  }
	| { readonly v: typeof SYNC_PROTOCOL_VERSION; readonly kind: "intent"; readonly intent: PresentationIntent };

/** 网关 → 客户端。版本匹配下未知 kind = 协议违约（响亮失败，不静默吞）。 */
export type SyncServerMessage =
	| { readonly v: typeof SYNC_PROTOCOL_VERSION; readonly kind: "snapshot"; readonly view: SyncView }
	| { readonly v: typeof SYNC_PROTOCOL_VERSION; readonly kind: "fact"; readonly record: HostEventRecord }
	| { readonly v: typeof SYNC_PROTOCOL_VERSION; readonly kind: "error"; readonly message: string };

export function encodeClientMessage(message: SyncClientMessage): string {
	return JSON.stringify(message);
}

export function encodeServerMessage(message: SyncServerMessage): string {
	return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 客户端消息结构校验：形状合格才放行；深度信任由网关的意图校验与宿主事实承担。 */
export function parseClientMessage(data: string): SyncClientMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.v !== SYNC_PROTOCOL_VERSION) return undefined;
	switch (parsed.kind) {
		case "hello":
			return typeof parsed.auth === "string" && typeof parsed.client === "string" && Array.isArray(parsed.capabilities)
				? {
						v: SYNC_PROTOCOL_VERSION,
						kind: "hello",
						auth: parsed.auth,
						client: parsed.client,
						capabilities: parsed.capabilities.filter((item): item is string => typeof item === "string"),
					}
				: undefined;
		case "intent": {
			const intent = parseIntent(parsed.intent);
			return intent === undefined ? undefined : { v: SYNC_PROTOCOL_VERSION, kind: "intent", intent };
		}
		default:
			return undefined;
	}
}

/** 网关消息结构校验：载荷形状只在信封层验证（view/record 是宿主侧信任数据）。 */
export function parseServerMessage(data: string): SyncServerMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.v !== SYNC_PROTOCOL_VERSION) return undefined;
	switch (parsed.kind) {
		case "snapshot":
			return isRecord(parsed.view)
				? { v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: parsed.view as unknown as SyncView }
				: undefined;
		case "fact":
			return isRecord(parsed.record)
				? { v: SYNC_PROTOCOL_VERSION, kind: "fact", record: parsed.record as unknown as HostEventRecord }
				: undefined;
		case "error":
			return typeof parsed.message === "string"
				? { v: SYNC_PROTOCOL_VERSION, kind: "error", message: parsed.message }
				: undefined;
		default:
			return undefined;
	}
}

/** PresentationIntent 的结构校验（穷尽动作词表）：网关转发前的唯一闸门。 */
export function parseIntent(value: unknown): PresentationIntent | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "input.submit":
			return typeof value.text === "string" &&
				(value.mode === "direct" || value.mode === "steer" || value.mode === "followUp")
				? { type: "input.submit", text: value.text, mode: value.mode }
				: undefined;
		case "turn.interruptAndDeliver":
			return typeof value.text === "string" ? { type: "turn.interruptAndDeliver", text: value.text } : undefined;
		case "turn.cancel":
			return value.source === "escape" || value.source === "ctrl+c"
				? { type: "turn.cancel", source: value.source }
				: { type: "turn.cancel" };
		case "queue.pullBack":
			return { type: "queue.pullBack" };
		case "thinking.cycle":
			return { type: "thinking.cycle" };
		case "ui.interaction":
			return { type: "ui.interaction" };
		default:
			return undefined;
	}
}

/** 注入式双工传输：ws、内存管道、未来的 localhost IPC 都实现这一个形状。 */
export interface SyncTransport {
	send(data: string): void;
	close(): void;
	onMessage(handler: (data: string) => void): void;
	onClose(handler: () => void): void;
}

const DEFAULT_BACKOFF_MS = (attempt: number): number => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));

/** 时间调度注入：presentation 不持有钟表（展示层静态约束），退避定时由消费方提供。 */
export interface SyncScheduler {
	/** delayMs 后执行 fn；返回取消函数。 */
	schedule(delayMs: number, fn: () => void): () => void;
}

export interface SyncClientOptions {
	readonly auth: string;
	readonly client: string;
	readonly capabilities?: readonly string[];
	/** 重连退避（毫秒）；默认 500ms 指数退避封顶 30s。 */
	readonly backoffMs?: (attempt: number) => number;
	/** 定时调度器（宿主事件循环定时器的中立包装；测试可注入受控时钟）。 */
	readonly scheduler: SyncScheduler;
	/** 诊断出口：重连与协议违约必须可见，绝不静默。 */
	readonly onError?: (text: string) => void;
}

export type SyncClientState = "stopped" | "connecting" | "synced";

/**
 * 客户端同步状态机：任何疑虑（断开、解析失败、时序违约）的唯一处理是断开重连，
 * 重连即快照。快照以视图空间 restore 进控制器，后续事实 ingest——与 TUI 直连
 * 跑同一套 PresentationController（投影大脑只有一份）。
 */
export class SyncClient {
	private transport?: SyncTransport;
	private reconnectCancel?: () => void;
	private attempt = 0;
	private stopped = false;
	private stateValue: SyncClientState = "stopped";

	constructor(
		private readonly controller: PresentationController,
		private readonly connect: () => SyncTransport | Promise<SyncTransport>,
		private readonly options: SyncClientOptions,
	) {}

	get state(): SyncClientState {
		return this.stateValue;
	}

	start(): void {
		if (this.stateValue !== "stopped") return;
		this.stopped = false;
		this.open();
	}

	stop(): void {
		this.stopped = true;
		this.reconnectCancel?.();
		this.reconnectCancel = undefined;
		this.transport?.close();
		this.transport = undefined;
		this.stateValue = "stopped";
	}

	/** 已同步时可发送意图；未同步返回 false（意图无队列，重试是调用方的呈现层决策）。 */
	sendIntent(intent: PresentationIntent): boolean {
		if (this.stateValue !== "synced" || this.transport === undefined) return false;
		this.transport.send(encodeClientMessage({ v: SYNC_PROTOCOL_VERSION, kind: "intent", intent }));
		return true;
	}

	private open(): void {
		this.stateValue = "connecting";
		void Promise.resolve()
			.then(this.connect)
			.then((transport) => {
				if (this.stopped) {
					transport.close();
					return;
				}
				this.transport = transport;
				this.attempt = 0;
				transport.onMessage((data) => this.receive(data));
				transport.onClose(() => this.scheduleReconnect());
				transport.send(
					encodeClientMessage({
						v: SYNC_PROTOCOL_VERSION,
						kind: "hello",
						auth: this.options.auth,
						client: this.options.client,
						capabilities: this.options.capabilities ?? [],
					}),
				);
			})
			.catch((error: unknown) => {
				this.options.onError?.(`sync: 连接失败：${toReadableError(error)}`);
				this.scheduleReconnect();
			});
	}

	private receive(data: string): void {
		const message = parseServerMessage(data);
		if (message === undefined) {
			this.violate("无法解析的服务器消息");
			return;
		}
		switch (message.kind) {
			case "snapshot":
				this.controller.restore(message.view);
				this.stateValue = "synced";
				return;
			case "fact":
				if (this.stateValue !== "synced") {
					this.violate("快照之前收到事实");
					return;
				}
				this.controller.ingest(message.record);
				return;
			case "error":
				this.options.onError?.(`sync: ${message.message}`);
				return;
		}
	}

	/** 协议违约：响亮报错并断开——重连即快照，不需要任何带内修复机制。 */
	private violate(reason: string): void {
		this.options.onError?.(`sync: ${reason}，重连`);
		this.transport?.close();
	}

	private scheduleReconnect(): void {
		this.transport = undefined;
		this.stateValue = "connecting";
		if (this.stopped) return;
		const delay = Math.max(0, (this.options.backoffMs ?? DEFAULT_BACKOFF_MS)(this.attempt++));
		this.reconnectCancel = this.options.scheduler.schedule(delay, () => {
			if (!this.stopped) this.open();
		});
	}
}
