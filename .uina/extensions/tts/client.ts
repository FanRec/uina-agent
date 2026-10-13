export type TtsSpeakFailureKind = "rejected" | "unknown";

export class TtsSpeakError extends Error {
	readonly kind: TtsSpeakFailureKind;
	readonly status?: number;

	constructor(message: string, kind: TtsSpeakFailureKind, status?: number) {
		super(message);
		this.name = "TtsSpeakError";
		this.kind = kind;
		this.status = status;
	}
}

/** Only controlled generation messages may enter the model-visible result. */
export class TtsGenerationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TtsGenerationError";
	}
}

function generationHttpError(status: number, body: string): TtsGenerationError {
	let detail: unknown;
	try {
		detail = (JSON.parse(body) as { detail?: unknown })?.detail;
	} catch {
		/* raw body remains diagnostic data */
	}
	let message = `TTS 合成失败（HTTP ${status}），请检查 tts inspect`;
	if (status === 404) message = "Bridge 缺少文件生成接口，需更新并重启 Bridge";
	else if (status === 504) message = "合成超时";
	else {
		const knownReasons = new Map<string, string>([
			["503:reference audio is unavailable", "参考音频不可用，请检查 TTS 部署配置"],
			["503:bridge is stopping", "Bridge 正在停止，恢复连接后再生成"],
			["502:vendor returned invalid or incomplete WAV", "语音模型返回无效或不完整 WAV"],
			["502:tts vendor rejected synthesis", "语音模型拒绝合成，请检查模型服务"],
			["502:tts vendor request failed", "语音模型无法连接，请检查模型服务"],
		]);
		if (typeof detail === "string") message = knownReasons.get(`${status}:${detail}`) ?? message;
	}
	return new TtsGenerationError(message, { cause: body });
}

export interface SpeakPayload {
	readonly trace_id: string;
	readonly segment_id: string;
	readonly index: number;
	readonly text: string;
	readonly kind?: string;
	readonly timeout_ms?: number;
	readonly generation_id?: number;
	readonly metadata?: Record<string, unknown>;
	readonly session_id?: string;
	readonly invocation_id?: string;
	readonly source_id?: string;
	readonly source_seq?: number;
	readonly epoch?: string;
}

export interface SubtitleSegmentState {
	readonly stop_outcome?: string;
	readonly state?: string;
	readonly error?: string;
	readonly task_id?: string;
	readonly generation_id?: number;
	readonly segment_index?: number;
	readonly text?: string;
	readonly revealed_text?: string;
	readonly revealed_count?: number;
	readonly playback_started?: boolean;
	readonly playback_completed?: boolean;
	readonly duration_ms?: number;
}

export interface SpeakingSegmentInfo {
	readonly index: number;
	readonly text: string;
	readonly revealed_text?: string;
}

export interface SubtitleStateResponse {
	readonly trace_id: string;
	readonly is_speaking?: boolean;
	readonly current_speaking?: SpeakingSegmentInfo | null;
	readonly pending_segments?: readonly SpeakingSegmentInfo[];
	readonly completed_segments?: readonly SpeakingSegmentInfo[];
	readonly segments: readonly SubtitleSegmentState[];
}

/**
 * 桥侧实际会发出的播放事件种类（封闭集合，来自 `PlaybackEventHub.publish` 的调用点）。
 *
 * `subtitle` 是每个进度 tick 的常规事件，原先漏在联合体外。
 * 未知种类仍必须能被接收（桥可以增发新 kind），因此消费处用
 * `PlaybackKind | (string & {})` 而不是 `| string` —— 后者会让联合体形同虚设：
 * 写错 kind 不报错，switch 也无法做穷尽检查。
 */
export type PlaybackKind =
	| "submitted"
	| "synthesizing"
	| "playback_started"
	| "subtitle"
	| "completed"
	| "cancelled"
	| "failed";

export interface PlaybackEvent {
	readonly event_id: string;
	readonly kind: PlaybackKind | (string & {});
	readonly trace_id: string;
	readonly generation_id?: number;
	readonly segment_index?: number;
	readonly task_id?: string;
	readonly created_at: string;
	readonly detail?: Record<string, unknown>;
}

export interface CancelTraceResponse {
	readonly status: "cancelled";
	readonly trace_id?: string;
	readonly mode?: "immediate" | "segment_boundary";
	readonly cancelled_task_count?: number;
	readonly playback_stopped: boolean;
	readonly stop_outcome?: "stopped" | "not_playing" | "unknown" | "failed";
}

/**
 * 从播放事件中读取声学电平。
 *
 * 电平随进度事件下发（见桥侧 `remember_snapshot`）。非电平事件或缺字段时返回 null ——
 * 明确返回"没有电平"而不是伪造 0，否则消费端无法区分"真静音"与"这一帧没测"。
 */
export function readPlaybackLevel(event: PlaybackEvent): { rms: number; peak: number } | null {
	const detail = event.detail;
	if (!detail) return null;
	const rms = detail["rms"];
	if (typeof rms !== "number" || !Number.isFinite(rms)) return null;
	const peak = detail["peak"];
	return { rms, peak: typeof peak === "number" && Number.isFinite(peak) ? peak : 0 };
}

const REQUIRED_BRIDGE_PATHS = [
	"/v1/tts/speak",
	"/v1/tts/reconnect",
	"/v1/tts/reset",
	"/v1/tts/test",
	"/v1/tts/restart",
] as const;

export interface TtsBridgeCompatibility {
	readonly reachable: boolean;
	readonly compatible: boolean;
	readonly missingPaths: readonly string[];
	readonly reason?: string;
}

export class TtsBridgeClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(baseUrl = "http://127.0.0.1:8102", timeoutMs = 5000) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.timeoutMs = timeoutMs;
	}

	async generate(text: string, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
		try {
			const response = await fetch(`${this.baseUrl}/v1/tts/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, timeout_ms: timeoutMs }),
				signal,
			});
			if (!response.ok) throw generationHttpError(response.status, await response.text());
			if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "audio/wav") {
				await response.body?.cancel();
				throw new TtsGenerationError("Bridge 未返回 WAV 音频");
			}
			return new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if (error instanceof TtsGenerationError) throw error;
			throw new TtsGenerationError("TTS Bridge 连接或音频传输失败，请检查 tts inspect", { cause: error });
		}
	}

	/**
	 * "健康"必须同时代表当前扩展所需协议可用；单纯 HTTP 200 不能让旧 Bridge 越过接缝。
	 */
	async isHealthy(): Promise<boolean> {
		return (await this.compatibility()).compatible;
	}

	async compatibility(signal?: AbortSignal): Promise<TtsBridgeCompatibility> {
		const health = await this.health(signal);
		if (!health) {
			return { reachable: false, compatible: false, missingPaths: [], reason: "Bridge /health 不可达" };
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const controller = new AbortController();
			timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 2000));
			const res = await fetch(`${this.baseUrl}/openapi.json`, {
				method: "GET",
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			});
			if (!res.ok) {
				return {
					reachable: true,
					compatible: false,
					missingPaths: [...REQUIRED_BRIDGE_PATHS],
					reason: `Bridge /openapi.json 返回 HTTP ${res.status}`,
				};
			}
			let parsed: unknown;
			try {
				parsed = await res.json();
			} catch {
				return {
					reachable: true,
					compatible: false,
					missingPaths: [...REQUIRED_BRIDGE_PATHS],
					reason: "Bridge OpenAPI 响应不是有效 JSON",
				};
			}
			const paths =
				parsed && typeof parsed === "object" && "paths" in parsed ? (parsed as { paths?: unknown }).paths : undefined;
			const missingPaths = REQUIRED_BRIDGE_PATHS.filter(
				(path) => !(paths && typeof paths === "object" && path in paths),
			);
			if (missingPaths.length) {
				return { reachable: true, compatible: false, missingPaths, reason: `缺少协议路径：${missingPaths.join(", ")}` };
			}
			if (health.bridge_ready !== true) {
				return { reachable: true, compatible: false, missingPaths: [], reason: "Bridge ready 未确认" };
			}
			if (health.voice_protocol_version !== 2) {
				return {
					reachable: true,
					compatible: false,
					missingPaths: [],
					reason: "声音协议版本不兼容，请由服务启动方更新并重启 Bridge",
				};
			}
			return { reachable: true, compatible: true, missingPaths: [] };
		} catch (error) {
			return {
				reachable: true,
				compatible: false,
				missingPaths: [...REQUIRED_BRIDGE_PATHS],
				reason: `Bridge 能访问但能力握手失败：${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async speak(
		payload: SpeakPayload,
		signal?: AbortSignal,
	): Promise<{ status: string; task_id?: string; reason?: string; epoch?: string; generation_id?: number }> {
		if (!payload.text || !payload.text.trim()) {
			return { status: "skipped", task_id: payload.segment_id };
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}/v1/tts/speak`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "sentence",
					timeout_ms: 3000,
					...payload,
				}),
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new TtsSpeakError(
					`TTS speak ${res.status >= 500 ? "result unknown" : "rejected"}: HTTP ${res.status} ${errText}`,
					res.status >= 500 ? "unknown" : "rejected",
					res.status,
				);
			}
			const result = (await res.json()) as {
				status: string;
				task_id?: string;
				reason?: string;
				epoch?: string;
				generation_id?: number;
			};
			if (!result || typeof result.status !== "string")
				throw new TtsSpeakError("发声服务未返回操作结论，提交结果未知", "unknown");
			if (result.reason !== undefined && typeof result.reason !== "string")
				result.reason = JSON.stringify(result.reason);
			return result;
		} catch (error) {
			if (error instanceof TtsSpeakError) throw error;
			throw new TtsSpeakError(
				`TTS speak result unknown: ${error instanceof Error ? error.message : String(error)}`,
				"unknown",
			);
		} finally {
			clearTimeout(timer);
		}
	}

	async health(signal?: AbortSignal): Promise<Record<string, unknown> | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 2000));
		try {
			const res = await fetch(`${this.baseUrl}/health`, {
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			});
			if (!res.ok) return null;
			const body = await res.json();
			return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	private async jsonRequest(
		path: string,
		body: Record<string, unknown>,
		timeoutMs = this.timeoutMs,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			});
			const text = await res.text();
			let parsed: Record<string, unknown> = {};
			try {
				parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
			} catch {
				if (res.ok) throw new Error("服务响应不是有效 JSON，操作结果未确认");
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
			if (typeof parsed.status !== "string") throw new Error("服务没有返回操作结论，结果未确认");
			return parsed;
		} finally {
			clearTimeout(timer);
		}
	}

	async reconnect(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return await this.jsonRequest("/v1/tts/reconnect", { session_id: sessionId }, this.timeoutMs, signal);
	}
	async reset(
		sessionId: string,
		expectedEpoch?: string,
		newEpoch?: string,
		invocationId?: string,
		timeoutMs = this.timeoutMs,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		return await this.jsonRequest(
			"/v1/tts/reset",
			{
				session_id: sessionId,
				...(expectedEpoch ? { expected_epoch: expectedEpoch } : {}),
				...(newEpoch ? { new_epoch: newEpoch } : {}),
				...(invocationId ? { invocation_id: invocationId } : {}),
			},
			timeoutMs,
			signal,
		);
	}
	async test(
		scope: "synthesis" | "playback",
		sessionId?: string,
		timeoutMs = 120000,
		signal?: AbortSignal,
		expectedEpoch?: string,
		traceId?: string,
	): Promise<Record<string, unknown>> {
		return await this.jsonRequest(
			"/v1/tts/test",
			{
				scope,
				timeout_ms: timeoutMs,
				...(sessionId ? { session_id: sessionId } : {}),
				expected_epoch: expectedEpoch,
				trace_id: traceId,
			},
			timeoutMs,
			signal,
		);
	}
	async restartVendor(timeoutMs = 120000, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return await this.jsonRequest("/v1/tts/restart", { target: "vendor" }, timeoutMs, signal);
	}

	async cancelTrace(
		traceId: string,
		mode: "immediate" | "segment_boundary" = "immediate",
		sessionId?: string,
		epoch?: string,
	): Promise<CancelTraceResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}/v1/tts/cancel-trace`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trace_id: traceId, mode, session_id: sessionId, expected_epoch: epoch }),
				signal: controller.signal,
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`TTS cancel-trace failed: HTTP ${res.status} ${errText}`);
			}
			return (await res.json()) as CancelTraceResponse;
		} finally {
			clearTimeout(timer);
		}
	}

	async turnEnd(
		traceId: string,
		generationId?: number,
		lastSegmentIndex?: number,
		sessionId?: string,
		epoch?: string,
	): Promise<{ status: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}/v1/tts/turn-end`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					trace_id: traceId,
					session_id: sessionId,
					epoch,
					...(generationId !== undefined ? { generation_id: generationId } : {}),
					...(lastSegmentIndex !== undefined ? { last_segment_index: lastSegmentIndex } : {}),
				}),
				signal: controller.signal,
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`TTS turn-end failed: HTTP ${res.status} ${errText}`);
			}
			const result = (await res.json()) as { status: string };
			if (result.status !== "accepted") throw new Error("来源结束未确认：" + String(result.status));
			return result;
		} finally {
			clearTimeout(timer);
		}
	}

	async getSubtitleState(traceId: string, signal?: AbortSignal): Promise<SubtitleStateResponse | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}/v1/tts/subtitle-state?trace_id=${encodeURIComponent(traceId)}`, {
				method: "GET",
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			});
			if (!res.ok) return null;
			return (await res.json()) as SubtitleStateResponse;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	async subscribeEvents(
		traceId: string | undefined,
		onEvent: (event: PlaybackEvent) => void,
		signal?: AbortSignal,
		onConnected?: () => void,
	): Promise<void> {
		const url = traceId
			? `${this.baseUrl}/v1/tts/events?trace_id=${encodeURIComponent(traceId)}`
			: `${this.baseUrl}/v1/tts/events`;
		const open = new AbortController();
		const timer = setTimeout(() => open.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await fetch(url, {
				method: "GET",
				headers: { Accept: "text/event-stream" },
				signal: signal ? AbortSignal.any([signal, open.signal]) : open.signal,
			});
		} finally {
			clearTimeout(timer);
		}

		if (!res.ok || !res.body) {
			throw new Error(`Failed to subscribe to TTS events: HTTP ${res.status}`);
		}
		onConnected?.();

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith("data:")) {
						const jsonStr = trimmed.slice(5).trim();
						if (jsonStr) {
							try {
								const parsed = JSON.parse(jsonStr) as PlaybackEvent;
								onEvent(parsed);
							} catch {
								// Ignore parse errors on SSE line
							}
						}
					}
				}
			}
		} catch (err) {
			if (signal?.aborted) return;
			throw err;
		}
	}
}
