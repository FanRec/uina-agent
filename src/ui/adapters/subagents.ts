/**
 * 内核 SubagentRegistry 的 UI 端口（由组合根注入，不是 UI 自造领域对象）。
 *
 * - 读取（list/read/transcript）走宿主视图。
 * - send / interrupt 是面板上的用户动作，端口只做转译；
 *   子 Agent 状态仍由 Registry 拥有，UI 不另存一份。
 * - ownerId 由调用方显式给出，避免 UI 自行推断归属。
 */

import type { SubagentRegistry } from "../../extensions/subagents/registry.js";
import type { SubagentSnapshot, SubagentRead, SubagentTranscript } from "../../extensions/subagents/types.js";

export interface SubagentPort {
	list(ownerId?: string): SubagentSnapshot[];
	read(id: string, ownerId: string, cursor?: number): SubagentRead;
	transcript(id: string, ownerId: string): SubagentTranscript;
	send(id: string, ownerId: string, text: string): Promise<void>;
	interrupt(id: string, ownerId: string): Promise<"interruption-requested" | "already-finished">;
	subscribe(listener: () => void): () => void;
}

export function createSubagentAdapter(registry: SubagentRegistry): SubagentPort {
	return {
		list(ownerId = "root"): SubagentSnapshot[] {
			return registry.list(ownerId);
		},
		read(id: string, ownerId: string, cursor = 0): SubagentRead {
			return registry.read(id, ownerId, cursor);
		},
		transcript(id: string, ownerId: string): SubagentTranscript {
			return registry.transcript(id, ownerId);
		},
		send(id: string, ownerId: string, text: string): Promise<void> {
			return registry.send(id, ownerId, text);
		},
		interrupt(id: string, ownerId: string): Promise<"interruption-requested" | "already-finished"> {
			return registry.interrupt(id, ownerId);
		},
		subscribe(listener: () => void): () => void {
			return registry.onChanged(listener);
		},
	};
}
