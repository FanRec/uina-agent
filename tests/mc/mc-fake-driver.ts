/**
 * Driver 侧测试替身：PlayerPortImpl + 窄 bot stub + 事实 sink。
 *
 * bot 一律窄 stub：只含被测路径真正触达的方法/字段；拒绝类断言要求这些调用
 * 发生在 bot 触达之前，因此 stub 不构成第二套产品分支。
 */

import type { BodySession, ControlOwner, EntityRef } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { DriverExecutionFact, DriverExecutionSink } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import type { CallFailure, Place } from "../../.uina/worlds/minecraft/contracts/values.js";
import { PlayerPortImpl } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import type { BodySessionImpl, HostView } from "../../.uina/worlds/minecraft/driver/body/session.js";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";

export const openSignal = (): AbortSignal => new AbortController().signal;

export const ownerT = (serial: number): ControlOwner => ({
	kind: "run",
	run: `run:t:${serial}`,
	segment: `seg:t:${serial}`,
	callId: `call:t:${serial}`,
});

export const placeT = (): Place => ({
	world: "world:t",
	worldRevision: "rev:t1",
	dimension: "overworld",
	position: { x: 0, y: 64, z: 0 },
});

export const entityT = (): EntityRef => ({
	connection: "conn:t1",
	incarnation: "inc:t1",
	appearance: "app:t1",
	networkId: 42,
});

/** 捕获 CallFailure；调用未失败时显式失败。 */
export async function captureFailure(promise: Promise<unknown>): Promise<CallFailure> {
	try {
		await promise;
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected the call to reject with CallFailure, but it resolved");
}

/** 等待会话到达 closed（revoke 的挂起结算在微任务/定时器后完成）。 */
export async function awaitClosed(session: BodySessionImpl): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (session.sessionState === "closed") return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("session did not reach closed state within 5s");
}

/** HostView stub：state 固定 ready，identity 可换（屏障疑虑作废用）。 */
function makeHost(): { view: HostView; setConnection: (connection: string) => void } {
	const raw = {
		state: "ready",
		identity: { connection: "conn:t1", incarnation: "inc:t1" },
		on: () => (): void => {},
	};
	return {
		view: raw as unknown as HostView,
		setConnection: (connection: string): void => {
			raw.identity = { connection, incarnation: "inc:t1" };
		},
	};
}

/** DriverExecutionSink stub：同步收事实并返回 ticket；永不返回 null（不触发 recorder fault）。 */
function makeSink(): { sink: DriverExecutionSink; facts: DriverExecutionFact[] } {
	const facts: DriverExecutionFact[] = [];
	let sequence = 0;
	return {
		facts,
		sink: {
			record(fact) {
				facts.push(fact);
				sequence += 1;
				return { instance: "rw:t1", sequence };
			},
		},
	};
}

/**
 * 窄 bot stub：默认面只有 revoke/close 清理真正触达的
 * clearControlStates / targetDigBlock / usingHeldItem；其余按测试需要注入。
 */
export function makeBodyBot(overrides: Record<string, unknown> = {}): MineflayerBot {
	return {
		clearControlStates: (): void => {},
		targetDigBlock: null,
		usingHeldItem: false,
		...overrides,
	} as unknown as MineflayerBot;
}

export interface BodyHarness {
	port: PlayerPortImpl;
	arbiter: DriverControlArbiter;
	facts: DriverExecutionFact[];
	/** 实际接线的那只 stub：测试可就地改字段/读回状态（overrides 里改的是副本）。 */
	bot: MineflayerBot;
	setConnection(connection: string): void;
}

/** 组合 PlayerPortImpl：真实仲裁器 + 确定性发号 + 窄 stub。 */
export function makeBodyHarness(botOverrides: Record<string, unknown> = {}): BodyHarness {
	const { view: host, setConnection } = makeHost();
	const { sink, facts } = makeSink();
	const arbiter = new DriverControlArbiter();
	let serial = 0;
	const mint = (prefix: string) => (): string => {
		serial += 1;
		return `${prefix}:t:${serial}`;
	};
	const bot = makeBodyBot(botOverrides);
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
	return { port, arbiter, facts, bot, setConnection };
}

/** 取一个可用会话（测试里几乎总是紧接着写操作）。 */
export async function acquireSession(harness: BodyHarness, serial = 1): Promise<BodySessionImpl> {
	const session: BodySession = await harness.port.acquire(ownerT(serial), openSignal());
	return session as BodySessionImpl;
}
