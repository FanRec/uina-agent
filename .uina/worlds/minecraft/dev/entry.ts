/**
 * Minecraft World 开发入口：I1 原生真实闭环（专用开发入口，不发布 WorldDef）。
 *
 * 唯一定义来源：docs/proposals/mc/development-plan.md §9、development-guide.md §5。
 * 装配在 dev/harness.ts（与 K1 场景共用），本文件只写 I1 步骤与断言：
 * read self → chat → 近距 goto → 远距 goto 中途 stop（证明停止后旧写源不可动作）
 * → 静止证明 → 断开。服务端启动/复位在 dev-env/。
 */

import type { SelfState } from "../contracts/body.js";
import type { RunSnapshot, RunSummary } from "../contracts/runtime.js";
import type { JsonValue, Ref, Vec3 } from "../contracts/values.js";
import type { WorldSnapshot } from "../capabilities/shared/views.js";
import { closeHarness, dist, fmtPos, openHarness, sleep } from "./harness.js";

/** 远距 goto 提交后到 stop 前的行走窗口（毫秒）。 */
const STOP_AFTER_MS = 1500;

function log(message: string): void {
	console.log(`[mc-i1] ${message}`);
}

function fail(message: string): never {
	throw new Error(`I1 FAIL: ${message}`);
}

/** 未知（null）不得被读成 0：日志里显式区分。 */
function fmtMaybe(value: number | null): string {
	return value == null ? "unknown" : String(value);
}

async function main(): Promise<void> {
	const h = await openHarness("i1");
	const { world: mcWorld, runtime: rt, ns, worldOwner, activation } = h;
	// openHarness 已完成连接与 runtime open（两段启动、恢复结算）
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
	const runValue = (snapshot: RunSummary): JsonValue | undefined => {
		const record = rt.readRecord(snapshot.record).value as unknown as { value?: JsonValue };
		return record.value;
	};
	/** 场景准备：找一个可站立的近邻目标（脚下实心、双脚空间为空），避免选到悬崖/水面。 */
	const findStandTarget = async (start: Vec3): Promise<Vec3> => {
		const solid = async (p: Vec3): Promise<boolean> => {
			const observation = await mcWorld.read<{ block: { name: string } | null }>({
				ref: "block@1",
				input: { at: { x: p.x, y: p.y, z: p.z } },
			});
			const name = observation.value?.block?.name ?? null;
			return name != null && name !== "air" && name !== "water" && name !== "lava";
		};
		const clear = async (p: Vec3): Promise<boolean> => {
			const observation = await mcWorld.read<{ block: { name: string } | null }>({
				ref: "block@1",
				input: { at: { x: p.x, y: p.y, z: p.z } },
			});
			const name = observation.value?.block?.name ?? null;
			return name == null || name === "air";
		};
		const bx = Math.floor(start.x);
		const by = Math.floor(start.y);
		const bz = Math.floor(start.z);
		for (const [dx, dz] of [
			[4, 0],
			[0, 4],
			[-4, 0],
			[0, -4],
			[3, 0],
			[0, 3],
			[-3, 0],
			[0, -3],
		]) {
			const candidate = { x: bx + dx, y: by, z: bz + dz };
			if (!(await clear(candidate))) continue;
			if (!(await clear({ x: candidate.x, y: candidate.y + 1, z: candidate.z }))) continue;
			if (!(await solid({ x: candidate.x, y: candidate.y - 1, z: candidate.z }))) continue;
			return candidate;
		}
		return { x: bx + 6, y: by, z: bz };
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
			maxTimeMs: opts.timeoutMs,
		});
		const reply = await rt.wait(run, { timeoutMs: opts.timeoutMs + 15000 });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished") {
			fail(`goto run not finished: ${JSON.stringify(reply)}`);
		}
		return reply.snapshot;
	};

	try {
		// 1. read self@1
		const self1 = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
		if (self1.value == null) fail(`self@1 returned null (unknown: ${JSON.stringify(self1.unknown)})`);
		const startPos = self1.value.place.position;
		log(
			`self@1: pos=${fmtPos(startPos)} health=${fmtMaybe(self1.value.health)} food=${fmtMaybe(self1.value.food)} ` +
				`coverage=${self1.coverage} cursor=${self1.cursor == null ? "none" : `${self1.cursor.stream}#${self1.cursor.sequence}`}` +
				(self1.unknown.length === 0 ? "" : ` unknown=${self1.unknown.join("; ")}`),
		);

		// 1b. K1 只读面：环境/知识/实体/按名搜方块（无副作用，可反复跑）
		const world1 = await mcWorld.read<WorldSnapshot>({ ref: "world@1", input: {} });
		log(
			`world@1: dimension=${world1.value?.dimension ?? "?"} time=${world1.value?.timeOfDay ?? "?"} ` +
				`weather=${world1.value?.weather ?? "?"} biome=${world1.value?.biome ?? "?"}`,
		);
		const item1 = await mcWorld.read<{ name: string; food: unknown; sourcesComplete: boolean }>({
			ref: "item@1",
			input: { name: "apple" },
		});
		log(
			`item@1 apple: food=${JSON.stringify(item1.value?.food ?? null)} sourcesComplete=${String(item1.value?.sourcesComplete)}`,
		);
		const entities1 = await mcWorld.read<{ entities: unknown[] }>({
			ref: "entities@1",
			input: { kind: "all", radius: 16 },
		});
		log(`entities@1: count=${entities1.value?.entities.length ?? 0}`);
		const blocks1 = await mcWorld.read<{ blocks: unknown[]; count: number; truncated: boolean }>({
			ref: "blocks@1",
			input: { name: "stone", radius: 8, limit: 3 },
		});
		log(`blocks@1 stone: count=${blocks1.value?.count ?? 0} truncated=${String(blocks1.value?.truncated)}`);

		// 2. chat@1 run
		const chatRun = submitRun(`req:${ns}:chat`, "chat@1", { text: "Uina I1: capability loop online" });
		const chatReply = await rt.wait(chatRun, { timeoutMs: 20000 });
		if (chatReply.kind !== "result" || chatReply.snapshot.phase !== "finished") {
			fail(`chat run not finished: ${JSON.stringify(chatReply)}`);
		}
		if (chatReply.snapshot.outcome !== "succeeded") {
			fail(`chat outcome ${chatReply.snapshot.outcome}: ${JSON.stringify(chatReply.snapshot.error ?? null)}`);
		}
		// chat@1 的值合同是 {sent, kind}（capabilities §4 chat）；效果记录另经 run 记录读取。
		const chatRecord = rt.readRecord(chatReply.snapshot.record);
		const chatSnapshot = chatRecord.value as unknown as RunSnapshot;
		if (chatSnapshot.phase !== "finished" || chatSnapshot.value == null) fail("chat run record has no value");
		const chatValue = chatSnapshot.value as unknown as { sent?: boolean; kind?: string };
		if (chatValue.sent !== true || chatValue.kind !== "message") {
			fail(`chat value ${JSON.stringify(chatValue)}`);
		}
		log(`chat run succeeded: value=${JSON.stringify(chatValue)} record=${chatReply.snapshot.record}`);

		// 3. goto@1 run（近距，验证到达）；地形漂移容忍：UNREACHABLE 时以 digThrough 重试一次
		let target: Vec3 = await findStandTarget(startPos);
		let gotoSnap = await runGoto(`req:${ns}:goto`, target, { tolerance: 2, timeoutMs: 30000 });
		if (gotoSnap.outcome !== "succeeded") {
			const code = gotoSnap.error?.code;
			if (code !== "UNREACHABLE") {
				fail(`goto outcome ${gotoSnap.outcome}: ${JSON.stringify(gotoSnap.error ?? null)}`);
			}
			log("near goto unreachable (terrain drift); retrying once with digThrough=true");
			const selfRetry = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
			if (selfRetry.value == null) fail("self@1 returned null before goto retry");
			target = await findStandTarget(selfRetry.value.place.position);
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
		// 完成口径：GoalNear 邻域在成功时成立（站姿/停稳随运动能力包补齐）。
		// 完成后因惯性/下坡继续滑动是物理事实，记录但不改写成功判定。
		const reported = (runValue(gotoSnap) as { at?: Vec3 } | undefined)?.at ?? null;
		if (reported == null) fail("goto run value has no arrival position");
		const reportedRemain = dist(reported, target);
		if (reportedRemain > 2.75) {
			fail(
				`goto reported arrival ${reportedRemain.toFixed(2)} blocks from target ` +
					`(start=${fmtPos(startPos)} target=${fmtPos(target)} value=${JSON.stringify(runValue(gotoSnap))})`,
			);
		}
		log(
			`goto run succeeded: reportedAt=${fmtPos(reported)} target=${fmtPos(target)} ` +
				`reportedDistance=${reportedRemain.toFixed(2)} sampledAt=${fmtPos(arrivedAt)}`,
		);
		await sleep(1200);
		const settled = await mcWorld.read<SelfState>({ ref: "self@1", input: {} });
		if (settled.value == null) fail("self@1 returned null after goto settle");
		const settledRemain = dist(settled.value.place.position, target);
		log(`goto post-settle: at=${fmtPos(settled.value.place.position)} distance=${settledRemain.toFixed(2)}`);
		const arrivedAtSettled = settled.value.place.position;

		// 4. stop 证明：远距 goto 中途停止 → 旧写源封印
		const farTarget: Vec3 = {
			x: Math.floor(arrivedAtSettled.x) + 32,
			y: Math.floor(arrivedAtSettled.y),
			z: Math.floor(arrivedAtSettled.z),
		};
		const farRun = submitRun(`req:${ns}:goto-far`, "goto@1", {
			at: { x: farTarget.x, y: farTarget.y, z: farTarget.z },
			tolerance: 3,
			digThrough: true,
			maxTimeMs: 60000,
		});
		await sleep(STOP_AFTER_MS);
		const stopReceipt = await rt.stop({ requestId: `req:${ns}:stop`, target: { run: farRun } });
		let stopProof: string;
		if (stopReceipt.snapshot?.phase === "finished" && stopReceipt.snapshot.outcome !== "cancelled") {
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

		await closeHarness(h);
		log("disconnected: runtime/history/client closed");
		log("I1 PASS");
	} catch (err) {
		console.error("[mc-i1] I1 ERROR:", err);
		await closeHarness(h);
		process.exitCode = 1;
	}
}

await main();
