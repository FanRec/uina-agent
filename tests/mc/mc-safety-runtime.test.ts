import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { BodySession, PlayerPort, SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { MinecraftRuntime } from "../../.uina/worlds/minecraft/runtime/index.js";

test("safety retires an uncooperative guest body; outer program handles interruption; record survives reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-safety-runtime-"));
	const program = await createProgram({
		dataRoot: root,
		loadProgram: async () => {
			throw new Error("unused");
		},
	});
	let acquired = 0,
		closed = 0;
	const owners: unknown[] = [];
	const port: PlayerPort = {
		acquire: async (owner) => {
			acquired++;
			owners.push(owner);
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
		namespace: "safety",
		worldOwner: "owner",
		world: {} as WorldPort,
		playerPort: port,
		callables: [],
		program,
	};
	let { runtime } = await MinecraftRuntime.open(opts);
	const origin = { worldOwner: "owner", activation: "a" };
	const owner = await runtime.attach(origin);
	await runtime.setOwnerGate({
		requestId: "enable",
		attachment: owner.attachment,
		gate: "disabled",
		closed: false,
		expectedRevision: owner.gateRevision,
	});
	try {
		const accepted = await runtime.submit(origin, {
			requestId: "run",
			schedule: { kind: "enqueue" },
			entry: {
				kind: "program",
				source: {
					code: "async function main(mc){try{await mc.withBody(async b=>{await mc.sleep(10000);});}catch(e){return e.code;}return 'unexpected';}",
				},
				input: {},
			},
		});
		if (accepted.kind !== "accepted") throw new Error("not accepted");
		await expect.poll(() => acquired).toBe(1);
		const record = await runtime.intervene(
			{ kind: "lava", sample: { value: { inLava: true } as SelfState } as Fact<SelfState>, evidence: [] },
			async () => "safe",
		);
		expect(record.ended).toBe("safe");
		expect(closed).toBe(2);
		expect(owners[1]).toMatchObject({ kind: "safety", intervention: record.intervention });
		const result = await runtime.wait(accepted.snapshot.run, { timeoutMs: 5000 });
		expect(result.snapshot).toMatchObject({ phase: "finished", outcome: "succeeded" });
		const calls = await runtime.listCalls(accepted.snapshot.run);
		expect(await runtime.readRecord(calls.items.find((c) => c.parent === null)!.record)).toMatchObject({
			kind: "inline",
			record: { value: { value: "INTERRUPTED" } },
		});
		await runtime.close();
		({ runtime } = await MinecraftRuntime.open({ ...opts, namespace: "reopen" }));
		expect(await runtime.readRecord(record.intervention)).toMatchObject({
			kind: "inline",
			record: { kind: "safety", value: { ended: "safe" } },
		});
		expect(runtime.inspectSafety().last).toBe(record.intervention);
		expect(acquired).toBe(2);
		await runtime.close();
		const db = new DatabaseSync(opts.dbPath);
		const interrupted = {
			...record,
			intervention: "safety:crashed",
			record: "rec:crashed",
			effects: [],
			unknownEffects: [],
			finishedAt: null,
			ended: null,
			outcome: null,
		};
		const fact = {
			effect: "eff:crashed",
			owner: { kind: "safety", intervention: interrupted.intervention },
			operation: "op:crashed",
			contract: "body.feedback@1",
			observedAt: new Date().toISOString(),
			kind: "dispatch",
			dispatch: "sent",
			completion: "unknown",
			evidence: [],
		};
		const payload = JSON.stringify({ kind: "safety", record: interrupted.record, value: interrupted });
		db.prepare("INSERT INTO records(record,kind,object_ref,payload,bytes) VALUES(?,?,?,?,?)").run(
			interrupted.record,
			"safety",
			interrupted.intervention,
			payload,
			Buffer.byteLength(payload),
		);
		db.prepare("INSERT INTO effects(effect,owner,operation,record,facts,verifications) VALUES(?,?,?,?,?,?)").run(
			fact.effect,
			JSON.stringify(fact.owner),
			fact.operation,
			"rec:effect-crashed",
			JSON.stringify([fact]),
			"[]",
		);
		db.prepare("UPDATE meta SET value='[]' WHERE key='owner_gates'").run();
		db.close();
		({ runtime } = await MinecraftRuntime.open({
			...opts,
			namespace: "recover",
			unclean: true,
			oldControlRetired: true,
		}));
		expect(await runtime.readRecord(interrupted.intervention)).toMatchObject({
			kind: "inline",
			record: {
				value: { ended: "invalidated", outcome: "unknown", effects: [fact.effect], unknownEffects: [fact.effect] },
			},
		});
		expect(await runtime.readRecord(interrupted.record)).toMatchObject({
			kind: "inline",
			record: { value: { finishedAt: null } },
		});
		expect(acquired).toBe(2);
	} finally {
		await runtime.close();
		await program.close();
	}
}, 15000);

test("失效的起因由调用点声明：连接变了算别人说过，自己失败必须上报", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-safety-cause-"));
	const program = await createProgram({
		dataRoot: root,
		loadProgram: async () => {
			throw new Error("unused");
		},
	});
	const port: PlayerPort = {
		acquire: async () =>
			({
				runScoped: async (_scope: unknown, work: () => Promise<unknown>) => work(),
				close: async () => {},
			}) as unknown as BodySession,
		chat: async () => {
			throw new Error("unused");
		},
	};
	const changes: [string | null, string | null][] = [];
	const { runtime } = await MinecraftRuntime.open({
		dbPath: join(root, "runtime.db"),
		storageId: "s",
		namespace: "cause",
		worldOwner: "owner",
		world: {} as WorldPort,
		playerPort: port,
		callables: [],
		program,
		onSafetyChanged: (record, cause) => changes.push([record.ended, cause]),
	});
	const trigger = {
		kind: "lava" as const,
		sample: { value: { inLava: true } as SelfState } as Fact<SelfState>,
		evidence: [] as string[],
	};
	try {
		const owner = await runtime.attach({ worldOwner: "owner", activation: "a" });
		await runtime.setOwnerGate({
			requestId: "enable",
			attachment: owner.attachment,
			gate: "disabled",
			closed: false,
			expectedRevision: owner.gateRevision,
		});
		const hijacked = runtime.intervene(
			trigger,
			(_body, signal) =>
				new Promise<"invalidated">((resolve) => signal.addEventListener("abort", () => resolve("invalidated"))),
		);
		await expect.poll(() => runtime.inspectSafety().active).not.toBeNull();
		await runtime.invalidateControl();
		expect((await hijacked).ended).toBe("invalidated");
		expect(changes.at(-1)).toEqual(["invalidated", "connection"]);
		// 没有任何"连接变了"的事实替它说，这条失效必须自己上报；起因是空的。
		expect((await runtime.intervene(trigger, async () => "invalidated")).ended).toBe("invalidated");
		expect(changes.at(-1)).toEqual(["invalidated", null]);
	} finally {
		await runtime.close();
		await program.close();
	}
}, 15000);
