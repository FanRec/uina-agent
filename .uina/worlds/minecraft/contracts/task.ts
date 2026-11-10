import type { Entry, RunSummary } from "./runtime.js";
import type { JsonValue, ProgramCheckpoint, Progress, Vec3 } from "./values.js";
import { COLLECT_DEFAULT_COUNT } from "../program/collect.js";

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
			const count = input.count ?? COLLECT_DEFAULT_COUNT;
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

function compactProgress(progress: Progress, entry?: Entry): Progress {
	if (entry?.kind !== "call") return progress;
	if (entry.selector === "collect@1" && typeof progress.acquired === "number")
		return { summary: progress.summary, acquired: progress.acquired, goal: progress.goal };
	if (entry.selector === "build@1" && progress.goal !== undefined)
		return { summary: progress.summary, goal: progress.goal, missing: progress.missing };
	return progress;
}

export function taskProgressText(snapshot: RunSummary, entry?: Entry): string | undefined {
	const progress = compactProgress(snapshot.progress, entry);
	if (typeof progress?.summary === "string" && progress.summary.trim()) return progress.summary.trim();
	if (entry?.kind !== "call" || !progress) return undefined;
	if (entry.selector === "collect@1" && typeof progress.acquired === "number") return `已入包 ${progress.acquired}`;
	if (entry.selector === "explore@1" && typeof progress.scanned === "number" && typeof progress.traveled === "number")
		return `已扫描 ${progress.scanned} 处，走了 ${Math.round(progress.traveled)} 格`;
	if (entry.selector === "build.resume@1" && typeof progress.verifiedAtCheckpoint === "number")
		return `已核验 ${progress.verifiedAtCheckpoint} 格`;
	const goal = progress.goal;
	if (
		entry.selector === "build@1" &&
		goal &&
		typeof goal === "object" &&
		!Array.isArray(goal) &&
		typeof goal.completed === "number" &&
		typeof goal.total === "number"
	)
		return `已完成 ${goal.completed}/${goal.total} 格`;
	return undefined;
}

export function taskView(task: string, snapshot: RunSummary, entry?: Entry) {
	const progress = compactProgress(snapshot.progress, entry);
	return {
		task,
		...taskIdentity(entry),
		revision: snapshot.revision,
		phase: snapshot.phase === "awaiting_decision" ? "needs_input" : snapshot.phase,
		control: snapshot.control,
		...(progress && Object.values(progress).some((value) => value !== undefined) ? { progress } : {}),
		...(snapshot.progressComplete === false ? { progressComplete: false } : {}),
		...(snapshot.unknownEffectCount > 0 || snapshot.unknownEffectsComplete === false
			? { unknownEffectCount: snapshot.unknownEffectCount }
			: {}),
		...(snapshot.unknownEffectsComplete === false ? { unknownEffectsComplete: false } : {}),
		...(snapshot.completion.scope === "execution" && snapshot.phase === "finished"
			? { completionScope: "execution" }
			: {}),
		...(snapshot.phase === "waiting" ? { waiting: snapshot.waiting } : {}),
		...(snapshot.phase === "awaiting_decision"
			? {
					decision: snapshot.decision,
					reason: snapshot.reason,
					...(snapshot.reasonComplete === false ? { reasonComplete: false } : {}),
				}
			: {}),
		...(snapshot.phase === "finished" ? { outcome: snapshot.outcome, error: snapshot.error } : {}),
	};
}

export function constructionDecisionEvidence(
	task: string,
	snapshot: Pick<RunSummary, "unknownEffects">,
	checkpoint?: ProgramCheckpoint | null,
) {
	const value = checkpoint?.value;
	const state = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const verifiedAtCheckpoint =
		typeof state.verified === "number" && Number.isInteger(state.verified) && state.verified >= 0
			? state.verified
			: undefined;
	// These cells did not match at the last check, which may have been incomplete.
	const cells = (Array.isArray(state.remaining) ? state.remaining : []).filter(
		(at): at is Vec3 & JsonValue =>
			at !== null &&
			typeof at === "object" &&
			!Array.isArray(at) &&
			typeof at.x === "number" &&
			Number.isInteger(at.x) &&
			typeof at.y === "number" &&
			Number.isInteger(at.y) &&
			typeof at.z === "number" &&
			Number.isInteger(at.z),
	);
	const [effect] = snapshot.unknownEffects ?? [];
	const nextCall = effect
		? { action: "tasks", params: { op: "trace", task, record: effect } }
		: cells[0]
			? { action: "observe", params: { selector: "block@1", input: { at: cells[0] } } }
			: undefined;
	return {
		...(verifiedAtCheckpoint !== undefined || cells.length
			? {
					construction: {
						verifiedAtCheckpoint,
						...(cells.length ? { cellsToRecheck: cells.slice(0, 8), cellsToRecheckCount: cells.length } : {}),
					},
				}
			: {}),
		...(nextCall ? { nextCall } : {}),
	};
}
