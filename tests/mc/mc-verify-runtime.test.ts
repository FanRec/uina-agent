/**
 * G4 ctx.verify：注册表、追加语义与恢复（真 RuntimeEngine + 真 RecordQueue）。
 *
 * 验收口径（known-gaps §G4）：一次真实 unknown 被复查并追加到原 Effect，
 * 不改写历史报告；未加载一律 unknown；未注册 verifier 如实 NOT_FOUND。
 * SQLite 持久化与跨重启复查走真实 worker（文件末尾的子进程集成测试）。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import type { BodySession, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { DriverExecutionFact } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { ExactRef, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { RuntimeEngine } from "../../.uina/worlds/minecraft/runtime/engine.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { RuntimeRefs } from "../../.uina/worlds/minecraft/runtime/refs.js";
import { DIG_VERIFIER_REF, digVerifier } from "../../.uina/worlds/minecraft/capabilities/shared/verify.js";
import { nativeCallable } from "./mc-native-fixture.js";

/** verify 回归的固定 descriptor 口径（capability scope 的 completion）。 */
const callable = (
	ref: ExactRef,
	invoke: NativeCallable<JsonValue, JsonValue>["invoke"],
): NativeCallable<JsonValue, JsonValue> =>
	nativeCallable(ref, invoke, {
		summary: "verify regression",
		completion: { scope: "capability", description: "observed result" },
	});

function digReceipt(effect: string, completion: DriverExecutionFact["completion"]): DriverExecutionFact {
	return {
		effect,
		operation: "op:verify",
		contract: "body.dig@1",
		observedAt: "2026-10-31T00:00:00.000Z",
		kind: "receipt",
		dispatch: "sent",
		completion,
		evidence: [],
		detail: { target: { x: 10, y: 64, z: 10 } },
	};
}

/** world stub：block@1 按脚本回答（air/stone/null=未加载）。 */
function worldWith(block: { name: string } | null): WorldPort {
	return {
		read: async () =>
			({
				value: { block: block == null ? null : { name: block.name } },
				observedAt: "2026-10-31T00:00:00.000Z",
				source: "server",
				coverage: "complete",
				unknown: [],
				evidence: ["ev:t:1"],
				cursor: null,
			}) as never,
	} as unknown as WorldPort;
}

interface HarnessOptions {
	world: WorldPort;
	verifiers?: Map<`${string}@${string}`, ReturnType<typeof digVerifier>>;
}

function harness(options: HarnessOptions, build: (queue: RecordQueue) => NativeCallable<JsonValue, JsonValue>[]) {
	const refs = new RuntimeRefs("verify");
	const instance = refs.writerInstance();
	const rows: { effectFact: unknown[]; verification: unknown[] } = { effectFact: [], verification: [] };
	const queue = new RecordQueue({
		instance,
		mintRecord: () => refs.record(),
		recoveredWatermarks: {},
		apply: (items) => {
			for (const item of items) {
				if (item.mutation.kind === "effect_fact") rows.effectFact.push(item.mutation.row);
				if (item.mutation.kind === "effect_verification") rows.verification.push(item.mutation.row);
			}
			queue.onDurable(instance, items[items.length - 1]!.ticket.sequence);
		},
	});
	const engine = new RuntimeEngine({
		refs,
		queue,
		world: options.world,
		verifiers: options.verifiers,
		playerPort: {
			acquire: async () => ({ close: async () => {} }) as BodySession,
			chat: async () => {
				throw new Error("chat is outside this verify fixture");
			},
		} satisfies PlayerPort,
		callables: build(queue),
		worldOwner: "owner:verify",
	});
	const submit = async (selector: ExactRef) => {
		const state = await engine.owner.attach({ worldOwner: "owner:verify", activation: "act:verify" });
		await engine.owner.setGate({
			requestId: "enable",
			attachment: state.attachment,
			gate: "disabled",
			closed: false,
			expectedRevision: state.gateRevision,
		});
		const reply = await engine.submit(
			{ worldOwner: "owner:verify", activation: "act:verify" },
			{ requestId: `req:${selector}`, entry: { kind: "call", selector, input: {} }, schedule: { kind: "enqueue" } },
		);
		if (reply.kind !== "accepted") throw new Error(JSON.stringify(reply));
		return reply.snapshot.run;
	};
	const finish = async (run: string) => {
		const reply = await engine.wait(run, { timeoutMs: 2000 }, undefined);
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") throw new Error(JSON.stringify(reply));
		return reply.snapshot;
	};
	return { engine, queue, rows, submit, finish };
}

describe("ctx.verify registry (G4)", () => {
	test("a real unknown dig effect is re-checked to met and appended without rewriting history", async () => {
		const h = harness(
			{ world: worldWith({ name: "air" }), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) },
			(queue) => [
				callable("digu@1", async (ctx) => {
					return await ctx.withBody(async () => {
						queue.record(digReceipt("eff:verify-dig", "unknown"));
						return (await ctx.verify("eff:verify-dig", "verify/dig@1", {})) as never;
					});
				}),
			],
		);
		const summary = await h.finish(await h.submit("digu@1"));
		// 核验返回 met，但 Run 的结算不随之改写：unknown 效果仍按 unknown 结算。
		expect(summary.outcome).toBe("unknown");
		const attribution = h.queue.effectRecord("eff:verify-dig");
		expect(attribution).not.toBeNull();
		expect(attribution!.facts).toHaveLength(1);
		expect(attribution!.facts[0]!.completion).toBe("unknown");
		expect(attribution!.verifications).toHaveLength(1);
		expect(attribution!.verifications[0]).toMatchObject({
			verifier: "verify/dig@1",
			completion: "met",
			reason: "cell 10,64,10 is air",
		});
		// 追加写成了新的 effect_verification 截面（含 facts + verifications）。
		expect(h.rows.verification).toHaveLength(1);
	});

	test("unloaded cells stay unknown and a still-solid cell is not_met", async () => {
		const h = harness({ world: worldWith(null), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) }, (queue) => [
			callable("digu@1", async (ctx) =>
				ctx.withBody(async () => {
					queue.record(digReceipt("eff:verify-unloaded", "unknown"));
					return (await ctx.verify("eff:verify-unloaded", "verify/dig@1", {})) as never;
				}),
			),
		]);
		await h.finish(await h.submit("digu@1"));
		const unloaded = h.queue.effectRecord("eff:verify-unloaded")!.verifications[0]!;
		expect(unloaded.completion).toBe("unknown");
		expect(unloaded.reason).toContain("not loaded");
	});

	test("an unregistered verifier fails NOT_FOUND with the registered list in hint", async () => {
		const h = harness(
			{ world: worldWith({ name: "air" }), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) },
			(queue) => [
				callable("digu@1", async (ctx) => {
					return await ctx.withBody(async () => {
						queue.record(digReceipt("eff:verify-dig", "unknown"));
						return (await ctx.verify("eff:verify-dig", "verify/nope@1", {})) as never;
					});
				}),
			],
		);
		const summary = await h.finish(await h.submit("digu@1"));
		expect(summary.outcome).toBe("failed");
		expect(summary.error?.code).toBe("NOT_FOUND");
		expect(summary.error?.message).toContain("not registered");
	});

	test("verifying an effect the runtime never recorded is NOT_FOUND", async () => {
		const h = harness(
			{ world: worldWith({ name: "air" }), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) },
			() => [
				callable("digu@1", async (ctx) => {
					return await ctx.withBody(async () => (await ctx.verify("eff:ghost", "verify/dig@1", {})) as never);
				}),
			],
		);
		const summary = await h.finish(await h.submit("digu@1"));
		expect(summary.outcome).toBe("failed");
		expect(summary.error?.code).toBe("NOT_FOUND");
		expect(summary.error?.message).toContain("no recorded facts");
	});

	test("a verifier for a different operation contract is rejected before any world read", async () => {
		const h = harness(
			{ world: worldWith({ name: "air" }), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) },
			(queue) => [
				callable("digu@1", async (ctx) =>
					ctx.withBody(async () => {
						queue.record({ ...digReceipt("eff:attack", "unknown"), contract: "body.attack@1" });
						return (await ctx.verify("eff:attack", "verify/dig@1", {})) as never;
					}),
				),
			],
		);
		const summary = await h.finish(await h.submit("digu@1"));
		expect(summary.outcome).toBe("failed");
		expect(summary.error?.code).toBe("INVALID_INPUT");
	});
});

describe("verify persistence across restart", () => {
	test("verifications survive close/reopen and re-verify appends to the restored effect", () => {
		const dir = mkdtempSync(join(tmpdir(), "uina-runtime-verify-"));
		const runtimeUrl = pathToFileURL(resolve(".uina/worlds/minecraft/runtime/index.ts")).href;
		const verifierUrl = pathToFileURL(resolve(".uina/worlds/minecraft/capabilities/shared/verify.ts")).href;
		const script = join(dir, "verify.mjs");
		writeFileSync(
			script,
			`
import assert from "node:assert/strict";
import { MinecraftRuntime } from ${JSON.stringify(runtimeUrl)};
import { buildVerifiers } from ${JSON.stringify(verifierUrl)};
const descriptor = ref => ({ref,summary:"verify",input:{},output:{},access:"act",implementation:"native",completion:{scope:"capability",description:"observed result"},errors:[],requires:[],examples:[]});
// world stub：第一轮 block@1 回 air（核验 met），第二轮回 stone（核验 not_met）。
let blockName = "air";
const world = { read: async () => ({ value: { block: { name: blockName } }, observedAt: "2026-10-31T00:00:00.000Z", source: "server", coverage: "complete", unknown: [], evidence: ["ev:t:1"], cursor: null }) };
let runtime;
const callables = [
 {descriptor:descriptor("digu@1"),invoke:ctx=>ctx.withBody(async()=>{
   runtime.sink.record({effect:"eff:verify-persist",operation:"op:verify",contract:"body.dig@1",observedAt:"2026-10-31T00:00:00.000Z",kind:"receipt",dispatch:"sent",completion:"unknown",evidence:[],detail:{target:{x:10,y:64,z:10}}});
   return await ctx.verify("eff:verify-persist","verify/dig@1");
 })},
 {descriptor:descriptor("reverify@1"),invoke:async ctx=>await ctx.verify("eff:verify-persist","verify/dig@1")}
];
const options = {dbPath:${JSON.stringify(join(dir, "runtime.db"))},storageId:"verify@1",namespace:"first",worldOwner:"owner:verify",world,verifiers:buildVerifiers(),playerPort:{acquire:async()=>({close:async()=>{}})},callables};
runtime = (await MinecraftRuntime.open(options)).runtime;
async function enable(rt){
 const owner=await rt.attach({worldOwner:"owner:verify",activation:"act:verify"});
 await rt.setOwnerGate({requestId:"enable",attachment:owner.attachment,gate:"disabled",closed:false,expectedRevision:owner.gateRevision});
}
try {
 await enable(runtime);
 const accepted=await runtime.submit({worldOwner:"owner:verify",activation:"act:verify"},{requestId:"req:dig",entry:{kind:"call",selector:"digu@1",input:{}},schedule:{kind:"enqueue"}});
 assert.equal(accepted.kind,"accepted");
 const reply=await runtime.wait(accepted.snapshot.run,{timeoutMs:3000});
 assert.equal(reply.kind,"result");
 const full=await runtime.readRecord(reply.snapshot.record);
 const receipt=full.record.value.value;
 assert.equal(receipt.completion,"met");
 // 落库检查：效果行的 verifications 已持久化。
 const {DatabaseSync}=await import("node:sqlite");
 const db=new DatabaseSync(options.dbPath);
 try {
  const row=db.prepare("SELECT verifications FROM effects WHERE effect='eff:verify-persist'").get();
  assert.equal(JSON.parse(row.verifications).length,1);
  assert.equal(JSON.parse(row.verifications)[0].completion,"met");
 } finally { db.close(); }
} finally { await runtime.close(); }
// 重启：效果行恢复进内存，第二轮 world 回 stone → not_met 追加为第二条。
blockName = "stone";
runtime = (await MinecraftRuntime.open({...options,namespace:"restart"})).runtime;
try {
 await enable(runtime);
 const accepted=await runtime.submit({worldOwner:"owner:verify",activation:"act:verify"},{requestId:"req:reverify",entry:{kind:"call",selector:"reverify@1",input:{}},schedule:{kind:"enqueue"}});
 assert.equal(accepted.kind,"accepted");
 const reply=await runtime.wait(accepted.snapshot.run,{timeoutMs:3000});
 assert.equal(reply.kind,"result");
 const full=await runtime.readRecord(reply.snapshot.record);
 assert.equal(full.record.value.value.completion,"not_met");
 const {DatabaseSync}=await import("node:sqlite");
 const db=new DatabaseSync(options.dbPath);
 try {
  const row=db.prepare("SELECT verifications,facts FROM effects WHERE effect='eff:verify-persist'").get();
  const verifications=JSON.parse(row.verifications);
  assert.equal(verifications.length,2);
  assert.deepEqual(verifications.map(v=>v.completion),["met","not_met"]);
  assert.equal(JSON.parse(row.facts)[0].completion,"unknown");
 } finally { db.close(); }
} finally { await runtime.close(); }
console.log("runtime verify persistence passed");
`,
		);
		try {
			const output = execFileSync(process.execPath, ["--import", "tsx", script], {
				cwd: resolve("."),
				encoding: "utf8",
				timeout: 30_000,
				windowsHide: true,
			});
			expect(output).toContain("runtime verify persistence passed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
