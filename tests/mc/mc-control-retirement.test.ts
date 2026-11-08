/**
 * C16：Body 资格被撤销时，起因可追踪、已派发事实不被抹掉、Stop 不自动续跑。
 *
 * 故障注入走真实 Runtime（Program → withBody → BodyLeaseQueue → PlayerPort），
 * 不 mock interruptible 内部的 Promise.race。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { BodySession, PlayerPort, SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { MinecraftRuntime } from "../../.uina/worlds/minecraft/runtime/index.js";

const HOLDING_PROGRAM = `async function main(mc) {
  try {
    await mc.withBody(async () => { await mc.sleep(10000); });
    return { unexpected: true };
  } catch (e) {
    return {
      code: e.code || null, message: e.message || null, hint: e.hint || null,
      dispatch: e.dispatch || null, progress: e.progress || null,
      effects: e.effects || null, recoverable: e.recoverable === true
    };
  }
}`;

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "uina-retirement-"));
	const program = await createProgram({
		dataRoot: root,
		loadProgram: async () => {
			throw new Error("unused");
		},
	});
	let acquired = 0;
	let closed = 0;
	const ownerKinds: unknown[] = [];
	const port: PlayerPort = {
		acquire: async (owner) => {
			acquired++;
			ownerKinds.push(owner);
			return {
				runScoped: async (_scope: unknown, work: () => Promise<unknown>) => work(),
				close: async () => {
					closed++;
				},
			} as unknown as BodySession;
		},
		chat: async () => {
			throw new Error("unused");
		},
	};
	const opts = {
		dbPath: join(root, "runtime.db"),
		storageId: "s",
		namespace: "retirement",
		worldOwner: "owner",
		world: {} as WorldPort,
		playerPort: port,
		callables: [],
		program,
	};
	const { runtime } = await MinecraftRuntime.open(opts);
	const origin = { worldOwner: "owner", activation: "a" };
	const owner = await runtime.attach(origin);
	await runtime.setOwnerGate({
		requestId: "enable",
		attachment: owner.attachment,
		gate: "disabled",
		closed: false,
		expectedRevision: owner.gateRevision,
	});
	const submit = async () => {
		const accepted = await runtime.submit(origin, {
			requestId: `run:${Date.now()}:${Math.random()}`,
			schedule: { kind: "enqueue" },
			entry: { kind: "program", source: { code: HOLDING_PROGRAM }, input: {} },
		});
		if (accepted.kind !== "accepted") throw new Error("not accepted");
		await expect.poll(() => acquired).toBeGreaterThanOrEqual(1);
		return accepted.snapshot.run;
	};
	const rootCall = async (run: string) => {
		const calls = await runtime.listCalls(run);
		return calls.items.find((c) => c.parent === null)!;
	};
	return { runtime, origin, submit, rootCall, stats: () => ({ acquired, closed, ownerKinds }) };
}

test("safety 撤销：起因可追踪、不硬编码 not_sent、不自动重放", async () => {
	const { runtime, submit, rootCall } = await fixture();
	try {
		const run = await submit();
		await runtime.intervene(
			{ kind: "lava", sample: { value: { inLava: true } as SelfState } as Fact<SelfState>, evidence: [] },
			async () => "safe",
		);
		const finished = await runtime.wait(run, { timeoutMs: 5000 });
		expect(finished.snapshot).toMatchObject({ phase: "finished" });
		const detail = await runtime.readRecord((await rootCall(run)).record);
		const value = detail.kind === "inline" ? (detail.record.value as { value?: Record<string, unknown> }).value : null;
		expect(value).toBeTruthy();
		expect(value).toMatchObject({ code: "INTERRUPTED", recoverable: true });
		expect(String(value!.message)).toContain("safety");
		expect(String(value!.hint)).toContain("new qualification");
		// 旧实现固定写死 not_sent / effects:[]；现在至少不再声称"证明没派发"。
		expect(value!.dispatch).not.toBe("not_sent");
		expect(Array.isArray(value!.effects)).toBe(true);
		expect(value!.progress).toMatchObject({ cause: "safety" });
	} finally {
		await runtime.close();
	}
});

test("用户 Stop 撤销后不自动续跑，也不会把新 Body 授予旧 Run", async () => {
	const { runtime, submit, rootCall, stats } = await fixture();
	try {
		const run = await submit();
		const before = stats().acquired;
		await runtime.stop({ requestId: "stop:user", target: { run } });
		const finished = await runtime.wait(run, { timeoutMs: 5000 });
		expect(finished.snapshot.phase).toBe("finished");
		expect((finished.snapshot as { outcome?: string }).outcome).toBe("cancelled");
		// 停止后没有为这个 Run 再申请身体；close 屏障仍走了一次。
		expect(stats().acquired).toBe(before);
		expect(stats().closed).toBeGreaterThan(0);
		const detail = await runtime.readRecord((await rootCall(run)).record);
		const raw = JSON.stringify(detail);
		expect(raw).toContain("user_stop");
	} finally {
		await runtime.close();
	}
});

test("连接失效撤销：起因是 disconnect，不是模糊的 body scope retired", async () => {
	const { runtime, submit, rootCall } = await fixture();
	try {
		const run = await submit();
		await runtime.invalidateControl();
		const finished = await runtime.wait(run, { timeoutMs: 5000 });
		expect(finished.snapshot.phase).toBe("finished");
		const detail = await runtime.readRecord((await rootCall(run)).record);
		expect(JSON.stringify(detail)).toContain("disconnect");
	} finally {
		await runtime.close();
	}
});
