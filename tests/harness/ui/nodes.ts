/**
 * 展示层 fixture 构造器：
 * 测试直接驱动 TranscriptContainer / UIHost 时，用真实投影节点形状代替旧的散字段参数。
 */
import type { ImageContent } from "../../../src/core/content.js";
import type { ToolResultStatus } from "../../../src/core/types.js";
import type { HostEvent, HostEventRecord } from "../../../src/host/events.js";
import type { AssistantNode, ThinkingNode, ToolNode, TurnNode } from "../../../src/presentation/projection.js";

/** 事件记录：`at` 是 UI 唯一允许的时间来源，测试显式给定。 */
export function record(event: HostEvent, at = Date.now()): HostEventRecord {
	return { at, event };
}

export function turnNode(turn: number, userText: string, images?: readonly ImageContent[]): TurnNode {
	return { kind: "turn", id: `turn:${turn}`, turn, userText, images, status: "running" };
}

export function thinkingNode(turn: number, index: number, text: string, startedAt?: number): ThinkingNode {
	return {
		kind: "thinking",
		id: `turn:${turn}:thinking:${index}`,
		turn,
		text,
		status: "running",
		startedAt,
	};
}

export function assistantNode(turn: number, index: number, text: string, startedAt?: number): AssistantNode {
	return {
		kind: "assistant",
		id: `turn:${turn}:assistant:${index}`,
		turn,
		text,
		status: "running",
		startedAt,
	};
}

export function toolStartNode(name: string, args: unknown, callId: string, startedAt?: number): ToolNode {
	return { kind: "tool", id: `turn:0:tool:${callId}`, turn: 0, callId, name, args, status: "running", startedAt };
}

export function toolDoneNode(
	name: string,
	result: string,
	durationMs: number | undefined,
	status: ToolResultStatus,
	callId: string,
	args?: unknown,
	attachments?: { images?: readonly ImageContent[]; details?: unknown },
): ToolNode {
	return {
		kind: "tool",
		id: `turn:0:tool:${callId}`,
		turn: 0,
		callId,
		name,
		args,
		status,
		durationMs,
		result,
		images: attachments?.images,
		details: attachments?.details,
	};
}
