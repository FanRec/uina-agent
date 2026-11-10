import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { enableAddon, installAddon } from "../addons/manage.js";
import { resolveAddonPlan } from "../addons/plan.js";
import type { CompletionReport, RunSummary } from "../contracts/runtime.js";
import { constructionDecisionEvidence } from "../contracts/task.js";
import { DEV_SERVER, type DevHarness, openHarness, sleep } from "./harness.js";
import { makeScenario } from "./scenario.js";

const crashRoot = process.argv[3];
const dataRoot = crashRoot ?? (await mkdtemp(join(tmpdir(), "uina-mc-fabric-live-")));
const profileId = "1".repeat(64);
if (!crashRoot)
	for (const [id, path] of [
		["fabric-fixture", "../dev-env/fabric/addon"],
		["spectatorplus", "../packages/spectatorplus"],
	] as const) {
		await installAddon(dataRoot, fileURLToPath(new URL(path, import.meta.url)));
		await enableAddon({ root: dataRoot, profileId, id });
	}
const addonPlan = () =>
	resolveAddonPlan({
		minecraftRoot: dataRoot,
		profileDir: join(dataRoot, "sessions", profileId),
		minecraftVersion: "1.21.11",
	});
const addons = await addonPlan();
assert.deepEqual(addons.roots, ["fabric-fixture", "spectatorplus"]);
const open = (unclean = false, plan = addons, oldControlRetired = true) =>
	openHarness("fabric-live", { dataRoot, addons: plan, ns: profileId, unclean, oldControlRetired });

async function reset(h: DevHarness) {
	const s = makeScenario(h, "fabric-live");
	const user = h.bot.username;
	await s.command(`/gamemode creative ${user}`);
	await s.command(`/tp ${user} 8.5 103 8.5`);
	await s.command("/fill 4 99 4 13 99 13 stone");
	await s.command("/fill 7 100 7 12 102 12 air");
	await s.command(`/tp ${user} 8.5 100 8.5`);
	await s.command(`/clear ${user}`);
	return s;
}

async function content(h: DevHarness) {
	const s = await reset(h);
	const user = h.bot.username;
	await s.command(`/give ${user} uina_fixture:tile 1`);
	await s.command(`/give ${user} uina_fixture:token 1`);
	await s.command(`/gamemode survival ${user}`);
	const at = { x: 10, y: 100, z: 8 };
	assert(
		(await s.serverProbe(`/execute if items entity ${user} inventory.* uina_fixture:token`)) ||
			(await s.serverProbe(`/execute if items entity ${user} hotbar.* uina_fixture:token`)),
	);
	const code = `async function main(mc, at) {
		const token = (await mc.read("item@1", { name: "uina_fixture:token" })).value;
		const inventory = (await mc.read("inventory@1")).value;
		if (!token || inventory.counts[token.name] !== 1) throw Error("custom item not decoded");
		await mc.call("place@1", { at, block: "uina_fixture:tile" });
		return { token: token.name, block: (await mc.read("block@1", { at })).value.block.name };
	}`;
	const accepted = await h.runtime.submit(
		{ worldOwner: h.worldOwner, activation: h.activation },
		{
			requestId: "fabric-program",
			entry: { kind: "program", source: { code }, input: at },
			schedule: { kind: "enqueue" },
		},
	);
	assert(accepted.kind === "accepted", JSON.stringify(accepted));
	const settled = await h.runtime.wait(accepted.snapshot.run, { timeoutMs: 15000 });
	assert(
		settled.kind === "result" && settled.snapshot.phase === "finished" && settled.snapshot.outcome === "succeeded",
		JSON.stringify(settled.kind === "result" ? await h.runtime.readRecord(settled.snapshot.record) : settled),
	);
	assert(await s.serverBlock(at, "uina_fixture:tile"));
	console.log("FABRIC content: item and block independently confirmed by the server", h.host.recoveryIdentity());
	return {
		item: h.bot.registry.itemsByName["uina_fixture:token"]!.id,
		state: h.bot.registry.blocksByName["uina_fixture:tile"]!.defaultState,
	};
}

async function spectator(h: DevHarness) {
	const s = await reset(h);
	const user = h.bot.username;
	const log = process.env.MC_FABRIC_OBSERVER_LOG;
	assert(log, "set MC_FABRIC_OBSERVER_LOG to the real Loom observer log");
	const observed = () =>
		readFile(log, "utf8").then((text) => text.split(/\r?\n/).filter((line) => line.includes("UINA_OBSERVER ")));
	async function waitFor(check: (lines: string[]) => boolean) {
		const deadline = Date.now() + 10000;
		for (;;) {
			const lines = await observed();
			if (check(lines)) return;
			assert(Date.now() < deadline, JSON.stringify(lines.slice(-6)));
			await sleep(100);
		}
	}
	await s.command("/gamemode spectator UinaObserver");
	await s.command(`/tp UinaObserver ${user}`);
	await s.command(`/give ${user} oak_log 2`);
	await s.command(`/gamemode survival ${user}`);
	const packets: number[] = [];
	const client = h.bot._client;
	const write = client.write.bind(client);
	client.write = (name, packet) => {
		if (name === "custom_payload" && packet.channel === "spectatorplus:opened_inventory_sync")
			packets.push(packet.data[0]);
		write(name, packet);
	};
	const synced = (line: string) => line.includes("SyncedInventoryScreen");
	await s.command("/execute as UinaObserver run spectate");
	await waitFor((lines) => lines.at(-1)?.includes("UINA_OBSERVER UinaObserver none") === true);
	const unrelated = (await observed()).length;
	assert((await s.call("craft@1", { item: "oak_planks", count: 4 })).ok);
	await sleep(500);
	assert(!(await observed()).slice(unrelated).some(synced), "unrelated observer opened the player's inventory");
	await s.command(`/spectate ${user} UinaObserver`);
	await waitFor((lines) => lines.at(-1)?.includes(`UINA_OBSERVER ${user} none`) === true);
	const attached = (await observed()).length;
	assert((await s.call("craft@1", { item: "oak_planks", count: 4 })).ok);
	await waitFor((lines) => {
		const changes = lines.slice(attached);
		const opened = changes.findIndex((line) => line.includes(`UINA_OBSERVER ${user} `) && synced(line));
		return opened >= 0 && changes.slice(opened + 1).some((line) => line.includes(`UINA_OBSERVER ${user} none`));
	});
	assert.deepEqual(packets, [1, 0, 1, 0]);
	console.log(
		"FABRIC SpectatorPlus: sent open/close for each craft; actual client mirrored only while spectating Uina",
	);
}

const cells = [
	{ at: { x: 10, y: 100, z: 8 }, block: "oak_log" },
	{ at: { x: 10, y: 100, z: 9 }, block: "oak_log" },
];

async function readConstructionEvidence(h: DevHarness, snapshot: Extract<RunSummary, { phase: "awaiting_decision" }>) {
	const reply = await h.runtime.readRecord(snapshot.completionRef, { format: "inline" });
	assert(reply.kind === "inline" && reply.record.kind === "completion", JSON.stringify(reply));
	const report = reply.record.value as unknown as CompletionReport;
	assert(report.reportKind === "decision");
	const checkpoint = report.snapshot.checkpoint;
	assert(checkpoint?.kind === "program");
	return constructionDecisionEvidence("task:fixture", snapshot, checkpoint);
}

async function verifyMissingMaterials(h: DevHarness) {
	const s = await reset(h);
	await s.command(`/gamemode survival ${h.bot.username}`);
	const result = await s.spawn("build.resume@1", { cells });
	const reply = await h.runtime.wait(result.run, { timeoutMs: 10000 });
	assert(reply.kind === "result" && reply.snapshot.phase === "awaiting_decision", JSON.stringify(reply));
	const evidence = await readConstructionEvidence(h, reply.snapshot);
	assert.deepEqual(evidence.construction, {
		verifiedAtCheckpoint: 0,
		cellsToRecheck: cells.map(({ at }) => at),
		cellsToRecheckCount: cells.length,
	});
	assert.deepEqual(evidence.nextCall, {
		action: "observe",
		params: { selector: "block@1", input: { at: cells[0]!.at } },
	});
	for (const { at } of cells) assert(await s.serverBlock(at, "air"));
	console.log("FABRIC recovery evidence: no materials, zero verified, both cells remained air");
}

async function interruptConstruction(h: DevHarness) {
	const s = await reset(h);
	const user = h.bot.username;
	await s.command(`/give ${user} oak_log 2`);
	await s.command(`/gamemode survival ${user}`);
	const unknown = process.argv[2] === "--interrupt-unknown";
	let identity: { run: string; segment: string } | undefined;
	if (unknown) {
		const client = h.bot._client;
		const write = client.write.bind(client);
		client.write = (name, packet) => {
			write(name, packet);
			if (name === "block_place") {
				assert(identity && process.send);
				process.send(identity);
				// Hold this process at the actual send boundary until the parent terminates it.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
				throw new Error("placement crash was not triggered");
			}
		};
	}
	const accepted = await h.runtime.submit(
		{ worldOwner: h.worldOwner, activation: h.activation },
		{
			requestId: "fabric-recovery",
			entry: { kind: "call", selector: "build.resume@1", input: { cells } },
			schedule: { kind: "enqueue" },
		},
	);
	assert(accepted.kind === "accepted", JSON.stringify(accepted));
	const { run } = accepted.snapshot;
	const { segment } = accepted;
	if (unknown) {
		identity = { run, segment };
		await new Promise<never>(() => {});
	}
	const db = new DatabaseSync(join(dataRoot, "runtime.db"), { readOnly: true });
	const row = db.prepare("SELECT checkpoint FROM segments WHERE segment=?");
	try {
		const deadline = Date.now() + 12000;
		while (Date.now() < deadline) {
			const checkpoint = row.get(segment)?.checkpoint;
			if (typeof checkpoint === "string" && JSON.parse(checkpoint).value.verified === 1) {
				process.send?.({ run, segment });
				await new Promise<never>(() => {});
			}
			const snapshot = await h.runtime.read(run);
			if (snapshot.phase === "finished" || snapshot.phase === "awaiting_decision")
				throw new Error(JSON.stringify(await h.runtime.readRecord(snapshot.record)));
			await sleep(2);
		}
		throw new Error("first placement checkpoint was not committed");
	} finally {
		db.close();
	}
}

async function verifyRestart(mode: "resume" | "unknown" | "assets" | "save" | "writer") {
	let targetPort = DEV_SERVER.port;
	const relay =
		mode === "save"
			? createServer((client) => {
					const upstream = connect(targetPort, "127.0.0.1");
					client.on("error", () => upstream.destroy()).on("close", () => upstream.destroy());
					upstream.on("error", () => client.destroy()).on("close", () => client.destroy());
					client.pipe(upstream).pipe(client);
				})
			: null;
	if (relay) {
		relay.listen(0, "127.0.0.1");
		await once(relay, "listening");
		DEV_SERVER.port = (relay.address() as { port: number }).port;
	}
	const child = fork(
		fileURLToPath(import.meta.url),
		[mode === "unknown" ? "--interrupt-unknown" : "--interrupt", dataRoot],
		{
			execArgv: ["--import", "tsx"],
			env: { ...process.env, MC_DEV_PORT: String(DEV_SERVER.port) },
		},
	);
	const exit = once(child, "exit");
	try {
		const first = await Promise.race([
			once(child, "message", { signal: AbortSignal.timeout(35000) }).then(
				([value]) => value as { run: string; segment: string },
			),
			exit.then(([code]) => {
				throw new Error(`construction process exited before its checkpoint (${code})`);
			}),
		]);
		child.kill("SIGKILL");
		const [, signal] = await exit;
		assert.equal(signal, "SIGKILL");
		let plan = addons;
		if (mode === "assets") {
			const updated = join(dataRoot, "updated-addon");
			await cp(fileURLToPath(new URL("../dev-env/fabric/addon", import.meta.url)), updated, { recursive: true });
			const index = join(updated, "index.js");
			await writeFile(index, (await readFile(index, "utf8")) + "\n// acceptance asset update\n");
			await installAddon(dataRoot, updated);
			plan = await addonPlan();
			assert.notEqual(plan.digest, addons.digest);
		}
		if (mode === "save") {
			const alternate = Number(process.env.MC_FABRIC_ALTERNATE_PORT);
			assert(Number.isInteger(alternate) && alternate > 0 && alternate !== targetPort, "set MC_FABRIC_ALTERNATE_PORT");
			targetPort = alternate;
		}
		if (mode === "writer") {
			await assert.rejects(
				open(true, plan, false),
				/unclean recovery requires proof that the old control domain retired/,
			);
			const db = new DatabaseSync(join(dataRoot, "runtime.db"), { readOnly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segments WHERE run=?").get(first.run)?.count, 1);
			} finally {
				db.close();
			}
			console.log("FABRIC recovery writer: startup refused without retirement proof; no new Segment");
			return;
		}
		const h = await open(true, plan);
		try {
			if (mode !== "resume") {
				const snapshot = await h.runtime.read(first.run);
				assert(snapshot.phase === "awaiting_decision", JSON.stringify(snapshot));
				if (mode === "unknown") assert(snapshot.unknownEffectCount > 0, JSON.stringify(snapshot));
				const attempted = await h.runtime.continue(
					{ worldOwner: h.worldOwner, activation: h.activation },
					{
						requestId: "explicit-recovery",
						run: first.run,
						decision: snapshot.decision,
						entry: { kind: "call", selector: "build.resume@1", input: { cells } },
					},
				);
				assert(attempted.kind === "not_accepted", JSON.stringify(attempted));
				assert.equal(
					attempted.code,
					{
						unknown: "RECOVERY_EFFECT_UNKNOWN",
						assets: "CHECKPOINT_INVALID",
						save: "WORLD_IDENTITY_CHANGED",
					}[mode],
				);
				assert.deepEqual(h.runtime.lookup("explicit-recovery"), {
					kind: "rejected",
					requestId: "explicit-recovery",
					code: attempted.code,
					message: attempted.message,
				});
				const deadline = Date.now() + 5000;
				for (;;) {
					const parked = await h.runtime.read(first.run);
					assert(parked.phase === "awaiting_decision", JSON.stringify(parked));
					if (parked.reason === attempted.message) break;
					assert(Date.now() < deadline, `task did not surface the recovery refusal: ${parked.reason}`);
					await sleep(100);
				}
				if (mode === "unknown") {
					const parked = await h.runtime.read(first.run);
					assert(parked.phase === "awaiting_decision");
					const evidence = await readConstructionEvidence(h, parked);
					assert.equal(evidence.nextCall?.action, "tasks");
					const effect = await h.runtime.readRecord(parked.unknownEffects[0]!, { format: "inline" });
					assert(effect.kind === "inline" && effect.record.kind === "effect", JSON.stringify(effect));
				}
				const stopped = await h.runtime.stop({ requestId: "stop-recovery", target: { run: first.run } });
				assert.equal(stopped.snapshot?.phase, "finished");
				assert.equal(stopped.control, "stopped");
				const settled = await h.runtime.read(first.run);
				assert(settled.phase === "finished" && settled.outcome === "cancelled", JSON.stringify(settled));
				assert.equal(settled.segment, first.segment);
				await h.runtime.recheckDurableWaits();
				assert.equal((await h.runtime.read(first.run)).segment, first.segment);
				console.log(`FABRIC recovery ${mode}: ${attempted.code}; explicit stop prevented continuation`);
				return;
			}
			const deadline = Date.now() + 12000;
			let settled = await h.runtime.read(first.run);
			while (settled.phase !== "finished" && Date.now() < deadline) {
				await sleep(100);
				settled = await h.runtime.read(first.run);
			}
			if (settled.phase !== "finished" || settled.outcome !== "succeeded")
				throw new Error(JSON.stringify("record" in settled ? await h.runtime.readRecord(settled.record) : settled));
			assert.notEqual(settled.segment, first.segment);
			const s = makeScenario(h, "fabric-recovery");
			for (const { at, block } of cells) assert(await s.serverBlock(at, block));
			const db = new DatabaseSync(join(dataRoot, "runtime.db"), { readOnly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS count FROM segments WHERE run=?").get(first.run)?.count, 2);
			} finally {
				db.close();
			}
			console.log(
				"FABRIC recovery: process killed after checkpoint; same Run, exactly two Segments, both blocks server-confirmed",
			);
		} finally {
			await h.close();
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		relay?.close();
	}
}

const scenario = process.argv[2];
if (scenario === "--restart") await verifyRestart("resume");
else if (scenario === "--restart-unknown") await verifyRestart("unknown");
else if (scenario === "--restart-assets") await verifyRestart("assets");
else if (scenario === "--restart-save") await verifyRestart("save");
else if (scenario === "--restart-writer") await verifyRestart("writer");
else {
	const h = await open();
	let contentIds: Awaited<ReturnType<typeof content>> | undefined;
	try {
		assert(h.host.recoveryIdentity(), "Fabric save identity unavailable");
		if (crashRoot) await interruptConstruction(h);
		else if (process.argv[2] === "--spectator") await spectator(h);
		else if (scenario === "--recovery-evidence") await verifyMissingMaterials(h);
		else contentIds = await content(h);
	} finally {
		await h.close();
	}
	if (scenario === "--registry-switch") {
		assert(contentIds);
		const port = Number(process.env.MC_FABRIC_VANILLA_PORT ?? "25565");
		assert(port !== DEV_SERVER.port && Number.isInteger(port) && port > 0);
		await h.host.connect({ ...DEV_SERVER, port });
		try {
			assert.equal(h.host.state, "ready");
			assert.equal(h.host.recoveryIdentity(), null);
			const registry = h.host.bot?.registry;
			assert(registry);
			assert.equal(registry.itemsByName["uina_fixture:token"], undefined);
			assert.equal(registry.items[contentIds.item], undefined);
			assert.equal(registry.blocksByStateId[contentIds.state], undefined);
			console.log("FABRIC registry: after switching to Paper the custom item and state IDs were unknown");
		} finally {
			h.host.close();
		}
	}
}
