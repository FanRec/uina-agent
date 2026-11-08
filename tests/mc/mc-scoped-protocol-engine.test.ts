/**
 * S4 引擎接线回归（真 RuntimeEngine + 真 RecordQueue + 真 BodyLeaseQueue）。
 *
 * 单元层测的是 scoped port 本身；这里防止引擎把端口又换回共享对象：
 * 普通调用拿不到写端口，两次 withBody 各拿一份，Body 退出后旧引用必须 not_sent。
 */

import { describe, expect, test } from "vitest";
import type { BodySession, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type {
	NativeCallable,
	ProtocolWritePort,
	ProtocolWriteDispatcher,
} from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { CallFailure, ExactRef, JsonValue, Ref } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { RuntimeEngine } from "../../.uina/worlds/minecraft/runtime/engine.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { RuntimeRefs } from "../../.uina/worlds/minecraft/runtime/refs.js";

function makeCallable(
	ref: ExactRef,
	invoke: NativeCallable<JsonValue, JsonValue>["invoke"],
): NativeCallable<JsonValue, JsonValue> {
	return {
		descriptor: {
			ref,
			summary: "scoped protocol write engine regression",
			input: {},
			output: {},
			access: "act",
			completion: { scope: "execution", description: "returns when the test work is done" },
			errors: [],
			requires: [],
			examples: [],
			implementation: "native",
		},
		invoke,
	};
}

async function submitAndWait(
	engine: RuntimeEngine,
	rootRef: ExactRef,
): Promise<{ run: Ref; outcome: string; error: { code: string } | null }> {
	const attached = await engine.owner.attach({ worldOwner: "world:e:1", activation: "act:e:1" });
	await engine.owner.setGate({
		requestId: "enable",
		attachment: attached.attachment,
		gate: "disabled",
		closed: false,
		expectedRevision: attached.gateRevision,
	});
	const acceptance = await engine.submit(
		{ worldOwner: "world:e:1", activation: "act:e:1" },
		{
			requestId: `req:${rootRef}`,
			entry: { kind: "call", selector: rootRef, input: {} },
			schedule: { kind: "enqueue" },
		},
	);
	if (acceptance.kind !== "accepted") throw new Error(`submission rejected: ${JSON.stringify(acceptance)}`);
	const run = acceptance.snapshot.run;
	await engine.wait(run, { timeoutMs: 2000 }, undefined);
	const summary = engine.read(run);
	return {
		run,
		outcome: summary.phase === "finished" ? (summary.outcome ?? "") : summary.phase,
		error: summary.phase === "finished" ? (summary.error ?? null) : null,
	};
}

describe("RuntimeEngine：每次 BodyScope 一份 scoped ProtocolWritePort", () => {
	test("普通调用无写端口；两次 withBody 端口不同；退出后旧引用 not_sent", async () => {
		const sends: string[] = [];
		const ports: (ProtocolWritePort | undefined)[] = [];
		let plainPort: ProtocolWritePort | undefined;
		let expired: CallFailure | null = null;
		let samePort = false;
		const dispatcher: ProtocolWriteDispatcher = {
			identity: () => ({ connection: "conn:e:1", incarnation: "inc:e:1" }),
			send: (_binding, _channel, data) => {
				const n = sends.length + 1;
				sends.push(String(data));
				return { effect: `eff:e:${n}`, operation: `op:e:${n}` };
			},
			confirm: () => {},
		};
		const root = makeCallable("e.root@1", async (ctx) => {
			plainPort = ctx.protocol;
			await ctx.withBody(async (scope) => {
				ports.push(scope.protocol);
				scope.protocol?.send("uina:example", "first");
			});
			const saved = ports[0];
			if (saved != null) {
				try {
					saved.send("uina:example", "late");
				} catch (error) {
					expired = error as CallFailure;
				}
			}
			await ctx.withBody(async (scope) => {
				ports.push(scope.protocol);
				samePort = scope.protocol === saved;
				scope.protocol?.send("uina:example", "second");
			});
			return "ok";
		});

		const refs = new RuntimeRefs("e");
		const instance = refs.writerInstance();
		const queue = new RecordQueue({
			instance,
			mintRecord: () => refs.record(),
			recoveredWatermarks: {},
			apply: (items) => {
				const last = items[items.length - 1];
				if (last != null) queue.onDurable(instance, last.ticket.sequence);
			},
		});
		const playerPort = {
			acquire: async () =>
				({
					body: "body:e:1",
					runScoped: async (_scope: unknown, work: () => Promise<unknown>) => work(),
					close: async () => {},
				}) as unknown as BodySession,
			chat: async () => {
				throw new Error("chat is outside this fixture");
			},
		} as PlayerPort;
		const engine = new RuntimeEngine({
			refs,
			queue,
			world: {} as WorldPort,
			playerPort,
			callables: [root],
			worldOwner: "world:e:1",
			protocol: dispatcher,
		});

		const done = await submitAndWait(engine, "e.root@1");
		expect(done.outcome, JSON.stringify(done.error)).toBe("succeeded");
		expect(plainPort).toBeUndefined();
		expect(ports).toHaveLength(2);
		expect(ports[0]).toBeDefined();
		expect(ports[1]).toBeDefined();
		expect(samePort).toBe(false);
		expect(sends).toEqual(["first", "second"]);
		expect(expired).toMatchObject({ code: "CONTROL_INVALID", dispatch: "not_sent" });
	});
});
