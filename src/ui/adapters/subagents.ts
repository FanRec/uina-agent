/**
 * 内核 SubagentRegistry 只读适配器。
 * 将 SubagentRegistry 的领域状态转译为 UI SubagentDashboard 所需的窄接口。
 */

import type { SubagentRegistry } from "../../extensions/subagents/registry.js";
import type { SubagentSnapshot, SubagentRead, SubagentTranscript } from "../../extensions/subagents/types.js";

export interface SubagentPort {
	list(ownerId?: string): SubagentSnapshot[];
	read(id: string, ownerId: string, cursor?: number): SubagentRead;
	transcript(id: string, ownerId: string): SubagentTranscript;
	send(id: string, ownerId: string, text: string): Promise<void>;
	interrupt(id: string, ownerId: string): Promise<"interruption-requested" | "already-finished">;
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
	};
}
