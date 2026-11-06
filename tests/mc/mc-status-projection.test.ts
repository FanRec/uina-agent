/**
 * `runs {op:"status"}` 的模型出口：内部 status 带最多 64KB 执行侧日志尾，
 * 只有故障时才需要。这里锁住"ready 无 tail、故障只有 2000 字符尾"。
 */
import { expect, test } from "vitest";
import { MinecraftFacade } from "../../.uina/worlds/minecraft/executor/facade.js";
import type { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";
import type { ServiceCompanionContext } from "../../src/extensions/world-framework/types.js";

const ctx: ServiceCompanionContext = {
	signal: new AbortController().signal,
	delivery: {
		namespace: "world:minecraft",
		session: "session",
		durability: "durable",
		inspect: async () => ({ kind: "absent" }),
		retire: async () => ({ kind: "retired" }),
	},
};

function platformStatus(overrides: Record<string, unknown> = {}) {
	return {
		phase: "ready",
		actionsAllowed: true,
		accountKey: "acct",
		side: { connection: "ready", owner: { gates: [] } },
		lastKnown: null,
		fault: null,
		policy: { heartbeatIntervalMs: 1000 },
		diagnostics: { tail: "log line\n".repeat(8000), discardedBytes: 0 },
		...overrides,
	};
}

function facadeOf(status: unknown): MinecraftFacade {
	const executor = {
		status: () => status,
		inspect: async () => status,
	} as unknown as MinecraftExecutor;
	return new MinecraftFacade(executor, ctx);
}

async function statusOf(facade: MinecraftFacade): Promise<Record<string, unknown>> {
	const result = await facade.execute("runs", { op: "status" }, new AbortController().signal);
	return JSON.parse(result.result) as Record<string, unknown>;
}

test("runs status omits the executor log tail when ready", async () => {
	const facade = facadeOf(platformStatus());
	// 64KB 日志尾不该进模型上下文；其余连接事实保留。
	const parsed = await statusOf(facade);
	expect(parsed).toMatchObject({ phase: "ready", actionsAllowed: true, side: { connection: "ready" } });
	expect(parsed.diagnostics).not.toHaveProperty("tail");
	expect(Object.keys(parsed.delivery as object).sort()).toEqual(["error", "pendingCount"]);
});

test("runs status keeps a bounded log tail when the executor is faulted", async () => {
	const facade = facadeOf(
		platformStatus({ phase: "faulted", actionsAllowed: false, fault: { code: "DISCONNECTED", message: "gone" } }),
	);
	const parsed = await statusOf(facade);
	expect(parsed).toMatchObject({ phase: "faulted", fault: { code: "DISCONNECTED" } });
	expect((parsed.diagnostics as { tail: string }).tail).toHaveLength(2000);
});
