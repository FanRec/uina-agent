import { describe, expect, test } from "vitest";
import type { ControlOwner, EntityRef } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { DriverExecutionFact, DriverExecutionSink } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { CallFailure, Place } from "../../.uina/worlds/minecraft/contracts/values.js";
import { PlayerPortImpl } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import type { BodySessionImpl, HostView } from "../../.uina/worlds/minecraft/driver/body/session.js";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";

/**
 * D7：PlayerPort 资格闸门与 BodySession 写拒绝的确定性单测（不依赖真服/网络）。
 *
 * 以实现事实为准的规格裁剪：
 * - PlayerPort.acquire 无排队语义：资格未释放时第二次 acquire 立即 CONTROL_CONFLICT
 *   （FIFO 排队在 engine.pumpBodyQueue 层，不在本文件范围）。
 * - 屏障不成立（§10.5）绑定"会话所属连接"：同连接新资格被拒（CONTROL_INVALID），
 *   连接更换后疑虑作废。
 * - "setControlState" 不是独立操作，持续控制经 drive() 安装；chat 不占 Body（合同注释
 *   明示），close 后 chat 仍按旁路派发，不是身体写。
 * bot 一律窄 stub：只含被测路径真正触达的方法/字段（由 grep 调用面确定），stub 仅存在
 * 于本文件；所有拒绝断言在 bot 触达之前发生，stub 不构成 FakeBot 产品分支。
 */

// ---- 测试专用窄 stub ----

/** HostView stub：state 固定 ready，identity 可换（屏障疑虑作废用）。 */
function makeHost() {
	const raw = {
		state: "ready",
		identity: { connection: "conn:t1", incarnation: "inc:t1" },
		on: () => (): void => {},
	};
	const view = raw as unknown as HostView;
	return {
		view,
		setConnection: (connection: string): void => {
			raw.identity = { connection, incarnation: "inc:t1" };
		},
	};
}

/** DriverExecutionSink stub：同步收事实并返回 ticket；永不返回 null（不触发 recorder fault）。 */
function makeSink() {
	const facts: DriverExecutionFact[] = [];
	let sequence = 0;
	const sink: DriverExecutionSink = {
		record(fact) {
			facts.push(fact);
			sequence += 1;
			return { instance: "rw:t1", sequence };
		},
	};
	return { sink, facts };
}

/**
 * 窄 bot stub：默认面只有 revoke/close 清理真正触达的
 * clearControlStates / targetDigBlock / usingHeldItem；其余按测试需要注入。
 */
function makeBot(overrides: Record<string, unknown> = {}): MineflayerBot {
	const stub = {
		clearControlStates: (): void => {},
		targetDigBlock: null,
		usingHeldItem: false,
		...overrides,
	};
	return stub as unknown as MineflayerBot;
}

/** 组合 PlayerPortImpl：真实仲裁器 + 确定性发号 + 窄 stub。 */
function makeHarness(botOverrides: Record<string, unknown> = {}) {
	const { view: host, setConnection } = makeHost();
	const { sink, facts } = makeSink();
	const arbiter = new DriverControlArbiter();
	let serial = 0;
	const mint = (prefix: string) => (): string => {
		serial += 1;
		return `${prefix}:t:${serial}`;
	};
	const bot = makeBot(botOverrides);
	const port = new PlayerPortImpl({
		host,
		bot: () => bot,
		sink,
		sampleSelf: () => null,
		arbiter,
		mintBody: mint("body"),
		mintOp: mint("op"),
		mintEff: mint("eff"),
	});
	return { port, arbiter, facts, setConnection };
}

// ---- 断言辅助 ----

const openSignal = (): AbortSignal => new AbortController().signal;

const ownerT = (serial: number): ControlOwner => ({
	kind: "run",
	run: `run:t:${serial}`,
	segment: `seg:t:${serial}`,
	callId: `call:t:${serial}`,
});

const placeT = (): Place => ({
	world: "world:t",
	worldRevision: "rev:t1",
	dimension: "overworld",
	position: { x: 0, y: 64, z: 0 },
});

const entityT = (): EntityRef => ({
	connection: "conn:t1",
	incarnation: "inc:t1",
	appearance: "app:t1",
	networkId: 42,
});

/** 捕获 CallFailure；调用未失败时显式失败。 */
async function captureFailure(promise: Promise<unknown>): Promise<CallFailure> {
	try {
		await promise;
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the call to reject with CallFailure, but it resolved");
}

/** 等待会话到达 closed（revoke 的挂起结算在微任务/定时器后完成）。 */
async function awaitClosed(session: BodySessionImpl): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (session.sessionState === "closed") return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("session did not reach closed state within 5s");
}

// ---- 资格闸门（PlayerPort.acquire） ----

describe("PlayerPort 资格闸门", () => {
	test("并发 acquire：资格未释放时第二次授予立即 CONTROL_CONFLICT（实现为拒绝，不排队）", async () => {
		const h = makeHarness();
		const first = await h.port.acquire(ownerT(1), openSignal());
		const err = await captureFailure(h.port.acquire(ownerT(2), openSignal()));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_CONFLICT");
		expect(err.source).toBe("capability");
		expect(err.dispatch).toBe("not_sent");
		expect(err.recoverable).toBe(false);
		await first.close();
	});

	test("goto 受控独占期间拒绝新资格；Body 持有期间 goto 槽同样被拒", async () => {
		const h = makeHarness();
		expect(h.arbiter.tryClaimGoto()).toBe(true);
		const err = await captureFailure(h.port.acquire(ownerT(1), openSignal()));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_CONFLICT");
		h.arbiter.releaseGoto();
		const session = await h.port.acquire(ownerT(1), openSignal());
		expect(h.arbiter.tryClaimGoto()).toBe(false);
		await session.close();
	});

	test("close 释放后可再次授予（同 owner 与异 owner）", async () => {
		const h = makeHarness();
		const first = await h.port.acquire(ownerT(1), openSignal());
		await first.close();
		const second = await h.port.acquire(ownerT(1), openSignal());
		expect(second).toBeDefined();
		await second.close();
		const third = await h.port.acquire(ownerT(2), openSignal());
		expect(third).toBeDefined();
		await third.close();
	});

	test("acquire 信号已取消：INTERRUPTED 拒绝且端口恢复可授予", async () => {
		const h = makeHarness();
		const controller = new AbortController();
		controller.abort();
		const err = await captureFailure(h.port.acquire(ownerT(1), controller.signal));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("INTERRUPTED");
		expect(err.dispatch).toBe("not_sent");
		const session = await h.port.acquire(ownerT(1), openSignal());
		expect(session).toBeDefined();
		await session.close();
	});

	test("信号中途取消（revoke）：drive 立即拒绝，会话退役后端口可再次授予", async () => {
		const h = makeHarness();
		const controller = new AbortController();
		const first = (await h.port.acquire(ownerT(1), controller.signal)) as BodySessionImpl;
		controller.abort();
		const err = await captureFailure(first.drive({ keys: { forward: true } }, 1));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_INVALID");
		expect(err.dispatch).toBe("not_sent");
		expect(err.recoverable).toBe(false);
		await awaitClosed(first);
		const second = await h.port.acquire(ownerT(2), openSignal());
		expect(second).toBeDefined();
		await second.close();
	});
});

// ---- 停止屏障（§10.5） ----

describe("停止屏障", () => {
	test("会话带未结算写操作关闭：同连接拒绝新资格，连接更换后疑虑作废", async () => {
		// dig 挂在 await digging（无 recheck 的静默挂起点）：close 的 2s 结算期限到期
		// 仍无法证明停止屏障 → barrierProven=false 锁存到当时连接。
		const h = makeHarness({
			blockAt: (): { name: string } => ({ name: "stone" }),
			digTime: (): number => 500,
			dig: (): Promise<never> => new Promise(() => {}),
			targetDigBlock: { position: { x: 0, y: 64, z: 0 } },
			stopDigging: (): void => {},
		});
		const first = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		// 挂起中的 dig：promise 永不 settle；catch 仅防实现路径变化时的未处理拒绝噪音
		void first.dig({ place: placeT(), block: { x: 0, y: 64, z: 0 } }).catch(() => {});
		await first.close();

		const err = await captureFailure(h.port.acquire(ownerT(2), openSignal()));
		expect(err.name).toBe("CallFailure");
		expect(err.code).toBe("CONTROL_INVALID");
		expect(err.hint).toContain("reconnect");

		// 连接更换：旧写入随旧连接消亡，疑虑作废，授予成功
		h.setConnection("conn:t2");
		const second = await h.port.acquire(ownerT(2), openSignal());
		expect(second).toBeDefined();
		await second.close();
	});
});

// ---- 资格失效后写拒绝（BodySessionImpl §5.3 写入核验） ----

describe("BodySession 资格失效后写拒绝", () => {
	test("close 后全部身体写操作 CONTROL_INVALID，且不产生任何派发事实", async () => {
		const h = makeHarness();
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		await session.close();
		const attempts: [string, () => Promise<unknown>][] = [
			["drive", () => session.drive({ keys: {} }, 1)],
			["dig", () => session.dig({ place: placeT(), block: { x: 0, y: 64, z: 0 } })],
			["attack", () => session.attack(entityT())],
			["useItem", () => session.useItem("main")],
			["endUse", () => session.endUse()],
			["equip", () => session.equip({ name: "iron_sword" }, "main")],
			["lookAt", () => session.lookAt({ x: 0, y: 64, z: 0 })],
			["interact", () => session.interact({ target: { place: placeT(), block: { x: 0, y: 64, z: 0 } }, hand: "main" })],
		];
		for (const [name, attempt] of attempts) {
			const err = await captureFailure(attempt());
			expect(err.name, name).toBe("CallFailure");
			expect(err.code, name).toBe("CONTROL_INVALID");
			expect(err.source, name).toBe("capability");
			expect(err.dispatch, name).toBe("not_sent");
			expect(err.recoverable, name).toBe(false);
		}
		// 拒绝发生在 bot 触达之前：效果事实流保持为空（未派发、未记录）
		expect(h.facts).toEqual([]);
	});
});

// ---- chat 旁路（规格差异固化：chat 不占 Body） ----

describe("chat 旁路", () => {
	test("chat 不占 Body：无资格与 close 后均可派发，按 body.chat@1 记录", async () => {
		const h = makeHarness({
			chat: (): void => {},
			supportFeature: (): boolean => false,
		});
		// 从未 acquire 资格，chat 直接可用（1.21.11 非排队版本 → dispatch=sent）
		const receipt = await h.port.chat("hello", openSignal());
		expect(receipt.dispatch).toBe("sent");
		expect(receipt.completion).toBe("met");
		const session = (await h.port.acquire(ownerT(1), openSignal())) as BodySessionImpl;
		await session.close();
		const again = await h.port.chat("again", openSignal());
		expect(again.dispatch).toBe("sent");
		expect(h.facts.some((fact) => fact.contract === "body.chat@1")).toBe(true);
	});
});
