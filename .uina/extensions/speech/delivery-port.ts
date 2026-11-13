/**
 * SpeechDeliveryPort（输出表达体系 §5.2）：Speech 只依赖以下业务语义；实现是
 * TTS 扩展的 `tts_delivery:*` 服务（Driver/Bridge 保留其物理所有权）。
 * 接口名不强制相同，语义固定：受理可区分、未知不得按拒绝补播、停止结果如实。
 */

export interface AdmissionResult {
	/** accepted = Driver 已受理进入交付路径；not_started/rejected/cancelled 是明确拒绝；unknown 不得按拒绝补播。 */
	readonly status: "accepted" | "rejected" | "not_started" | "unknown" | "cancelled";
	readonly reason?: string;
	readonly taskId?: string;
	/** Driver Source 身份（trace）；受理或创建来源时返回。 */
	readonly traceId?: string;
}

export interface SealResult {
	readonly status: "sealed" | "not_started" | "unknown";
	readonly reason?: string;
}

export interface StopResult {
	readonly outcome: "interrupted" | "no_op" | "failed" | "unknown";
	readonly reason?: string;
	readonly segmentIndex?: number;
	readonly segmentText?: string;
	readonly committedCharEnd?: number;
}

export interface DeliveryView {
	readonly online: boolean;
	readonly muted: boolean;
	readonly submittedSegments: number;
	readonly pendingSegments: number;
	readonly currentSegmentIndex: number | null;
	readonly stopUnconfirmed?: boolean;
	readonly unknownSegments?: number;
}

export interface MuteResult {
	readonly success: boolean;
	readonly isOnline?: boolean;
	readonly reason?: string;
	readonly status?: string;
}

export interface SpeechDeliveryPort {
	submitSegment(utteranceId: string, text: string): Promise<AdmissionResult>;
	sealSource(utteranceId: string): Promise<SealResult>;
	stopSource(utteranceId?: string): Promise<StopResult>;
	setMuted(muted: boolean): Promise<MuteResult>;
	snapshot(): Promise<DeliveryView | undefined>;
}

export type TtsServiceCaller = <T = unknown>(name: string, input?: unknown) => Promise<T>;

/** 经 tts 扩展的交付服务实现端口；服务缺失时如实降级为不可交付。 */
export function createDeliveryPort(callService: TtsServiceCaller, hasService: (name: string) => boolean): SpeechDeliveryPort {
	const available = (): boolean => hasService("tts_delivery:submit");
	return {
		async submitSegment(utteranceId, text) {
			if (!available()) return { status: "not_started", reason: "发声驱动未挂载" };
			return await callService<AdmissionResult>("tts_delivery:submit", { utteranceId, text });
		},
		async sealSource(utteranceId) {
			if (!available()) return { status: "not_started", reason: "发声驱动未挂载" };
			return await callService<SealResult>("tts_delivery:seal", { utteranceId });
		},
		async stopSource(utteranceId) {
			if (!available()) return { outcome: "failed", reason: "发声驱动未挂载" };
			return await callService<StopResult>("tts_delivery:stop", utteranceId === undefined ? {} : { utteranceId });
		},
		async setMuted(muted) {
			if (!available()) return { success: false, reason: "发声驱动未挂载" };
			return await callService<MuteResult>("tts_delivery:set_muted", { muted });
		},
		async snapshot() {
			if (!available()) return undefined;
			return await callService<DeliveryView>("tts_delivery:snapshot");
		},
	};
}
