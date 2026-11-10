import { expect, test, vi } from "vitest";
import type { CompletionView, DeliveryState } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { DeliveryPump, formatCompletion } from "../../.uina/worlds/minecraft/executor/delivery.js";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import type { HostDeliveryState } from "../../src/core/types.js";
import type {
	EventSubmission,
	ServiceCompanionContext,
	WorldEvent,
} from "../../src/extensions/world-framework/types.js";
import { pollUntil as until } from "./mc-native-fixture.js";

test.each([false, true])("ACK 失败不阻塞同批其他回执 (已写入 %s)", async (committedBeforeLoss) => {
	const pending = new Set(["first", "next"]),
		emitted: string[] = [];
	let failFirstAck = true;
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
		emitEvents: async (events) => {
			for (const event of events) {
				emitted.push(event.receipt!.key);
				host.set(event.receipt!.key, {
					kind: "committed",
					receipt: { ...event.receipt!, namespace: "n", session: "s", record: "canonical", channel: "input" },
				});
			}
			return events.map(() => ({ accepted: true }) as const);
		},
	};
	const executor = {
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries")
				return { items: [...pending].map((completionRef) => ({ completionRef, requestId: completionRef })) };
			if (method === "runtime.settleDelivery") {
				if (p.ref === "first" && failFirstAck) {
					if (committedBeforeLoss) pending.delete(p.ref);
					throw new Error("ACK reply lost");
				}
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
		// 同一批交出：两份各有自己的 attempt，互不占位。
		await pump.reconcile();
		await Promise.resolve();
		expect(emitted).toEqual(["first", "next"]);
		await pump.reconcile();
		expect(pump.diagnostics().error).toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
		expect(pending.has("next")).toBe(false);
		expect(pending.has("first")).toBe(!committedBeforeLoss);
		failFirstAck = false;
		await pump.reconcile();
		expect(pending.size).toBe(0);
		// 回执重试不等于重投：两条各交过一次。
		expect(emitted).toEqual(["first", "next"]);
		// §10.6 三态：本激活提交数可数；"模型有没有真读到"没有合法入口，如实说未知。
		expect(pump.diagnostics().commit).toMatchObject({
			activated: 2,
			retired: 0,
			consumption: "consumption_unknown",
		});
	} finally {
		await pump.close();
	}
});

test("过时的待决策通知退出在途记录，且不确认交付", async () => {
	const executor = pendingExecutor(["decision"]);
	const rpc = executor.rpc.bind(executor);
	let eligible = true;
	executor.rpc = async <T>(...args: Parameters<MinecraftExecutor["rpc"]>): Promise<T> => {
		if (args[0] === "runtime.pendingDeliveries" && !eligible) return { items: [] } as T;
		if (args[0] === "runtime.readDelivery") return { ...(await rpc<DeliveryState>(...args)), eligible } as T;
		return rpc<T>(...args);
	};
	const events: WorldEvent[] = [];
	const pump = new DeliveryPump(executor, {
		signal: new AbortController().signal,
		delivery: absentBatchPort(),
		emitEvents: async (batch) => {
			events.push(...batch);
			return batch.map(() => ({ accepted: true }) as const);
		},
	});
	try {
		await pump.reconcile();
		expect(pump.diagnostics().activeInputs.map((input) => input.key)).toEqual(["decision"]);
		eligible = false;
		expect(await events[0]!.render!()).toBeNull();
		await pump.reconcile();
		expect(pump.diagnostics().activeInputs).toEqual([]);
		expect(pump.diagnostics().commit.activated).toBe(0);
	} finally {
		await pump.close();
	}
});

test.each(["input", "tool"] as const)("旧激活的 %s 交接不阻塞同轮通知", async (channel) => {
	const pending = new Set(["old", "next"]),
		emitted: string[] = [];
	const receipt = {
		key: "old",
		attempt: "old-attempt",
		namespace: "n",
		session: "s",
		record: "canonical",
		channel,
	};
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async (key) =>
				key === "old"
					? { kind: "pending", channel, activity: "processing", attempt: "old-attempt", since: "now" }
					: { kind: "absent" },
			retire: async (key, attempt) => {
				expect([key, attempt]).toEqual(["old", "old-attempt"]);
				return { kind: "committed", receipt };
			},
		},
		emitEvents: async (events) => {
			for (const event of events) emitted.push(event.receipt!.key);
			return events.map(() => ({ accepted: true }) as const);
		},
	};
	const executor = {
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () =>
				new Map([
					[
						"old",
						{
							key: "old",
							attempt: "old-attempt",
							channel,
							namespace: "n",
							session: "s",
							activation: "old-activation",
							createdAt: "now",
						},
					],
				]),
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
		expect(pump.diagnostics().activeInputs.map((input) => input.key)).toEqual(["next"]);
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
		emitEvents: async (list) => {
			for (const event of list) {
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
			}
			return list.map(() => ({ accepted: true }) as const);
		},
	};
	const executor = {
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
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
		// 正文读不到时仍可查已知 Effect，不重复读取同一份报告。
		expect(JSON.parse((await events[0]!.render!())!)).toMatchObject({
			nextCall: { action: "tasks", params: { op: "trace" } },
		});
		// 展示投影不变改细节通道：事件 data 仍是完整 CompletionView。
		expect((events[0]!.data as { content: { kind: string } }).content.kind).toBe("unavailable");
		expect(pump.diagnostics().error).toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
		await pump.reconcile();
		expect(acked).toEqual(["good"]);
	} finally {
		await pump.close();
	}
});
test("同轮多处完成一次交出：每条各自回执，宿主还在处理的那条不挡别人", async () => {
	const pending = new Set(["blocked", "b", "c"]);
	const batches: string[][] = [];
	const acked: string[] = [];
	const host = new Map<string, HostDeliveryState>();
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async (key) =>
				key === "blocked"
					? { kind: "pending", channel: "input", activity: "processing", attempt: "host-own", since: "now" }
					: (host.get(key) ?? { kind: "absent" }),
			retire: async () => ({ kind: "retired" }),
		},
		emitEvents: async (events) => {
			batches.push(events.map((event) => event.receipt!.key));
			// 只有 b 真的落地；c 假装丢了（宿主不认识它），下一轮必须重投。
			host.set("b", {
				kind: "committed",
				receipt: {
					key: "b",
					attempt: events.find((event) => event.receipt!.key === "b")!.receipt!.attempt,
					namespace: "n",
					session: "s",
					record: "canonical",
					channel: "input",
				},
			});
			return events.map(() => ({ accepted: true }) as const);
		},
	};
	const executor = {
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries")
				return { items: [...pending].map((completionRef) => ({ completionRef, requestId: completionRef })) };
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
						recordBytes: 200,
						reportKind: "terminal",
						snapshot: { phase: "finished", outcome: "succeeded" },
					},
				};
			if (method === "runtime.settleDelivery") {
				acked.push(p.ref!);
				pending.delete(p.ref!);
				return null;
			}
			throw new Error(method);
		},
		readRecord: async () => ({ kind: "inline", record: { kind: "completion", value: {} } }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx);
	try {
		await pump.reconcile();
		await until(() => batches.length === 1);
		// 一次交出：宿主还在处理 blocked，它不进批次，但也挡不住 b/c。
		expect(batches).toEqual([["b", "c"]]);
		expect(pump.diagnostics().activeInputs.map((input) => input.key)).toContain("blocked");
		await pump.reconcile();
		await until(() => batches.length === 2);
		// b 有回执就被 ACK，c 没有就重投：两条各走各的，不共享一个"在途"结论。
		expect(acked).toEqual(["b"]);
		expect(batches).toEqual([["b", "c"], ["c"]]);
		expect(pump.diagnostics().activeInputs.map((input) => input.key)).not.toContain("b");
	} finally {
		await pump.close();
	}
});

test("G6 退场：所有事实事件都走 minecraft_event，不再有 digest 专用通道", async () => {
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
			return { accepted: true };
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx, 10);
	try {
		pump.start();
		const send = (ref: string, payload: unknown) => {
			for (const listener of listeners) listener([{ ref, observedAt: "t", payload } as never]);
		};
		send("ev:n:2", { kind: "safety_changed", intervention: {} });
		await until(() => events.length === 1);
		expect(events[0]!.type).toBe("minecraft_event");
		expect(JSON.parse(events[0]!.text!).nextCall).toEqual({
			action: "observe",
			params: { selector: "events@1" },
		});
		// 世界状态不再作为独立消息上行：只可能是事实事件（历史可查的那几种）。
		send("ev:n:3", { kind: "digest", self: { dimension: "overworld" } });
		await until(() => events.length === 2);
		expect(events[1]!.type).toBe("minecraft_event");
		expect(JSON.parse(events[1]!.text!).nextCall).toEqual({
			action: "observe",
			params: { selector: "events@1" },
		});
	} finally {
		await pump.close();
	}
});

test("需要立即重新决策的事件走 urgent；其余事实排队等下一次决策", async () => {
	const events: WorldEvent[] = [];
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
			events.push(event);
			return { accepted: true };
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	const pump = new DeliveryPump(executor, ctx, 60_000);
	const deliver = async (payload: Record<string, unknown>): Promise<WorldEvent> => {
		const before = events.length;
		for (const listener of listeners) listener([{ ref: `ev:${before}`, observedAt: "t", payload } as never]);
		await until(() => events.length > before);
		return events.at(-1)!;
	};
	try {
		pump.start();
		// 当前执行前提失效或有人在等回应：插队重新决策。
		expect((await deliver({ kind: "death" })).delivery).toBe("urgent");
		expect((await deliver({ kind: "connection", state: "disconnected" })).delivery).toBe("urgent");
		expect((await deliver({ kind: "chat", channel: "private", self: false })).delivery).toBe("urgent");
		const directed = await deliver({
			kind: "chat",
			channel: "public",
			addressed: true,
			self: false,
			text: "@Uina come see this",
			sender: { name: "Friend" },
			rich: { large: "fixture" },
		});
		expect(directed.delivery).toBe("urgent");
		expect(JSON.parse(directed.text!)).toEqual({
			kind: "chat",
			channel: "public",
			sender: "Friend",
			text: "@Uina come see this",
			ref: "ev:3",
		});
		expect((await deliver({ kind: "safety_changed", ended: "blocked" })).delivery).toBe("urgent");
		expect((await deliver({ kind: "safety_changed", ended: "timeout" })).delivery).toBe("urgent");
		// 其余事实不打断当前思考。
		expect((await deliver({ kind: "connection", state: "ready" })).delivery).toBeUndefined();
		expect((await deliver({ kind: "chat", channel: "private", self: true })).delivery).toBeUndefined();
		expect((await deliver({ kind: "safety_changed", ended: "safe" })).delivery).toBeUndefined();
	} finally {
		await pump.close();
	}
});

/** 手工控制提交结果的时机：先让 reconcile 跑完，再把"没交出去"落在诊断上。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** 让一条事实事件进投递泵：只关心"交了几次、留下什么诊断"。 */
function eventPump(emit: (event: WorldEvent) => Promise<EventSubmission>) {
	const listeners = new Set<
		(events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void
	>();
	let calls = 0;
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
			calls++;
			return emit(event);
		},
	};
	const executor = {
		subscribe: (
			listener: (events: import("../../.uina/worlds/minecraft/contracts/executor.js").GameNotice[]) => void,
		) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
		rpc: async () => ({ items: [] }),
	} as unknown as MinecraftExecutor;
	return {
		pump: new DeliveryPump(executor, ctx, 60_000),
		calls: () => calls,
		/** 推一条死亡事实（urgent，不必等回合即可交付）。 */
		fire: () => {
			for (const listener of listeners)
				listener([{ ref: "ev:t:1", observedAt: "t", payload: { kind: "death" } } as never]);
		},
	};
}

test("minecraft_event 投递失败补发一次；补发成功不留诊断错误", async () => {
	const seen: string[] = [];
	let failed = false;
	// 60s 轮询：测试期内不跑 reconcile，诊断错误不会被成功轮次清空。
	const { pump, fire, calls } = eventPump(async (event) => {
		seen.push(event.text!);
		if (failed) return { accepted: true };
		failed = true;
		return { accepted: false, reason: "transient submit rejection", retryable: true };
	});
	try {
		pump.start();
		fire();
		await until(() => calls() === 2);
		expect(seen[0]).toBe(seen[1]); // 幂等 id：同一条事件补发
		expect(pump.diagnostics().error).toBeNull();
	} finally {
		await pump.close();
	}
});

test("补发仍失败只存诊断，不无限重试", async () => {
	const { pump, fire, calls } = eventPump(async () => ({
		accepted: false,
		reason: "queue keeps rejecting",
		retryable: true,
	}));
	try {
		pump.start();
		fire();
		await until(() => calls() === 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(calls()).toBe(2);
		expect(pump.diagnostics().error).toMatchObject({
			code: "EVENT_DELIVERY_FAILED",
			message: "queue keeps rejecting",
		});
	} finally {
		await pump.close();
	}
});

test("世界说这条不必再交：retryable=false 不补发", async () => {
	const gate = deferred<EventSubmission>();
	const { pump, fire, calls } = eventPump(() => gate.promise);
	try {
		pump.start();
		fire();
		await until(() => calls() === 1);
		// 先让 start() 那次 0ms reconcile 跑完，它成功时会清空诊断，别让它抢在断言前面。
		await new Promise((resolve) => setTimeout(resolve, 20));
		gate.resolve({ accepted: false, reason: "世界已停用", retryable: false });
		await until(() => pump.diagnostics().error !== null);
		expect(pump.diagnostics().error).toMatchObject({ code: "EVENT_DELIVERY_FAILED", message: "世界已停用" });
		// 超过一个补发窗口：retryable=false 的条目不该再交一次。
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(calls()).toBe(1);
	} finally {
		await pump.close();
	}
});

test("事件形状非法是世界的 bug：报错不补发", async () => {
	const gate = deferred<EventSubmission>();
	const { pump, fire, calls } = eventPump(() => gate.promise);
	try {
		pump.start();
		fire();
		await until(() => calls() === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		gate.reject(new Error("World 事件必须提供 text 或 render"));
		await until(() => pump.diagnostics().error !== null);
		expect(pump.diagnostics().error).toMatchObject({
			code: "EVENT_DELIVERY_FAILED",
			message: "World 事件必须提供 text 或 render",
		});
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(calls()).toBe(1);
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
		task: expect.stringMatching(/^task:local:/),
	});
	// 同一事实只写一次：三层包装与内部簿记都不出现在模型文本里。
	for (const key of ["content", "snapshot", "requestId", "segment", "completionRef", "recordBytes", "reportKind"])
		expect(parsed).not.toHaveProperty(key);
	for (const key of ["nextCall", "progressComplete", "unknownEffectCount", "unknownEffectsComplete"])
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
	expect(lost.nextCall).toMatchObject({
		action: "tasks",
		params: { op: "trace", task: "task:local:req-proj", record: "eff:1" },
	});
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
		phase: "needs_input",
		decision: "rec:decision:1",
		reason: "need a plan",
	});
	// 先查当前决策，再选择续段入口。
	expect(projected.nextCall).toMatchObject({ action: "tasks", params: { op: "get" } });
	expect(projected).not.toHaveProperty("outcome");
});

/** 一批待交付 completion 的最小 executor：pending 页 + 一份已超正文阈值的 delivery 状态。 */
function pendingExecutor(keys: readonly string[]): MinecraftExecutor {
	const pending = [...keys];
	return {
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
		},
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries")
				return { items: pending.map((completionRef) => ({ completionRef, requestId: completionRef })) };
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
}

/** 只给单条入口的宿主：dev/session-live 的 stubContext 就是这个形状。 */
function absentBatchPort(): ServiceCompanionContext["delivery"] {
	return {
		namespace: "n",
		session: "s",
		durability: "durable",
		inspect: async () => ({ kind: "absent" }),
		retire: async () => ({ kind: "retired" }),
	};
}

test("a completion wake received during a scan gets another pass before the fallback timer", async () => {
	vi.useFakeTimers();
	const executor = pendingExecutor(["completion"]);
	const rpc = executor.rpc.bind(executor);
	const inScan = deferred<void>();
	const resume = deferred<void>();
	let scans = 0;
	executor.rpc = async <T>(...args: Parameters<MinecraftExecutor["rpc"]>): Promise<T> => {
		if (args[0] === "runtime.pendingDeliveries" && ++scans === 1) {
			inScan.resolve();
			await resume.promise;
			return { items: [] } as T;
		}
		return rpc<T>(...args);
	};
	let changed!: Parameters<MinecraftExecutor["subscribe"]>[0];
	executor.subscribe = (listener) => {
		changed = listener;
		return () => {};
	};
	const emitted: string[] = [];
	const pump = new DeliveryPump(executor, {
		signal: new AbortController().signal,
		delivery: absentBatchPort(),
		emitEvents: async (events) => {
			emitted.push(...events.map((event) => event.receipt!.key));
			// Leave any retry to the fallback timer, as for a real Host refusal.
			return events.map(() => ({ accepted: false, reason: "test", retryable: true }) as const);
		},
	});
	try {
		pump.start();
		const initial = pump.reconcile();
		await inScan.promise;
		changed([]);
		changed([]);
		resume.resolve();
		await initial;
		await vi.advanceTimersByTimeAsync(100);
		expect(emitted).toEqual(["completion"]);
		expect(scans).toBe(2);
	} finally {
		resume.resolve();
		await pump.close();
		vi.useRealTimers();
	}
});

test("a completion skipped during admission is promptly delivered once after the receipt", async () => {
	vi.useFakeTimers();
	const admission = deferred<void>();
	const submitting = deferred<string>();
	let requestId: string | undefined;
	let host: HostDeliveryState = { kind: "absent" };
	let settled = false;
	const events: string[] = [];
	const executor = pendingExecutor(["completion"]);
	const rpc = executor.rpc.bind(executor);
	Object.assign(executor, {
		status: () => ({ actionsAllowed: true, side: { launch: "launch" } }),
		submit: async (request: { requestId: string }) => {
			requestId = request.requestId;
			submitting.resolve(requestId);
			await admission.promise;
			return { kind: "accepted", segment: "segment", snapshot: { run: "run" } };
		},
		ledger: { ...executor.ledger, putRequest: async () => {}, found: async () => {} },
	});
	executor.rpc = async <T>(...args: Parameters<MinecraftExecutor["rpc"]>): Promise<T> => {
		if (args[0] === "runtime.pendingDeliveries")
			return { items: requestId && !settled ? [{ completionRef: "completion", requestId }] : [] } as T;
		if (args[0] === "runtime.settleDelivery") {
			settled = true;
			return undefined as T;
		}
		return rpc<T>(...args);
	};
	const port = absentBatchPort()!;
	const signal = new AbortController().signal;
	const facade = new MinecraftFacade(executor, {
		signal,
		delivery: { ...port, inspect: async () => host },
		emitEvents: async (batch) => {
			for (const event of batch) {
				events.push(event.receipt!.key);
				host = {
					kind: "committed",
					receipt: {
						...event.receipt!,
						namespace: port.namespace,
						session: port.session,
						record: "input",
						channel: "input",
					},
				};
			}
			return batch.map(() => ({ accepted: true }) as const);
		},
	});
	try {
		const run = facade.execute("run", { selector: "chat@1", input: { text: "hello" } }, signal);
		await submitting.promise;
		await facade.reconcile();
		expect(events).toEqual([]);
		admission.resolve();
		expect((await run).details).toMatchObject({ kind: "accepted" });
		expect(events).toEqual([]);
		await vi.advanceTimersByTimeAsync(100);
		expect(events).toEqual(["completion"]);
		expect(settled).toBe(true);
	} finally {
		admission.resolve();
		await facade.close();
		vi.useRealTimers();
	}
});

test("宿主没有批量入口时显式报错，不静默把完成通知当成已交出", async () => {
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: absentBatchPort(),
		emitEvent: async () => ({ accepted: true }),
	};
	const pump = new DeliveryPump(pendingExecutor(["only"]), ctx, 60_000);
	try {
		await pump.reconcile();
		expect(pump.diagnostics().error).toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
		expect(pump.diagnostics().error?.message).toContain("批量投递入口");
	} finally {
		await pump.close();
	}
});

test("批量回执少一条时清掉那条在途记录，不留下永远退不了的输入", async () => {
	let calls = 0;
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: absentBatchPort(),
		emitEvents: async (events) => {
			calls++;
			// 宿主少回一条：既没说接手，也没说拒收。
			return events.slice(0, 1).map(() => ({ accepted: true }) as const);
		},
	};
	const pump = new DeliveryPump(pendingExecutor(["a", "b"]), ctx, 60_000);
	try {
		await pump.reconcile();
		// 只推微任务：交付结果处理完就断言，不让 wake(0) 的下一轮对账改写诊断。
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(calls).toBe(1);
		expect(pump.diagnostics().activeInputs.map((input) => input.key)).toEqual(["a"]);
		expect(pump.diagnostics().error).toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
	} finally {
		await pump.close();
	}
});

test("大量 pending：每轮有界扫描，新完成不被历史积压饿死", async () => {
	const total = 300;
	const pending = new Map<number, string>();
	const requestedAttempts: string[][] = [];
	for (let index = 0; index < total; index++) pending.set(index + 1, `c${index}`);
	const delivered: string[] = [];
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
		emitEvents: async (events) => {
			for (const event of events) {
				const key = event.receipt!.key;
				delivered.push(key);
				host.set(key, {
					kind: "committed",
					receipt: { ...event.receipt!, namespace: "n", session: "s", record: "canonical", channel: "input" },
				});
			}
			return events.map(() => ({ accepted: true }) as const);
		},
	};
	// 键集分页替身：cursor 是最后一条的 rowid，与真实实现同口径。
	const executor = {
		ledger: {
			taskEntries: async () => new Map(),
			requests: async () => [],
			attempts: async (keys: string[]) => {
				requestedAttempts.push(keys);
				return new Map();
			},
			putAttempt: async () => {},
		},
		rpc: async (method: string, p: { ref?: string; cursor?: string; limit?: number }) => {
			if (method === "runtime.pendingDeliveries") {
				const after = p.cursor == null ? 0 : Number(p.cursor);
				const limit = p.limit ?? 10;
				const rows = [...pending.entries()].filter(([rowid]) => rowid > after).sort((a, b) => a[0] - b[0]);
				const page = rows.slice(0, limit);
				return {
					items: page.map(([, ref]) => ({ completionRef: ref, requestId: ref })),
					// 与真实实现同口径：total 是积压总数，不是本页条数。
					total: pending.size,
					...(rows.length > limit ? { next: String(page[page.length - 1]![0]) } : {}),
				};
			}
			if (method === "runtime.settleDelivery") {
				for (const [rowid, ref] of pending) if (ref === p.ref) pending.delete(rowid);
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
						recordBytes: 200,
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
		await new Promise((resolve) => setTimeout(resolve, 0));
		// 一轮只看 96 条：不是"扫完全部历史待办才处理新内容"。
		expect(pump.diagnostics().scan.inspected).toBe(96);
		expect(pump.diagnostics().scan.resumable).toBe(true);
		expect(requestedAttempts[0]).toEqual([...pending.values()].slice(0, 96));
		// 但积压总数要报真值：96 是"这轮看了多少"，不是"还剩多少"。
		expect(pump.diagnostics().pendingCount).toBe(total);
		// 每轮最多交 8 条。
		expect(delivered.length).toBe(8);
		// 续扫：后续轮次从上一轮停下的键集位置继续，不重复检查同一条。
		const rounds = 40;
		for (let round = 0; round < rounds; round++) {
			await pump.reconcile();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		// 300 条全部交付且没有重复：有界扫描不会漏项。
		expect(delivered.length).toBe(total);
		expect(new Set(delivered).size).toBe(total);
		expect(pending.size).toBe(0);
	} finally {
		await pump.close();
	}
});
