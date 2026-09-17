import { validImages } from "../core/content.js";
import { readDeclaredEffects } from "../core/effects.js";
import type { AgentMessage, ToolEffect, ToolResultStatus } from "../core/types.js";
import type {
	AbandonedEffects,
	HydratedSessionEntry,
	QueuedInput,
	SessionEntry,
	SessionEntryPayload,
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
	originId: string;
	callId: string;
	name: string;
	started: boolean;
}

export interface RecoveredState {
	entries: HydratedSessionEntry[];
	allEntries: HydratedSessionEntry[];
	recoveredTail: AgentMessage[];
	queued: QueuedInput[];
}

class SessionReplayContext {
	readonly entries: HydratedSessionEntry[] = [];
	readonly allEntries: HydratedSessionEntry[] = [];
	readonly recoveredTail: AgentMessage[] = [];
	readonly queued = new Map<string, QueuedInput>();
	readonly finishedEvents = new Map<string, { status: ToolResultStatus; result?: string }>();
	readonly resultIds = new Set<string>();
	readonly recordIds = new Set<string>();
	pendingCalls: PendingCall[] = [];
	currentRecord?: SessionRecord;
	settlingTail = false;

	add(payload: SessionEntryPayload, syntheticId?: string): void {
		const node: HydratedSessionEntry = {
			...payload,
			id: syntheticId ?? this.currentRecord!.id,
			seq: this.currentRecord!.seq,
			timestamp: this.currentRecord!.timestamp,
			parentId: this.entries.at(-1)?.id ?? null,
		};
		this.entries.push(node);
		this.allEntries.push(node);
		if (this.settlingTail && syntheticId && payload.kind === "message") {
			this.recoveredTail.push(structuredClone(payload.message as AgentMessage));
		}
	}

	closePending(): void {
		for (const call of this.pendingCalls) {
			if (this.resultIds.has(call.callId)) continue;
			const finished = this.finishedEvents.get(call.callId);
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
			this.add(
				{
					kind: "message",
					message: {
						role: "tool",
						tool_call_id: call.callId,
						status: recoveredStatus,
						content,
					},
				},
				`recovered:${call.originId}:${call.callId}`,
			);
			this.resultIds.add(call.callId);
		}
		this.pendingCalls = [];
	}

	toState(): RecoveredState {
		return {
			entries: this.entries,
			allEntries: this.allEntries,
			recoveredTail: this.recoveredTail,
			queued: [...this.queued.values()].sort((a, b) => a.order - b.order),
		};
	}
}

/**
 * 聚合被放弃历史切片中"发生过什么外部效果"的通用事实。
 * Session Core 不认识任何具体工具：效果由工具在自己的结果 details.effects
 * 里声明（Generic effect facts，经 core/effects.ts 契约读取），这里只做过滤
 * （failed/cancelled/not_started 不构成已发生的事实；unknown 仍上报）与去重。
 */
export function summarizeAbandonedEffects(abandoned: readonly SessionEntry[]): AbandonedEffects {
	const effects: ToolEffect[] = [];
	const seen = new Set<string>();
	const push = (effect: ToolEffect): void => {
		const key = `${effect.effectType}:${effect.externalOperationId ?? ""}:${effect.label ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		effects.push(effect);
	};

	for (const entry of abandoned) {
		if (entry.kind === "rewind" && entry.effects) {
			for (const effect of entry.effects.effects) push(effect);
			continue;
		}
		if (entry.kind !== "message") continue;
		const msg = entry.message as AgentMessage;
		if (msg.role !== "tool") continue;
		if (msg.status === "failed" || msg.status === "cancelled" || msg.status === "not_started") continue;
		for (const effect of readDeclaredEffects(msg)) push(effect);
	}

	return { effects };
}

function replayRewind(ctx: SessionReplayContext, record: SessionRecord & { kind: "rewind" }): void {
	if (ctx.pendingCalls.some((call) => !ctx.resultIds.has(call.callId))) {
		throw new SessionFormatError("回溯前有未结算工具调用");
	}
	const index = ctx.entries.findIndex((entry) => entry.id === record.targetId);
	if (ctx.entries.at(-1)?.id !== record.fromId || index < 0 || index === ctx.entries.length - 1) {
		throw new SessionFormatError("回溯目标必须是当前主线的历史祖先，原位置必须匹配");
	}
	if (!isSafeRewindTarget(ctx.entries, index)) {
		throw new SessionFormatError("回溯目标切断工具调用与结果或不是持久化节点");
	}
	const abandoned = ctx.entries.slice(index + 1);
	const carriedInputs = collectCarriedInputs(abandoned);
	const effects = summarizeAbandonedEffects(abandoned);
	let notice =
		`[会话回溯 ${record.id}]\n` +
		`从 ${record.fromId} 回溯至 ${record.targetId}；来源：${record.source}。\n` +
		`原因（发起方说明）：${record.reason}\n` +
		`退出路径只读，可用 session_list(scope=all) / session_read 查询，包括此前回溯。外部副作用、文件和后台任务没有被撤销；重新行动前核实当前状态。后附历史输入保留原要求，不表示再次执行旧任务；最新要求不因回溯而失效。`;

	const effectLines: string[] = [];
	// 通用展示：按声明方给的 effectType 分组，行内容取 label / 外部操作身份。
	const grouped = new Map<string, string[]>();
	for (const effect of effects.effects) {
		const labels = grouped.get(effect.effectType) ?? [];
		labels.push(effect.label ?? effect.externalOperationId ?? "?");
		grouped.set(effect.effectType, labels);
	}
	for (const [effectType, labels] of grouped) {
		effectLines.push(`- ${effectType} (${labels.length}): ${labels.join(", ")}`);
	}
	if (effectLines.length > 0) {
		notice += `\n[在被放弃历史切片中产生的外部操作]\n` + effectLines.join("\n");
	}

	ctx.entries.splice(index + 1);
	ctx.pendingCalls = [];
	ctx.add({ kind: "rewind", record: structuredClone(record), notice, carriedInputs, effects });
}

function replayInput(ctx: SessionReplayContext, record: SessionRecord & { kind: "input" }): void {
	if (!ctx.queued.has(record.input.id)) {
		throw new SessionFormatError(`input 没有对应队列项: ${record.input.id}`);
	}
	ctx.closePending();
	ctx.queued.delete(record.input.id);
	ctx.add({ kind: "input", input: structuredClone(record.input) });
}

function replayCustomMessage(
	ctx: SessionReplayContext,
	record: SessionRecord & { kind: "custom_message" },
): void {
	ctx.add({
		kind: "custom_message",
		customType: record.customType,
		content: record.content,
		...(record.images ? { images: record.images } : {}),
		...(record.display === undefined ? {} : { display: record.display }),
		...(record.details === undefined ? {} : { details: record.details }),
	});
}

function replayCustomEntry(
	ctx: SessionReplayContext,
	record: SessionRecord & { kind: "custom_entry" },
): void {
	ctx.add({
		kind: "custom_entry",
		customType: record.customType,
		...(record.data === undefined ? {} : { data: record.data }),
	});
}

function replayMessage(ctx: SessionReplayContext, record: SessionRecord & { kind: "message" }): void {
	if (record.message.role === "assistant" && record.message.tool_calls?.length) {
		ctx.closePending();
		ctx.resultIds.clear();
		ctx.finishedEvents.clear();
		const ids = new Set<string>();
		for (const call of record.message.tool_calls) {
			if (!call.id || ids.has(call.id)) {
				throw new SessionFormatError(`重复工具调用 id: ${call.id}`);
			}
			ids.add(call.id);
		}
		ctx.add({ kind: "message", message: record.message });
		ctx.pendingCalls = record.message.tool_calls.map((call) => ({
			originId: record.id,
			callId: call.id,
			name: call.name,
			started: false,
		}));
		return;
	}

	if (record.message.role !== "tool") {
		ctx.closePending();
	}
	if (record.message.role === "tool") {
		const toolMsg = record.message as { role: "tool"; tool_call_id: string; content: string };
		const call = ctx.pendingCalls.find((candidate) => candidate.callId === toolMsg.tool_call_id);
		if (!call || ctx.resultIds.has(call.callId)) {
			throw new SessionFormatError(`工具结果没有对应的未完成调用: ${toolMsg.tool_call_id}`);
		}
		ctx.resultIds.add(call.callId);
	}
	ctx.add({ kind: "message", message: record.message });
}

function replayCompaction(
	ctx: SessionReplayContext,
	record: SessionRecord & { kind: "compaction" },
): void {
	ctx.closePending();
	ctx.add({
		kind: "compaction",
		summary: record.summary,
		retainedTail: structuredClone(record.retainedTail),
		tokensBefore: record.tokensBefore,
	});
}

/** Replays records and inserts explicit results for calls interrupted by a crash. */
export function recoverRecords(records: SessionRecord[], settleTail = true): RecoveredState {
	const ctx = new SessionReplayContext();

	for (const record of records) {
		if (ctx.recordIds.has(record.id)) {
			throw new SessionFormatError(`重复记录 id: ${record.id}`);
		}
		ctx.recordIds.add(record.id);
		ctx.currentRecord = record;

		switch (record.kind) {
			case "rewind":
				replayRewind(ctx, record);
				break;
			case "input":
				replayInput(ctx, record);
				break;
			case "custom_message":
				replayCustomMessage(ctx, record);
				break;
			case "custom_entry":
				replayCustomEntry(ctx, record);
				break;
			case "message":
				replayMessage(ctx, record);
				break;
			case "compaction":
				replayCompaction(ctx, record);
				break;
			case "event":
				applyEvent(record, ctx.queued, ctx.finishedEvents, ctx.pendingCalls);
				break;
		}
	}

	ctx.settlingTail = true;
	if (settleTail) {
		ctx.closePending();
	}
	return ctx.toState();
}

/** Projects the ordered journal into the effective AgentMessage history, preserving custom and compaction messages. */
export function projectAgentHistory(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.kind === "rewind") {
			const compaction = entry.record.compaction;
			if (compaction) {
				// 嵌入压缩在此应用（与 standalone compaction 条目同语义）：落盘的压缩结果
				// 就是生效的上下文，不再等待后续体检重算一遍摘要。
				messages.length = 0;
				messages.push({
					role: "compactionSummary",
					summary: compaction.summary,
					content: `[历史摘要] ${compaction.summary}`,
					tokensBefore: compaction.tokensBefore,
				});
				// 连续性提示不原样保留在尾位：从保留尾中滤出，由 protectRewindContext
				// 统一重注入到 compactionSummary 之后（"never at the absolute tail"）。
				messages.push(
					...(compaction.retainedTail as AgentMessage[]).filter(
						(message) => !(message as { id?: string }).id?.startsWith("continuity:"),
					),
				);
			} else {
				messages.push(...rewindMessages(entry));
			}
			continue;
		}
		if (entry.kind === "input") {
			const message = projectInputMessage(entry.input);
			if (message) messages.push(message);
			continue;
		}
		if (entry.kind === "message") {
			messages.push(structuredClone(entry.message as AgentMessage));
			continue;
		}
		if (entry.kind === "custom_message") {
			messages.push({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
    ...(entry.images ? { images: entry.images } : {}),
				display: entry.display,
				details: entry.details,
			});
			continue;
		}
		if (entry.kind === "compaction") {
			messages.length = 0;
			messages.push(
				{
					role: "compactionSummary",
					summary: entry.summary,
					content: `[历史摘要] ${entry.summary}`,
					tokensBefore: entry.tokensBefore,
				},
				...(entry.retainedTail as AgentMessage[]).map((m) => structuredClone(m)),
			);
		}
	}
	return protectRewindContext(messages, entries);
}

/** Runtime inputs remain identifiable session facts, not human utterances. */
export function projectInputMessage(input: QueuedInput): AgentMessage {
	if (input.source?.kind === "runtime") {
		const prov = input.source.provenance?.abandoned ? " [来自废弃分支]" : "";
		return {
			role: "custom",
			id: input.id,
			customType: "runtime-input",
			display: false,
			images: input.images,
			content: `[运行时事件 ${input.source.type}${input.source.ref ? ` · ${input.source.ref}` : ""}${prov}]\n${input.text}`,
			details: { source: input.source, data: input.data },
		};
	}
	return {
		role: "user",
		id: input.id,
		content: input.text,
		images: input.images,
	};
}

function applyQueueEvent(record: SessionEventRecord, queued: Map<string, QueuedInput>): void {
	const data = record.data;
	if (record.event === "queue_enqueued") {
		if (
			typeof data.id !== "string" ||
			typeof data.order !== "number" ||
			(data.mode !== "steer" && data.mode !== "followUp") ||
			typeof data.text !== "string" ||
			!validImages(data.images)
		) {
			throw new SessionFormatError("queue_enqueued 数据不完整");
		}
		if (queued.has(data.id)) {
			throw new SessionFormatError(`重复队列 id: ${data.id}`);
		}
		if (!Number.isSafeInteger(data.order) || data.order <= 0) {
			throw new SessionFormatError("queue_enqueued order 无效");
		}
		queued.set(data.id, {
			id: data.id,
			order: data.order,
			mode: data.mode,
			text: data.text,
			...(validImages(data.images) && data.images ? { images: data.images } : {}),
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
	}
}

function applyToolEvent(
	record: SessionEventRecord,
	finishedEvents: Map<string, { status: ToolResultStatus; result?: string }>,
	pendingCalls: PendingCall[],
): void {
	const data = record.data;
	if (typeof data.callId !== "string") {
		throw new SessionFormatError(`${record.event} 缺少 callId`);
	}
	const pending = pendingCalls.find((call) => call.callId === data.callId);
	if (!pending) {
		throw new SessionFormatError(`${record.event} 没有对应调用: ${data.callId}`);
	}

	if (record.event === "tool_started") {
		if (pending.started) {
			throw new SessionFormatError(`tool_started 重复: ${data.callId}`);
		}
		pending.started = true;
		return;
	}

	if (record.event === "tool_finished") {
		if (finishedEvents.has(data.callId)) {
			throw new SessionFormatError(`tool_finished 重复: ${data.callId}`);
		}
		const status = data.status;
		if (status !== "not_started" && !pending.started) {
			throw new SessionFormatError(`工具未启动即完成: ${data.callId}`);
		}
		if (
			status !== "succeeded" &&
			status !== "failed" &&
			status !== "cancelled" &&
			status !== "unknown" &&
			status !== "not_started"
		) {
			throw new SessionFormatError(`tool_finished status 无效: ${data.callId}`);
		}
		finishedEvents.set(data.callId, {
			status,
			result: typeof data.result === "string" ? data.result : undefined,
		});
	}
}

function applyEvent(
	record: SessionEventRecord,
	queued: Map<string, QueuedInput>,
	finishedEvents: Map<string, { status: ToolResultStatus; result?: string }>,
	pendingCalls: PendingCall[],
): void {
	switch (record.event) {
		case "queue_enqueued":
		case "queue_consumed":
		case "queue_restored":
			applyQueueEvent(record, queued);
			break;

		case "tool_started":
		case "tool_finished":
			applyToolEvent(record, finishedEvents, pendingCalls);
			break;

		case "turn_failed":
		case "turn_aborted":
			break;
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
		record.kind !== "rewind" &&
		record.kind !== "input" &&
		record.kind !== "message" &&
		record.kind !== "custom_message" &&
		record.kind !== "custom_entry" &&
		record.kind !== "compaction" &&
		record.kind !== "event"
	) {
		return false;
	}
	if (record.kind === "rewind") return ["id", "targetId", "fromId", "source", "requestId", "reason"].every(key => typeof record[key] === "string" && (record[key] as string).trim().length > 0) && (record.summary === undefined || typeof record.summary === "string");
	if (record.kind === "input") {
		if (!record.input || typeof record.input !== "object") return false;
		const input = record.input as Record<string, unknown>;
		return typeof input.id === "string" && input.id.length > 0 && Number.isSafeInteger(input.order) && (input.order as number) > 0
			&& (input.mode === "steer" || input.mode === "followUp") && typeof input.text === "string"
			&& validImages(input.images) && (input.source === undefined || isInputSource(input.source));
	}
	if (record.kind === "message") {
		return isAgentMessage(record.message);
	}
	if (record.kind === "custom_message") {
		return validImages(record.images) && typeof record.customType === "string" && record.customType.length > 0 && typeof record.content === "string" && (record.display === undefined || typeof record.display === "boolean");
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
			record.retainedTail.every(isAgentMessage)
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

function isAgentMessage(value: unknown): value is AgentMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
 if (!validImages(message.images)) return false;
	if (message.role === "custom") return typeof message.content === "string" && typeof message.customType === "string" && message.customType.length > 0 && (message.display === undefined || typeof message.display === "boolean");
	if (message.role === "compactionSummary") return typeof message.content === "string" && typeof message.summary === "string" && (message.tokensBefore === undefined || (typeof message.tokensBefore === "number" && Number.isFinite(message.tokensBefore)));
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
	if (message.usage !== undefined) {
		if (!message.usage || typeof message.usage !== "object") return false;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) if ((message.usage as Record<string, unknown>)[key] !== undefined && typeof (message.usage as Record<string, unknown>)[key] !== "number") return false;
	}
	if (message.tool_calls === undefined) return true;
	return (
		Array.isArray(message.tool_calls) &&
		message.tool_calls.every((call) => {
			if (!call || typeof call !== "object") return false;
			const toolCall = call as Record<string, unknown>;
			return (
				typeof toolCall.id === "string" &&
				typeof toolCall.name === "string" &&
				"args" in toolCall &&
				(toolCall.thinkingSignature === undefined || typeof toolCall.thinkingSignature === "string")
			);
		})
	);
}

/** A rewind may only keep a complete tool exchange at a persisted node. */
export function safeRewindTargets(entries: readonly SessionEntry[]): Set<string> {
	const safe = new Set<string>();
	const pending = new Set<string>();
	let invalid = false;
	const apply = (message: AgentMessage): void => {
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				pending.add(call.id);
			}
		}
		if (message.role === "tool") {
			if (!pending.delete(message.tool_call_id)) {
				invalid = true;
			}
		}
	};
	for (const entry of entries) {
		if (entry.kind === "compaction") {
			pending.clear();
			invalid = false;
			for (const message of entry.retainedTail) {
				apply(message as AgentMessage);
			}
		} else if (entry.kind === "rewind") {
			pending.clear();
			invalid = false;
		} else if (entry.kind === "message") {
			apply(entry.message as AgentMessage);
		}
		if (!invalid && pending.size === 0 && entry.id && !entry.id.startsWith("recovered:")) {
			safe.add(entry.id);
		}
	}
	return safe;
}

export function isSafeRewindTarget(entries: readonly SessionEntry[], index: number): boolean {
	const id = entries[index]?.id;
	return !!id && safeRewindTargets(entries.slice(0, index + 1)).has(id);
}

function collectCarriedInputs(abandoned: readonly SessionEntry[]): AgentMessage[] {
	const raw: AgentMessage[] = [];
	for (const entry of abandoned) {
		if (entry.kind === "input" && entry.input.source?.kind !== "runtime") {
			const m = projectInputMessage(entry.input);
			if (m) raw.push(m);
		} else if (entry.kind === "message" && entry.message.role === "user") {
			raw.push(structuredClone(entry.message as AgentMessage));
		} else if (entry.kind === "rewind") {
			raw.push(...entry.carriedInputs.map((m) => structuredClone(m)));
		}
	}
	const seen = new Set<string>();
	const deduped: AgentMessage[] = [];
	for (const msg of raw) {
		const key = msg.id ? `id:${msg.id}` : `text:${msg.content}`;
		if (!seen.has(key)) {
			seen.add(key);
			deduped.push(msg);
		}
	}
	return deduped;
}

function rewindMessages(entry: Extract<SessionEntry, { kind: "rewind" }>): AgentMessage[] {
	const content = `${entry.notice}\n[当前主线从此处继续；被放弃分支仅在需要时通过只读历史查询]`;
	return [{
		id: `continuity:${entry.id}`,
		role: "custom",
		customType: "session-continuity",
		content,
		display: true,
	}];
}

/** Compaction is a projection; it cannot erase the latest committed rewind facts.
 * Injected notice is positioned immediately after compactionSummary, never at the absolute tail. */
export function protectRewindContext(messages: AgentMessage[], entries: readonly SessionEntry[]): AgentMessage[] {
	const latest = entries.findLast((entry): entry is Extract<SessionEntry, { kind: "rewind" }> => entry.kind === "rewind");
	if (!latest) return messages;
	const ids = new Set(messages.map((message) => message.id));
	const missing = rewindMessages(latest).slice(0, 1).filter((message) => !ids.has(message.id));
	if (missing.length === 0) return messages;
	if (messages.length > 0 && messages[0].role === "compactionSummary") {
		return [messages[0], ...missing, ...messages.slice(1)];
	}
	return [...missing, ...messages];
}
