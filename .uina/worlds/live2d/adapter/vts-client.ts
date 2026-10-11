import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadModelProfile, controlFilesUnchanged, type ModelProfile, type ModelInput } from "./profile.js";

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

export interface MotionInjectionEvidence {
	generation: number;
	sent: number;
	accepted: number;
	failed: number;
	dropped: number;
	filtered: number;
	pending: number;
	acceptedInputs: readonly string[];
}
interface InjectionObservation extends Omit<MotionInjectionEvidence, "acceptedInputs"> {
	acceptedInputs: Set<string>;
	settled?: () => void;
}
interface PendingInjection {
	id: string;
	observations: readonly { observation: InjectionObservation; inputs: readonly string[] }[];
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
	private modelGeneration = 0;
	private blockedAt = 0;
	getModelGeneration(): number {
		return this.modelGeneration;
	}

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
	private authDenied = false;
	private validationPending?: Promise<boolean>;
	private readonly injectionStats = { sent: 0, accepted: 0, failed: 0, dropped: 0, filtered: 0, lastAcceptedAt: 0 };
	getInjectionStats() {
		return { ...this.injectionStats, generation: this.connectionGeneration };
	}
	private readonly injectionObservations = new Map<string, InjectionObservation>();
	/** A request captures its contributors at SEND time; a later ACK cannot credit a newer playback. */
	observeMotionInjections(leaseID: string): {
		snapshot(): MotionInjectionEvidence;
		finish(): Promise<MotionInjectionEvidence>;
		close(): void;
	} {
		if (this.injectionObservations.has(leaseID)) throw new Error("Duplicate injection observation: " + leaseID);
		const observation: InjectionObservation = {
			generation: this.connectionGeneration,
			sent: 0,
			accepted: 0,
			failed: 0,
			dropped: 0,
			filtered: 0,
			pending: 0,
			acceptedInputs: new Set(),
		};
		this.injectionObservations.set(leaseID, observation);
		const close = () => this.injectionObservations.delete(leaseID);
		const snapshot = (): MotionInjectionEvidence => {
			const { acceptedInputs, settled: _, ...counts } = observation;
			return { ...counts, acceptedInputs: [...acceptedInputs] };
		};
		return {
			close,
			snapshot,
			finish: async () => {
				close();
				// Only drain this playback's existing request; its normal injection timeout bounds the wait.
				if (observation.pending)
					await new Promise<void>((resolve) => {
						observation.settled = resolve;
					});
				return snapshot();
			},
		};
	}
	private completeInjection(accepted: boolean): void {
		const pending = this.injectionPending;
		if (!pending) return;
		this.injectionPending = undefined;
		if (this.injectionTimer) clearTimeout(this.injectionTimer);
		this.injectionTimer = undefined;
		if (accepted) {
			this.injectionStats.accepted++;
			this.injectionStats.lastAcceptedAt = Date.now();
		} else this.injectionStats.failed++;
		for (const { observation, inputs } of pending.observations) {
			observation.pending--;
			if (accepted) {
				observation.accepted++;
				for (const input of inputs) observation.acceptedInputs.add(input);
			} else observation.failed++;
			if (!observation.pending) observation.settled?.();
		}
	}
	async validateModelFiles(): Promise<boolean> {
		if (!this.modelProfile) return false;
		if (this.validationPending) return this.validationPending;
		const profile = this.modelProfile,
			generation = this.connectionGeneration;
		this.validationPending = controlFilesUnchanged(profile)
			.then((ok) => {
				if (generation !== this.connectionGeneration) return false;
				if (!ok) {
					this.blockedModelID = profile.modelID;
					this.blockedAt = Date.now();
					this.fault = "控制配置已变化；请执行 reload，不必等待丢失的事件。";
					this.ready = false;
					this.stage = "需要重新加载模型";
					this.onConnectionChange?.(false);
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

	async request(messageType: string, data: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.isAuthenticated) throw new Error("VTS 未鉴权");
		return this.sendRequest(messageType, data, 5000);
	}
	async reloadCurrentModel(): Promise<void> {
		const id = this.blockedModelID ?? this.modelProfile?.modelID;
		if (!id) throw new Error("没有可重新加载的模型");
		// Explicit unload/load crosses a witnessed boundary even when the old event was lost.
		await this.request("ModelLoadRequest", { modelID: "" });
		await new Promise((resolve) => setTimeout(resolve, 2200));
		const deadline = Date.now() + 8000;
		while (!this.getConnectionStatus().authenticated && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 50));
		await this.request("ModelLoadRequest", { modelID: id });
	}

	private fault?: string;
	private injectionPending?: PendingInjection;
	private injectionTimer?: NodeJS.Timeout;
	private readonly profileLoader: (modelID: string) => Promise<ModelProfile>;
	private onConnectionChange?: (connected: boolean) => void;

	constructor(options?: VTSClientOptions) {
		this.profileLoader = options?.profileLoader ?? ((id) => loadModelProfile(id, options?.modelsRoot));
		this.url = options?.url ?? "ws://127.0.0.1:8001";
		this.pluginName = options?.pluginName ?? "Uina Live2D VTS";
		this.pluginDeveloper = options?.pluginDeveloper ?? "Uina";
		this.authToken = options?.token;
		// 移植差异（唯一）：本模块已移入 adapter/ 子目录，token 文件保持在世界根目录以延续既有凭据与 .gitignore 约定。
		const localTokenPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "vts-token.json");
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
						timeSinceModelLoaded?: number;
					};
					if (!model.modelLoaded || !model.modelID) throw new Error("VTS 当前未加载模型。");
					if (
						this.blockedModelID === model.modelID &&
						!(
							Number.isFinite(model.timeSinceModelLoaded) &&
							Date.now() - model.timeSinceModelLoaded! * 1000 > this.blockedAt + 250
						)
					) {
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
					this.stage = "设备事实就绪";
					this.modelGeneration++;
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
		this.ready = false;
		this.completeInjection(false);
		this.injectionObservations.clear();
		this.connectionGeneration++;
		this.modelProfile = undefined;
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
		// 授权被用户明确拒绝后不再自动重连：重连只会重新弹窗，恢复需要重启 Live2D 应用。
		if (this.authDenied) {
			this.stage = "授权被拒绝，等待手动重启";
			return;
		}
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
			if (!existsSync(this.tokenPath)) return undefined;
			const content = readFileSync(this.tokenPath, "utf8").trim();
			if (!content) return undefined;
			if (content.startsWith("{")) {
				const parsed = JSON.parse(content);
				return parsed.token || parsed.authenticationToken;
			}
			return content;
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
				const authRes = await this.authenticateToken(token);

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
		let tokenRes: { authenticationToken?: string };
		try {
			tokenRes = (await this.sendRequest("AuthenticationTokenRequest", {
				pluginName: this.pluginName,
				pluginDeveloper: this.pluginDeveloper,
			})) as { authenticationToken?: string };
		} catch (error) {
			// 用户在 VTS 弹窗拒绝授权：立即停止自动重连，否则退避循环会每隔几秒再次弹窗骚扰用户。
			if (error instanceof Error && error.message.includes("VTS API Error")) {
				this.authDenied = true;
				this.stage = "授权被拒绝";
				throw new Error("VTS 授权请求被拒绝，已停止自动重连（避免反复弹窗）；重启 Live2D 应用后重试。");
			}
			throw error;
		}

		if (!tokenRes?.authenticationToken) {
			throw new Error("VTS 未返回有效的授权 Token");
		}

		if (generation !== this.connectionGeneration) throw new Error("VTS connection changed");
		token = tokenRes.authenticationToken;
		this.savePersistedToken(token);

		// 使用新 Token 鉴权
		const finalAuthRes = await this.authenticateToken(token);

		if (!finalAuthRes?.authenticated) {
			throw new Error(`VTS 鉴权被拒绝: ${finalAuthRes?.reason ?? "未知原因"}`);
		}
	}

	private authenticateToken(token: string): Promise<{ authenticated?: boolean; reason?: string }> {
		return this.sendRequest("AuthenticationRequest", {
			pluginName: this.pluginName,
			pluginDeveloper: this.pluginDeveloper,
			authenticationToken: token,
		}) as Promise<{ authenticated?: boolean; reason?: string }>;
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
		// 刷新设备事实不触发连接回调，避免把事实变化误当重连。
		if (JSON.stringify(outputs) !== JSON.stringify(profile.physicsOutputs)) {
			this.modelProfile = { ...profile, physicsState: physics, physicsOutputs: outputs };
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
		}
	}
	private async observeModel(): Promise<void> {
		if (!(await this.validateModelFiles())) return;
		// 注入无响应的传输故障由注入 1s 超时与 socket 生命周期兜底，这里不做 teardown 级回应。
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
				this.modelGeneration++;
				this.ready = false;
				this.onConnectionChange?.(false);
				this.fault = "模型已切换，重新读取绑定";
				const generation = this.connectionGeneration;
				setTimeout(() => {
					if (generation === this.connectionGeneration) {
						this.cleanupSocket();
						this.scheduleReconnect();
					}
				}, 50);
				return;
			}
			if (this.injectionPending && json.requestID === this.injectionPending.id) {
				this.completeInjection(json.messageType === "InjectParameterDataResponse");
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

				const req = json.requestID ? this.pendingRequests.get(json.requestID) : undefined;
				if (req && json.requestID) {
					this.pendingRequests.delete(json.requestID);
					req.reject(new Error(`VTS API Error (${errorID}): ${message}`));
				}
				return;
			}

			const req = json.requestID ? this.pendingRequests.get(json.requestID) : undefined;
			if (req && json.requestID) {
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
	injectParameters(
		parameters: readonly VTSParamValue[],
		contributions: readonly { leaseID: string; inputs: readonly string[] }[] = [],
	): void {
		const observations = contributions.flatMap(({ leaseID, inputs }) => {
			const observation = this.injectionObservations.get(leaseID);
			return observation && inputs.length ? [{ observation, inputs }] : [];
		});
		if (!this.isConnected() || !this.ws || this.injectionPending || (this.ws.bufferedAmount ?? 0) > 0) {
			this.injectionStats.dropped++;
			for (const { observation } of observations) observation.dropped++;
			return;
		}
		// ready 已包含参数清单核验；每帧仍过滤未知输入和非有限值。
		this.filteredParamBuffer.length = 0;
		for (const p of parameters) {
			if (this.injectableParameters.has(p.id) && Number.isFinite(p.value)) {
				this.filteredParamBuffer.push(p);
			} else this.injectionStats.filtered++;
		}
		const injectedInputs = new Set(this.filteredParamBuffer.map((p) => p.id));
		for (const { observation, inputs } of observations)
			observation.filtered += inputs.filter((input) => !injectedInputs.has(input)).length;
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
			const sentObservations = observations
				.map(({ observation, inputs }) => ({
					observation,
					inputs: inputs.filter((input) => injectedInputs.has(input)),
				}))
				.filter(({ inputs }) => inputs.length > 0);
			for (const { observation } of sentObservations) {
				observation.sent++;
				observation.pending++;
			}
			this.injectionPending = { id: payload.requestID, observations: sentObservations };
			this.injectionTimer = setTimeout(() => {
				this.fault = "VTS 参数注入确认超时";
				this.cleanupSocket();
				this.scheduleReconnect();
			}, 1000);
			const generation = this.connectionGeneration;
			this.ws.send(JSON.stringify(payload), (error) => {
				if (error && generation === this.connectionGeneration && this.injectionPending?.id === payload.requestID) {
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
	async getModelPosition(
		expectedModelID?: string,
	): Promise<{ positionX: number; positionY: number; rotation: number; size: number }> {
		const data = (await this.sendRequest("CurrentModelRequest", {}, 3000)) as {
			modelID?: string;
			modelLoaded?: boolean;
			modelPosition?: { positionX: number; positionY: number; rotation: number; size: number };
		};
		if (expectedModelID !== undefined && (data.modelLoaded !== true || data.modelID !== expectedModelID))
			throw new Error("VTS 当前模型身份已变化，拒绝使用旧位姿。");
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
		// 热键是本地即时动作，不应携带默认 30s 超时——costume 流程持锁等待会阻塞所有表情通道。
		return this.sendRequest(
			"HotkeyTriggerRequest",
			{
				hotkeyID,
				...(itemInstanceID ? { itemInstanceID } : {}),
			},
			2000,
		);
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
