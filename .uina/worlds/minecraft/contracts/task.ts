import type { Entry, RunSummary } from "./runtime.js";

export const taskHandle = (profileId: string, rootRequestId: string): string => `task:${profileId}:${rootRequestId}`;

export function submitsTask(action: string, params: Record<string, unknown>): boolean {
	return action === "run" || action === "chat" || (action === "tasks" && params.op === "continue");
}

const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 80);

export function taskIdentity(entry?: Entry): { label: string; goal?: string } {
	if (!entry) return { label: "任务" };
	if (entry.kind === "program")
		return "name" in entry.source ? { label: `运行 ${short(entry.source.name)}` } : { label: "临时 Program" };
	const input = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input : {};
	switch (entry.selector) {
		case "collect@1": {
			const item = input.item;
			const count = input.count ?? 1;
			return {
				label: "采集",
				...(typeof item === "string" && Number.isInteger(count) && Number(count) > 0
					? { goal: `${count} × ${short(item)}` }
					: {}),
			};
		}
		case "build@1":
		case "build.resume@1": {
			const from = input.from;
			const blueprint =
				from &&
				typeof from === "object" &&
				!Array.isArray(from) &&
				from.kind === "blueprint" &&
				typeof from.name === "string"
					? short(from.name)
					: undefined;
			return {
				label: entry.selector === "build.resume@1" ? "可恢复施工" : "建造",
				...(Array.isArray(input.cells)
					? { goal: `${input.cells.length} 个目标格` }
					: blueprint
						? { goal: `蓝图 ${blueprint}` }
						: {}),
			};
		}
		case "explore@1": {
			const until = input.until;
			const block = until && typeof until === "object" && !Array.isArray(until) ? until.block : undefined;
			return { label: "探索", ...(typeof block === "string" ? { goal: `寻找 ${short(block)}` } : {}) };
		}
		default:
			return { label: short(entry.selector) };
	}
}

export function taskView(task: string, snapshot: RunSummary, entry?: Entry) {
	return {
		task,
		...taskIdentity(entry),
		revision: snapshot.revision,
		phase: snapshot.phase === "awaiting_decision" ? "needs_input" : snapshot.phase,
		control: snapshot.control,
		progress: snapshot.progress,
		progressComplete: snapshot.progressComplete,
		unknownEffectCount: snapshot.unknownEffectCount,
		unknownEffectsComplete: snapshot.unknownEffectsComplete,
		completionScope: snapshot.completion.scope,
		...(snapshot.phase === "waiting" ? { waiting: snapshot.waiting } : {}),
		...(snapshot.phase === "awaiting_decision" ? { decision: snapshot.decision, reason: snapshot.reason } : {}),
		...(snapshot.phase === "finished" ? { outcome: snapshot.outcome, error: snapshot.error } : {}),
	};
}
