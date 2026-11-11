/** 受理终局的持久闭环：confirming 只见过不确定受理，确定拒绝必须主动交到模型面前。 */
import { expect, test } from "vitest";
import { DeliveryPump } from "../../.uina/worlds/minecraft/executor/delivery.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import type { RequestCredential } from "../../.uina/worlds/minecraft/executor/ledger-worker.js";
import type { HostDeliveryState } from "../../src/core/types.js";
import type { ServiceCompanionContext, WorldEvent } from "../../src/extensions/world-framework/types.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("确定拒绝按原 requestId 送达一次；Host canonical 回执结清义务，不碰 Runtime settle", async () => {
	const requestId = "req:notice:1";
	const key = `acceptance:${requestId}`;
	const credential = {
		operation: "submit",
		request: {
			requestId,
			entry: { kind: "call", selector: "chat@1", input: { text: "hello" } },
			schedule: { kind: "enqueue" },
		},
		requestId,
		activation: "launch:1",
		createdAt: "2026-11-11T00:00:00Z",
		refusal: { kind: "rejected", code: "OWNER_GATE_CLOSED", message: "gate closed" },
		notice: "pending",
	} as unknown as RequestCredential;

	const notices = new Map<string, string>();
	const host = new Map<string, HostDeliveryState>();
	const emitted: WorldEvent[] = [];
	const settled: string[] = [];
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		delivery: {
			namespace: "n",
			session: "s",
			durability: "durable",
			inspect: async (name) => host.get(name) ?? { kind: "absent" },
			retire: async () => ({ kind: "retired" }),
		},
		emitEvents: async (events) => {
			for (const event of events) {
				emitted.push(event);
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
			requests: async (selection: { kind: string }) =>
				selection.kind === "notice_pending" && notices.get(requestId) !== "delivered" ? [credential] : [],
			attempts: async () => new Map(),
			putAttempt: async () => {},
			markNotice: async (id: string, state: string) => {
				notices.set(id, state);
			},
		},
		rpc: async (method: string, p: { ref?: string }) => {
			if (method === "runtime.pendingDeliveries") return { items: [], total: 0 };
			if (method === "runtime.settleDelivery") {
				settled.push(p.ref!);
				return null;
			}
			throw new Error(`unexpected rpc ${method}`);
		},
	} as unknown as MinecraftExecutor;

	const pump = new DeliveryPump(executor, ctx);
	try {
		// 义务从持久凭证重建，不依赖进程内 Map；重启后同一条也会被扫到。
		await pump.reconcile();
		await flush();
		expect(emitted).toHaveLength(1);
		expect(emitted[0]!.type).toBe("minecraft_acceptance");
		expect(emitted[0]!.receipt!.key).toBe(key);
		expect(JSON.parse(emitted[0]!.text!)).toMatchObject({
			kind: "acceptance_result",
			task: `task:local:${requestId}`,
			outcome: "not_started",
			reason: { code: "OWNER_GATE_CLOSED" },
			scope: "no background run was created",
		});

		// Host 已提交：结清凭证，重复对账与重放都不产生第二条通知或动作。
		await pump.reconcile();
		await flush();
		expect(emitted).toHaveLength(1);
		expect(notices.get(requestId)).toBe("delivered");
		expect(settled).toEqual([]);

		// 义务结清后不再出现在待交接页，诊断随之归零。
		await pump.reconcile();
		expect(pump.diagnostics().acceptance.pendingNotices).toBe(0);
	} finally {
		await pump.close();
	}
});
