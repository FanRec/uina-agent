/**
 * Minecraft World 开发入口：I1 原生真实闭环（专用开发入口，不发布 WorldDef）。
 *
 * 唯一定义来源：docs/proposals/mc/development-plan.md §9（K1 子集随基础模块
 * 接通 + dev 入口）、development-guide.md §5（真服场景验证）。
 * 装配正式模块：Driver（ClientHost/FactsSource/PlayerPort/GotoDirector）→
 * World（当前读 + 历史存储）→ Runtime（受理/记录/结算），端口互注入解循环
 * （Runtime 消费 Driver/World 端口，Driver 消费 runtime.sink——open 前用
 * 占位 sink，open 后接线；open 前无任何副作用发生）。
 * 场景：connect → read self@1 → chat@1 run → goto@1 run → 远距 goto 中途
 * stop（证明停止后旧写源不可动作）→ 断开。服务端启动/复位在 dev-env/。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlayerPortImpl } from "../driver/body/player-port.js";
import { ClientHost } from "../driver/client-host.js";
import { DriverControlArbiter } from "../driver/control-arbiter.js";
import { FactsSource } from "../driver/facts/index.js";
import { GotoDirector } from "../driver/goto.js";
import { MinecraftRuntime } from "../runtime/index.js";
import type { DriverExecutionSink, EffectRecord, RunSnapshot, RunSummary } from "../contracts/runtime.js";
import type { SelfState } from "../contracts/body.js";
import type { JsonValue, Ref, Vec3 } from "../contracts/values.js";
import { createActions } from "../capabilities/actions.js";
import { buildQueries } from "../capabilities/queries.js";
import { MinecraftWorld } from "../world/index.js";

const SERVER = {
	host: "127.0.0.1",
	port: 25565,
	username: process.env.MC_DEV_USER ?? "UinaDev",
	version: "1.21.11",
};
const STORAGE_ID = "minecraft-runtime@1";
/** 远距 goto 提交后到 stop 前的行走窗口（毫秒）。 */
const STOP_AFTER_MS = 1500;

function log(message: string): void {
	console.log(`[mc-i1] ${message}`);
}

function fail(message: string): never {
	throw new Error(`I1 FAIL: ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function dist(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function fmtPos(p: Vec3): string {
	return `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`;
}

/** 未知（null）不得被读成 0：日志里显式区分。 */
function fmtMaybe(value: number | null): string {
	return value == null ? "unknown" : String(value);
}

type BotEntityView = { entity?: { position?: { x: number; y: number; z: number }; onGround?: boolean } | null };

/**
 * 出生落定等待（验证侧准备）：世界持久化下服务器会把玩家放回上次位置，
 * 可能有坠落/惯性；位置静止且落地后再计算目标，避免寻路起点不稳。
 */
async function waitForStill(bot: BotEntityView): Promise<void> {
	const deadline = Date.now() + 8000;
	let stable = 0;
	let last: Vec3 | null = null;
	while (Date.now() < deadline) {
		const pos = bot.entity?.position ?? null;
		if (pos != null && bot.entity?.onGround === true && last != null && dist(pos, last) < 0.01) {
			stable++;
			if (stable >= 3) return;
		} else {
			stable = 0;
		}
		last = pos;
		await sleep(150);
	}
	log("warn: spawn stillness wait timed out; proceeding from last sampled position");
}

/**
 * 每前缀独立单调发号（Driver 级 body:/op:/eff: 空间）。
 * 必须带本次启动命名空间：effect/op 引用会随 EffectRecord 落 world-history.db，
 * 每进程从 1 重来会与已提交记录的主键跨启动冲突（world.md §5.3）。
 */
function makeIssuer(namespace: string): (prefix: string) => Ref {
	const counters = new Map<string, number>();
	return (prefix: string): Ref => {
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		return `${prefix}:${namespace}:${next}`;
	};
}

async function main(): Promise<void> {
	const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
	const worldDataDir = join(repoRoot, ".uina", "world-data", "minecraft");
	mkdirSync(worldDataDir, { recursive: true });

	// per-boot 命名空间：禁冒号；绑定身份每次启动显式生成（不猜旧身份）
	const ns = `i1-${Date.now().toString(36)}`;
	const worldRef = `wld:${ns}`;
	const binding = `bind:${ns}`;
	const worldRevision = `wldrev:${ns}`;
	const worldOwner = `owner:${ns}`;
	const activation = `act:${ns}`;

	// ---- Driver ----
	const host = new ClientHost();
	const arbiter = new DriverControlArbiter();
	const mint = makeIssuer(ns);
	const facts = new FactsSource(host, { binding, world: worldRef, worldRevision, streamNamespace: ns });
	// open 前占位：契约行为 = 返回 null 即锁存 recorder fault；open 前无副作用发生
	const sinkRef: { current: DriverExecutionSink | null } = { current: null };
	const sink: DriverExecutionSink = { record: (fact) => sinkRef.current?.record(fact) ?? null };
	const playerPort = new PlayerPortImpl({
		host,
		bot: () => host.bot,
		sink,
		sampleSelf: () => facts.sampleSelf(),
		arbiter,
		mintBody: () => mint("body"),
		mintOp: () => mint("op"),
		mintEff: () => mint("eff"),
	});
	const gotoDirector = new GotoDirector({
		host,
		bot: () => host.bot,
		sink,
		arbiter,
		mintOp: () => mint("op"),
		mintEff: () => mint("eff"),
	});

	// ---- World ----
	const queries = buildQueries();
	const mcWorld = new MinecraftWorld({
		facts,
		resolvers: queries.resolvers,
		dbPath: join(worldDataDir, "world-history.db"),
		binding: { binding, world: worldRef, worldRevision },
		namespace: ns,
	});

	// ---- Runtime 接缝引用（open 后接线） ----
	let runtime: MinecraftRuntime | null = null;
	const actions = createActions({ runtime: () => runtime ?? fail("runtime is not open yet"), gotoDirector });

	try {
		// 1. 连接真服
		log(`connecting ${SERVER.host}:${SERVER.port} as ${SERVER.username} (${SERVER.version})`);
		await host.connect(SERVER);
		if (host.state !== "ready" || host.identity == null) fail(`client not ready: ${host.state}`);
		const bot = host.bot;
		if (bot == null) fail("client host lost the bot after ready");
		log(
			`ready: connection=${host.identity.connection} incarnation=${host.identity.incarnation} ` +
				`dimension=${host.dimension ?? "unknown"} position=${host.position ? fmtPos(host.position) : "unknown"}`,
		);
		await waitForStill(bot as unknown as BotEntityView);

		// 2. Runtime open（两段启动，WAL/FULL 实值核对 + 恢复结算）
		// 协议号不在 Bot 类型上；从注册表版本元数据读取，读不到则如实缺省 environment
		const protocol = (bot as unknown as { registry?: { version?: { version?: number } } }).registry?.version?.version;
		const opened = await MinecraftRuntime.open({
			dbPath: join(worldDataDir, "runtime.db"),
			storageId: STORAGE_ID,
			namespace: ns,
			worldOwner,
			world: mcWorld,
			playerPort,
			callables: actions.callables,
			...(typeof protocol === "number" ? { environment: { serverVersion: bot.version, protocol } } : {}),
		});
		runtime = opened.runtime;
		sinkRef.current = runtime.sink;
		const rt: MinecraftRuntime = runtime;
		log(
			`runtime open: journal=${opened.start.journalMode} sync=${opened.start.synchronousMode} ` +
				`recovered=${JSON.stringify(opened.start.recoveredCounts)}`,
		);
		log(`history: ${await mcWorld.historyReady}`);
		log(`world availability: ${JSON.stringify(mcWorld.availability())}`);

		const origin = { worldOwner, activation };
		const submitRun = (requestId: Ref, selector: string, input: JsonValue): Ref => {
			const acceptance = rt.submit(origin, {
				requestId,
				entry: { kind: "call", selector, input },
				schedule: { kind: "enqueue" },
			});
			if (acceptance.kind !== "accepted") fail(`submit ${requestId} not accepted: ${JSON.stringify(acceptance)}`);
			return acceptance.snapshot.run;
		};
		const runGoto = async (
			requestId: Ref,
			at: Vec3,
			opts: { tolerance: number; timeoutMs: number; digThrough?: boolean },
		): Promise<Extract<RunSummary, { phase: "finished" }>> => {
			const run = submitRun(requestId, "goto@1", {
				at: { x: at.x, y: at.y, z: at.z },
				tolerance: opts.tolerance,
				...(opts.digThrough === true ? { digThrough: true } : {}),
				timeoutMs: opts.timeoutMs,
			});
			const reply = await rt.wait(run, { timeoutMs: opts.timeoutMs + 15000 });
			if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
				fail(`goto run not finished: ${JSON.stringify(reply)}`);
			}
			return reply.snapshot;
		};

		// 3. read self@1
		const self1 = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
		if (self1.value == null) fail(`self@1 returned null (unknown: ${JSON.stringify(self1.unknown)})`);
		const startPos = self1.value.place.position;
		log(
			`self@1: pos=${fmtPos(startPos)} health=${fmtMaybe(self1.value.health)} food=${fmtMaybe(self1.value.food)} ` +
				`coverage=${self1.coverage} cursor=${self1.cursor.stream}#${self1.cursor.sequence}` +
				(self1.unknown.length === 0 ? "" : ` unknown=${self1.unknown.join("; ")}`),
		);

		// 4. chat@1 run
		const chatRun = submitRun(`req:${ns}:chat`, "chat@1", { text: "Uina I1: capability loop online" });
		const chatReply = await rt.wait(chatRun, { timeoutMs: 20000 });
		if (chatReply.kind !== "result" || chatReply.snapshot.phase !== "finished") {
			fail(`chat run not finished: ${JSON.stringify(chatReply)}`);
		}
		if (chatReply.snapshot.outcome !== "succeeded") {
			fail(`chat outcome ${chatReply.snapshot.outcome}: ${JSON.stringify(chatReply.snapshot.error ?? null)}`);
		}
		const chatRecord = rt.readRecord(chatReply.snapshot.record);
		const chatSnapshot = chatRecord.value as unknown as RunSnapshot;
		if (chatSnapshot.phase !== "finished" || chatSnapshot.value == null) fail("chat run record has no value");
		const chatEffectRef = (chatSnapshot.value as { effect: Ref }).effect;
		const chatEffect = rt.readRecord(chatEffectRef);
		if (chatEffect.kind !== "effect") fail(`chat effect record kind ${chatEffect.kind}`);
		const chatEffectValue = chatEffect.value as unknown as EffectRecord;
		if (chatEffectValue.latest.dispatch !== "sent" || chatEffectValue.latest.completion !== "met") {
			fail(`chat effect latest ${JSON.stringify(chatEffectValue.latest)}`);
		}
		log(
			`chat run succeeded: effect=${chatEffectRef} dispatch=sent completion=met ` +
				`facts=${chatEffectValue.facts.length}`,
		);

		// 5. goto@1 run（近距，验证到达）；地形漂移容忍：UNREACHABLE 时以 digThrough 重试一次
		let target: Vec3 = {
			x: Math.floor(startPos.x) + 6,
			y: Math.floor(startPos.y),
			z: Math.floor(startPos.z),
		};
		let gotoSnap = await runGoto(`req:${ns}:goto`, target, { tolerance: 2, timeoutMs: 30000 });
		if (gotoSnap.outcome !== "succeeded") {
			const code = gotoSnap.error?.code;
			if (code !== "UNREACHABLE") {
				fail(`goto outcome ${gotoSnap.outcome}: ${JSON.stringify(gotoSnap.error ?? null)}`);
			}
			log("near goto unreachable (terrain drift); retrying once with digThrough=true");
			const selfRetry = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
			if (selfRetry.value == null) fail("self@1 returned null before goto retry");
			target = {
				x: Math.floor(selfRetry.value.place.position.x) + 6,
				y: Math.floor(selfRetry.value.place.position.y),
				z: Math.floor(selfRetry.value.place.position.z),
			};
			gotoSnap = await runGoto(`req:${ns}:goto-retry`, target, {
				tolerance: 2,
				timeoutMs: 30000,
				digThrough: true,
			});
		}
		if (gotoSnap.outcome !== "succeeded") {
			fail(`goto outcome ${gotoSnap.outcome}: ${JSON.stringify(gotoSnap.error ?? null)}`);
		}
		const self2 = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
		if (self2.value == null) fail("self@1 returned null after goto");
		const arrivedAt = self2.value.place.position;
		const remain = dist(arrivedAt, target);
		if (remain > 3.5) fail(`goto arrived too far from target: ${remain.toFixed(2)} blocks`);
		log(`goto run succeeded: at=${fmtPos(arrivedAt)} target=${fmtPos(target)} distance=${remain.toFixed(2)}`);

		// 6. stop 证明：远距 goto 中途停止 → 旧写源封印
		const farTarget: Vec3 = { x: Math.floor(arrivedAt.x) + 32, y: Math.floor(arrivedAt.y), z: Math.floor(arrivedAt.z) };
		const farRun = submitRun(`req:${ns}:goto-far`, "goto@1", {
			at: { x: farTarget.x, y: farTarget.y, z: farTarget.z },
			tolerance: 3,
			digThrough: true,
			timeoutMs: 60000,
		});
		await sleep(STOP_AFTER_MS);
		const stopReceipt = await rt.stop({ requestId: `req:${ns}:stop`, target: { run: farRun } });
		let stopProof: string;
		if (stopReceipt.snapshot?.phase === "finished" && stopReceipt.snapshot.outcome !== "cancelled") {
			// 极少数：goto 在 stop 前已终结（NoPath 立即失败等）。stop 不改历史是合同行为。
			stopProof = `degraded (far run already finished as ${stopReceipt.snapshot.outcome} before stop)`;
			log(`stop receipt: intent=${stopReceipt.intent} control=${stopReceipt.control} — ${stopProof}`);
		} else {
			if (stopReceipt.intent !== "durable") fail(`stop intent ${stopReceipt.intent}, expected durable`);
			const farReply = await rt.wait(farRun, { timeoutMs: 30000 });
			if (farReply.kind !== "result" || farReply.snapshot.phase !== "finished") {
				fail(`far run not finished after stop: ${JSON.stringify(farReply)}`);
			}
			if (farReply.snapshot.outcome !== "cancelled")
				fail(`far run outcome ${farReply.snapshot.outcome}, expected cancelled`);
			stopProof = "durable stop intent cancelled the run";
			log(`stop receipt: intent=${stopReceipt.intent} control=${stopReceipt.control}; run outcome=cancelled`);
		}
		// 结算静止证明：/goto 的 quiescence 期限（2s）后两次采样位置一致
		await sleep(2500);
		const still1 = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
		await sleep(1200);
		const still2 = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
		if (still1.value == null || still2.value == null) fail("self@1 returned null during stillness check");
		const drift = dist(still1.value.place.position, still2.value.place.position);
		if (drift > 0.05) fail(`client still moving after stop: drift ${drift.toFixed(4)}`);
		log(`post-stop stillness verified: drift=${drift.toFixed(4)} (${stopProof})`);

		// 7. 断开
		await rt.close();
		await mcWorld.close();
		await host.close();
		log("disconnected: runtime/history/client closed");
		log("I1 PASS");
	} catch (err) {
		console.error("[mc-i1] I1 ERROR:", err);
		try {
			await runtime?.close();
		} catch {
			// 收尾失败不影响错误上报
		}
		try {
			await mcWorld.close();
		} catch {
			// 同上
		}
		try {
			await host.close();
		} catch {
			// 同上
		}
		process.exitCode = 1;
	}
}

await main();
