import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness } from "./harness.js";
import type { SelfState } from "../contracts/body.js";
import type { SafetyInterventionRecord } from "../contracts/runtime.js";

interface Scenario {
	direct(action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	step(name: string, work: () => Promise<void>): Promise<void>;
	reopen(): Promise<void>;
	safeStop(): Promise<void>;
	resume(): Promise<void>;
	model?: (prompt: string) => Promise<void>;
}
export async function feedbackScenario(s: Scenario) {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	async function until<T>(read: () => Promise<T>, test: (v: T) => boolean, ms = 20000): Promise<T> {
		const end = Date.now() + ms;
		while (true) {
			const value = await read();
			if (test(value)) return value;
			if (Date.now() > end) throw new Error(`condition timed out: ${JSON.stringify(value)}`);
			await sleep(100);
		}
	}
	const self = async () => (await s.direct("observe", { selector: "self@1" })).value as unknown as SelfState;
	const command = async (text: string) => {
		await s.direct("chat", { text });
		await sleep(200);
	};
	const record = async (ref: string) =>
		(await s.direct("runs", { op: "record", ref, format: "inline" })).record as { value: Record<string, unknown> };
	const state = async () =>
		(await s.direct("runs", { op: "status" })).side as { safety: { active: string | null; last: string | null } };
	const run = async (code: string) => {
		const reply = await s.direct("run", { code });
		assert.ok(reply.kind === "accepted" || reply.kind === "result", JSON.stringify(reply));
		return (reply.snapshot as { run: string }).run;
	};
	const finish = async (id: string) => {
		await until(
			() => s.direct("runs", { op: "status", run: id }),
			(r) => r.phase === "finished",
		);
		return (await record(id)).value;
	};
	const prepare = async () => {
		await command("/gamemode creative UinaDev");
		await command("/effect clear UinaDev");
		await command("/tp UinaDev 16010.5 200 16000.5");
		await command("/fill 16006 199 15996 16024 199 16004 minecraft:stone");
		await command("/fill 15996 200 15996 16090 205 16004 minecraft:air");
		// Physically extinguish fire left by the previous isolated hazard before
		// returning to survival; healing alone does not remove burning.
		await command("/setblock 16010 200 16000 minecraft:water");
		await command("/setblock 16010 200 16000 minecraft:air");
		await command("/kill @e[type=!minecraft:player,distance=..24]");
		await command("/gamemode survival UinaDev");
		await command("/effect give UinaDev minecraft:instant_health 1 5 true");
		await until(self, (v) => v.onGround && v.health === 20);
		await until(state, (v) => v.safety.active === null);
	};
	if (!s.model) await prepare();
	if (s.model) {
		await s.step("real model handles preservation interruption and runs a fresh finite movement loop", async () => {
			const initial = (await self()).place.position;
			let calibrationError: unknown;
			const calibration = s.model!(
				`只使用minecraft工具，在当前专用平台完成一次反馈与中断恢复校准。实际用run.code提交你编写的一个普通JS程序：先用mc.withBody和body.loop原地采样等待Runtime中断（同步step返回{keys:{}}，最多200帧；第一次收到frame时调用mc.progress({summary:'awaiting_interrupt'})作为测试握手，测试器看到这个真实进度后触发一次受伤自保）。必须在withBody外层catch捕获INTERRUPTED。随后mc.read('self@1')重读现场，重新mc.withBody取得新身体，用新的body.loop向x正方向走2格后返回{done:true}；第二个loop最多100帧。返回{caughtCode, start, end, frames}，caughtCode必须来自真实异常。body.loop的step必须同步。accepted后查询或等待Run，读取固定记录核实返回值，然后结束。不要goto、服务器指令、其他工具、探索或重复试验。`,
			).catch((error) => {
				calibrationError = error;
				throw error;
			});
			void calibration.catch(() => {});
			await until(
				async () => {
					if (calibrationError) throw calibrationError;
					return (await s.direct("runs", { op: "list", activeOnly: true })).items as {
						run: string;
						control: string;
						progress?: { summary?: string };
					}[];
				},
				(items) => items.some((item) => item.control === "active" && item.progress?.summary === "awaiting_interrupt"),
				60000,
			);
			await command("/damage UinaDev 15 minecraft:generic");
			await calibration;
			const end = (await self()).place.position;
			assert.ok(end.x - initial.x >= 1.5 && end.x - initial.x <= 5, JSON.stringify({ initial, end }));
			const runs = await s.direct("runs", { op: "list", activeOnly: false });
			let found = false;
			for (const item of runs.items as { run: string; outcome: string }[]) {
				const calls = await s.direct("runs", { op: "calls", run: item.run });
				for (const c of calls.items as { call: string; implementation: string }[])
					if (c.implementation === "program") {
						const call = (await record(c.call)).value;
						const source = await readFile((call.program as { snapshot: string }).snapshot, "utf8");
						found ||=
							item.outcome === "succeeded" &&
							/\.loop\s*\(/.test(source) &&
							(call.value as { caughtCode?: string })?.caughtCode === "INTERRUPTED";
					}
			}
			assert.ok(found, "model did not execute a successful loop program");
		});
		return;
	}
	await s.step("real QuickJS loop and sample-to-apply latency from actual physics receipts", async () => {
		const id = await run(
			`async function main(mc){return mc.withBody(async body=>{let n=0,after=null;const stream=await body.feedback({inv:{ref:'inventory@1'}});const samples=[];try{while(n++<12){const f=await stream.next(after);after=f.sequence;const r=await stream.apply(f,{keys:{forward:true},look:{yaw:-Math.PI/2,pitch:0}});if(!f.sensors.inv)throw new Error('sensor missing');samples.push({sample:f.step.sequence,applied:r.appliedStep.sequence});}}finally{await stream.close();}return samples;});}`,
		);
		const result = await finish(id);
		assert.equal(result.outcome, "succeeded", JSON.stringify(result));
		const values = result.value as { sample: number; applied: number }[];
		assert.equal(values.length, 12);
		assert.ok(values.every((r) => r.applied > r.sample));
		const calls = await s.direct("runs", { op: "calls", run: id });
		const root = (await record((calls.items as { call: string }[])[0]!.call)).value;
		const latencies: number[] = [];
		for (const ref of root.effects as string[]) {
			const effect = (await record(ref)).value;
			for (const fact of effect.facts as { detail?: { latencyMs?: number } }[])
				if (fact.detail?.latencyMs !== undefined) latencies.push(fact.detail.latencyMs);
		}
		assert.equal(latencies.length, 12);
		latencies.sort((a, b) => a - b);
		console.log(
			`[mc-feedback] sample→guest→apply p50=${latencies[6]!.toFixed(1)}ms p95=${latencies[11]!.toFixed(1)}ms`,
		);
		assert.ok(latencies.every((v) => v < 250));
	});
	await s.step(
		"feedback view conflicts reject before writing while movement-only feedback permits lookAt",
		async () => {
			const result = await finish(
				await run(
					`async function main(mc){return mc.withBody(async b=>{const st=await b.feedback({});try{let f=await st.next();const p=f.self.value.place.position;await st.apply(f,{keys:{},look:{yaw:0,pitch:0}});let code;try{await b.lookAt({x:p.x+2,y:p.y+1.62,z:p.z});code='unexpected';}catch(e){code=e.code;}f=await st.next(f.sequence);await st.apply(f,{keys:{}});const receipt=await b.lookAt({x:p.x+2,y:p.y+1.62,z:p.z});return {code,completion:receipt.completion};}finally{await st.close();}});}`,
				),
			);
			assert.equal(result.outcome, "succeeded", JSON.stringify(result));
			assert.deepEqual(result.value, { code: "CONTROL_CONFLICT", completion: "met" });
		},
	);
	await s.step("late guest input is rejected and leaves no continuous motion", async () => {
		const id = await run(
			`async function main(mc){return mc.withBody(async b=>{const st=await b.feedback({});try{const f=await st.next();await mc.sleep(350);try{await st.apply(f,{keys:{forward:true}});return 'unexpected';}catch(e){return e.code;}}finally{await st.close();}});}`,
		);
		const result = await finish(id);
		assert.equal(result.value, "FRAME_EXPIRED", JSON.stringify(result));
	});
	await s.step("loop refuses asynchronous step", async () => {
		const result = await finish(
			await run(
				`async function main(mc){try{await mc.withBody(b=>b.loop(async f=>({keys:{}})));}catch(e){return e.code;}}`,
			),
		);
		assert.equal(result.value, "STEP_ASYNC");
	});
	await prepare();
	let savedSafety = "";
	async function hazard(kind: string, setup: () => Promise<void>, during?: string) {
		const previous = (await state()).safety.last;
		const id = during ? await run(during) : null;
		if (id)
			await until(
				() => s.direct("runs", { op: "status", run: id }),
				(r) => r.control === "active",
			);
		await setup();
		let sampledAt = 0;
		const started = await until(
			state,
			(v) => v.safety.active !== null || (v.safety.last !== previous && v.safety.last !== null),
		);
		const ref = started.safety.active ?? started.safety.last!;
		const value = await until(
			async () => {
				let value: SafetyInterventionRecord | null = null;
				try {
					value = (await record(ref)).value as unknown as SafetyInterventionRecord;
				} catch (error) {
					if (!String(error).includes("NOT_FOUND")) throw error;
				}
				if (value?.finishedAt === null && Date.now() - sampledAt > 500) {
					sampledAt = Date.now();
					const v = await self();
					console.log(
						`[mc-feedback] ${kind} position=${JSON.stringify(v.place.position)} health=${v.health} oxygen=${v.oxygen}`,
					);
				}
				return value;
			},
			(v) => v !== null && v.finishedAt !== null,
			25000,
		);
		assert.ok(value);
		if (kind === "lava" && value.ended === "safe")
			await command("/fill 15996 200 15996 16090 205 16004 minecraft:air replace minecraft:lava");
		console.log(`[mc-feedback] ${kind} ended=${value.ended} outcome=${value.outcome} effects=${value.effects.length}`);
		assert.equal(value.trigger.kind, kind);
		assert.equal(value.ended, "safe");
		assert.equal(value.outcome, "succeeded");
		assert.ok(value.effects.length > 0 || kind === "low_health_damage");
		for (const effect of value.effects)
			assert.equal(((await record(effect)).value.owner as { kind: string }).kind, "safety");
		if (id) {
			const result = await finish(id);
			assert.equal(result.value, "INTERRUPTED", JSON.stringify(result));
		}
		savedSafety = ref;
	}
	await s.step("lava interrupts held body and escapes using safety-owned effects", () =>
		hazard(
			"lava",
			async () => {
				const p = (await self()).place.position;
				await command(`/setblock ${Math.floor(p.x)} 200 ${Math.floor(p.z)} minecraft:lava`);
			},
			`async function main(mc){try{await mc.withBody(()=>mc.sleep(60000));}catch(e){return e.code;}}`,
		),
	);
	await prepare();
	await s.step("drowning swims to observed air and oxygen recovers", () =>
		hazard("drowning", async () => {
			await command("/fill 16008 200 15999 16012 202 16001 minecraft:water");
			await command("/tp UinaDev 16010.5 200 16000.5");
		}),
	);
	await prepare();
	await s.step("safety interrupts actual mining and the old dig cannot complete later", async () => {
		await command("/give UinaDev minecraft:diamond_pickaxe");
		await command("/setblock 16011 200 16000 minecraft:obsidian");
		await hazard(
			"lava",
			async () => {
				await command("/execute at UinaDev run setblock ~ ~ ~ minecraft:lava");
			},
			`async function main(mc){try{await mc.call('mine@1',{at:{x:16011,y:200,z:16000},collect:false});}catch(e){return e.code;}}`,
		);
		await sleep(500);
		const block = await s.direct("observe", { selector: "block@1", input: { at: { x: 16011, y: 200, z: 16000 } } });
		assert.equal((block.value as { block: { name: string } }).block.name, "obsidian");
	});
	await prepare();
	await s.step("safety retires the exclusive navigation writer before taking body control", async () => {
		await hazard(
			"low_health_damage",
			async () => {
				// Keep the route geometry unchanged: this isolates Runtime preemption
				// from the pathfinder independently stopping on a newly placed fluid.
				await command("/damage UinaDev 15 minecraft:generic");
			},
			`async function main(mc){try{await mc.call('goto@1',{at:{x:16070,y:200,z:16000},tolerance:1,placeToReach:false});}catch(e){return e.code;}}`,
		);
		assert.ok((await self()).place.position.x < 16040, "old navigation resumed after intervention");
	});
	await prepare();
	await s.step("new low-health damage triggers once and safe requires two seconds without damage", () =>
		hazard("low_health_damage", async () => {
			await command("/summon minecraft:zombie 16014.5 200 16000.5 {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b}");
			await command("/damage UinaDev 15 minecraft:generic");
		}),
	);
	await s.step("safety records survive full managed reopen without action replay", async () => {
		const before = await record(savedSafety);
		await s.reopen();
		assert.deepEqual(await record(savedSafety), before);
		assert.equal((await state()).safety.last, savedSafety);
		assert.equal((await state()).safety.active, null);
	});
	await prepare();
	await s.step("global emergency gates preservation and explicit resume releases only emergency", async () => {
		await command("/setblock 16010 200 16000 minecraft:lava");
		await s.safeStop();
		const before = (await state()).safety.last;
		await sleep(400);
		assert.equal((await state()).safety.active, null);
		assert.equal((await state()).safety.last, before);
		await s.resume();
		await command("/setblock 16010 200 16000 minecraft:air");
		await until(self, (v) => v.health !== null && v.health > 0);
	});
	await prepare();
}

/** Prepare the environment before creating a model Host, so admin completion
 * reports cannot wake and charge the calibration model. Same real execution side. */
export async function prepareFeedbackModelScene() {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-feedback-model-setup-"));
	const h = await openHarness("feedback-model-setup", { dataRoot: root });
	try {
		let n = 0;
		const command = async (text: string) => {
			const accepted = await h.runtime.submit(
				{ worldOwner: h.worldOwner, activation: h.activation },
				{
					requestId: `setup:${++n}`,
					schedule: { kind: "enqueue" },
					entry: { kind: "call", selector: "chat@1", input: { text } },
				},
			);
			assert.equal(accepted.kind, "accepted");
			if (accepted.kind !== "accepted") throw new Error("setup not accepted");
			const result = await h.runtime.wait(accepted.snapshot.run, { timeoutMs: 5000 });
			if (result.snapshot.phase !== "finished") throw new Error("setup command did not finish");
			assert.equal(result.snapshot.outcome, "succeeded");
			await new Promise((r) => setTimeout(r, 200));
		};
		await command("/gamemode creative UinaDev");
		await command("/tp UinaDev 16010.5 205 16000.5");
		const deadline = Date.now() + 10000;
		while (
			(await h.world.read<{ block: unknown }>({ ref: "block@1", input: { at: { x: 16010, y: 199, z: 16000 } } })).value
				.block === null
		) {
			if (Date.now() > deadline) throw new Error("setup chunk not loaded");
			await new Promise((r) => setTimeout(r, 100));
		}
		await command("/fill 15996 199 15996 16090 199 16004 minecraft:stone");
		await command("/fill 15996 200 15996 16090 205 16004 minecraft:air");
		await command("/tp UinaDev 16010.5 200 16000.5");
		await command("/kill @e[type=!minecraft:player,distance=..24]");
		await command("/effect clear UinaDev");
		await command("/setblock 16010 200 16000 minecraft:water");
		await command("/setblock 16010 200 16000 minecraft:air");
		await command("/gamemode survival UinaDev");
		await command("/effect give UinaDev minecraft:instant_health 1 5 true");
	} finally {
		await h.close();
	}
}
