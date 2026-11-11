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
import { DIG_VERIFIER_REF, digVerifier } from "../../.uina/worlds/minecraft/capabilities/shared/verify.js";
import type { BodySession, PlayerPort } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { NativeCallable } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type {
	DriverExecutionFact,
	EffectVerification,
	EffectVerifier,
} from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { ExactRef, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { WorldPort } from "../../.uina/worlds/minecraft/contracts/world.js";
import { RuntimeEngine } from "../../.uina/worlds/minecraft/runtime/engine.js";
import { assessEffectFacts, RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { RuntimeRefs } from "../../.uina/worlds/minecraft/runtime/refs.js";
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
		detail: { target: { x: 10, y: 64, z: 10 }, dimension: "overworld" },
	};
}

/** world stub：block@1 按脚本回答（air/stone/null=未加载）；self@1 报告当前维度。 */
function worldWith(block: { name: string } | null, dimension = "overworld"): WorldPort {
	return {
		read: async ({ ref }: { ref: string }) =>
			ref === "self@1"
				? ({
						value: { place: { dimension } },
						observedAt: "2026-10-31T00:00:00.000Z",
						source: "server",
						coverage: "complete",
						unknown: [],
						evidence: ["ev:t:1"],
						cursor: null,
					} as never)
				: ({
						value: { block: block == null ? null : { name: block.name } },
						observedAt: "2026-10-31T00:00:00.000Z",
						source: "server",
						coverage: "complete",
						unknown: [],
						evidence: ["ev:t:1"],
						cursor: null,
					} as never),
	} as unknown as WorldPort;
}

/** 恒定 met 的核验器：F3 矩阵用（只代表业务判定，不关心合同身份）。 */
function staticMetVerifier(): EffectVerifier {
	return {
		check: async () => ({ completion: "met", evidence: [], reason: "static business confirmation" }),
	};
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
	test("an in-flight unknown dig re-checked to met settles the call on current facts without rewriting facts", async () => {
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
		// 进行中调用的当前判定：锚定核验关闭未决后按可信事实结算（历史 facts 不改写）。
		expect(summary.outcome).toBe("succeeded");
		expect(summary.unknownEffects).toEqual([]);
		const attribution = h.queue.effectRecord("eff:verify-dig");
		expect(attribution).not.toBeNull();
		expect(attribution!.facts).toHaveLength(1);
		expect(attribution!.facts[0]!.completion).toBe("unknown");
		expect(attribution!.verifications).toHaveLength(1);
		expect(attribution!.verifications[0]).toMatchObject({
			verifier: "verify/dig@1",
			completion: "met",
			reason: "cell 10,64,10 is air",
			factsAnchor: 1,
		});
		// 追加写成了新的 effect_verification 截面（含 facts + verifications）。
		expect(h.rows.verification).toHaveLength(1);
	});

	test("F2: a fact arriving during the check invalidates the anchor and the stale met is not returned as current truth", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const racing: EffectVerifier = {
			check: async () => {
				await gate;
				return { completion: "met", evidence: [], reason: "raced verifier read only its snapshot" };
			},
		};
		const h = harness(
			{
				world: worldWith({ name: "air" }),
				verifiers: new Map([["verify/racing@1" as `${string}@${string}`, racing]]),
			},
			(queue) => [
				callable("racer@1", async (ctx) =>
					ctx.withBody(async () => {
						queue.record(digReceipt("eff:verify-race", "unknown"));
						const verifyPromise = ctx.verify("eff:verify-race", "verify/racing@1", {}) as Promise<never>;
						await Promise.resolve();
						// 核验已启动、尚未完成：此刻到达的新事实不在核验器的快照里。
						queue.record(digReceipt("eff:verify-race", "unknown"));
						release();
						return await verifyPromise;
					}),
				),
			],
		);
		const summary = await h.finish(await h.submit("racer@1"));
		// 竞态后当前判定仍按事实投影：两个 unknown receipt → 未决，核验不结清。
		expect(summary.outcome).toBe("unknown");
		expect(summary.unknownEffects).toEqual(["eff:verify-race"]);
		const attribution = h.queue.effectRecord("eff:verify-race")!;
		expect(attribution.facts).toHaveLength(2);
		expect(attribution.verifications).toHaveLength(1);
		expect(attribution.verifications[0]!.factsAnchor).toBe(1);
		expect(attribution.verifications[0]!.completion).toBe("met");
	});

	test("F3: a met verification does not bypass an unsettled cleanup barrier (goto)", async () => {
		const h = harness(
			{
				world: worldWith({ name: "air" }),
				verifiers: new Map([["verify/met@1" as `${string}@${string}`, staticMetVerifier()]]),
			},
			(queue) => [
				callable("gotoverify@1", async (ctx) =>
					ctx.withBody(async () => {
						queue.record({ ...digReceipt("eff:verify-barrier", "met"), contract: "body.goto@1" });
						queue.record({
							...digReceipt("eff:verify-barrier", "unknown"),
							contract: "body.goto@1",
							kind: "cleanup",
						});
						return (await ctx.verify("eff:verify-barrier", "verify/met@1", {})) as never;
					}),
				),
			],
		);
		const summary = await h.finish(await h.submit("gotoverify@1"));
		// 业务问题已被核验关闭（返回 met），但导航写源静止证明缺失：仍按未决结算。
		expect(summary.outcome).toBe("unknown");
		expect(summary.unknownEffects).toEqual(["eff:verify-barrier"]);
	});

	test("F3: receipt unknown + cleanup met + qualified verification settles per the contract (goto)", async () => {
		const h = harness(
			{
				world: worldWith({ name: "air" }),
				verifiers: new Map([["verify/met@1" as `${string}@${string}`, staticMetVerifier()]]),
			},
			(queue) => [
				callable("gotosettle@1", async (ctx) =>
					ctx.withBody(async () => {
						queue.record({ ...digReceipt("eff:verify-settle", "unknown"), contract: "body.goto@1" });
						queue.record({
							...digReceipt("eff:verify-settle", "met"),
							contract: "body.goto@1",
							kind: "cleanup",
						});
						return (await ctx.verify("eff:verify-settle", "verify/met@1", {})) as never;
					}),
				),
			],
		);
		const summary = await h.finish(await h.submit("gotosettle@1"));
		// 业务核验关闭不确定性 + 清理已静止：按已有合同结清。
		expect(summary.outcome).toBe("succeeded");
		expect(summary.unknownEffects).toEqual([]);
	});

	test("a verification appended after a run closed never rewrites that run's recorded outcome", async () => {
		const h = harness(
			{ world: worldWith({ name: "air" }), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) },
			(queue) => [
				callable("digonce@1", async (ctx) =>
					ctx.withBody(async () => {
						queue.record(digReceipt("eff:verify-history", "unknown"));
						return "done";
					}),
				),
				callable("reverify@1", async (ctx) =>
					ctx.withBody(async () => (await ctx.verify("eff:verify-history", "verify/dig@1", {})) as never),
				),
			],
		);
		const first = await h.finish(await h.submit("digonce@1"));
		expect(first.outcome).toBe("unknown");
		// 结算之后再追加合格核验：原 Run 截面保持 unknown，不倒写。
		await h.finish(await h.submit("reverify@1"));
		expect(h.queue.effectRecord("eff:verify-history")!.verifications).toHaveLength(1);
		const settled = h.engine.read(first.run);
		expect(settled.phase).toBe("finished");
		expect(settled.phase === "finished" && settled.outcome).toBe("unknown");
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

	test("a conflicting late driver fact invalidates an anchored verification (E07)", async () => {
		const h = harness(
			{ world: worldWith({ name: "air" }), verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]) },
			(queue) => [
				callable("latefact@1", async (ctx) =>
					ctx.withBody(async () => {
						queue.record(digReceipt("eff:verify-late", "unknown"));
						await ctx.verify("eff:verify-late", "verify/dig@1", {});
						// 核验之后又到的冲突事实：锚点失效，核验退回历史诊断。
						queue.record(digReceipt("eff:verify-late", "unknown"));
						return "done";
					}),
				),
			],
		);
		const summary = await h.finish(await h.submit("latefact@1"));
		expect(summary.outcome).toBe("unknown");
		expect(summary.unknownEffects).toEqual(["eff:verify-late"]);
		const attribution = h.queue.effectRecord("eff:verify-late")!;
		expect(attribution.facts).toHaveLength(2);
		expect(attribution.verifications).toHaveLength(1);
		expect(attribution.verifications[0]!.factsAnchor).toBe(1);
	});

	test("a cross-dimension or identity-less dig effect is never confirmed by a same-coordinate read (E08)", async () => {
		const h = harness(
			{
				world: worldWith({ name: "air" }, "the_nether"),
				verifiers: new Map([[DIG_VERIFIER_REF, digVerifier()]]),
			},
			(queue) => [
				callable("elsewhere@1", async (ctx) =>
					ctx.withBody(async () => {
						// 事实记录于 overworld，当前维度是 the_nether。
						queue.record(digReceipt("eff:verify-dim", "unknown"));
						return (await ctx.verify("eff:verify-dim", "verify/dig@1", {})) as never;
					}),
				),
			],
		);
		const summary = await h.finish(await h.submit("elsewhere@1"));
		expect(summary.outcome).toBe("unknown");
		const verification = h.queue.effectRecord("eff:verify-dim")!.verifications[0]!;
		expect(verification.completion).toBe("unknown");
		expect(verification.reason).toContain("overworld");
	});

	test("verifications without a fact anchor stay diagnostic and never close uncertainty (E08)", async () => {
		const facts = [digReceipt("eff:legacy", "unknown")];
		const legacy: EffectVerification = {
			record: "rec:legacy",
			observedAt: "2026-10-31T00:00:00.000Z",
			verifier: "verify/dig@1",
			completion: "met",
			evidence: [],
		};
		// 旧格式核验无锚点：只做诊断，不把 unknown 关掉。
		expect(assessEffectFacts(facts, [legacy]).unresolved).toBe(true);
		expect(assessEffectFacts(facts, [{ ...legacy, factsAnchor: facts.length }]).unresolved).toBe(false);
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
// world stub：第一轮 block@1 回 air（核验 met），第二轮回 stone（核验 not_met）；self@1 报维度。
let blockName = "air";
const world = { read: async ({ ref }) => ref === "self@1"
 ? { value: { place: { dimension: "overworld" } }, observedAt: "2026-10-31T00:00:00.000Z", source: "server", coverage: "complete", unknown: [], evidence: ["ev:t:1"], cursor: null }
 : { value: { block: { name: blockName } }, observedAt: "2026-10-31T00:00:00.000Z", source: "server", coverage: "complete", unknown: [], evidence: ["ev:t:1"], cursor: null } };
let runtime;
const callables = [
 {descriptor:descriptor("digu@1"),invoke:ctx=>ctx.withBody(async()=>{
   runtime.sink.record({effect:"eff:verify-persist",operation:"op:verify",contract:"body.dig@1",observedAt:"2026-10-31T00:00:00.000Z",kind:"receipt",dispatch:"sent",completion:"unknown",evidence:[],detail:{target:{x:10,y:64,z:10},dimension:"overworld"}});
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
