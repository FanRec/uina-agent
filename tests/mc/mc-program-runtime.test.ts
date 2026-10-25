import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MinecraftRuntime } from "../../.uina/worlds/minecraft/runtime/index.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { readProgram } from "../../.uina/worlds/minecraft/library/program-source.js";
import { createLibrary } from "../../.uina/worlds/minecraft/library/index.js";
import { readCallSource } from "../../.uina/worlds/minecraft/library/origin.js";
import type { NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { BodySession, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";

test("formal Runtime executes code and named children, preserves snapshots across SQLite reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-program-runtime-"));
	const program = await createProgram({
		dataRoot: root,
		loadProgram: (name) => readProgram(join(root, "programs"), name),
	});
	await mkdir(join(root, "programs"));
	await writeFile(
		join(root, "programs", "child.js"),
		"async function main(mc,input){return await mc.call('echo@1',input);}",
	);
	let closed = 0,
		writes = 0;
	const playerPort = {
		acquire: async () =>
			({
				runScoped: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
				lookAt: async () => {
					writes++;
					return { effect: "eff:test", dispatch: "not_sent", completion: "met", evidence: [] };
				},
				close: async () => {
					closed++;
				},
			}) as unknown as BodySession,
		chat: async () => {
			throw new Error("unused");
		},
	} satisfies PlayerPort;
	const callable: NativeCallable<JsonValue, JsonValue> = {
		descriptor: {
			ref: "echo@1",
			summary: "echo",
			input: {},
			output: {},
			access: "act",
			completion: { scope: "execution", description: "echo" },
			implementation: "native",
			errors: [],
			requires: [],
			examples: [],
		},
		invoke: async (ctx, input) =>
			ctx.withBody(async (scope) => {
				await scope.player.lookAt({ x: 0, y: 64, z: 0 });
				return input;
			}),
	};
	const options = {
		dbPath: join(root, "runtime.db"),
		storageId: "test",
		namespace: "prog",
		worldOwner: "owner",
		world: {} as WorldPort,
		playerPort,
		callables: [callable],
		program,
	};
	let { runtime } = await MinecraftRuntime.open(options);
	const origin = { worldOwner: "owner", activation: "activation" };
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
			requestId: "req:code",
			schedule: { kind: "enqueue" },
			entry: {
				kind: "program",
				source: {
					code: "async function main(mc){ return mc.withBody(async b => { return b.call('child',{count:3}); }); }",
				},
				input: {},
			},
		});
		expect(accepted.kind).toBe("accepted");
		if (accepted.kind !== "accepted") return;
		const result = await runtime.wait(accepted.snapshot.run, { timeoutMs: 5000 });
		expect(result.snapshot).toMatchObject({
			phase: "finished",
			outcome: "succeeded",
			completion: { scope: "execution" },
		});
		expect(writes).toBe(1);
		expect(closed).toBe(1);
		const calls = await runtime.listCalls(accepted.snapshot.run);
		expect(calls.items).toHaveLength(3);
		const record = await runtime.readRecord(calls.items.find((c) => c.ref === "child")!.record);
		expect(record).toMatchObject({
			kind: "inline",
			record: { value: { implementation: "program", program: { name: "child", snapshot: expect.any(String) } } },
		});
		for (const value of [1, 2]) {
			const header =
				'// uina {"input":{"$id":"urn:uina:runtime:input","type":"object"},"output":{"$id":"urn:uina:runtime:output","type":"number"}}\n';
			const accepted = await runtime.submit(origin, {
				requestId: `req:schema:${value}`,
				schedule: { kind: "enqueue" },
				entry: { kind: "program", source: { code: header + `async function main(){return ${value};}` }, input: {} },
			});
			expect(accepted.kind).toBe("accepted");
			if (accepted.kind === "accepted")
				expect((await runtime.wait(accepted.snapshot.run, { timeoutMs: 3000 })).snapshot).toMatchObject({
					phase: "finished",
					outcome: "succeeded",
				});
		}
		const wrong = await runtime.submit(origin, {
			requestId: "req:selfwait",
			schedule: { kind: "enqueue" },
			entry: {
				kind: "program",
				source: { code: "async function main(mc){return mc.withBody(async b=>mc.call('child',{}));}" },
				input: {},
			},
		});
		expect(wrong.kind).toBe("accepted");
		if (wrong.kind === "accepted") {
			const ended = await runtime.wait(wrong.snapshot.run, { timeoutMs: 300 });
			expect(ended.snapshot).toMatchObject({
				phase: "finished",
				outcome: "failed",
				error: { code: "BODY_SCOPE_ACTIVE" },
			});
		}
		await runtime.close();
		({ runtime } = await MinecraftRuntime.open({ ...options, namespace: "reopen", oldControlRetired: true }));
		expect(await runtime.read(accepted.snapshot.run)).toMatchObject({ phase: "finished", outcome: "succeeded" });
		const library = createLibrary({
			dataRoot: root,
			compile: (p) => program.validate(p),
			readSource: (origin) =>
				readCallSource(origin, {
					readRun: (run) => runtime.read(run),
					readRecord: (ref) => runtime.readRecord(ref, { format: "inline" }),
					readSnapshot: (request) => program.readSnapshot(request),
				}),
		});
		const child = calls.items.find((c) => c.ref === "child")!;
		await writeFile(join(root, "programs/child.js"), "async function main(){return 'new working file';}");
		const saved = await library.save({
			name: "reused",
			summary: "saved exact child",
			from: { run: child.run, segment: child.segment, call: child.call },
		});
		expect(saved.kind).toBe("program");
		const material = await library.get("program", "reused");
		expect(material).toMatchObject({
			savedFrom: { call: child.call },
			source: expect.stringContaining("mc.call('echo@1',input)"),
		});
		await expect(
			library.save({
				name: "wrong",
				summary: "wrong segment",
				from: { run: child.run, segment: "other", call: child.call },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await library.delete("program", "reused");
		expect(
			await readCallSource(
				{ run: child.run, segment: child.segment, call: child.call },
				{
					readRun: (run) => runtime.read(run),
					readRecord: (ref) => runtime.readRecord(ref, { format: "inline" }),
					readSnapshot: (request) => program.readSnapshot(request),
				},
			),
		).toMatchObject({ source: expect.stringContaining("mc.call('echo@1',input)") });
		let reopenedOwner = await runtime.attach(origin);
		for (const gate of reopenedOwner.gates)
			reopenedOwner = (
				await runtime.setOwnerGate({
					requestId: `reopen:${gate}`,
					attachment: reopenedOwner.attachment,
					gate,
					closed: false,
					expectedRevision: reopenedOwner.gateRevision,
				})
			).state;
		const large = await runtime.submit(origin, {
			requestId: "req:large-source-record",
			schedule: { kind: "enqueue" },
			entry: { kind: "program", source: { code: "async function main(){return null;}" }, input: "x".repeat(300000) },
		});
		expect(large.kind).toBe("accepted");
		if (large.kind === "accepted") {
			await runtime.wait(large.snapshot.run, { timeoutMs: 3000 });
			const rootCall = (await runtime.listCalls(large.snapshot.run)).items[0]!;
			const from = { run: rootCall.run, segment: rootCall.segment, call: rootCall.call };
			expect((await runtime.readRecord(from.call)).kind).toBe("file");
			expect(
				await readCallSource(from, {
					readRun: (run) => runtime.read(run),
					readRecord: (ref) => runtime.readRecord(ref),
					readSnapshot: (request) => program.readSnapshot(request),
				}),
			).toMatchObject({ source: "async function main(){return null;}" });
		}
	} finally {
		await runtime.close();
		await program.close();
	}
}, 15000);
