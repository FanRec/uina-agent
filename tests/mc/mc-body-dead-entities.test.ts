import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import type { ControlOwner } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { DriverExecutionFact, DriverExecutionSink } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { type PlayerPortDeps, PlayerPortImpl } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";

/**
 * deadEntities（批29）：连接级死亡观察的确定性单测。
 *
 * 裁剪依据：PlayerPort 持有的 entityDead 累积跨资格会话有效（战斗拍循环在
 * 会话间隙发生的击杀不丢）；断线/化身变更清空（networkId 只在连接内无歧义）。
 * bot 用真 EventEmitter 承载 entityDead；host 通知由测试直接注入。
 */

const ownerT = (serial: number): ControlOwner => ({
	kind: "run",
	run: `run:t:${serial}`,
	segment: `seg:t:${serial}`,
	callId: `call:t:${serial}`,
});

interface Harness {
	port: PlayerPortImpl;
	bus: EventEmitter;
	notices: ((notice: { kind: string }) => void)[];
	setIdentity(incarnation: string): void;
}

function makeHarness(): Harness {
	const bot = Object.assign(new EventEmitter(), {
		clearControlStates: (): void => {},
		targetDigBlock: null,
	}) as unknown as MineflayerBot;
	const identity = { connection: "conn:t1", incarnation: "inc:t1" };
	const notices: ((notice: { kind: string }) => void)[] = [];
	const host = {
		state: "ready",
		get identity(): { connection: string; incarnation: string } {
			return identity;
		},
		on: (listener: (notice: { kind: string }) => void): (() => void) => {
			notices.push(listener);
			return () => {};
		},
	};
	const facts: DriverExecutionFact[] = [];
	const sink: DriverExecutionSink = {
		record: (fact) => {
			facts.push(fact);
			return { instance: "rw:t", sequence: facts.length };
		},
	};
	const arbiter = new DriverControlArbiter();
	let serial = 0;
	const mint = (prefix: string) => (): string => `${prefix}:t:${++serial}`;
	const deps: PlayerPortDeps = {
		assertActionAllowed: (): void => {},
		host: host as unknown as PlayerPortDeps["host"],
		bot: () => bot,
		sink,
		sampleSelf: () => null,
		arbiter,
		mintBody: mint("body"),
		mintOp: mint("op"),
		mintEff: mint("eff"),
	};
	return {
		port: new PlayerPortImpl(deps),
		bus: bot as unknown as EventEmitter,
		notices,
		setIdentity: (incarnation: string) => {
			identity.incarnation = incarnation;
		},
	};
}

describe("deadEntities：连接级死亡观察", () => {
	test("entityDead 事件累积进 deadEntities；跨资格会话可见（会话间隙的击杀不丢）", async () => {
		const h = makeHarness();
		const first = await h.port.acquire(ownerT(1), new AbortController().signal);
		h.bus.emit("entityDead", { id: 42 });
		expect(first.deadEntities().has(42)).toBe(true);
		await first.close();
		// 会话关闭后发生的死亡（无资格窗口）同样累积。
		h.bus.emit("entityDead", { id: 43 });
		const second = await h.port.acquire(ownerT(2), new AbortController().signal);
		expect(second.deadEntities().has(42)).toBe(true);
		expect(second.deadEntities().has(43)).toBe(true);
		// 无关实体不出现。
		expect(second.deadEntities().has(99)).toBe(false);
		await second.close();
	});

	test("断线/化身变更通知清空观察（networkId 只在连接内无歧义）", async () => {
		const h = makeHarness();
		const session = await h.port.acquire(ownerT(1), new AbortController().signal);
		h.bus.emit("entityDead", { id: 42 });
		expect(session.deadEntities().has(42)).toBe(true);
		for (const notice of h.notices) notice({ kind: "incarnation_changed" });
		h.setIdentity("inc:t2");
		expect(session.deadEntities().has(42)).toBe(false);
		await session.close();
		// 旧 tap 已拆：重连前的死亡不捕获；新资格重挂后恢复累积。
		h.bus.emit("entityDead", { id: 7 });
		const next = await h.port.acquire(ownerT(2), new AbortController().signal);
		expect(next.deadEntities().has(7)).toBe(false);
		h.bus.emit("entityDead", { id: 8 });
		expect(next.deadEntities().has(8)).toBe(true);
		await next.close();
	});
});
