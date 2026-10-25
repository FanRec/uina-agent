import { expect, test } from "vitest";
import type { ServiceCompanionContext, WorldEvent } from "../../src/extensions/world-framework/types.js";
import type { HostDeliveryState } from "../../src/core/types.js";
import type { DeliveryState } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import { DeliveryPump } from "../../.uina/worlds/minecraft/executor/delivery.js";

test("a lost Runtime ACK reply cannot retain an already committed input slot", async () => {
	const pending = new Set(["first", "next"]),
		emitted: string[] = [];
	const host = new Map<string, HostDeliveryState>();
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async (key) => host.get(key) ?? { kind: "absent" },
			retire: async () => ({ kind: "retired" }),
		},
		emitEvent: async (event) => {
			emitted.push(event.receipt!.key);
			host.set(event.receipt!.key, {
				kind: "committed",
				receipt: { ...event.receipt!, namespace: "n", session: "s", record: "canonical", channel: "input" },
			});
		},
	};
	const executor = {
		ledger: { requests: async () => [], attempts: async () => [], putAttempt: async () => {} },
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries")
				return { items: [...pending].map((completionRef) => ({ completionRef, requestId: completionRef })) };
			if (method === "runtime.settleDelivery") {
				pending.delete(p.ref!);
				throw new Error("ACK committed but reply lost");
			}
			if (method === "runtime.readDelivery")
				return {
					disposition: "pending",
					eligible: true,
					delivery: {
						completionRef: p.ref,
						requestId: p.ref,
						run: "r",
						segment: "s",
						revision: 1,
						recordBytes: 20000,
						reportKind: "terminal",
						snapshot: { phase: "finished", outcome: "succeeded" },
					},
				};
			throw new Error(method);
		},
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx);
	try {
		await pump.reconcile();
		await Promise.resolve();
		expect(emitted).toEqual(["first"]);
		await pump.reconcile();
		await pump.reconcile();
		await Promise.resolve();
		expect(emitted).toEqual(["first", "next"]);
	} finally {
		await pump.close();
	}
});

test("an old input committed during retire cannot occupy the background input slot", async () => {
	const pending = new Set(["old", "next"]),
		emitted: string[] = [];
	const receipt = {
		key: "old",
		attempt: "old-attempt",
		namespace: "n",
		session: "s",
		record: "canonical",
		channel: "input" as const,
	};
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async (key) =>
				key === "old"
					? { kind: "pending", channel: "input", activity: "processing", attempt: "old-attempt", since: "now" }
					: { kind: "absent" },
			retire: async () => ({ kind: "committed", receipt }),
		},
		emitEvent: async (e) => {
			emitted.push(e.receipt!.key);
		},
	};
	const executor = {
		ledger: {
			requests: async () => [],
			attempts: async () => [
				{
					key: "old",
					attempt: "old-attempt",
					channel: "input",
					namespace: "n",
					session: "s",
					activation: "old-activation",
					createdAt: "now",
				},
			],
			putAttempt: async () => {},
		},
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries")
				return { items: [...pending].map((completionRef) => ({ completionRef, requestId: completionRef })) };
			if (method === "runtime.settleDelivery") {
				pending.delete(p.ref!);
				return null;
			}
			if (method === "runtime.readDelivery")
				return {
					disposition: "pending",
					eligible: true,
					delivery: {
						completionRef: p.ref,
						requestId: p.ref,
						run: "r",
						segment: "s",
						revision: 1,
						recordBytes: 20000,
						reportKind: "terminal",
						snapshot: { phase: "finished", outcome: "succeeded" },
					},
				};
			throw new Error(method);
		},
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx);
	try {
		await pump.reconcile();
		await Promise.resolve();
		expect(emitted).toEqual(["next"]);
		expect(pump.diagnostics().activeInput?.key).toBe("next");
	} finally {
		await pump.close();
	}
});

test("one unavailable report does not block other headers; unavailable content retains its outcome", async () => {
	const committed = new Map<string, HostDeliveryState>();
	const events: WorldEvent[] = [];
	const acked: string[] = [];
	const state: DeliveryState = {
		disposition: "pending",
		eligible: true,
		delivery: {
			completionRef: "good",
			requestId: "q",
			run: "r",
			segment: "s",
			revision: 1,
			recordBytes: 200,
			reportKind: "terminal",
			snapshot: {
				run: "r",
				rootRequestId: "q",
				segment: "s",
				revision: 1,
				record: "rec",
				completion: { scope: "execution" },
				phase: "finished",
				outcome: "failed",
				completionRef: "good",
				progress: { remaining: 2 },
				progressComplete: true,
				control: "stopped",
				unknownEffectCount: 1,
				unknownEffects: ["eff"],
				unknownEffectsComplete: true,
			},
		},
	};
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async (key) =>
				key === "bad" ? { kind: "unavailable", reason: "unreadable key" } : (committed.get(key) ?? { kind: "absent" }),
			retire: async () => ({
				kind: "changed",
				state: { kind: "pending", channel: "input", activity: "queued", attempt: "newer", since: "now" },
			}),
		},
		emitEvent: async (event) => {
			events.push(event);
			committed.set("good", {
				kind: "committed",
				receipt: {
					key: "good",
					attempt: event.receipt!.attempt,
					namespace: "n",
					session: "s",
					record: "canonical",
					channel: "input",
				},
			});
		},
	};
	const executor = {
		ledger: { requests: async () => [], attempts: async () => [], putAttempt: async () => {} },
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries")
				return {
					items: [
						{ completionRef: "bad", requestId: "qb" },
						{ completionRef: "good", requestId: "q" },
					],
				};
			if (method === "runtime.readDelivery") return state;
			if (method === "runtime.settleDelivery") {
				acked.push(p.ref!);
				return null;
			}
			throw new Error(method);
		},
		readRecord: async () => {
			throw new Error("material unavailable");
		},
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx);
	try {
		await pump.reconcile();
		expect(events).toHaveLength(1);
		expect(JSON.parse((await events[0]!.render!())!)).toMatchObject({
			snapshot: { outcome: "failed", unknownEffectCount: 1 },
			content: { kind: "unavailable" },
		});
		expect(pump.diagnostics().error).toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
		await pump.reconcile();
		expect(acked).toEqual(["good"]);
		await pump.retry("good", "older");
		expect(events).toHaveLength(1);
	} finally {
		await pump.close();
	}
});
