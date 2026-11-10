import assert from "node:assert/strict";
import type { RequestProjection } from "../../../../src/core/types.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { HostEvent } from "../../../../src/host/events.js";
import type { DeepReadonly } from "../../../../src/runtime/events.js";
import type { CompletionReport, DeliveryState } from "../contracts/runtime.js";
import type { MinecraftExecutor } from "../executor/index.js";
import type { ExecutionProbe } from "./execution-probe.js";

interface Timing {
	durableObservedAt?: number;
	acceptedAt?: number;
	eligibleObservedAt?: number;
	hostAcceptedAt?: number;
	modelContextAt?: number;
	replyAt?: number;
	found?: unknown;
}

/** Dev-only observations at the existing Runtime, delivery, and Host boundaries. */
export function playRhythmProbe(probe: ExecutionProbe) {
	const timings = new Map<string, Timing>();
	const attempts = new Map<string, string>();
	const tasks = new Map<string, string>();
	const reads: { task: string; at: number }[] = [];
	const received = new Set<string>();
	const projected = new Set<string>();
	const observed = new Set<Promise<void>>();
	const errors: string[] = [];

	const timing = (ref: string) => {
		const row = timings.get(ref) ?? {};
		timings.set(ref, row);
		return row;
	};
	return {
		watch(executor: MinecraftExecutor) {
			const rpc = executor.rpc.bind(executor);
			executor.rpc = async <T>(...args: Parameters<MinecraftExecutor["rpc"]>): Promise<T> => {
				const result = await rpc<T>(...args);
				if (args[0] === "runtime.readDelivery") {
					const delivery = result as DeliveryState;
					if (delivery.eligible) timing(delivery.delivery.completionRef).eligibleObservedAt ??= Date.now();
				}
				return result;
			};
		},
		wrap(ctx: ServiceCompanionContext): ServiceCompanionContext {
			return {
				...ctx,
				emitEvents: (events) => {
					for (const event of events) {
						if (event.type !== "minecraft_completion" || !event.receipt) continue;
						attempts.set(event.id, event.receipt.key);
					}
					return ctx.emitEvents!(events);
				},
			};
		},
		onHostEvent(event: HostEvent) {
			if (event.type === "input_accepted") {
				const ref = attempts.get(event.inputId);
				if (ref) timing(ref).hostAcceptedAt ??= Date.now();
				else if (event.source?.type === "minecraft_event") received.add(event.inputId);
			}
			if (event.type === "output_end" && event.channel === "content") {
				for (const row of timings.values()) if (row.modelContextAt !== undefined) row.replyAt ??= Date.now();
			}
			if (event.type === "tool_call" && event.args.action === "tasks") {
				const params = event.args.params as { op?: string; task?: string } | undefined;
				if (params?.op === "get" && params.task) reads.push({ task: params.task, at: Date.now() });
			}
			if (event.type !== "tool_result") return;
			const params = event.args.params as { selector?: string; code?: string } | undefined;
			if (event.args.action !== "run" || (params?.selector !== "explore@1" && !params?.code?.includes("rhythmProbe")))
				return;
			const result = event.details as { kind: string; task: string };
			if (result.kind !== "accepted") return;
			const acceptedAt = Date.now();
			const record = (async () => {
				const run = await probe.resolve(result.task);
				const outcome = await probe.executor().wait(run, { timeoutMs: 30_000 });
				assert.equal(outcome.kind, "result");
				const ref = outcome.snapshot.completionRef;
				assert(ref);
				const report = (await probe.record(ref)).record.value as CompletionReport;
				const row = timing(ref);
				row.durableObservedAt = Date.now();
				row.acceptedAt = acceptedAt;
				if (report.reportKind === "terminal" && report.snapshot.outcome === "succeeded") {
					const value = report.snapshot.value as { found?: unknown } | null;
					row.found = value?.found;
				}
				tasks.set(result.task, ref);
			})().catch((error: unknown) => {
				errors.push(String(error));
			});
			observed.add(record);
		},
		onRequest(projection: DeepReadonly<Pick<RequestProjection, "messages">>) {
			for (const message of projection.messages) {
				const input = message.context?.input;
				if (!input) continue;
				if (received.has(input.eventId)) projected.add(input.eventId);
				const ref = attempts.get(input.eventId);
				if (ref) timing(ref).modelContextAt ??= Date.now();
			}
		},
		async report() {
			await Promise.all(observed);
			return {
				worldEventsAccepted: received.size,
				worldEventsProjected: projected.size,
				completionAttempts: attempts.size,
				errors,
				tasks: [...tasks].map(([task, ref]) => {
					const row = timing(ref);
					return {
						task,
						ref,
						...row,
						readsBeforeNotice: reads.filter((read) => read.task === task && read.at < (row.modelContextAt ?? Infinity))
							.length,
					};
				}),
			};
		},
	};
}
