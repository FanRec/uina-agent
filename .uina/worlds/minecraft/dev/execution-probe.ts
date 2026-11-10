import assert from "node:assert/strict";
import type { MinecraftExecutor } from "../executor/index.js";

/** Capture the active Executor for assertions about persisted execution and delivery. */
export function executionProbe() {
	let active: () => MinecraftExecutor | null = () => null;
	const executor = () => {
		const value = active();
		assert(value, "no active Minecraft Executor");
		return value;
	};
	return {
		onExecutorAccess(get: typeof active) {
			active = get;
		},
		executor,
		async resolve(task: unknown): Promise<string> {
			assert(typeof task === "string" && task.startsWith("task:"), "missing task receipt");
			const separator = task.indexOf(":", "task:".length);
			assert(separator > 0, "invalid task receipt");
			const result = await executor().lookup(task.slice(separator + 1));
			assert(result.kind === "found", JSON.stringify(result));
			return result.snapshot.run;
		},
		list: (params: Record<string, unknown> = {}) =>
			executor().rpc<{ items: Record<string, unknown>[]; next?: string }>("runtime.list", params),
		calls: (run: unknown, cursor?: string) =>
			executor().rpc<{ items: Record<string, unknown>[]; next?: string }>("runtime.calls", {
				run,
				...(cursor ? { cursor } : {}),
			}),
		record: async (ref: unknown): Promise<{ kind: "inline"; record: { value: unknown } }> => {
			assert(typeof ref === "string");
			const result = await executor().readRecord(ref, { format: "inline" });
			assert(result.kind === "inline", `record ${ref} unavailable: ${result.kind}`);
			return result;
		},
	};
}

export type ExecutionProbe = ReturnType<typeof executionProbe>;
