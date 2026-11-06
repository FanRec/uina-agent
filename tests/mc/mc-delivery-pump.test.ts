import { expect, test } from "vitest";
import type { CompletionView, DeliveryState } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { DeliveryPump, formatCompletion } from "../../.uina/worlds/minecraft/executor/delivery.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import type { HostDeliveryState } from "../../src/core/types.js";
import type { ServiceCompanionContext, WorldEvent } from "../../src/extensions/world-framework/types.js";

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
			phase: "finished",
			outcome: "failed",
			detail: "unavailable",
			unknownEffectCount: 1,
		});
		// 正文读不到时不再指一条注定失败的 record 读取。
		expect(JSON.parse((await events[0]!.render!())!)).not.toHaveProperty("nextCall");
		// 展示投影不变改细节通道：事件 data 仍是完整 CompletionView。
		expect((events[0]!.data as { content: { kind: string } }).content.kind).toBe("unavailable");
		expect(pump.diagnostics().error).toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
		await pump.reconcile();
		expect(acked).toEqual(["good"]);
		await pump.retry("good", "older");
		expect(events).toHaveLength(1);
	} finally {
		await pump.close();
	}
});
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("G6 digest events ride minecraft_digest without an events@1 pointer; other notices keep theirs", async () => {
	const events: WorldEvent[] = [];
	const listeners = new Set<
		(events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void
	>();
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		isBusy: () => false,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async () => ({ kind: "absent" }),
			retire: async () => ({ kind: "retired" }),
		},
		emitEvent: async (event) => {
			events.push(event);
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: { requests: async () => [], attempts: async () => [], putAttempt: async () => {} },
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx, 10);
	try {
		pump.start();
		const send = (ref: string, payload: unknown) => {
			for (const listener of listeners) listener([{ ref, observedAt: "t", payload } as never]);
		};
		send("digest:n:1", { kind: "digest", self: { dimension: "overworld" }, inventory: { counts: {} }, world: {} });
		await until(() => events.length === 1);
		expect(events[0]!.type).toBe("minecraft_digest");
		const text = JSON.parse(events[0]!.text!);
		expect(text.kind).toBe("digest");
		expect(text.observedAt).toBe("t");
		expect(text.nextCall).toBeUndefined();
		send("ev:n:2", { kind: "safety_changed", intervention: {} });
		await until(() => events.length === 2);
		expect(events[1]!.type).toBe("minecraft_event");
		expect(JSON.parse(events[1]!.text!).nextCall).toEqual({
			action: "runs",
			params: { op: "record", ref: "ev:n:2" },
		});
	} finally {
		await pump.close();
	}
});

test("G6 while the host is busy only the newest digest is held; it flushes on idle", async () => {
	const events: WorldEvent[] = [];
	const listeners = new Set<
		(events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void
	>();
	let busy = true;
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		isBusy: () => busy,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async () => ({ kind: "absent" }),
			retire: async () => ({ kind: "retired" }),
		},
		emitEvent: async (event) => {
			events.push(event);
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: { requests: async () => [], attempts: async () => [], putAttempt: async () => {} },
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx, 10);
	try {
		pump.start();
		const send = (seq: string) => {
			for (const listener of listeners)
				listener([{ ref: `digest:n:${seq}`, observedAt: "t", payload: { kind: "digest", seq } } as never]);
		};
		send("A");
		send("B");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(events).toHaveLength(0);
		busy = false;
		await pump.reconcile();
		await until(() => events.length === 1);
		expect(JSON.parse(events[0]!.text!).seq).toBe("B");
	} finally {
		await pump.close();
	}
});

test("minecraft_event 投递失败补发一次；补发成功不留诊断错误", async () => {
	const events: string[] = [];
	const listeners = new Set<
		(events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void
	>();
	let failed = false;
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async () => ({ kind: "absent" }),
			retire: async () => ({ kind: "retired" }),
		},
		emitEvent: async (event) => {
			events.push(event.text!);
			if (!failed) {
				failed = true;
				throw new Error("transient submit rejection");
			}
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: { requests: async () => [], attempts: async () => [], putAttempt: async () => {} },
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx, 60_000); // 测试期内不跑 reconcile，诊断错误不被清空
	try {
		pump.start();
		for (const listener of listeners)
			listener([{ ref: "ev:t:1", observedAt: "t", payload: { kind: "death" } } as never]);
		await until(() => events.length === 2);
		expect(events[0]).toBe(events[1]); // 幂等 id：同一条事件补发
		expect(pump.diagnostics().error).toBeNull();
	} finally {
		await pump.close();
	}
});

test("补发仍失败只存诊断，不无限重试", async () => {
	const events: string[] = [];
	const listeners = new Set<
		(events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void
	>();
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async () => ({ kind: "absent" }),
			retire: async () => ({ kind: "retired" }),
		},
		emitEvent: async (event) => {
			events.push(event.text!);
			throw new Error("queue keeps rejecting");
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: { requests: async () => [], attempts: async () => [], putAttempt: async () => {} },
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx, 60_000);
	try {
		pump.start();
		for (const listener of listeners)
			listener([{ ref: "ev:t:1", observedAt: "t", payload: { kind: "death" } } as never]);
		await until(() => events.length === 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(events.length).toBe(2);
		expect(pump.diagnostics().error).toMatchObject({ code: "EVENT_DELIVERY_FAILED" });
	} finally {
		await pump.close();
	}
});

function completionView(overrides: Record<string, unknown> = {}): CompletionView {
	const snapshot = {
		run: "run:proj:1",
		rootRequestId: "req-proj",
		revision: 7,
		segment: "seg:proj:1",
		record: "rec:proj:1",
		completion: { scope: "capability", description: "the server confirmed the target became air" },
		progress: { mined: 4, acquired: 3, collected: { oak_log: 3 }, remaining: 1, toolsUsed: [] },
		control: "none",
		unknownEffects: [],
		phase: "finished",
		outcome: "succeeded",
		completionRef: "comp:proj:1",
		interruptedChildren: [],
	};
	return {
		completionRef: "comp:proj:1",
		requestId: "req-proj",
		run: "run:proj:1",
		segment: "seg:proj:1",
		revision: 7,
		recordBytes: 512,
		reportKind: "terminal",
		snapshot: { ...snapshot, progressComplete: true, unknownEffectCount: 0, unknownEffectsComplete: true },
		content: { kind: "inline", report: { reportKind: "terminal", snapshot } },
		...overrides,
	} as unknown as CompletionView;
}

test("inline completion projects one layer and stays within the model budget", () => {
	const text = formatCompletion(completionView());
	expect(text.length).toBeLessThanOrEqual(800);
	const parsed = JSON.parse(text) as Record<string, unknown>;
	expect(parsed).toMatchObject({
		kind: "result",
		phase: "finished",
		outcome: "succeeded",
		completionRef: "comp:proj:1",
	});
	// 同一事实只写一次：三层包装与内部簿记都不出现在模型文本里。
	for (const key of ["content", "snapshot", "requestId", "segment", "revision", "recordBytes", "reportKind"])
		expect(parsed).not.toHaveProperty(key);
});

test("degraded completion keeps truncation marks and the run's own error", () => {
	const base = completionView();
	const summary = {
		run: "run:proj:1",
		rootRequestId: "req-proj",
		revision: 7,
		segment: "seg:proj:1",
		record: "rec:proj:1",
		completion: { scope: "capability", description: "x" },
		progress: {},
		progressComplete: false,
		control: "none",
		unknownEffectCount: 9,
		unknownEffects: ["eff:1"],
		unknownEffectsComplete: false,
		phase: "finished",
		outcome: "failed",
		error: { code: "TIMEOUT", message: "budget ran out", messageComplete: false },
		completionRef: "comp:proj:1",
	};
	const record = {
		...base,
		snapshot: summary,
		content: { kind: "record", record: "comp:proj:1" },
	} as unknown as CompletionView;
	const projected = JSON.parse(formatCompletion(record)) as Record<string, unknown>;
	expect(projected).toMatchObject({
		detail: "record",
		outcome: "failed",
		progressComplete: false,
		unknownEffectsComplete: false,
		error: { code: "TIMEOUT", message: "budget ran out", messageComplete: false },
	});
	expect(projected.nextCall).toBeDefined();

	const unavailable = {
		...base,
		snapshot: summary,
		content: { kind: "unavailable", record: "comp:proj:1", error: { code: "RECORD_UNAVAILABLE", message: "x" } },
	} as unknown as CompletionView;
	const lost = JSON.parse(formatCompletion(unavailable)) as Record<string, unknown>;
	// 正文读不到由 detail 表达，不覆盖 run 自己的错误，也不再指 record。
	expect(lost).toMatchObject({ detail: "unavailable", error: { code: "TIMEOUT" } });
	expect(lost).not.toHaveProperty("nextCall");
});

test("awaiting_decision hands out the decision, never a record pointer", () => {
	const base = completionView();
	const summary = {
		run: "run:proj:1",
		rootRequestId: "req-proj",
		revision: 7,
		segment: "seg:proj:1",
		record: "rec:proj:1",
		completion: { scope: "execution", description: "x" },
		progress: { phase: 2 },
		progressComplete: true,
		control: "none",
		unknownEffectCount: 0,
		unknownEffects: [],
		unknownEffectsComplete: true,
		phase: "awaiting_decision",
		decision: "rec:decision:1",
		reason: "need a plan",
		reasonComplete: true,
		completionRef: "comp:proj:2",
	};
	const inline = {
		...base,
		completionRef: "comp:proj:2",
		snapshot: summary,
		content: { kind: "inline", report: { reportKind: "decision", snapshot: summary } },
	} as unknown as CompletionView;
	const projected = JSON.parse(formatCompletion(inline)) as Record<string, unknown>;
	expect(projected).toMatchObject({
		phase: "awaiting_decision",
		decision: "rec:decision:1",
		reason: "need a plan",
	});
	// 唯一能推进的是 runs.continue，而 entry 不能预填，因此不给 nextCall。
	expect(projected).not.toHaveProperty("nextCall");
	expect(projected).not.toHaveProperty("outcome");
});
