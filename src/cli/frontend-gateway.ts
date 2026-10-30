/**
 * 多前端网关：把宿主的两个公开面（输入入口 + 有序事实流）搬到线上，
 * 只服务 observe / intent 两个动词。
 *
 * 落位证据（设计文档 §3.3 据此修正）：扩展 pi API 拿不到 HostEventRecord.at、
 * snapshot()（队列）、interrupt 与 operator 来源标注——经扩展激活是功能降级，
 * 网关必须由组合根直达 UinaHost 公开面。
 *
 * 同步纪律（连接生命周期 = 同步生命周期）：hello 即快照，握手期缓冲有界，
 * 背压超限即断开（客户端重连即快照）；无游标、无带内修复。
 * 策略（token、绑定地址、文本上限）在本文件收口，宿主不感知"远端"概念。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { errorMessage } from "../core/errors.js";
import type { InputSource } from "../core/types.js";
import type { HostEventRecord } from "../host/events.js";
import type { UinaHost } from "../host/host.js";
import { PresentationController } from "../presentation/controller.js";
import { sanitizeExternal } from "../presentation/sanitize.js";
import {
	encodeServerMessage,
	parseClientMessage,
	SYNC_PROTOCOL_VERSION,
	type SyncServerMessage,
} from "../presentation/sync.js";

const MAX_TEXT_LENGTH = 32_768;
/** 握手期事实缓冲上限：正常瞬间排空；超限说明客户端握手后彻底停滞，丢弃并靠重连自愈。 */
const MAX_HANDSHAKE_BUFFER = 256;
/** ws 背压上限：超过即断开——慢客户端的唯一处理是重连拿新快照。 */
const BACKPRESSURE_LIMIT = 8 * 1024 * 1024;

interface GatewayClient {
	id: string;
	label: string;
	joined: boolean;
	buffer: HostEventRecord[];
	send: (data: string) => boolean;
}

/**
 * 传输无关的网关核心：订阅宿主、维护自己的 PresentationController、
 * 管理会话与扇出。ws/内存传输只是两个适配器——一致性测试走内存适配器。
 */
export class FrontendGatewayCore {
	private readonly clients = new Map<string, GatewayClient>();
	private readonly controller = new PresentationController();
	private readonly detach: () => void;

	constructor(
		private readonly host: UinaHost,
		private readonly token: string,
		private readonly onError?: (text: string) => void,
	) {
		// 先建恢复基线再订阅：两步之间无 await，单线程派发保证无事件窗口。
		this.controller.replaceAll(host.restoredEntries, host.restoredAuxiliary);
		this.detach = host.onEventRecord((record) => {
			// 回溯不是增量事实（ingestLive 对它返回空）：与 TUI 消费者同构地整段重建，
			// 并对已接入客户端就地推新快照——客户端对 snapshot 幂等 restore，无需新消息种。
			if (record.event.type === "session_rewind") {
				const rewind = record.event;
				this.controller.replaceAll(rewind.entries, this.host.auxiliaryEntries(), rewind.turnNumber);
				for (const client of this.clients.values()) {
					if (client.joined) {
						this.send(client, { v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: this.controller.view() });
					}
				}
				return;
			}
			this.controller.ingest(record);
			for (const client of this.clients.values()) {
				if (!client.joined) {
					if (client.buffer.length < MAX_HANDSHAKE_BUFFER) client.buffer.push(record);
					continue;
				}
				this.dispatchFact(client, record);
			}
		});
	}

	/** 连接建立（尚未握手）。send 返回 false 表示背压超限，适配器负责断开。 */
	attachConnection(send: (data: string) => boolean): string {
		const id = randomUUID();
		this.clients.set(id, { id, label: "", joined: false, buffer: [], send });
		return id;
	}

	handleMessage(clientId: string, data: string): void {
		const client = this.clients.get(clientId);
		if (client === undefined) return;
		const message = parseClientMessage(data);
		if (message === undefined) {
			this.reject(client, "无法解析的消息");
			return;
		}
		if (message.kind === "hello") {
			if (client.joined) {
				this.reject(client, "重复握手");
				return;
			}
			if (!this.tokensMatch(message.auth)) {
				this.reject(client, "鉴权失败");
				return;
			}
			client.label = sanitizeExternal(message.client).slice(0, 40) || "remote";
			client.joined = true;
			// 快照与缓冲排空之间无 await：单线程派发保证割界原子（先到缓冲、后进扇出）。
			// session 是 join 时刻的会话状态基线；此后由各 Surface 经状态事实自行维护。
			this.controller.applySnapshot(this.host.snapshot());
			this.send(client, { v: SYNC_PROTOCOL_VERSION, kind: "snapshot", view: this.controller.view() });
			for (const record of client.buffer.splice(0)) this.dispatchFact(client, record);
			return;
		}
		if (!client.joined) {
			this.reject(client, "未握手，意图不受理");
			return;
		}
		void this.dispatchIntent(client, message.intent);
	}

	handleClose(clientId: string): void {
		this.clients.delete(clientId);
	}

	/** 当前视图（诊断与一致性测试用）。 */
	view() {
		return this.controller.view();
	}

	dispose(): void {
		this.detach();
		this.clients.clear();
	}

	private send(client: GatewayClient, message: SyncServerMessage): void {
		client.send(encodeServerMessage(message));
	}

	private reject(client: GatewayClient, message: string): void {
		this.send(client, { v: SYNC_PROTOCOL_VERSION, kind: "error", message });
	}

	private dispatchFact(client: GatewayClient, record: HostEventRecord): void {
		this.send(client, { v: SYNC_PROTOCOL_VERSION, kind: "fact", record });
	}

	private tokensMatch(presented: string): boolean {
		const expected = createHash("sha256").update(this.token).digest();
		const received = createHash("sha256").update(presented).digest();
		return timingSafeEqual(expected, received);
	}

	private async dispatchIntent(
		client: GatewayClient,
		intent: import("../presentation/actions.js").PresentationIntent,
	): Promise<void> {
		const source: InputSource = {
			kind: "user",
			type: "operator",
			origin: "external",
			channel: `gateway:${client.id}`,
			actor: { id: client.id, label: client.label, relation: "operator" },
		};
		try {
			switch (intent.type) {
				case "input.submit": {
					const text = intent.text.trim();
					if (text.length === 0) {
						this.reject(client, "空输入不提交");
						return;
					}
					if (text.length > MAX_TEXT_LENGTH) {
						this.reject(client, `输入超过 ${MAX_TEXT_LENGTH} 字符上限`);
						return;
					}
					if (text.startsWith("/")) {
						this.reject(client, "远程端暂不支持斜杠命令，请在本机终端使用");
						return;
					}
					await this.host.submitText(text, intent.mode, source);
					return;
				}
				case "turn.cancel":
					if (this.host.isBusy()) this.host.interrupt();
					return;
				case "turn.interruptAndDeliver": {
					const text = intent.text.trim();
					this.host.interrupt();
					void this.host
						.waitForIdle()
						.then(async () => {
							if (text.length > 0) await this.host.pushInput(text, "followUp");
						})
						.catch((error: unknown) => {
							this.onError?.(`网关投递失败：${errorMessage(error)}`);
						});
					return;
				}
				case "queue.pullBack":
					this.reject(client, "远程端暂不支持队列撤回，请在本机终端操作");
					return;
				case "thinking.cycle":
					if (!this.host.snapshot().thinkingLevels?.length) {
						this.reject(client, "当前 Provider 未提供 thinking 能力元数据，无法循环档位");
						return;
					}
					this.host.cycleThinkingLevel();
					return;
				case "ui.interaction":
					return;
			}
		} catch (error) {
			this.reject(client, `意图被拒：${errorMessage(error)}`);
		}
	}
}

export interface FrontendGatewayServer {
	readonly url: string;
	readonly token: string;
	readonly tokenPath: string;
	dispose(): Promise<void>;
}

const STATIC_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

export interface FrontendGatewayOptions {
	host: UinaHost;
	port: number;
	hostname: string;
	/** token 与静态页产物所在的宿主数据目录。 */
	dataDir: string;
	/** 浏览器薄面产物目录（dist/web）；缺省时不服务静态页。 */
	staticRoot?: string;
	onError?: (text: string) => void;
}

/**
 * 启动网关：每次启用重新生成 token（落 0600），默认只绑回环——出本机是
 * 调用方的显式选择，本函数只在非回环绑定时经 onError 提示。
 */
export async function startFrontendGateway(options: FrontendGatewayOptions): Promise<FrontendGatewayServer> {
	const token = randomBytes(24).toString("base64url");
	const tokenPath = join(options.dataDir, "gateway-token");
	await mkdir(options.dataDir, { recursive: true });
	await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
	const core = new FrontendGatewayCore(options.host, token, options.onError);

	const httpServer: Server = createServer((req, res) => {
		void serveStatic(req, res, options.staticRoot);
	});
	const wss = new WebSocketServer({ noServer: true });
	httpServer.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => attachSocket(core, ws));
	});
	if (options.hostname !== "127.0.0.1" && options.hostname !== "localhost") {
		options.onError?.(
			`网关绑定在 ${options.hostname}（非回环）：任何拿到 token 的设备都能在此机器上执行命令，请确认这是显式选择。`,
		);
	}
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(options.port, options.hostname, () => resolve());
	});
	return {
		url: `http://${options.hostname}:${options.port}/`,
		token,
		tokenPath,
		dispose: async () => {
			core.dispose();
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

function attachSocket(core: FrontendGatewayCore, ws: WebSocket): void {
	const send = (data: string): boolean => {
		if (ws.readyState !== WebSocket.OPEN) return false;
		if (ws.bufferedAmount > BACKPRESSURE_LIMIT) {
			ws.close();
			return false;
		}
		ws.send(data);
		return true;
	};
	const clientId = core.attachConnection(send);
	ws.on("message", (data) => {
		core.handleMessage(clientId, data.toString());
	});
	ws.on("close", () => core.handleClose(clientId));
	ws.on("error", () => ws.close());
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, staticRoot: string | undefined): Promise<void> {
	if (req.method !== "GET" || staticRoot === undefined) {
		res.writeHead(req.method === "GET" ? 404 : 405, { "content-type": "text/plain; charset=utf-8" });
		res.end(staticRoot === undefined ? "网关未配置静态页（缺 dist/web 产物，请先 pnpm build）" : "");
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	let pathname = decodeURIComponent(url.pathname);
	if (pathname === "/") pathname = "/index.html";
	const resolved = normalize(join(staticRoot, pathname));
	// 前缀必须贴着分隔符比：否则兄弟目录（webx）能绕过 web 的边界。
	const rootWithSep = normalize(staticRoot).endsWith(sep) ? normalize(staticRoot) : normalize(staticRoot) + sep;
	if (!resolved.startsWith(rootWithSep) && resolved !== normalize(staticRoot)) {
		res.writeHead(403);
		res.end();
		return;
	}
	try {
		const body = await readFile(resolved);
		res.writeHead(200, { "content-type": STATIC_TYPES[extname(resolved)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("无页面产物：请先运行 pnpm build");
	}
}
