import { loadModelAdapterDefinition, suggestModelAdapter } from "./model-adapter.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadModelProfile, profileFilesUnchanged, type ModelProfile, type ModelInput } from "./model-profile.js";

export interface VTSClientOptions {
	url?: string;
	pluginName?: string;
	pluginDeveloper?: string;
	token?: string;
	tokenPath?: string;
	reconnectIntervalMs?: number;
	maxReconnectIntervalMs?: number;
	modelsRoot?: string;
	profileLoader?: (modelID: string) => Promise<ModelProfile>;
	webSocketFactory?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
	readyState: number;
	bufferedAmount?: number;
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
	private stage = "未启动";
	private handshakeTimer?: NodeJS.Timeout;
	private isDisposed = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private isAuthenticated = false;
	private ready = false;
	private connectionGeneration = 0;

	private readonly injectableParameters = new Set<string>();
	private readonly filteredParamBuffer: VTSParamValue[] = [];
	private availableHotkeys: VTSHotkeyInfo[] = [];

	private requestCounter = 0;
	private readonly pendingRequests = new Map<
		string,
		{ resolve: (data: unknown) => void; reject: (err: Error) => void }
	>();

	private modelProfile?: ModelProfile;
	private inputFacts: ModelInput[] = [];
	private observationTimer?: NodeJS.Timeout;
	private blockedModelID?: string;
	private lastInjectionAttemptAt = 0;
	private validationPending?: Promise<boolean>;
	private readonly injectionStats = { sent: 0, accepted: 0, failed: 0, dropped: 0, filtered: 0, lastAcceptedAt: 0 };
	getInjectionStats() {
		return { ...this.injectionStats, generation: this.connectionGeneration };
	}
	async validateModelFiles(): Promise<boolean> {
		if (!this.modelProfile) return false;
		if (this.validationPending) return this.validationPending;
		const profile = this.modelProfile,
			generation = this.connectionGeneration;
		this.validationPending = profileFilesUnchanged(profile)
			.then((ok) => {
				if (generation !== this.connectionGeneration) return false;
				if (!ok) {
					this.blockedModelID = profile.modelID;
					this.fault = "模型配置已变化，需要重新加载 VTS 模型";
					this.cleanupSocket();
					this.scheduleReconnect();
				}
				return ok;
			})
			.finally(() => {
				this.validationPending = undefined;
			});
		return this.validationPending;
	}
	async createInput(input: { name: string; min: number; max: number; defaultValue: number }): Promise<void> {
		if (!this.isAuthenticated) throw new Error("VTS 未鉴权");
		await this.sendRequest("ParameterCreationRequest", {
			parameterName: input.name,
			explanation: "Uina declarative motion input",
			min: input.min,
			max: input.max,
			defaultValue: input.defaultValue,
		});
		await this.refreshInjectableParameters();
	}

	private fault?: string;
	private injectionPending?: string;
	private injectionTimer?: NodeJS.Timeout;
	private readonly profileLoader: (modelID: string) => Promise<ModelProfile>;
	private onConnectionChange?: (connected: boolean) => void;

	constructor(options?: VTSClientOptions) {
		this.profileLoader = options?.profileLoader ?? ((id) => loadModelProfile(id, options?.modelsRoot));
		this.url = options?.url ?? "ws://127.0.0.1:8001";
		this.pluginName = options?.pluginName ?? "Uina Live2D VTS";
		this.pluginDeveloper = options?.pluginDeveloper ?? "Uina";
		this.authToken = options?.token;
		const localTokenPath = resolve(dirname(fileURLToPath(import.meta.url)), "vts-token.json");
		const homeTokenPath = resolve(process.env.UINA_HOME || homedir(), ".uina", "vts-token.json");
		this.tokenPath = options?.tokenPath ?? (existsSync(localTokenPath) ? localTokenPath : homeTokenPath);
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
		return this.ws !== null && this.ws.readyState === 1 && this.ready;
	}

	getModelProfile(): ModelProfile | undefined {
		return this.modelProfile;
	}
	getFault(): string | undefined {
		return this.fault;
	}

	getConnectionStatus(): {
		endpoint: string;
		apiConnected: boolean;
		authenticated: boolean;
		ready: boolean;
		stage: string;
		fault?: string;
	} {
		return {
			endpoint: this.url,
			apiConnected: this.ws?.readyState === 1,
			authenticated: this.isAuthenticated,
			ready: this.isConnected(),
			stage: this.stage,
			fault: this.fault,
		};
	}

	connect(): void {
		this.isDisposed = false;
		if (this.ws !== null || this.isConnecting) return;
		this.isConnecting = true;
		this.stage = "连接 API";
		const generation = ++this.connectionGeneration;

		try {
			const ws = this.wsFactory(this.url);
			this.ws = ws;
			this.handshakeTimer = setTimeout(() => {
				if (generation !== this.connectionGeneration || this.ws !== ws) return;
				this.fault ??= `VTS API 连接超时: ${this.url}`;
				this.cleanupSocket();
				this.scheduleReconnect();
			}, 5000);

			ws.onopen = async () => {
				if (generation !== this.connectionGeneration || this.ws !== ws) return;
				if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
				this.handshakeTimer = undefined;
				this.isConnecting = false;
				try {
					this.stage = "鉴权（可能等待 VTS 授权）";
					await this.authenticate();
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.isAuthenticated = true;
					this.stage = "订阅模型切换";
					await this.sendRequest("EventSubscriptionRequest", { eventName: "ModelLoadedEvent", subscribe: true });
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.currentReconnectMs = this.baseReconnectMs;
					this.stage = "读取输入参数";
					await this.refreshInjectableParameters();
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.stage = "读取当前模型";
					const model = (await this.sendRequest("CurrentModelRequest", {})) as {
						modelLoaded?: boolean;
						modelID?: string;
					};
					if (!model.modelLoaded || !model.modelID) throw new Error("VTS 当前未加载模型。");
					if (this.blockedModelID === model.modelID) {
						this.fault = "保存配置已变化，等待 VTS 重新加载模型确认";
						this.stage = "等待模型重新加载";
						return;
					}
					this.stage = "读取模型保存绑定";
					const profile = await this.profileLoader(model.modelID);
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.stage = "读取模型真实范围";
					const live = (await this.sendRequest("Live2DParameterListRequest", {})) as {
						parameters?: Array<{ name: string; min: number; max: number; defaultValue: number }>;
					};
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					const parameterRanges = Object.fromEntries(
						(live.parameters ?? [])
							.filter(
								(p) =>
									typeof p.name === "string" &&
									[p.min, p.max, p.defaultValue].every(Number.isFinite) &&
									p.min < p.max &&
									p.defaultValue >= p.min &&
									p.defaultValue <= p.max,
							)
							.map((p) => [p.name, { min: p.min, max: p.max, defaultValue: p.defaultValue }]),
					);
					if (!Object.keys(parameterRanges).length) throw new Error("VTS 未提供模型真实参数范围。");
					this.modelProfile = { ...profile, inputs: this.inputFacts, parameterRanges };
					this.modelProfile.adapterDefinition =
						profile.adapterDefinition ??
						(profile.directory
							? await loadModelAdapterDefinition(this.modelProfile)
							: suggestModelAdapter(this.modelProfile));
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					await this.refreshModelSources();
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.fault = undefined;
					if (profile.directory) {
						const state = (await this.sendRequest("APIStateRequest", {}, 3000)) as { vTubeStudioVersion?: string };
						if (generation !== this.connectionGeneration || this.ws !== ws) return;
						this.modelProfile = { ...this.modelProfile!, vtsVersion: state.vTubeStudioVersion };
					}
					this.stage = "读取模型热键";
					await this.refreshModelHotkeys();
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.ready = true;
					this.stage = "可控制";
					this.onConnectionChange?.(true);
					let observing = false;
					this.observationTimer = setInterval(() => {
						if (observing || !this.isConnected()) return;
						observing = true;
						void this.observeModel()
							.catch((error) => {
								if (generation === this.connectionGeneration) {
									this.fault = String(error);
									this.cleanupSocket();
									this.scheduleReconnect();
								}
							})
							.finally(() => {
								observing = false;
							});
					}, 1000);
				} catch (err) {
					if (generation !== this.connectionGeneration || this.ws !== ws) return;
					this.fault = `${this.stage}: ${err instanceof Error ? err.message : String(err)}`;
					console.error("[Live2D] VTS 初始化失败:", err instanceof Error ? err.message : String(err));
					if (generation === this.connectionGeneration) this.cleanupSocket();
					this.scheduleReconnect();
				}
			};

			ws.onmessage = (event) => {
				if (generation !== this.connectionGeneration || this.ws !== ws) return;
				this.handleMessage(String(event.data));
			};

			ws.onclose = () => {
				if (generation !== this.connectionGeneration || this.ws !== ws) return;
				this.fault ??= "VTS API 连接关闭";
				this.cleanupSocket();
				this.scheduleReconnect();
			};

			// Record transport errors. The ws EventEmitter also requires an error listener.
			ws.onerror = (event) => {
				if (generation !== this.connectionGeneration || this.ws !== ws) return;
				const error = event as { message?: string };
				this.fault = `VTS API 连接错误: ${error.message ?? "无法连接"} (${this.url})`;
			};
		} catch (err) {
			this.fault = err instanceof Error ? err.message : String(err);
			console.error("[Live2D] VTS 连接初始化异常:", err instanceof Error ? err.message : String(err));
			this.cleanupSocket();
			this.scheduleReconnect();
		}
	}

	private cleanupSocket(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
		this.isConnecting = false;
		const wasConnected = this.ready;
		if (this.observationTimer) clearInterval(this.observationTimer);
		this.observationTimer = undefined;
		this.lastInjectionAttemptAt = 0;
		this.ready = false;
		this.connectionGeneration++;
		this.modelProfile = undefined;
		this.injectionPending = undefined;
		if (this.injectionTimer) clearTimeout(this.injectionTimer);
		this.injectionTimer = undefined;
		this.isAuthenticated = false;
		this.injectableParameters.clear();
		this.inputFacts = [];
		this.availableHotkeys = [];
		const socket = this.ws;
		this.ws = null;
		if (socket) {
			try {
				socket.close();
			} catch {
				// ignore
			}
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
		this.stage = "等待重连";
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
		const generation = this.connectionGeneration;
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

		if (generation !== this.connectionGeneration) throw new Error("VTS connection changed");
		// 请求新 Token（VTS 将弹出确认框）
		console.log(`[Live2D] 正在向 VTube Studio 请求授权，请在 VTS 软件界面中点击【允许 / Allow】...`);
		const tokenRes = (await this.sendRequest("AuthenticationTokenRequest", {
			pluginName: this.pluginName,
			pluginDeveloper: this.pluginDeveloper,
		})) as { authenticationToken?: string };

		if (!tokenRes?.authenticationToken) {
			throw new Error("VTS 未返回有效的授权 Token");
		}

		if (generation !== this.connectionGeneration) throw new Error("VTS connection changed");
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
		const generation = this.connectionGeneration;
		const result = (await this.sendRequest("InputParameterListRequest", {})) as {
			defaultParameters?: ModelInput[];
			customParameters?: ModelInput[];
		};
		if (generation !== this.connectionGeneration) throw new Error("VTS 连接已更换。");
		this.inputFacts = [
			...(result.defaultParameters ?? []).map((i) => ({ ...i, custom: false })),
			...(result.customParameters ?? []).map((i) => ({ ...i, custom: true })),
		];
		this.injectableParameters.clear();
		for (const item of this.inputFacts) if (item.name) this.injectableParameters.add(item.name);

		if (this.injectableParameters.size === 0) throw new Error("VTS 参数清单为空。");
	}

	private async refreshModelSources(): Promise<void> {
		const profile = this.modelProfile;
		if (!profile?.directory) return;
		const generation = this.connectionGeneration;
		const physics = (await this.sendRequest("GetCurrentModelPhysicsRequest", {}, 3000)) as {
			modelID?: string;
			physicsSwitchedOn?: boolean;
			modelHasPhysics?: boolean;
		};
		if (generation !== this.connectionGeneration) return;
		if (physics.modelID !== profile.modelID) throw new Error("VTS 活动物理身份未核验");
		const enabled = physics.physicsSwitchedOn === true && physics.modelHasPhysics === true;
		const outputs = enabled
			? [
					...new Set(
						(profile.physicsGroups ?? []).flatMap((g) => g.outputs.filter((o) => o.weight !== 0).map((o) => o.id)),
					),
				]
			: [];
		if (JSON.stringify(outputs) !== JSON.stringify(profile.physicsOutputs)) {
			this.modelProfile = { ...profile, physicsState: physics, physicsOutputs: outputs };
			if (this.ready) this.onConnectionChange?.(true);
		} else if (JSON.stringify(profile.physicsState) !== JSON.stringify(physics))
			this.modelProfile = { ...profile, physicsState: physics };
		const activeProfile = this.modelProfile;
		if (!activeProfile?.sources?.some((source) => source.kind === "expression")) return;
		const result = (await this.sendRequest("ExpressionStateRequest", { details: true }, 3000)) as {
			modelID?: string;
			expressions?: { file: string; active: boolean; parameters?: { name: string }[] }[];
		};
		if (generation !== this.connectionGeneration) return;
		if (result.modelID !== profile.modelID || !Array.isArray(result.expressions))
			throw new Error("VTS 活动表情事实未核验");
		const active = result.expressions
			.filter((e) => e.active)
			.map((e) => e.file)
			.sort();
		if (JSON.stringify(active) !== JSON.stringify(activeProfile.activeExpressions)) {
			this.modelProfile = {
				...activeProfile,
				activeExpressions: active,
				sources: [
					...(activeProfile.sources ?? []).filter((s) => s.kind !== "expression"),
					...result.expressions.map((e) => ({
						file: e.file,
						kind: "expression" as const,
						parameters: (e.parameters ?? []).map((p) => p.name),
					})),
				],
			};
			if (this.ready) this.onConnectionChange?.(true);
		}
	}
	private async observeModel(): Promise<void> {
		if (!(await this.validateModelFiles())) return;
		if (
			this.lastInjectionAttemptAt &&
			Date.now() - this.injectionStats.lastAcceptedAt > 1000 &&
			this.injectionStats.lastAcceptedAt
		)
			throw new Error("VTS 输入控制已超时，来源可能已交还");
		await this.refreshModelSources();
	}

	getAvailableHotkeys(): readonly VTSHotkeyInfo[] {
		return this.availableHotkeys;
	}

	findHotkey(query: string): VTSHotkeyInfo | undefined {
		const q = query.trim();
		if (!q) return undefined;

		// 两级匹配：精确（hotkeyID / name）→ 大小写不敏感。
		// 热键表只有个位数条目且不在热路径，归一化索引与模糊包含匹配是过度设计。
		const exact = this.availableHotkeys.find((h) => h.hotkeyID === q || h.name === q);
		if (exact) return exact;

		const lowerQ = q.toLowerCase();
		return this.availableHotkeys.find((h) => h.hotkeyID.toLowerCase() === lowerQ || h.name.toLowerCase() === lowerQ);
	}

	private async refreshModelHotkeys(): Promise<void> {
		const generation = this.connectionGeneration;
		const res = (await this.sendRequest("HotkeysInCurrentModelRequest", {})) as {
			availableHotkeys?: VTSHotkeyInfo[];
		};
		if (generation !== this.connectionGeneration) return;
		this.availableHotkeys = (res.availableHotkeys ?? []).map((h) => ({
			name: h.name,
			hotkeyID: h.hotkeyID,
			type: h.type,
			description: h.description,
			file: h.file,
		}));
	}

	private sendRequest(messageType: string, data: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== 1) {
				return reject(new Error("VTS socket not open"));
			}

			const requestID = `req_${++this.requestCounter}_${Date.now()}`;
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestID);
				reject(new Error(`VTS 请求超时: ${messageType}`));
			}, timeoutMs);

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

			if (json.messageType === "ModelLoadedEvent") {
				this.blockedModelID = undefined;
				this.fault = "模型已切换，重新读取绑定";
				this.cleanupSocket();
				this.scheduleReconnect();
				return;
			}
			if (this.injectionPending && json.requestID === this.injectionPending) {
				if (json.messageType === "InjectParameterDataResponse") {
					this.injectionStats.accepted++;
					this.injectionStats.lastAcceptedAt = Date.now();
				} else this.injectionStats.failed++;
				this.injectionPending = undefined;
				if (this.injectionTimer) clearTimeout(this.injectionTimer);
				this.injectionTimer = undefined;
				if (json.messageType === "APIError") {
					this.fault = `VTS 参数注入失败: ${JSON.stringify(json.data)}`;
					this.cleanupSocket();
					this.scheduleReconnect();
				}
				return;
			}
			if (json.messageType === "APIError") {
				const errData = json.data as { errorID?: number; message?: string } | undefined;
				const errorID = errData?.errorID;
				const message = errData?.message || "VTS API Error";

				if (errorID === 51) {
					console.warn("[Live2D] VTube Studio 授权弹窗已打开，请在 VTS 界面点击【允许 / Allow】以完成连接。");
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
		if (parameters.length) this.lastInjectionAttemptAt = Date.now();
		if (!this.isConnected() || !this.ws || this.injectionPending || (this.ws.bufferedAmount ?? 0) > 0) {
			this.injectionStats.dropped++;
			return;
		}
		// ready 已包含参数清单核验；每帧仍过滤未知输入和非有限值。
		this.filteredParamBuffer.length = 0;
		for (const p of parameters) {
			if (this.injectableParameters.has(p.id) && Number.isFinite(p.value)) {
				this.filteredParamBuffer.push(p);
			} else this.injectionStats.filtered++;
		}
		if (this.filteredParamBuffer.length === 0) return;

		const payload = {
			apiName: "VTubeStudioPublicAPI",
			apiVersion: "1.0",
			requestID: `inj_${++this.requestCounter}`,
			messageType: "InjectParameterDataRequest",
			data: {
				faceFound: true,
				mode: "set",
				parameterValues: this.filteredParamBuffer,
			},
		};

		try {
			this.injectionStats.sent++;
			this.injectionPending = payload.requestID;
			this.injectionTimer = setTimeout(() => {
				this.injectionStats.failed++;
				this.fault = "VTS 参数注入确认超时";
				this.cleanupSocket();
				this.scheduleReconnect();
			}, 1000);
			const generation = this.connectionGeneration;
			this.ws.send(JSON.stringify(payload), (error) => {
				if (error && generation === this.connectionGeneration) {
					this.injectionStats.failed++;
					this.fault = error.message;
					this.cleanupSocket();
					this.scheduleReconnect();
				}
			});
		} catch {
			this.cleanupSocket();
			this.scheduleReconnect();
		}
	}

	/**
	 * 控制模型在屏幕上的位移、缩放与 360° 旋转 (MoveModelRequest)
	 */
	async getModelPosition(): Promise<{ positionX: number; positionY: number; rotation: number; size: number }> {
		const data = (await this.sendRequest("CurrentModelRequest", {}, 3000)) as {
			modelPosition?: { positionX: number; positionY: number; rotation: number; size: number };
		};
		if (
			!data.modelPosition ||
			![
				data.modelPosition.positionX,
				data.modelPosition.positionY,
				data.modelPosition.rotation,
				data.modelPosition.size,
			].every(Number.isFinite)
		)
			throw new Error("VTS 未提供模型位置。");
		return data.modelPosition;
	}
	async moveModel(options: {
		timeInSeconds?: number;
		valuesAreRelativeToModel?: boolean;
		positionX?: number;
		positionY?: number;
		rotation?: number;
		size?: number;
	}): Promise<unknown> {
		return this.sendRequest(
			"MoveModelRequest",
			{
				timeInSeconds: options.timeInSeconds ?? 0.5,
				valuesAreRelativeToModel: options.valuesAreRelativeToModel ?? true,
				...(options.positionX !== undefined ? { positionX: options.positionX } : {}),
				...(options.positionY !== undefined ? { positionY: options.positionY } : {}),
				...(options.rotation !== undefined ? { rotation: options.rotation } : {}),
				...(options.size !== undefined ? { size: options.size } : {}),
			},
			1000,
		);
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
		this.stage = "已停止";
		this.connectionGeneration++;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.cleanupSocket();
	}
}
