import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	PROTOCOL_WRITE_CONTRACT,
	type ProtocolWriteBinding,
	type ProtocolWriteDispatcher,
	type ProtocolWriteIdentity,
} from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { DriverExecutionFact, DriverExecutionSink } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";
import { createProtocolWriteDispatcher } from "../../.uina/worlds/minecraft/driver/protocol-dispatch.js";
import { RecordQueue } from "../../.uina/worlds/minecraft/runtime/records.js";
import { createScopedProtocolWrite } from "../../.uina/worlds/minecraft/runtime/scoped-protocol.js";

/**
 * 设计包 §6.1：scoped ProtocolWritePort + 现有 Effect Ledger。
 *
 * 过期写入（保存引用 / Body 退出 / 子 Call 委托 / 停止或安全打断 / 死亡跨维度 /
 * 断线重连）一律 not_sent 且不得触达 Driver；真实派发只证明"发出去了"，
 * 没有 ACK 或观察证据时 completion 必须是 unknown。
 */

const protocolState = vi.hoisted(() => ({
	writes: [] as { channel: string; data: string | Uint8Array }[],
	throwOnWrite: false,
}));

vi.mock("../../.uina/worlds/minecraft/driver/mineflayer/protocol.js", () => ({
	protocolFor: () => ({
		customPayload(channel: string, data: string | Uint8Array): void {
			if (protocolState.throwOnWrite) throw new Error("write failed");
			protocolState.writes.push({ channel, data });
		},
	}),
}));

const bindingOf = (overrides: Partial<ProtocolWriteBinding> = {}): ProtocolWriteBinding => ({
	run: "run:s4:1",
	segment: "seg:s4:1",
	call: "call:s4:1",
	body: "body:s4:1",
	owner: { kind: "run", run: "run:s4:1", segment: "seg:s4:1", callId: "call:s4:1" },
	connection: "conn:s4:1",
	incarnation: "inc:s4:1",
	...overrides,
});

const guardError = (code: string) =>
	callFailure({ code, source: "capability", message: code, dispatch: "not_sent", effects: [], recoverable: true });

/** 捕获抛出的 CallFailure，逐字段核对 dispatch / code / effects。 */
function expectFailure(work: () => void, expected: Record<string, unknown>): void {
	let thrown: unknown = null;
	try {
		work();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toMatchObject(expected);
}

function scopedHarness(
	options: { binding?: Partial<ProtocolWriteBinding>; identity?: ProtocolWriteIdentity | null } = {},
) {
	let identity: ProtocolWriteIdentity | null =
		options.identity === undefined ? { connection: "conn:s4:1", incarnation: "inc:s4:1" } : options.identity;
	const sends: { binding: ProtocolWriteBinding; channel: string; data: string | Uint8Array }[] = [];
	const confirms: { binding: ProtocolWriteBinding; effect: string; evidence: readonly string[] }[] = [];
	const dispatcher: ProtocolWriteDispatcher = {
		identity: () => identity,
		send: (binding, channel, data) => {
			const n = sends.length + 1;
			sends.push({ binding, channel, data });
			return { effect: `eff:s4:${n}`, operation: `op:s4:${n}` };
		},
		confirm: (binding, dispatch, evidence) =>
			confirms.push({ binding, effect: dispatch.effect, evidence: [...evidence] }),
	};
	let failure: ReturnType<typeof guardError> | null = null;
	const binding = bindingOf(options.binding);
	const port = createScopedProtocolWrite({
		dispatcher,
		binding,
		guard: () => {
			if (failure != null) throw failure;
		},
	});
	return {
		port,
		sends,
		confirms,
		binding,
		setIdentity: (next: ProtocolWriteIdentity | null) => {
			identity = next;
		},
		setGuardFailure: (next: ReturnType<typeof guardError> | null) => {
			failure = next;
		},
	};
}

describe("scoped ProtocolWritePort：逐次权限与身份复核", () => {
	test("有效的 Scope 正常派发，携带建立时定稿的绑定", () => {
		const h = scopedHarness();
		h.port.send("uina:example", "hello");
		expect(h.sends).toEqual([{ binding: h.binding, channel: "uina:example", data: "hello" }]);
	});

	test("保存旧引用后调用：not_sent，Driver 不被触达", () => {
		const h = scopedHarness();
		const saved = h.port;
		h.setGuardFailure(guardError("CONTROL_INVALID"));
		expectFailure(() => saved.send("uina:example", "late"), {
			code: "CONTROL_INVALID",
			dispatch: "not_sent",
		});
		expect(h.sends).toHaveLength(0);
	});

	test("Body 退出 / 停止 / 安全打断：逐次 guard 失败都是 not_sent", () => {
		const h = scopedHarness();
		h.port.send("uina:example", "first");
		for (const code of ["CONTROL_INVALID", "INTERRUPTED", "CONTROL_ISOLATION_FAILED"]) {
			h.setGuardFailure(guardError(code));
			expectFailure(() => h.port.send("uina:example", code), { code, dispatch: "not_sent" });
		}
		expect(h.sends).toHaveLength(1);
	});

	test("子 Call 委托期间（BODY_SUSPENDED）：not_sent", () => {
		const h = scopedHarness();
		h.setGuardFailure(guardError("BODY_SUSPENDED"));
		expectFailure(() => h.port.send("uina:example", "delegated"), { dispatch: "not_sent" });
		expect(h.sends).toHaveLength(0);
	});

	test("死亡/跨维度换代：CONNECTION_RETIRED，not_sent", () => {
		const h = scopedHarness();
		h.setIdentity({ connection: "conn:s4:1", incarnation: "inc:s4:2" });
		expectFailure(() => h.port.send("uina:example", "respawn"), {
			code: "CONNECTION_RETIRED",
			dispatch: "not_sent",
		});
		expect(h.sends).toHaveLength(0);
	});

	test("换服（connection 变化）：CONNECTION_RETIRED，not_sent", () => {
		const h = scopedHarness();
		h.setIdentity({ connection: "conn:s4:2", incarnation: "inc:s4:2" });
		expectFailure(() => h.port.send("uina:example", "other server"), {
			code: "CONNECTION_RETIRED",
			dispatch: "not_sent",
		});
		expect(h.sends).toHaveLength(0);
	});

	test("断线重连：identity 为 null 时 not_sent；即使恢复也不接受旧 Scope", () => {
		const h = scopedHarness();
		h.setIdentity(null);
		expectFailure(() => h.port.send("uina:example", "down"), {
			code: "DISCONNECTED",
			dispatch: "not_sent",
		});
		h.setIdentity({ connection: "conn:s4:2", incarnation: "inc:s4:2" });
		expectFailure(() => h.port.send("uina:example", "reconnected"), { dispatch: "not_sent" });
		expect(h.sends).toHaveLength(0);
	});

	test("建立时就没有连接身份：端口存在但任何 send 都 not_sent", () => {
		const h = scopedHarness({ binding: { connection: null, incarnation: null } });
		expectFailure(() => h.port.send("uina:example", "no identity"), {
			code: "CONNECTION_RETIRED",
			dispatch: "not_sent",
		});
		expect(h.sends).toHaveLength(0);
	});

	test("确认必须带观察证据：空证据不给虚假 met", () => {
		const h = scopedHarness();
		const effect = h.port.send("uina:example", "hello");
		expectFailure(() => h.port.confirm(effect, []), {
			code: "EFFECT_UNCONFIRMED",
			dispatch: "sent",
			effects: [effect],
		});
		expect(h.confirms).toHaveLength(0);
	});

	test("只能确认本端口发出的 effect", () => {
		const h = scopedHarness();
		h.port.send("uina:example", "hello");
		expectFailure(() => h.port.confirm("eff:other:1", ["ev:server:1"]), {
			code: "EFFECT_NOT_OWNED",
			dispatch: "sent",
			effects: ["eff:other:1"],
		});
		expect(h.confirms).toHaveLength(0);
	});

	test("带观察证据的确认把 effect 交给 Driver 结算", () => {
		const h = scopedHarness();
		const effect = h.port.send("uina:example", "hello");
		h.port.confirm(effect, ["ev:server:1", "ev:server:2"]);
		expect(h.confirms).toEqual([{ binding: h.binding, effect, evidence: ["ev:server:1", "ev:server:2"] }]);
	});

	test("Scope 过期后确认失败仍如实报 sent + 该 effect", () => {
		const h = scopedHarness();
		const effect = h.port.send("uina:example", "hello");
		h.setGuardFailure(guardError("CONTROL_INVALID"));
		expectFailure(() => h.port.confirm(effect, ["ev:server:1"]), {
			code: "CONTROL_INVALID",
			dispatch: "sent",
			effects: [effect],
		});
		expect(h.confirms).toHaveLength(0);
	});
});

function dispatchHarness(options: { sink?: DriverExecutionSink } = {}) {
	const facts: DriverExecutionFact[] = [];
	const sink: DriverExecutionSink = options.sink ?? {
		record: (fact) => {
			facts.push(fact);
			return { instance: "rw:s4:1", sequence: facts.length };
		},
		async ensureDurable() {},
	};
	let connection = "conn:s4:1";
	let incarnation = "inc:s4:1";
	let bot: unknown = {};
	let blocked = false;
	let op = 0;
	let eff = 0;
	const host = {
		get identity() {
			return { connection, incarnation };
		},
		get bot() {
			return bot;
		},
	} as unknown as ClientHost;
	const dispatcher = createProtocolWriteDispatcher({
		host,
		sink,
		mintOp: () => `op:s4:${++op}`,
		mintEff: () => `eff:s4:${++eff}`,
		assertActionAllowed: () => {
			if (blocked) throw new Error("execution side is closing");
		},
	});
	return {
		dispatcher,
		facts,
		setIdentity: (nextConnection: string, nextIncarnation: string) => {
			connection = nextConnection;
			incarnation = nextIncarnation;
		},
		disconnect: () => {
			bot = null;
		},
		block: () => {
			blocked = true;
		},
	};
}

describe("Driver 派发：真实写入 + 现有 Effect Ledger", () => {
	beforeEach(() => {
		protocolState.writes.length = 0;
		protocolState.throwOnWrite = false;
	});

	test("写入一次并留下 dispatch=sent / completion=unknown 的派发事实", () => {
		const h = dispatchHarness();
		h.dispatcher.send(bindingOf(), "uina:example", "hello");
		expect(protocolState.writes).toEqual([{ channel: "uina:example", data: "hello" }]);
		expect(h.facts).toHaveLength(1);
		expect(h.facts[0]).toMatchObject({
			effect: "eff:s4:1",
			operation: "op:s4:1",
			contract: PROTOCOL_WRITE_CONTRACT,
			kind: "dispatch",
			dispatch: "sent",
			completion: "unknown",
			evidence: [],
			owner: { kind: "run", run: "run:s4:1", segment: "seg:s4:1", callId: "call:s4:1" },
		});
		expect(h.facts[0]?.detail).toMatchObject({
			channel: "uina:example",
			bytes: 5,
			connection: "conn:s4:1",
			incarnation: "inc:s4:1",
			acknowledged: false,
		});
	});

	test("派发事实进入真实 RecordQueue：无 ACK 的效果被结算为 unknown", () => {
		const queue = new RecordQueue({
			instance: "rw:s4:1",
			mintRecord: () => "rec:s4:1",
			recoveredWatermarks: {},
			apply: () => {},
		});
		const h = dispatchHarness({
			sink: { record: (fact) => queue.record(fact), ensureDurable: (ticket) => queue.ensureDurable(ticket) },
		});
		h.dispatcher.send(bindingOf(), "uina:example", "hello");
		expect(queue.unknownEffectsFor("run:s4:1")).toEqual(["eff:s4:1"]);
		expect(queue.effectsForCall("call:s4:1")).toEqual(["eff:s4:1"]);
		expect(queue.effectRecord("eff:s4:1")?.facts[0]).toMatchObject({
			dispatch: "sent",
			completion: "unknown",
			evidence: [],
		});
	});

	test("确认写入 receipt：同一 effect 结算为 met，不再算未知效果", () => {
		const queue = new RecordQueue({
			instance: "rw:s4:1",
			mintRecord: () => "rec:s4:1",
			recoveredWatermarks: {},
			apply: () => {},
		});
		const h = dispatchHarness({
			sink: { record: (fact) => queue.record(fact), ensureDurable: (ticket) => queue.ensureDurable(ticket) },
		});
		const dispatch = h.dispatcher.send(bindingOf(), "uina:example", "hello");
		expect(queue.unknownEffectsFor("run:s4:1")).toEqual([dispatch.effect]);

		h.dispatcher.confirm(bindingOf(), dispatch, ["ev:server:1", "ev:server:2"]);
		expect(queue.unknownEffectsFor("run:s4:1")).toEqual([]);
		const record = queue.effectRecord(dispatch.effect);
		expect(record?.facts.map((fact) => fact.kind)).toEqual(["dispatch", "receipt"]);
		expect(record?.latest).toMatchObject({
			dispatch: "sent",
			completion: "met",
			evidence: ["ev:server:1", "ev:server:2"],
		});
	});

	test("确认时换代/断线：如实报 sent + 该 effect，不写 receipt", () => {
		const h = dispatchHarness();
		const dispatch = h.dispatcher.send(bindingOf(), "uina:example", "hello");
		h.setIdentity("conn:s4:1", "inc:s4:2");
		expectFailure(() => h.dispatcher.confirm(bindingOf(), dispatch, ["ev:server:1"]), {
			code: "CONNECTION_RETIRED",
			dispatch: "sent",
			effects: [dispatch.effect],
		});
		expect(h.facts).toHaveLength(1);
	});

	test("驱动侧换代/断线复核：不写包、不留派发事实", () => {
		const h = dispatchHarness();
		h.setIdentity("conn:s4:1", "inc:s4:2");
		expectFailure(() => h.dispatcher.send(bindingOf(), "uina:example", "stale"), {
			code: "CONNECTION_RETIRED",
			dispatch: "not_sent",
		});
		h.setIdentity("conn:s4:1", "inc:s4:1");
		h.disconnect();
		expectFailure(() => h.dispatcher.send(bindingOf(), "uina:example", "down"), {
			code: "DISCONNECTED",
			dispatch: "not_sent",
		});
		expect(protocolState.writes).toHaveLength(0);
		expect(h.facts).toHaveLength(0);
	});

	test("执行域关闭时不发新副作用", () => {
		const h = dispatchHarness();
		h.block();
		expect(() => h.dispatcher.send(bindingOf(), "uina:example", "closing")).toThrow(/closing/);
		expect(protocolState.writes).toHaveLength(0);
		expect(h.facts).toHaveLength(0);
	});

	test("真实写入失败：不留已派发的假事实", () => {
		const h = dispatchHarness();
		protocolState.throwOnWrite = true;
		expect(() => h.dispatcher.send(bindingOf(), "uina:example", "bad")).toThrow(/write failed/);
		expect(h.facts).toHaveLength(0);
	});

	test("Effect Ledger 拒收：包已发出，如实以 sent + unknown 效果失败", () => {
		const h = dispatchHarness({ sink: { record: () => null, async ensureDurable() {} } });
		expectFailure(() => h.dispatcher.send(bindingOf(), "uina:example", "hello"), {
			code: "EFFECT_RECORD_FAILED",
			dispatch: "sent",
			effects: ["eff:s4:1"],
		});
		expect(protocolState.writes).toHaveLength(1);
	});
});
