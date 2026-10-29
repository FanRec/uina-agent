/**
 * 实时事实摄取：HostEventRecord -> FactDraft[]。
 *
 * 只翻译，不判断。时间一律取宿主派发记录里的 `at`；事件本身不携带时刻。
 * 无展示含义的运行时事件显式忽略，新增事件类型会因穷尽断言而编译报错。
 */

import type { HostEventRecord } from "../host/events.js";
import type { FactDraft, FactPayload } from "./facts.js";
import { sanitizeExternal } from "./sanitize.js";

function live(payload: FactPayload, at: number): FactDraft {
	return { ...payload, origin: "live", at };
}

export function ingestLive(record: HostEventRecord): readonly FactDraft[] {
	const at = record.at;
	const event = record.event;

	switch (event.type) {
		case "turn_start":
			return [
				live(
					{
						kind: "turn.started",
						turn: event.turnNumber,
						userText: sanitizeExternal(event.userText),
						images: event.images,
					},
					at,
				),
			];

		case "turn_end":
			return [live({ kind: "turn.ended", turn: event.turnNumber, usage: event.requestUsage }, at)];

		case "turn_aborted":
			return [live({ kind: "turn.aborted", turn: event.turnNumber }, at)];

		case "output_update": {
			if (event.channel === "thinking") {
				return [live({ kind: "thinking.delta", text: sanitizeExternal(event.text) }, at)];
			}
			if (event.channel === "content") {
				return [live({ kind: "assistant.delta", text: sanitizeExternal(event.text) }, at)];
			}
			// tool 通道是工具参数的流式传输，展示由 tool.started/tool.finished 表达。
			return [];
		}

		case "tool_call":
			return [
				live(
					{
						kind: "tool.started",
						callId: event.callId,
						name: event.toolName,
						args: event.args,
						invocationId: event.invocationId,
					},
					at,
				),
			];

		case "tool_result":
			return [
				live(
					{
						kind: "tool.finished",
						callId: event.callId,
						name: event.toolName,
						args: event.args,
						status: event.status,
						result: sanitizeExternal(event.result),
						details: event.details,
						images: event.images,
					},
					at,
				),
			];

		case "usage_update":
			return [live({ kind: "usage.reported", usage: event.usage, estimated: false }, at)];

		case "context_update":
			return [live({ kind: "context.updated", snapshot: event.snapshot }, at)];

		case "context_prepare":
			return [
				live(
					{
						kind: "context.prepared",
						turn: event.turnNumber,
						systemPrompt: sanitizeExternal(event.systemPrompt),
						injections: event.injections.map((item) => ({ ...item, preview: sanitizeExternal(item.preview) })),
					},
					at,
				),
			];

		case "model_select":
			return [live({ kind: "model.selected", model: event.model }, at)];

		case "thinking_level_select":
			return [live({ kind: "thinking.selected", level: event.level }, at)];

		case "session_compact_start":
			return [live({ kind: "compaction.started", operationId: event.operationId }, at)];

		case "session_compact_progress":
			return [
				live(
					{
						kind: "compaction.progress",
						operationId: event.operationId,
						phase: event.phase,
						detail: event.detail === undefined ? undefined : sanitizeExternal(event.detail),
					},
					at,
				),
			];

		case "session_compact":
			return [
				live(
					{
						kind: "compaction.ended",
						operationId: event.operationId,
						status: event.status,
						summary: event.summary === undefined ? undefined : sanitizeExternal(event.summary),
						error: event.error === undefined ? undefined : sanitizeExternal(event.error),
						tokensBefore: event.tokensBefore,
						tokensAfter: event.tokensAfter,
						retainedTail: event.retainedTailEntries,
					},
					at,
				),
			];

		case "provider_retry":
			return [
				live(
					{
						kind: "retry",
						provider: event.provider,
						attempt: event.attempt,
						delayMs: event.delayMs,
						status: event.status,
						reason: sanitizeExternal(event.reason),
					},
					at,
				),
			];

		case "provider_recovered":
			return [live({ kind: "retry.recovered", provider: event.provider, attempt: event.attempt }, at)];

		case "queue":
			return [live({ kind: "queue", items: event.items }, at)];

		case "error":
			return [live({ kind: "error", text: sanitizeExternal(event.text) }, at)];

		case "notice":
			return [live({ kind: "notice", level: "info", text: sanitizeExternal(event.text) }, at)];

		case "external_input":
			return [
				live(
					{
						kind: "external",
						inputId: event.inputId,
						source: event.source,
						receivedAt: event.receivedAt,
						text: sanitizeExternal(event.text),
						images: event.images,
					},
					at,
				),
			];

		case "custom_message":
			return [
				live(
					{
						kind: "custom.message",
						customType: event.message.customType,
						content: sanitizeExternal(event.message.content),
						images: event.message.images,
						display: event.message.display,
						details: event.message.details,
					},
					at,
				),
			];

		case "session_rewind":
			// 回溯不是增量事实：controller 以 replay 生成整段事实并 replaceAll。
			return [];

		// ── 设计内忽略：步骤生命周期与输入受理不产生展示节点。 ──
		case "agent_start":
		case "agent_end":
		case "agent_settled":
		case "output_start":
		case "output_end":
		case "output_interrupted":
		case "input_accepted":
		case "input_settled":
		case "custom_entry":
			return [];

		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}
