import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

export interface VTSClientOptions {
	url?: string;
	pluginName?: string;
	pluginDeveloper?: string;
	token?: string;
	tokenPath?: string;
	reconnectIntervalMs?: number;
	maxReconnectIntervalMs?: number;
	webSocketFactory?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
	readyState: number;
	send(data: string, cb?: (err?: Error) => void): void;
	close(): void;
	onopen: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
}

export interface VTSParamValue {
	id: string;
	value: number;
	weight?: number;
}

export interface VTSHotkeyInfo {
	name: string;
	hotkeyID: string;
	type?: string;
	description?: string;
	file?: string;
}

export class VTSClient {
	private readonly url: string;
	private readonly pluginName: string;
	private readonly pluginDeveloper: string;
	private authToken?: string;
	private readonly tokenPath: string;
	private readonly baseReconnectMs: number;
	private readonly maxReconnectMs: number;
	private currentReconnectMs: number;
	private readonly wsFactory: (url: string) => WebSocketLike;

	private ws: WebSocketLike | null = null;
	private isConnecting = false;
	private isDisposed = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private isAuthenticated = false;

	private readonly injectableParameters = new Set<string>();
	private readonly filteredParamBuffer: VTSParamValue[] = [];
	private availableHotkeys: VTSHotkeyInfo[] = [];
	private readonly normalizedHotkeyIndex = new Map<string, VTSHotkeyInfo>();

	private requestCounter = 0;
	private readonly pendingRequests = new Map<
		string,
		{ resolve: (data: unknown) => void; reject: (err: Error) => void }
	>();

	private onConnectionChange?: (connected: boolean) => void;

	constructor(options?: VTSClientOptions) {
		this.url = options?.url ?? "ws://127.0.0.1:8001";
		this.pluginName = options?.pluginName ?? "Uina Live2D VTS";
		this.pluginDeveloper = options?.pluginDeveloper ?? "Uina";
		this.authToken = options?.token;
		const localTokenPath = resolve(dirname(fileURLToPath(import.meta.url)), "vts-token.json");
		const homeTokenPath = resolve(process.env.UINA_HOME || homedir(), ".uina", "vts-token.json");
		this.tokenPath =
			options?.tokenPath ??
			(existsSync(localTokenPath) ? localTokenPath : homeTokenPath);
		this.baseReconnectMs = options?.reconnectIntervalMs ?? 1000;
		this.maxReconnectMs = options?.maxReconnectIntervalMs ?? 10000;
		this.currentReconnectMs = this.baseReconnectMs;

		this.wsFactory =
			options?.webSocketFactory ??
			((u: string) => {
				return new WebSocket(u) as unknown as WebSocketLike;
			});
	}

	setConnectionChangeListener(listener: (connected: boolean) => void): void {
		this.onConnectionChange = listener;
	}

	isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === 1 && this.isAuthenticated;
	}

	getInjectableParameters(): ReadonlySet<string> {
		return this.injectableParameters;
	}

	connect(): void {
		if (this.isDisposed || this.ws !== null || this.isConnecting) return;
		this.isConnecting = true;

		try {
			const ws = this.wsFactory(this.url);
			this.ws = ws;

			ws.onopen = async () => {
				this.isConnecting = false;
				try {
					await this.authenticate();
					this.isAuthenticated = true;
					this.currentReconnectMs = this.baseReconnectMs;
					this.onConnectionChange?.(true);
					void this.refreshInjectableParameters();
					void this.refreshModelHotkeys();
				} catch (err) {
					console.error(
						"[Live2D] VTS 握手/鉴权失败:",
						err instanceof Error ? err.message : String(err),
					);
					this.cleanupSocket();
					this.scheduleReconnect();
				}
			};

			ws.onmessage = (event) => {
				this.handleMessage(String(event.data));
			};

			ws.onclose = () => {
				this.cleanupSocket();
				this.scheduleReconnect();
			};

			ws.onerror = () => {
				// onerror 通常伴随 onclose
			};
		} catch (err) {
			console.error(
				"[Live2D] VTS 连接初始化异常:",
				err instanceof Error ? err.message : String(err),
			);
			this.cleanupSocket();
			this.scheduleReconnect();
		}
	}

	private cleanupSocket(): void {
		this.isConnecting = false;
		const wasConnected = this.isAuthenticated;
		this.isAuthenticated = false;
		this.injectableParameters.clear();
		this.availableHotkeys = [];
		this.normalizedHotkeyIndex.clear();
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = null;
		}
		for (const req of this.pendingRequests.values()) {
			req.reject(new Error("VTS connection closed"));
		}
		this.pendingRequests.clear();
		if (wasConnected) {
			this.onConnectionChange?.(false);
		}
	}

	private scheduleReconnect(): void {
		if (this.isDisposed || this.reconnectTimer !== null) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.currentReconnectMs = Math.min(this.currentReconnectMs * 1.5, this.maxReconnectMs);
			this.connect();
		}, this.currentReconnectMs);
	}

	private loadPersistedToken(): string | undefined {
		if (this.authToken) return this.authToken;
		try {
			if (existsSync(this.tokenPath)) {
				const content = readFileSync(this.tokenPath, "utf8").trim();
				if (content) {
					if (content.startsWith("{")) {
						const parsed = JSON.parse(content);
						return parsed.token || parsed.authenticationToken;
					}
					return content;
				}
			}
		} catch {
			// ignore read error
		}
		return undefined;
	}

	private savePersistedToken(token: string): void {
		this.authToken = token;
		try {
			mkdirSync(dirname(this.tokenPath), { recursive: true });
			writeFileSync(
				this.tokenPath,
				JSON.stringify(
					{
						pluginName: this.pluginName,
						pluginDeveloper: this.pluginDeveloper,
						token,
					},
					null,
					2,
				),
				"utf8",
			);
		} catch (err) {
			console.warn("[Live2D] 保存 VTS Token 失败:", err);
		}
	}

	private async authenticate(): Promise<void> {
		let token = this.loadPersistedToken();

		if (token) {
			try {
				const authRes = (await this.sendRequest("AuthenticationRequest", {
					pluginName: this.pluginName,
					pluginDeveloper: this.pluginDeveloper,
					authenticationToken: token,
				})) as { authenticated?: boolean; reason?: string };

				if (authRes?.authenticated) {
					return;
				}
			} catch {
				// 已保存的 Token 失效，回退至重新请求 Token
				token = undefined;
			}
		}

		// 请求新 Token（VTS 将弹出确认框）
		console.log(
			`[Live2D] 正在向 VTube Studio 请求授权，请在 VTS 软件界面中点击【允许 / Allow】...`,
		);
		const tokenRes = (await this.sendRequest("AuthenticationTokenRequest", {
			pluginName: this.pluginName,
			pluginDeveloper: this.pluginDeveloper,
		})) as { authenticationToken?: string };

		if (!tokenRes?.authenticationToken) {
			throw new Error("VTS 未返回有效的授权 Token");
		}

		token = tokenRes.authenticationToken;
		this.savePersistedToken(token);

		// 使用新 Token 鉴权
		const finalAuthRes = (await this.sendRequest("AuthenticationRequest", {
			pluginName: this.pluginName,
			pluginDeveloper: this.pluginDeveloper,
			authenticationToken: token,
		})) as { authenticated?: boolean; reason?: string };

		if (!finalAuthRes?.authenticated) {
			throw new Error(`VTS 鉴权被拒绝: ${finalAuthRes?.reason ?? "未知原因"}`);
		}
	}

	private async refreshInjectableParameters(): Promise<void> {
		try {
			const res = (await this.sendRequest("InputParameterListRequest", {})) as {
				defaultParameters?: Array<{ name?: string }>;
				customParameters?: Array<{ name?: string }>;
			};
			this.injectableParameters.clear();
			for (const key of ["defaultParameters", "customParameters"] as const) {
				const list = res?.[key];
				if (Array.isArray(list)) {
					for (const item of list) {
						if (item?.name) {
							this.injectableParameters.add(item.name);
						}
					}
				}
			}
		} catch (err) {
			if (this.isConnected() && !this.isDisposed) {
				console.warn("[Live2D] 获取 VTS 可注入参数列表失败:", err);
			}
		}
	}

	getAvailableHotkeys(): readonly VTSHotkeyInfo[] {
		return this.availableHotkeys;
	}

	findHotkey(query: string): VTSHotkeyInfo | undefined {
		const q = query.trim();
		if (!q) return undefined;

		// 1. 精确匹配 hotkeyID 或 name
		const exact = this.availableHotkeys.find(
			(h) => h.hotkeyID === q || h.name === q,
		);
		if (exact) return exact;

		// 2. 大小写不敏感匹配
		const lowerQ = q.toLowerCase();
		const ci = this.availableHotkeys.find(
			(h) => h.hotkeyID.toLowerCase() === lowerQ || h.name.toLowerCase() === lowerQ,
		);
		if (ci) return ci;

		// 3. O(1) 预建归一化查表 (消除每次循环正则)
		const normalizedQ = lowerQ.replace(/[\s_-]+/g, "");
		const direct = this.normalizedHotkeyIndex.get(normalizedQ);
		if (direct) return direct;

		// 4. 模糊包含匹配
		return this.availableHotkeys.find((h) => {
			const normName = h.name.toLowerCase().replace(/[\s_-]+/g, "");
			return normName.includes(normalizedQ);
		});
	}

	async refreshModelHotkeys(): Promise<readonly VTSHotkeyInfo[]> {
		if (!this.isConnected()) return [];
		try {
			const res = (await this.sendRequest("HotkeysInCurrentModelRequest", {})) as {
				modelLoaded?: boolean;
				modelName?: string;
				modelID?: string;
				availableHotkeys?: VTSHotkeyInfo[];
			};
			if (Array.isArray(res?.availableHotkeys)) {
				this.availableHotkeys = res.availableHotkeys.map((h) => ({
					name: h.name,
					hotkeyID: h.hotkeyID,
					type: h.type,
					description: h.description,
					file: h.file,
				}));
				this.normalizedHotkeyIndex.clear();
				for (const h of this.availableHotkeys) {
					const norm = h.name.toLowerCase().replace(/[\s_-]+/g, "");
					this.normalizedHotkeyIndex.set(norm, h);
					this.normalizedHotkeyIndex.set(h.hotkeyID.toLowerCase(), h);
				}
			} else {
				this.availableHotkeys = [];
				this.normalizedHotkeyIndex.clear();
			}
		} catch (err) {
			if (this.isConnected() && !this.isDisposed) {
				console.warn("[Live2D] 查询 VTS 当前模型热键失败:", err);
			}
		}
		return this.availableHotkeys;
	}

	private sendRequest(messageType: string, data: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== 1) {
				return reject(new Error("VTS socket not open"));
			}

			const requestID = `req_${++this.requestCounter}_${Date.now()}`;
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestID);
				reject(new Error(`VTS 请求超时: ${messageType}`));
			}, 30000);

			this.pendingRequests.set(requestID, {
				resolve: (res) => {
					clearTimeout(timer);
					resolve(res);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			const payload = {
				apiName: "VTubeStudioPublicAPI",
				apiVersion: "1.0",
				requestID,
				messageType,
				data,
			};

			try {
				this.ws.send(JSON.stringify(payload), (err) => {
					if (err) {
						clearTimeout(timer);
						this.pendingRequests.delete(requestID);
						reject(err);
					}
				});
			} catch (err) {
				clearTimeout(timer);
				this.pendingRequests.delete(requestID);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private handleMessage(raw: string): void {
		if (!raw || !raw.trim()) return;
		try {
			const json = JSON.parse(raw) as {
				requestID?: string;
				messageType?: string;
				data?: unknown;
			};

			if (json.messageType === "APIError") {
				const errData = json.data as { errorID?: number; message?: string } | undefined;
				const errorID = errData?.errorID;
				const message = errData?.message || "VTS API Error";

				if (errorID === 51) {
					console.warn(
						"[Live2D] VTube Studio 授权弹窗已打开，请在 VTS 界面点击【允许 / Allow】以完成连接。",
					);
				} else {
					console.error(`[Live2D] VTS API 报错 (${errorID}): ${message}`);
				}

				if (json.requestID && this.pendingRequests.has(json.requestID)) {
					const req = this.pendingRequests.get(json.requestID)!;
					this.pendingRequests.delete(json.requestID);
					req.reject(new Error(`VTS API Error (${errorID}): ${message}`));
				}
				return;
			}

			if (json.requestID && this.pendingRequests.has(json.requestID)) {
				const req = this.pendingRequests.get(json.requestID)!;
				this.pendingRequests.delete(json.requestID);
				req.resolve(json.data);
			}
		} catch {
			// ignore non-json messages
		}
	}

	/**
	 * 向 VTS 注入合成参数 (非阻塞高频调用，自动过滤未知参数防 453 报错)
	 */
	injectParameters(parameters: readonly VTSParamValue[]): void {
		if (!this.isConnected() || !this.ws) return;

		// 严格过滤：若已知 VTS 参数列表，剔除非追踪参数，防止 453 导致整帧被拒
		let validParameters: readonly VTSParamValue[] = parameters;
		if (this.injectableParameters.size > 0) {
			this.filteredParamBuffer.length = 0;
			for (let i = 0; i < parameters.length; i++) {
				const p = parameters[i]!;
				if (this.injectableParameters.has(p.id)) {
					this.filteredParamBuffer.push(p);
				}
			}
			if (this.filteredParamBuffer.length === 0) return;
			validParameters = this.filteredParamBuffer;
		}

		const payload = {
			apiName: "VTubeStudioPublicAPI",
			apiVersion: "1.0",
			requestID: `inj_${++this.requestCounter}`,
			messageType: "InjectParameterDataRequest",
			data: {
				faceFound: true,
				mode: "set",
				parameterValues: validParameters,
			},
		};

		try {
			this.ws.send(JSON.stringify(payload));
		} catch {
			// 高频帧丢弃防阻塞
		}
	}

	/**
	 * 控制模型在屏幕上的位移、缩放与 360° 旋转 (MoveModelRequest)
	 */
	async moveModel(options: {
		timeInSeconds?: number;
		valuesAreRelativeToModel?: boolean;
		positionX?: number;
		positionY?: number;
		rotation?: number;
		size?: number;
	}): Promise<unknown> {
		return this.sendRequest("MoveModelRequest", {
			timeInSeconds: options.timeInSeconds ?? 0.5,
			valuesAreRelativeToModel: options.valuesAreRelativeToModel ?? true,
			...(options.positionX !== undefined ? { positionX: options.positionX } : {}),
			...(options.positionY !== undefined ? { positionY: options.positionY } : {}),
			...(options.rotation !== undefined ? { rotation: options.rotation } : {}),
			...(options.size !== undefined ? { size: options.size } : {}),
		});
	}

	/**
	 * 触发 VTube Studio 快捷键 (HotkeyTriggerRequest)
	 */
	async triggerHotkey(hotkeyID: string, itemInstanceID?: string): Promise<unknown> {
		return this.sendRequest("HotkeyTriggerRequest", {
			hotkeyID,
			...(itemInstanceID ? { itemInstanceID } : {}),
		});
	}

	disconnect(): void {
		this.isDisposed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.cleanupSocket();
	}
}
