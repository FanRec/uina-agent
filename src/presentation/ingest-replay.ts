/**
 * 恢复事实摄取：journal（entries + auxiliary 事件记录）-> FactDraft[]。
 *
 * 与 ingestLive 产出同一词汇的事实；差别只在来源与时间：这里的时间全部来自
 * 持久化记录的时间戳，缺失即 undefined，绝不以当前时钟补齐。
 *
 * 工具的开始/结束与状态不来自 AgentMessage，而来自 auxiliary 里的
 * `tool_started` / `tool_finished` 事件记录——它们是 journal 的权威事实，
 * AgentMessage 只是模型可见投影。
 */

import type { ToolResultStatus } from "../core/types.js";
import type { SessionCustomEntryRecord, SessionEntry, SessionEventRecord } from "../session/types.js";
import type { FactDraft, FactPayload } from "./facts.js";
import { sanitizeExternal } from "./sanitize.js";

export interface ReplayInput {
	readonly entries: readonly SessionEntry[];
	/** Host.restoredAuxiliary / auxiliaryEntries()：工具与回合终局事件记录。 */
	readonly auxiliary?: readonly (SessionEventRecord | SessionCustomEntryRecord)[];
}

interface JournalTool {
	name?: string;
	args?: unknown;
	startedAt?: number;
	finishedAt?: number;
	status?: ToolResultStatus;
}

/**
 * presentation core 只允许 type-only 依赖 core（check:boundaries），因此这里镜像
 * core/types 的 `TOOL_RESULT_STATUSES`；tests/ui-projection.test.ts 断言展示矩阵与
 * core 列表一致，tests/ui-replay-equivalence 覆盖 replay 的真实状态来源。
 */
const TOOL_STATUSES: readonly ToolResultStatus[] = ["succeeded", "failed", "cancelled", "unknown", "not_started"];

function isToolStatus(value: unknown): value is ToolResultStatus {
	return typeof value === "string" && (TOOL_STATUSES as readonly string[]).includes(value);
}

/** journal 时间戳（ISO 字符串）-> Unix 毫秒；缺失或非法保持 undefined。 */
function parseJournalTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function replay(payload: FactPayload, at: number | undefined): FactDraft {
	return at === undefined ? { ...payload, origin: "replay" } : { ...payload, origin: "replay", at };
}

/** 工具 journal（开始/结束/状态）的唯一读取入口：只服务事实摄取，渲染不参与。 */
function collectJournalTools(
	auxiliary: readonly (SessionEventRecord | SessionCustomEntryRecord)[],
): Map<string, JournalTool> {
	const tools = new Map<string, JournalTool>();
	for (const record of auxiliary) {
		if (record.kind !== "event") continue;
		if (record.event !== "tool_started" && record.event !== "tool_finished") continue;
		const at = parseJournalTime(record.timestamp);
		const data = record.data;
		const callId = typeof data.callId === "string" ? data.callId : undefined;
		if (callId === undefined) continue;
		const journal = tools.get(callId) ?? {};
		if (record.event === "tool_started") {
			journal.startedAt = at;
			if (typeof data.name === "string") journal.name = data.name;
			journal.args = data.args;
		} else {
			journal.finishedAt = at;
			if (isToolStatus(data.status)) journal.status = data.status;
			// 完成事件通常也带 name/args（loop 写入时就有）；以开始事件优先，缺失时补齐。
			if (journal.name === undefined && typeof data.name === "string") journal.name = data.name;
			if (journal.args === undefined) journal.args = data.args;
		}
		tools.set(callId, journal);
	}
	return tools;
}

function collectTurnOutcomes(auxiliary: readonly (SessionEventRecord | SessionCustomEntryRecord)[]): {
	abortedTurns: Map<number, number | undefined>;
	failedTurns: Map<number, { at?: number; text?: string }>;
} {
	const abortedTurns = new Map<number, number | undefined>();
	const failedTurns = new Map<number, { at?: number; text?: string }>();
	for (const record of auxiliary) {
		if (record.kind !== "event") continue;
		if (record.event !== "turn_aborted" && record.event !== "turn_failed") continue;
		const at = parseJournalTime(record.timestamp);
		const data = record.data;
		const turn = typeof data.turnId === "number" ? data.turnId : undefined;
		if (turn === undefined) continue;
		if (record.event === "turn_aborted") {
			abortedTurns.set(turn, at);
		} else {
			failedTurns.set(turn, {
				at,
				text: typeof data.error === "string" ? sanitizeExternal(data.error) : undefined,
			});
		}
	}
	return { abortedTurns, failedTurns };
}

export function ingestReplay(input: ReplayInput): readonly FactDraft[] {
	const tools = collectJournalTools(input.auxiliary ?? []);
	const { abortedTurns, failedTurns } = collectTurnOutcomes(input.auxiliary ?? []);
	const facts: FactDraft[] = [];
	let turn = 0;
	let turnOpen = false;

	/** 一个回合确认结束后才结算：已知中止/失败沿用 journal 的终局，否则只记"已结束"。 */
	const closeTurn = (): void => {
		if (!turnOpen) return;
		turnOpen = false;
		if (abortedTurns.has(turn)) {
			facts.push(replay({ kind: "turn.aborted", turn }, abortedTurns.get(turn)));
			return;
		}
		facts.push(replay({ kind: "turn.ended", turn }, undefined));
		const failed = failedTurns.get(turn);
		if (failed?.text !== undefined) {
			facts.push(replay({ kind: "error", text: failed.text }, failed.at));
		}
	};

	for (const entry of input.entries) {
		const at = parseJournalTime(entry.timestamp);
		switch (entry.kind) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") {
					closeTurn();
					turn += 1;
					turnOpen = true;
					facts.push(
						replay(
							{
								kind: "turn.started",
								turn,
								userText: sanitizeExternal(message.content),
								images: message.images,
							},
							at,
						),
					);
					break;
				}
				if (message.role === "assistant") {
					if (message.thinking !== undefined && message.thinking.length > 0) {
						facts.push(replay({ kind: "thinking.delta", text: sanitizeExternal(message.thinking) }, at));
					}
					if (message.content.length > 0) {
						facts.push(replay({ kind: "assistant.delta", text: sanitizeExternal(message.content) }, at));
					}
					for (const call of message.tool_calls ?? []) {
						const journal = tools.get(call.id);
						facts.push(
							replay(
								{
									kind: "tool.started",
									callId: call.id,
									name: call.name,
									args: call.args,
								},
								journal?.startedAt ?? journal?.finishedAt ?? at,
							),
						);
					}
					break;
				}
				if (message.role === "tool") {
					const journal = tools.get(message.tool_call_id);
					facts.push(
						replay(
							{
								kind: "tool.finished",
								callId: message.tool_call_id,
								name: message.name ?? journal?.name ?? "",
								args: journal?.args,
								status: journal?.status ?? message.status ?? "unknown",
								result: sanitizeExternal(message.content),
								details: message.details,
								images: message.images,
							},
							journal?.finishedAt ?? at,
						),
					);
					break;
				}
				if (message.role === "custom") {
					facts.push(
						replay(
							{
								kind: "custom.message",
								customType: message.customType,
								content: sanitizeExternal(message.content),
								images: message.images,
								display: message.display,
								details: message.details,
							},
							at,
						),
					);
					break;
				}
				// system 消息不属于展示事实（它由 context.prepared 表达）。
				break;
			}

			case "input": {
				const { source, id, text, images } = entry.input;
				// 与 live 的 external_input 同一条件：runtime 来源且明确为外部。
				if (source?.kind === "runtime" && source.origin === "external") {
					facts.push(
						replay(
							{
								kind: "external",
								inputId: id,
								source,
								receivedAt: entry.timestamp ?? "",
								text: sanitizeExternal(text),
								images,
							},
							at,
						),
					);
				}
				// 用户直接输入由紧随其后的 user message 表达；仅入队记录不产生展示节点。
				break;
			}

			case "custom_message":
				facts.push(
					replay(
						{
							kind: "custom.message",
							customType: entry.customType,
							content: sanitizeExternal(entry.content),
							images: entry.images,
							display: entry.display,
							details: entry.details,
						},
						at,
					),
				);
				break;

			case "rewind":
				facts.push(
					replay(
						{
							kind: "rewind",
							fromId: entry.record.fromId,
							targetId: entry.record.targetId,
							toEntrySeq: entry.seq ?? entry.record.seq,
						},
						at,
					),
				);
				break;

			default: {
				const _exhaustive: never = entry;
				return _exhaustive;
			}
		}
	}
	// 恢复出来的会话没有"仍在运行"的回合：最后一个回合同样以已结束收口。
	closeTurn();
	return facts;
}
