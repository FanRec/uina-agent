import type { ChatMsg, ToolResultStatus } from "../core/types.js";
import type {
	QueuedInput,
	SessionEventRecord,
	SessionRecord,
} from "./types.js";

export class SessionFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionFormatError";
	}
}

interface PendingCall {
	callId: string;
	name: string;
	started: boolean;
}

export interface RecoveredState {
	messages: ChatMsg[];
	customMessages: Array<{ customType: string; content: string; display?: boolean; details?: unknown }>;
	customEntries: Array<{ customType: string; data?: unknown }>;
	queued: QueuedInput[];
}

/** Replays records and inserts explicit results for calls interrupted by a crash. */
export function recoverRecords(records: SessionRecord[]): RecoveredState {
	const messages: ChatMsg[] = [];
	const customMessages: RecoveredState["customMessages"] = [];
	const customEntries: RecoveredState["customEntries"] = [];
	const queued = new Map<string, QueuedInput>();
	const finishedEvents = new Map<string, { status: ToolResultStatus; result?: string }>();
	const resultIds = new Set<string>();
	const declaredIds = new Set<string>();
	let pendingCalls: PendingCall[] = [];

	const closePending = (): void => {
		for (const call of pendingCalls) {
			if (resultIds.has(call.callId)) continue;
			const finished = finishedEvents.get(call.callId);
			const status: ToolResultStatus =
				finished?.status ?? (call.started ? "unknown" : "not_started");
			const content = finished?.result ??
				JSON.stringify({
					error:
						finished
							? "工具结果记录不完整；外部副作用结果未知"
							: status === "unknown"
								? "工具已启动，但进程在结果提交前结束；结果未知"
								: "工具调用在进程结束前尚未启动",
					status: finished ? "unknown" : status,
				});
			const recoveredStatus =
				finished && finished.result === undefined && finished.status !== "not_started"
					? "unknown"
					: status;
			messages.push({
				role: "tool",
				tool_call_id: call.callId,
				status: recoveredStatus,
				content,
			});
			resultIds.add(call.callId);
		}
		pendingCalls = [];
	};

	for (const record of records) {
		if (record.kind === "custom_message") {
			customMessages.push({ customType: record.customType, content: record.content, ...(record.display === undefined ? {} : { display: record.display }), ...(record.details === undefined ? {} : { details: record.details }) });
			continue;
		}
		if (record.kind === "custom_entry") {
			customEntries.push({ customType: record.customType, ...(record.data === undefined ? {} : { data: record.data }) });
			continue;
		}
		if (record.kind === "message") {
			if (record.message.role === "assistant" && record.message.tool_calls?.length) {
				closePending();
				const ids = new Set<string>();
				for (const call of record.message.tool_calls) {
					if (!call.id || ids.has(call.id) || declaredIds.has(call.id)) {
						throw new SessionFormatError(`重复工具调用 id: ${call.id}`);
					}
					ids.add(call.id);
					declaredIds.add(call.id);
				}
				messages.push(record.message);
				pendingCalls = record.message.tool_calls.map((call) => ({
					callId: call.id,
					name: call.name,
					started: false,
				}));
				continue;
			}

			if (record.message.role !== "tool") closePending();
			if (record.message.role === "tool") {
				const toolMsg = record.message as { role: "tool"; tool_call_id: string; content: string };
				const call = pendingCalls.find(
					(candidate) => candidate.callId === toolMsg.tool_call_id,
				);
				if (!call || resultIds.has(call.callId)) {
					throw new SessionFormatError(
						`工具结果没有对应的未完成调用: ${toolMsg.tool_call_id}`,
					);
				}
				resultIds.add(call.callId);
			}
			messages.push(record.message);
			continue;
		}

		if (record.kind === "compaction") {
			closePending();
			messages.length = 0;
			messages.push(
				{ role: "user", content: `[历史摘要] ${record.summary}` },
				...record.retainedTail,
			);
			continue;
		}

		applyEvent(record, queued, finishedEvents, pendingCalls);
	}

	closePending();
	return {
		messages,
		customMessages,
		customEntries,
		queued: [...queued.values()].sort((a, b) => a.order - b.order),
	};
}

function applyEvent(
	record: SessionEventRecord,
	queued: Map<string, QueuedInput>,
	finishedEvents: Map<string, { status: ToolResultStatus; result?: string }>,
	pendingCalls: PendingCall[],
): void {
	const data = record.data;
	if (record.event === "queue_enqueued") {
		if (
			typeof data.id !== "string" ||
			typeof data.order !== "number" ||
			(data.mode !== "steer" && data.mode !== "followUp") ||
			typeof data.text !== "string"
		) {
			throw new SessionFormatError("queue_enqueued 数据不完整");
		}
		if (queued.has(data.id)) throw new SessionFormatError(`重复队列 id: ${data.id}`);
		if (!Number.isSafeInteger(data.order) || data.order <= 0) {
			throw new SessionFormatError("queue_enqueued order 无效");
		}
		queued.set(data.id, {
			id: data.id,
			order: data.order,
			mode: data.mode,
			text: data.text,
			...(isInputSource(data.source) ? { source: data.source } : {}),
			...(data.data !== undefined ? { data: data.data } : {}),
		});
		return;
	}
	if (record.event === "queue_consumed" || record.event === "queue_restored") {
		if (typeof data.id !== "string" || !queued.has(data.id)) {
			throw new SessionFormatError(`${record.event} 缺少 id`);
		}
		queued.delete(data.id);
		return;
	}
	if (record.event === "tool_started") {
		if (typeof data.callId !== "string") {
			throw new SessionFormatError("tool_started 缺少 callId");
		}
		const pending = pendingCalls.find((call) => call.callId === data.callId);
		if (!pending) {
			throw new SessionFormatError(`tool_started 没有对应调用: ${data.callId}`);
		}
		if (pending.started) throw new SessionFormatError(`tool_started 重复: ${data.callId}`);
		pending.started = true;
		return;
	}
	if (record.event === "tool_finished") {
		if (typeof data.callId !== "string") {
			throw new SessionFormatError("tool_finished 缺少 callId");
		}
		const pending = pendingCalls.find((call) => call.callId === data.callId);
		if (!pending) {
			throw new SessionFormatError(`tool_finished 没有对应调用: ${data.callId}`);
		}
		if (finishedEvents.has(data.callId)) throw new SessionFormatError(`tool_finished 重复: ${data.callId}`);
		const status = data.status;
		if (status !== "not_started" && !pending.started) {
			throw new SessionFormatError(`工具未启动即完成: ${data.callId}`);
		}
		if (status !== "succeeded" && status !== "failed" && status !== "cancelled" && status !== "unknown" && status !== "not_started") {
			throw new SessionFormatError(`tool_finished status 无效: ${data.callId}`);
		}
		finishedEvents.set(data.callId, {
			status,
			result: typeof data.result === "string" ? data.result : undefined,
		});
		return;
	}
	if (record.event === "turn_failed" || record.event === "turn_aborted") {
		return;
	}
}

function isInputSource(value: unknown): value is QueuedInput["source"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const source = value as Record<string, unknown>;
	return (source.kind === "user" || source.kind === "runtime" || source.kind === "agent") && typeof source.type === "string";
}

export function isRecord(value: unknown): value is SessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.seq !== "number" ||
		!Number.isSafeInteger(record.seq) ||
		record.seq <= 0 ||
		typeof record.timestamp !== "string"
	) {
		return false;
	}
	if (
		record.kind !== "message" &&
		record.kind !== "custom_message" &&
		record.kind !== "custom_entry" &&
		record.kind !== "compaction" &&
		record.kind !== "event"
	) {
		return false;
	}
	if (record.kind === "message") {
		return isChatMsg(record.message);
	}
	if (record.kind === "custom_message") {
		return typeof record.customType === "string" && record.customType.length > 0 && typeof record.content === "string" && (record.display === undefined || typeof record.display === "boolean");
	}
	if (record.kind === "custom_entry") {
		return typeof record.customType === "string" && record.customType.length > 0;
	}
	if (record.kind === "compaction") {
		return (
			typeof record.summary === "string" &&
			typeof record.tokensBefore === "number" &&
			Number.isFinite(record.tokensBefore) &&
			Array.isArray(record.retainedTail) &&
			record.retainedTail.every(isChatMsg)
		);
	}
	return (
		typeof record.event === "string" &&
		[
			"queue_enqueued",
			"queue_consumed",
			"queue_restored",
			"tool_started",
			"tool_finished",
			"turn_failed",
			"turn_aborted",
		].includes(record.event) &&
		!!record.data &&
		typeof record.data === "object" &&
		!Array.isArray(record.data)
	);
}

function isChatMsg(value: unknown): value is ChatMsg {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	if (
		typeof message.content !== "string" ||
		(message.role !== "system" &&
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "tool")
	) {
		return false;
	}
	if (message.role === "tool") return typeof message.tool_call_id === "string";
	if (message.role !== "assistant") return true;
	if (message.thinking !== undefined && typeof message.thinking !== "string") return false;
	if (message.thinkingSignature !== undefined && typeof message.thinkingSignature !== "string") return false;
	if (message.tool_calls === undefined) return true;
	return (
		Array.isArray(message.tool_calls) &&
		message.tool_calls.every((call) => {
			if (!call || typeof call !== "object") return false;
			const toolCall = call as Record<string, unknown>;
			return (
				typeof toolCall.id === "string" &&
				typeof toolCall.name === "string" &&
				"args" in toolCall
			);
		})
	);
}
