import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { builtinCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { BodySession, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";
import { MinecraftRuntime } from "../../.uina/worlds/minecraft/runtime/index.js";
import { createProgramHost } from "../../.uina/worlds/minecraft/runtime/program-host.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

test("Runtime world waiting preserves body ownership and stop closes its guest without harming the supplier", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-wait-runtime-"));
	const h = makeFactsHarness({
		bot: makeBot({
			_client: new EventEmitter(),
			health: 10,
			entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, effects: {} },
			registry: { effects: {} },
			game: { dimension: "overworld" },
		}),
	});
	const caps = builtinCatalog.bind({
		surface: () => null,
		knowledge: () => null,
		gotoDirector: {} as never,
		runtime: () => {
			throw new Error("unused");
		},
	});
	const world = new MinecraftWorld({
		facts: h.facts,
		readers: caps.readers,
		validators: caps.validators,
		queries: caps.queries,
		dbPath: join(root, "history.db"),
		namespace: "test",
		binding: { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" },
	});
	let runtime: MinecraftRuntime | undefined,
		writes = 0,
		closed = 0;
	const program = await createProgram({
		dataRoot: root,
		loadProgram: async () => {
			throw new Error("unused");
		},
		onChanged: () => runtime?.programChanged(),
	});
	let acquisitionFailure: Promise<never> | undefined;
	const playerPort: PlayerPort = {
		acquire: async () => {
			if (acquisitionFailure) return acquisitionFailure;
			return {
				runScoped: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
				lookAt: async () => {
					writes++;
					h.bot().health = 18;
					h.bot().emit("health");
					return { effect: "eff:test", dispatch: "not_sent", completion: "met", evidence: [] };
				},
				close: async () => {
					closed++;
				},
			} as unknown as BodySession;
		},
		chat: async () => {
			throw new Error("unused");
		},
	};
	runtime = (
		await MinecraftRuntime.open({
			dbPath: join(root, "runtime.db"),
			storageId: "test",
			namespace: "test",
			worldOwner: "owner",
			world,
			program,
			playerPort,
			callables: [],
			queryRefs: caps.queries.map((q) => q.ref),
		})
	).runtime;
	const rt = runtime,
		origin = { worldOwner: "owner", activation: "activation" };
	const owner = await rt.attach(origin);
	await rt.setOwnerGate({
		requestId: "enable",
		attachment: owner.attachment,
		gate: "disabled",
		closed: false,
		expectedRevision: owner.gateRevision,
	});
	const run = async (requestId: string, code: string) => {
		const r = await rt.submit(origin, {
			requestId,
			schedule: { kind: "enqueue" },
			entry: { kind: "program", source: { code }, input: {} },
		});
		if (r.kind !== "accepted") throw new Error(JSON.stringify(r));
		return r.snapshot.run;
	};
	const waitCode = "mc.waitUntil({me:{ref:'self@1'}},s=>s.me.health>=15)";
	const supply = "async function main(mc){return mc.withBody(b=>b.lookAt({x:0,y:64,z:0}));}";
	try {
		const waiting = await run("wait", `async function main(mc){return ${waitCode};}`);
		await expect
			.poll(() => rt.read(waiting))
			.toMatchObject({ phase: "waiting", waiting: { kind: "world_change", targets: ["self@1"] }, control: "none" });
		const supplier = await run("supply", supply);
		expect((await rt.wait(supplier, { timeoutMs: 3000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "succeeded",
		});
		expect((await rt.wait(waiting, { timeoutMs: 3000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "succeeded",
		});

		h.bot().health = 10;
		h.bot().emit("health");
		const parallel = await run(
			"parallel",
			`async function main(mc){return Promise.all([${waitCode},mc.waitUntil({inv:{ref:'inventory@1'}},()=>false)]);}`,
		);
		await expect
			.poll(() => rt.read(parallel))
			.toMatchObject({
				phase: "waiting",
				waiting: { kind: "world_change", targets: expect.arrayContaining(["self@1", "inventory@1"]) },
			});
		h.bot().health = 18;
		h.bot().emit("health");
		await expect
			.poll(() => rt.read(parallel))
			.toMatchObject({ phase: "waiting", waiting: { kind: "world_change", targets: ["inventory@1"] } });
		await rt.stop({ requestId: "stop-parallel", target: { run: parallel } });
		expect((await rt.wait(parallel, { timeoutMs: 3000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "cancelled",
		});
		h.bot().health = 10;
		h.bot().emit("health");
		const held = await run("held", `async function main(mc){return mc.withBody(()=>${waitCode});}`);
		await expect.poll(() => rt.read(held)).toMatchObject({ phase: "waiting", control: "active" });
		const blocked = await run("blocked", supply);
		await expect.poll(() => rt.read(blocked)).toMatchObject({ phase: "queued" });
		expect(writes).toBe(1);
		await rt.stop({ requestId: "stop-held", target: { run: held } });
		expect((await rt.wait(held, { timeoutMs: 3000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "cancelled",
		});
		expect((await rt.wait(blocked, { timeoutMs: 3000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "succeeded",
		});
		expect(writes).toBe(2);
		expect(closed).toBe(3);

		let rejectAcquisition!: (error: Error) => void;
		acquisitionFailure = new Promise<never>((_resolve, reject) => {
			rejectAcquisition = reject;
		});
		const recovered = await run(
			"recover-acquire",
			"async function main(mc){try{await mc.withBody(()=>null);}catch(e){}return mc.waitUntil({me:{ref:'self@1'}},()=>false);}",
		);
		await expect
			.poll(() => program.capacity().calls.find((c) => c.run === recovered)?.waiting?.method)
			.toBe("acquireBody");
		rt.programChanged();
		expect(await rt.read(recovered)).toMatchObject({ phase: "queued" });
		rejectAcquisition(Object.assign(new Error("acquire failed"), { code: "CONTROL_CONFLICT" }));
		acquisitionFailure = undefined;
		await expect
			.poll(() => rt.read(recovered))
			.toMatchObject({ phase: "waiting", waiting: { kind: "world_change", targets: ["self@1"] } });
		await rt.stop({ requestId: "stop-recovered", target: { run: recovered } });
		expect((await rt.wait(recovered, { timeoutMs: 3000 })).snapshot).toMatchObject({
			phase: "finished",
			outcome: "cancelled",
		});
		expect(program.capacity().residentGuests).toBe(0);
	} finally {
		await rt.close();
		await program.close();
		await world.close();
	}
});

test("a failed watch registration closes earlier targets and preserves the original error", async () => {
	const scope = new AbortController();
	let closed = 0;
	const ctx = {
		signal: scope.signal,
		world: {
			watch: async (q: { ref: string }, _cursor: unknown, signal: AbortSignal) => {
				if (q.ref === "bad@1") throw Object.assign(new Error("original failure"), { code: "STORE_UNAVAILABLE" });
				return {
					next: async () =>
						new Promise((_resolve, reject) =>
							signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
						),
					close: async () => {
						closed++;
					},
				};
			},
		},
	} as unknown as CallContext;
	const resources = new Set<() => Promise<void>>();
	const host = createProgramHost(ctx, resources, () => "read");
	const version = Buffer.from(JSON.stringify({ stream: "s", epoch: "e", sequence: 1 })).toString("base64url");
	await expect(
		host.watch({ targets: { a: { ref: "good@1" }, b: { ref: "bad@1" } }, after: { a: version, b: version } }),
	).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", message: "original failure" });
	expect(closed).toBe(1);
	expect(resources.size).toBe(1);
});
