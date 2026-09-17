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
	SessionRewindRecord,
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

/**
 * canonical replay 的唯一事实状态机（双部分模型，执行稿 v6 §2）：
 * - **semantic state**：仅 CanonicalRecord 可改——主线、全历史、队列、工具因果；
 * - **auxiliary timeline**：AuxiliaryRecord 的 opaque 登记处（event 按 name 级静态
 *   分类：queue_* 与 tool_* 名称为 Canonical；turn_failed/turn_aborted 仅登记不解释），
 *   供 projector 与展示消费。
 *
 * 派生查询（safeTargets）一律从本状态增量维护，禁止第二个 journal walker。
 * 纯度契约：解释不修复——replay 零合成（P3b 起），未决操作由 checkRecord 的
 * unresolved-operation detection 拒绝非法延续；恢复只能经 planRecovery 落盘。
 */
export interface CanonicalState {
	/** 主线（回溯在此截断）。 */
	entries: HydratedSessionEntry[];
	/** 全历史，含被放弃切片（只增不减）。 */
	allEntries: HydratedSessionEntry[];
	queued: Map<string, QueuedInput>;
	pendingCalls: PendingCall[];
	finishedEvents: Map<string, { status: ToolResultStatus; result?: string }>;
	resultIds: Set<string>;
	/** 记录身份幂等索引：reducer 拒绝重复记录 id；recovery identity 由本索引结构化管理。 */
	recordIds: Set<string>;
	/** 派生查询：主线上可安全回溯的目标（完整工具交换处的持久化节点）。 */
	safeTargets: Set<string>;
	/** auxiliary timeline：仅登记、不解释的记录。 */
	auxiliary: SessionEventRecord[];
	// ---- safeTargets 增量维护的游标（reducer 内部状态，非公共语义）----
	openCallIds: Set<string>;
	settlementInvalid: boolean;
}

export function initialCanonicalState(): CanonicalState {
	return {
		entries: [],
		allEntries: [],
		queued: new Map(),
		pendingCalls: [],
		finishedEvents: new Map(),
		resultIds: new Set(),
		recordIds: new Set(),
		safeTargets: new Set(),
		auxiliary: [],
		openCallIds: new Set(),
		settlementInvalid: false,
	};
}

// ---------------------------------------------------------------------------
// CanonicalRecord / AuxiliaryRecord 静态分类（持久化双原语的分类依据，event 到
// name 级）。双原语共享同一持久化强度（durable append + fsync），唯一区别是
// reducer 的语义效果：CanonicalRecord 改变 semantic state；AuxiliaryRecord 仅
// 登记 auxiliary timeline——内存 timeline 同步由 applyRecord 统一完成。
// 分类成文于 applyRecord/applyEvent 的分派 switch（唯一执行点）：
// turn_failed/turn_aborted 仅登记；custom_entry 现仍解释进 session 条目
// （P3a 起成文保留，P6 数据模型裁定时收口为仅登记）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// reduceRecord：check / apply 两相
//
// check 先行（非法即 throw SessionFormatError，绝不触碰状态），apply 落状态。
// 持久化路径据此达成"内存永不领先磁盘"：check → durable append → apply。
// ---------------------------------------------------------------------------

/** 两相第一相：校验记录对当前状态的合法性。失败即抛，状态不变。 */
export function checkRecord(state: CanonicalState, record: SessionRecord): void {
	if (state.recordIds.has(record.id)) {
		throw new SessionFormatError(`重复记录 id: ${record.id}`);
	}
	switch (record.kind) {
		case "rewind":
			return checkRewind(state, record);
		case "input":
			ensureSettled(state, record.kind);
			if (!state.queued.has(record.input.id)) {
				throw new SessionFormatError(`input 没有对应队列项: ${record.input.id}`);
			}
			return;
		case "message":
			return checkMessage(state, record);
		case "event":
			return checkEvent(state, record);
		case "custom_message":
		case "custom_entry":
			ensureSettled(state, record.kind);
			// schema 已由 isRecord 把关，语义上无条件接受。
			return;
		case "compaction":
			ensureSettled(state, record.kind);
			return;
	}
}

/** L3 unresolved-operation detection：存在未结算调用时，任何改变对话事实的
 * 后续记录都非法（恢复必须先经 planRecovery 落盘，replay 不制造事实）。
 * tool message / tool 事件 / 队列事件 / auxiliary 事件不受此限。 */
function ensureSettled(state: CanonicalState, kind: SessionRecord["kind"]): void {
	const unsettled = state.pendingCalls.filter((call) => !state.resultIds.has(call.callId));
	if (unsettled.length > 0) {
		throw new SessionFormatError(
			`存在未结算的工具调用，无法解释 ${kind} 记录: ${unsettled.map((call) => call.callId).join(", ")}`,
		);
	}
}

function checkRewind(state: CanonicalState, record: SessionRewindRecord): void {
	ensureSettled(state, record.kind);
	const index = state.entries.findIndex((entry) => entry.id === record.targetId);
	if (state.entries.at(-1)?.id !== record.fromId || index < 0 || index === state.entries.length - 1) {
		throw new SessionFormatError("回溯目标必须是当前主线的历史祖先，原位置必须匹配");
	}
	if (!state.safeTargets.has(record.targetId)) {
		throw new SessionFormatError("回溯目标切断工具调用与结果或不是持久化节点");
	}
}

function checkMessage(state: CanonicalState, record: SessionRecord & { kind: "message" }): void {
	const { message } = record;
	if (message.role === "assistant" && message.tool_calls?.length) {
		const ids = new Set<string>();
		for (const call of message.tool_calls) {
			if (!call.id || ids.has(call.id)) {
				throw new SessionFormatError(`重复工具调用 id: ${call.id}`);
			}
			ids.add(call.id);
		}
		// assistant-with-calls 开启新的调用批：之前的调用必须已全部结算。
		ensureSettled(state, record.kind);
		return;
	}
	if (message.role === "tool") {
		const toolMsg = message as { role: "tool"; tool_call_id: string };
		const call = state.pendingCalls.find((candidate) => candidate.callId === toolMsg.tool_call_id);
		if (!call || state.resultIds.has(call.callId)) {
			throw new SessionFormatError(`工具结果没有对应的未完成调用: ${toolMsg.tool_call_id}`);
		}
		return;
	}
	ensureSettled(state, record.kind);
}

function checkEvent(state: CanonicalState, record: SessionEventRecord): void {
	const data = record.data;
	switch (record.event) {
		case "queue_enqueued": {
			if (
				typeof data.id !== "string" ||
				typeof data.order !== "number" ||
				(data.mode !== "steer" && data.mode !== "followUp") ||
				typeof data.text !== "string" ||
				!validImages(data.images)
			) {
				throw new SessionFormatError("queue_enqueued 数据不完整");
			}
			if (state.queued.has(data.id)) {
				throw new SessionFormatError(`重复队列 id: ${data.id}`);
			}
			if (!Number.isSafeInteger(data.order) || data.order <= 0) {
				throw new SessionFormatError("queue_enqueued order 无效");
			}
			return;
		}
		case "queue_consumed":
		case "queue_restored": {
			if (typeof data.id !== "string" || !state.queued.has(data.id)) {
				throw new SessionFormatError(`${record.event} 缺少 id`);
			}
			return;
		}
		case "tool_started":
		case "tool_finished": {
			if (typeof data.callId !== "string") {
				throw new SessionFormatError(`${record.event} 缺少 callId`);
			}
			const pending = state.pendingCalls.find((call) => call.callId === data.callId);
			if (!pending) {
				throw new SessionFormatError(`${record.event} 没有对应调用: ${data.callId}`);
			}
			if (record.event === "tool_started") {
				if (pending.started) {
					throw new SessionFormatError(`tool_started 重复: ${data.callId}`);
				}
				return;
			}
			if (state.finishedEvents.has(data.callId)) {
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
			return;
		}
		case "turn_failed":
		case "turn_aborted":
			// Auxiliary：无语义校验，apply 仅登记。
			return;
	}
}

/** 两相第二相：增量登记。前置契约 = checkRecord 已对同一 state 通过。 */
export function applyRecord(state: CanonicalState, record: SessionRecord): void {
	state.recordIds.add(record.id);
	switch (record.kind) {
		case "rewind":
			return applyRewind(state, record);
		case "input":
			state.queued.delete(record.input.id);
			return addEntry(state, record, { kind: "input", input: structuredClone(record.input) });
		case "custom_message":
			return addEntry(state, record, {
				kind: "custom_message",
				customType: record.customType,
				content: record.content,
				...(record.images ? { images: record.images } : {}),
				...(record.display === undefined ? {} : { display: record.display }),
				...(record.details === undefined ? {} : { details: record.details }),
			});
		case "custom_entry":
			return addEntry(state, record, {
				kind: "custom_entry",
				customType: record.customType,
				...(record.data === undefined ? {} : { data: record.data }),
			});
		case "message":
			return applyMessage(state, record);
		case "compaction":
			return addEntry(state, record, {
				kind: "compaction",
				summary: record.summary,
				retainedTail: structuredClone(record.retainedTail),
				tokensBefore: record.tokensBefore,
			});
		case "event":
			return applyEvent(state, record);
	}
}

function applyRewind(state: CanonicalState, record: SessionRewindRecord): void {
	const index = state.entries.findIndex((entry) => entry.id === record.targetId);
	const abandoned = state.entries.slice(index + 1);
	const carriedInputs = collectCarriedInputs(abandoned);
	const effects = summarizeAbandonedEffects(abandoned);
	const notice = buildRewindNotice(record, effects);
	state.entries.splice(index + 1);
	state.pendingCalls = [];
	addEntry(state, record, { kind: "rewind", record: structuredClone(record), notice, carriedInputs, effects });
}

function applyMessage(state: CanonicalState, record: SessionRecord & { kind: "message" }): void {
	const { message } = record;
	if (message.role === "assistant" && message.tool_calls?.length) {
		state.resultIds.clear();
		state.finishedEvents.clear();
		addEntry(state, record, { kind: "message", message });
		state.pendingCalls = message.tool_calls.map((call) => ({
			originId: record.id,
			callId: call.id,
			name: call.name,
			started: false,
		}));
		return;
	}
	if (message.role === "tool") {
		// 闭合调用：resultIds 是"已收到结果"的权威索引，planRecovery 据此不再生成恢复事实。
		const toolMsg = message as { role: "tool"; tool_call_id: string };
		const call = state.pendingCalls.find((candidate) => candidate.callId === toolMsg.tool_call_id)!;
		state.resultIds.add(call.callId);
	}
	addEntry(state, record, { kind: "message", message });
}

function applyEvent(state: CanonicalState, record: SessionEventRecord): void {
	const data = record.data;
	switch (record.event) {
		case "queue_enqueued":
			state.queued.set(data.id as string, {
				id: data.id as string,
				order: data.order as number,
				mode: data.mode as "steer" | "followUp",
				text: data.text as string,
				...(validImages(data.images) && data.images ? { images: data.images } : {}),
				...(isInputSource(data.source) ? { source: data.source } : {}),
				...(data.data !== undefined ? { data: data.data } : {}),
			});
			return;
		case "queue_consumed":
		case "queue_restored":
			state.queued.delete(data.id as string);
			return;
		case "tool_started": {
			const pending = state.pendingCalls.find((call) => call.callId === data.callId)!;
			pending.started = true;
			return;
		}
		case "tool_finished":
			state.finishedEvents.set(data.callId as string, {
				status: data.status as ToolResultStatus,
				result: typeof data.result === "string" ? data.result : undefined,
			});
			return;
		case "turn_failed":
		case "turn_aborted":
			// Auxiliary 登记：不改变 semantic state，只同步 opaque timeline。
			state.auxiliary.push(record);
			return;
	}
}

/** 主线/全历史追加 + safeTargets 增量维护：每个条目只在此处入队，单一路径。 */
function addEntry(
	state: CanonicalState,
	record: SessionRecord,
	payload: SessionEntryPayload,
	syntheticId?: string,
): void {
	const entry: HydratedSessionEntry = {
		...payload,
		id: syntheticId ?? record.id,
		seq: record.seq,
		timestamp: record.timestamp,
		parentId: state.entries.at(-1)?.id ?? null,
	};
	state.entries.push(entry);
	state.allEntries.push(entry);
	trackSafety(state, entry);
}

/** safeTargets 增量规则（与逐前缀派生等价）：压缩/回溯重置工具交换状态；
 * 消息按 assistant(开启调用)/tool(闭合调用) 增量更新；无未闭合调用且无结果
 * 孤儿处的持久化节点才是安全回溯目标。 */
function trackSafety(state: CanonicalState, entry: HydratedSessionEntry): void {
	if (entry.kind === "compaction") {
		state.openCallIds.clear();
		state.settlementInvalid = false;
		for (const message of entry.retainedTail as AgentMessage[]) {
			applySafetyMessage(state, message);
		}
	} else if (entry.kind === "rewind") {
		state.openCallIds.clear();
		state.settlementInvalid = false;
	} else if (entry.kind === "message") {
		applySafetyMessage(state, entry.message as AgentMessage);
	}
	if (!state.settlementInvalid && state.openCallIds.size === 0 && !entry.id.startsWith("recovered:")) {
		state.safeTargets.add(entry.id);
	}
}

function applySafetyMessage(state: CanonicalState, message: AgentMessage): void {
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			state.openCallIds.add(call.id);
		}
	}
	if (message.role === "tool") {
		if (!state.openCallIds.delete(message.tool_call_id)) {
			state.settlementInvalid = true;
		}
	}
}

// ---------------------------------------------------------------------------
// canonicalReplay：同一个 reducer 从头折叠（仅启动、校验与测试）
// ---------------------------------------------------------------------------

/** 唯一解释器：check 先行、apply 落状态。 */
export function reduceRecord(state: CanonicalState, record: SessionRecord): void {
	checkRecord(state, record);
	applyRecord(state, record);
}

/** canonicalReplay：pure、deterministic、no I/O。对同一状态自增 reduceRecord，
 * 与持久化路径的增量步语义严格一致（replay ≡ memory 的机器可验证基础）。 */
export function canonicalReplay(records: readonly SessionRecord[]): CanonicalState {
	const state = initialCanonicalState();
	for (const record of records) {
		reduceRecord(state, record);
	}
	return state;
}

/** 队列的对外视图：按 order 稳定排序。 */
export function queuedInputs(state: CanonicalState): QueuedInput[] {
	return [...state.queued.values()].sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// planRecovery：crash 结算决策（纯函数，独立于 reducer）
// ---------------------------------------------------------------------------

/** 一条恢复事实：稳定身份 + 合成工具结果。 */
export interface RecoveryEntry {
	/** 稳定恢复身份 `recovered:${originId}:${callId}`；落盘后 reducer 经 recordIds 拒绝重复。 */
	id: string;
	callId: string;
	message: AgentMessage;
}

export interface RecoveryPlan {
	/** 逐条提交后 CanonicalState 均合法；任意前缀落盘后再 crash，
	 * replay + planRecovery 从该处续作且不再生成已落盘项（幂等）。 */
	entries: RecoveryEntry[];
}

/** crash 结算决策：把未决调用结算为显式恢复事实。pure、deterministic、no I/O。
 * 产出必须持久化（带稳定身份）后才成为 canonical fact——replay 不制造事实（L3）。 */
export function planRecovery(state: CanonicalState): RecoveryPlan {
	const entries: RecoveryEntry[] = [];
	for (const call of state.pendingCalls) {
		if (state.resultIds.has(call.callId)) continue;
		entries.push({
			id: `recovered:${call.originId}:${call.callId}`,
			callId: call.callId,
			message: recoveredToolMessage(call, state.finishedEvents),
		});
	}
	return { entries };
}

function recoveredToolMessage(
	call: PendingCall,
	finishedEvents: Map<string, { status: ToolResultStatus; result?: string }>,
): AgentMessage {
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
	return {
		role: "tool",
		tool_call_id: call.callId,
		status: recoveredStatus,
		content,
	};
}

// ---------------------------------------------------------------------------
// 投影（自由接缝：解释自由，失败只报 provider 错、不伤 journal）
// ---------------------------------------------------------------------------

/** 聚合被放弃历史切片中"发生过什么外部效果"的通用事实。
 * Session Core 不认识任何具体工具：效果由工具在自己的结果 details.effects
 * 里声明（Generic effect facts，经 core/effects.ts 契约读取），这里只做过滤
 * （failed/cancelled/not_started 不构成已发生的事实；unknown 仍上报）与去重。 */
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

function buildRewindNotice(record: SessionRewindRecord, effects: AbandonedEffects): string {
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
	return notice;
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
		// renderable 结构：效果事实与回溯身份从散文中独立出来，UI 可据此渲染。
		details: {
			rewindId: entry.id,
			targetId: entry.record.targetId,
			fromId: entry.record.fromId,
			source: entry.record.source,
			...(entry.effects ? { effects: entry.effects.effects } : {}),
		},
	}];
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

// ---------------------------------------------------------------------------
// record schema 校验（解析边界）
// ---------------------------------------------------------------------------

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
