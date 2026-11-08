import { describe, expect, test, vi } from "vitest";
import type {
	AddonFactPublication,
	AddonFactPublicationOptions,
	ConnectionFactSink,
} from "../../.uina/worlds/minecraft/contracts/protocol.js";
import type { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import type { DriverProtocol } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";
import type { Fact, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { createConnectionPort } from "../../.uina/worlds/minecraft/driver/protocol-extension.js";
import type { FactViewContext } from "../../.uina/worlds/minecraft/driver/facts/view.js";
import { createView } from "../../.uina/worlds/minecraft/driver/facts/view.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

/**
 * 连接级协议扩展（addons.md §3.2，设计包 §6.2）。
 *
 * 三条底线：
 * 1. 事实按**采集事件来源身份**绑定：断线清空、换代按作用域失效，迟到发布被拒绝；
 * 2. 订阅有明确生命周期：dispose 后不再回调，换代后的迟到消息被丢弃；
 * 3. scope / source 由原始证据确定，视图读取也按作用域验证。
 */

const pub = (overrides: Partial<AddonFactPublicationOptions> = {}): AddonFactPublicationOptions => ({
	scope: "connection",
	source: "server",
	...overrides,
});

const publication = (overrides: Partial<AddonFactPublication> = {}): AddonFactPublication => ({
	scope: "connection",
	source: "server",
	origin: { connection: "conn:t:1", incarnation: "inc:t:1" },
	...overrides,
});

interface FakeProtocol {
	version: string;
	onCustomPayload(listener: (notice: { channel: string; data: Uint8Array }) => void): () => void;
	registerChannels(channels: readonly string[]): void;
	emit(channel: string, text: string): void;
	listenerCount(): number;
	registered(): string[];
}

function fakeProtocol(): FakeProtocol {
	const listeners = new Set<(notice: { channel: string; data: Uint8Array }) => void>();
	const channels = new Set<string>();
	const encoder = new TextEncoder();
	return {
		version: "1.21.11",
		onCustomPayload(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		registerChannels(channelList) {
			for (const channel of channelList) channels.add(channel);
		},
		emit(channel, text) {
			for (const listener of [...listeners]) listener({ channel, data: encoder.encode(text) });
		},
		listenerCount: () => listeners.size,
		registered: () => [...channels],
	};
}

function harness(options: { current?: () => boolean } = {}) {
	const bot = makeBot();
	const protocol = fakeProtocol();
	const published: {
		addonId: string;
		key: string;
		value: JsonValue;
		publication: AddonFactPublication;
	}[] = [];
	const facts: ConnectionFactSink = {
		publishAddonFact: (addonId, key, value, factPublication) => {
			published.push({ addonId, key, value, publication: factPublication });
		},
	};
	let current = true;
	let connection = "conn:t:1";
	let incarnation = "inc:t:1";
	const host = {
		get state() {
			return "ready";
		},
		get identity() {
			return { connection, incarnation };
		},
		bot: null,
	} as unknown as ClientHost;
	const port = createConnectionPort({
		addonId: "example-mod",
		host,
		bot: bot as unknown as MineflayerBot,
		protocol: protocol as unknown as DriverProtocol,
		facts,
		isCurrent: options.current ?? (() => current),
	});
	return {
		bot,
		protocol,
		published,
		port,
		stale: () => {
			current = false;
		},
		setIdentity: (nextConnection: string, nextIncarnation: string) => {
			connection = nextConnection;
			incarnation = nextIncarnation;
		},
	};
}

describe("ConnectionPort：只读订阅 + 生命周期", () => {
	test("自定义通道按 channel 过滤，回调原始字节；订阅即向服务端声明通道", () => {
		const h = harness();
		const seen: string[] = [];
		h.port.onCustomPayload("uina:example", (data) => {
			seen.push(Buffer.from(data).toString("utf8"));
		});
		expect(h.protocol.registered()).toEqual(["uina:example"]);
		h.protocol.emit("uina:other", "ignored");
		h.protocol.emit("uina:example", '{"op":"state","counter":2}');
		expect(seen).toEqual(['{"op":"state","counter":2}']);
	});

	test("dispose 解除全部订阅（含 attach 登记的释放函数）", () => {
		const h = harness();
		let released = 0;
		const off = h.port.onCustomPayload("uina:example", () => {
			released += 1;
		});
		expect(typeof off).toBe("function");
		h.port.defer(() => {
			released += 10;
		});
		h.port.dispose();
		h.protocol.emit("uina:example", "{}");
		expect(released).toBe(10);
		expect(h.protocol.listenerCount()).toBe(0);
	});

	test("连接换代后：迟到订阅不再回调，发布被丢弃", () => {
		const h = harness();
		h.port.onCustomPayload("uina:example", () => {
			h.port.publishFact("machine", { counter: 1 }, pub());
		});
		h.protocol.emit("uina:example", "{}");
		expect(h.published).toHaveLength(1);

		h.stale();
		const seen: string[] = [];
		h.port.onCustomPayload("uina:example", () => seen.push("late"));
		h.protocol.emit("uina:example", "{}");
		// 已退役端口在采集身份检查之前就被丢弃，不会写进新连接。
		h.port.publishFact("machine", { counter: 2 }, pub());
		expect(seen).toEqual([]);
		expect(h.published).toHaveLength(1);
	});

	test("isCurrent 在订阅建立后变 false：回调被丢弃（不写进新连接）", () => {
		const h = harness();
		h.stale();
		const seen: string[] = [];
		h.port.onCustomPayload("uina:example", () => seen.push("x"));
		expect(h.protocol.registered()).toEqual([]);
		h.protocol.emit("uina:example", "{}");
		expect(seen).toEqual([]);
	});

	test("单个监听器抛错不影响其它监听器（错误被吞并记录）", () => {
		const h = harness();
		const seen: string[] = [];
		h.port.onCustomPayload("uina:example", () => {
			throw new Error("boom");
		});
		h.port.onCustomPayload("uina:example", () => seen.push("second"));
		expect(() => h.protocol.emit("uina:example", "{}")).not.toThrow();
		expect(seen).toEqual(["second"]);
	});

	test("onEvent 走 bot 事件；dispose 后不再转发", () => {
		const h = harness();
		let spawns = 0;
		h.port.onEvent("spawn", () => {
			spawns += 1;
		});
		h.bot.emit("spawn");
		expect(spawns).toBe(1);
		h.port.dispose();
		h.bot.emit("spawn");
		expect(spawns).toBe(1);
	});

	test("身份与版本来自当前连接（不缓存旧值）", () => {
		const h = harness();
		expect(h.port.addonId).toBe("example-mod");
		expect(h.port.connection).toBe("conn:t:1");
		expect(h.port.incarnation).toBe("inc:t:1");
		expect(h.port.version).toBe("1.21.11");
		expect(h.port.state()).toBe("ready");
	});
});

describe("ConnectionPort：采集事件来源身份", () => {
	test("回调外发布被拒绝：没有采集事件就没有事实来源", () => {
		const h = harness();
		expect(() => h.port.publishFact("machine", { counter: 1 }, pub())).toThrow(/ADDON_FACT_ORIGIN_MISSING/);
		expect(h.published).toHaveLength(0);
	});

	test("scope / source 原样带到 FactsSource，不套默认值", () => {
		const h = harness();
		h.port.onCustomPayload("uina:example", () => {
			h.port.publishFact(
				"machine",
				{ counter: null },
				{
					scope: "incarnation",
					source: "derived",
					unknown: ["counter not observed"],
				},
			);
		});
		h.protocol.emit("uina:example", "{}");
		expect(h.published[0]?.publication).toEqual({
			scope: "incarnation",
			source: "derived",
			unknown: ["counter not observed"],
			origin: { connection: "conn:t:1", incarnation: "inc:t:1" },
		});
	});

	test("异步续段仍带事件到达时的身份，不误标成换代后的新事实", async () => {
		const h = harness();
		h.port.onCustomPayload("uina:example", async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			h.port.publishFact("machine", { counter: 1 }, pub());
		});
		h.protocol.emit("uina:example", "{}");
		h.setIdentity("conn:t:1", "inc:t:2");
		await vi.waitFor(() => expect(h.published).toHaveLength(1));
		expect(h.published[0]?.publication.origin).toEqual({
			connection: "conn:t:1",
			incarnation: "inc:t:1",
		});
	});

	test("原始包订阅与 spawn 事件同样带采集身份", () => {
		const h = harness();
		h.port.onPacket("custom_payload", () => h.port.publishFact("fromPacket", 1, pub()));
		h.port.onEvent("spawn", () => h.port.publishFact("fromSpawn", 2, pub()));
		(h.bot as unknown as { _client: { emit(name: string, payload: unknown): void } })._client.emit(
			"custom_payload",
			{},
		);
		h.bot.emit("spawn");
		expect(h.published.map((entry) => entry.key)).toEqual(["fromPacket", "fromSpawn"]);
		expect(h.published.every((entry) => entry.publication.origin.incarnation === "inc:t:1")).toBe(true);
	});
});

describe("addon facts：作用域、来源与迟到发布", () => {
	test("发布后可按 addonId/key 读取；来源是 server，绑定采集身份", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact(
			"example-mod",
			"machine",
			{ counter: 3, item: "example:uina_token", serverTime: "t0" },
			publication(),
		);
		const capture = h.facts.sample((view) => view.addonFact("example-mod", "machine"));
		expect(capture.value?.value).toEqual({ counter: 3, item: "example:uina_token", serverTime: "t0" });
		expect(capture.value?.source).toBe("server");
		expect(capture.value?.coverage).toBe("complete");
		expect(capture.value?.connection).toBe("conn:t:1");
		expect(capture.value?.incarnation).toBe("inc:t:1");
	});

	test("derived 来源按原始证据保留，不一律标成 server", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact(
			"example-mod",
			"machine",
			{ counter: null },
			publication({
				source: "derived",
				unknown: ["no state observed yet"],
			}),
		);
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value?.source).toBe("derived");
	});

	test("unknown 非空即 partial（字段缺失不伪装成完整）", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact(
			"example-mod",
			"machine",
			{ counter: null },
			publication({
				unknown: ["server did not report a numeric counter"],
			}),
		);
		const capture = h.facts.sample((view) => view.addonFact("example-mod", "machine"));
		expect(capture.value?.coverage).toBe("partial");
		expect(capture.value?.unknown).toEqual(["server did not report a numeric counter"]);
	});

	test("未发布过的 key 是 null（不是空对象/零值）", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("非纯 JSON 值被拒绝，不写入半成品", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => h.facts.publishAddonFact("example-mod", "machine", circular as JsonValue, publication())).toThrow(
			/not a plain JSON value/,
		);
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("断线清空；重连后旧事实不会串到新连接", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: 7 }, publication());
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value?.value).toEqual({ counter: 7 });

		h.disconnect();
		h.reconnect();
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("没有活客户端时发布被丢弃（不缓存给下一次连接）", () => {
		const h = makeFactsHarness({ state: "connecting", bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: 9 }, publication());
		h.reconnect();
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("返回副本：调用方改不动已发布事实", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: 1 }, publication());
		const first = h.facts.sample((view) => view.addonFact("example-mod", "machine")).value;
		(first?.value as { counter: number }).counter = 99;
		const second = h.facts.sample((view) => view.addonFact("example-mod", "machine")).value;
		expect(second?.value).toEqual({ counter: 1 });
	});

	test("换代只清 incarnation 域；服务器范围事实保留且视图仍可读", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "body", { health: 20 }, publication({ scope: "incarnation" }));
		h.facts.publishAddonFact("example-mod", "machine", { counter: 3 }, publication({ scope: "connection" }));
		h.changeIncarnation("inc:t:2");
		expect(h.facts.sample((view) => view.addonFact("example-mod", "body")).value).toBeNull();
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value?.value).toEqual({ counter: 3 });
	});

	test("换代后旧采集身份的迟到发布被拒绝", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.changeIncarnation("inc:t:2");
		h.facts.publishAddonFact("example-mod", "machine", { counter: 99 }, publication());
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("跨服后旧采集身份的迟到发布被拒绝", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.setIdentity("conn:t:2", "inc:t:2");
		h.facts.publishAddonFact("example-mod", "machine", { counter: 99 }, publication());
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("新采集身份发布的服务器范围事实绑定新连接，来源按证据保留", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.setIdentity("conn:t:2", "inc:t:2");
		h.reconnect();
		h.facts.publishAddonFact(
			"example-mod",
			"machine",
			{ counter: 5 },
			publication({
				origin: { connection: "conn:t:2", incarnation: "inc:t:2" },
				source: "derived",
			}),
		);
		const fact = h.facts.sample((view) => view.addonFact("example-mod", "machine")).value;
		expect(fact?.connection).toBe("conn:t:2");
		expect(fact?.incarnation).toBe("inc:t:2");
		expect(fact?.source).toBe("derived");
	});
});

describe("视图按作用域验证", () => {
	const factOf = (value: JsonValue): Fact<JsonValue> => ({
		value,
		observedAt: "2026-01-01T00:00:00.000Z",
		connection: "conn:v:1",
		incarnation: "inc:v:1",
		source: "server",
		coverage: "complete",
		unknown: [],
		evidence: [],
	});

	function viewOf(options: {
		connection: string;
		incarnation: string;
		scope: "connection" | "incarnation";
		originIncarnation: string;
	}) {
		const entry = {
			fact: factOf({ counter: 1 }),
			scope: options.scope,
			origin: { connection: "conn:v:1", incarnation: options.originIncarnation },
		};
		return createView({
			stamp: { connection: options.connection, incarnation: options.incarnation },
			addonFacts: new Map([["a/b", entry]]),
		} as unknown as FactViewContext);
	}

	test("换代后 incarnation 域即使仍在表里也不可见", () => {
		expect(
			viewOf({
				connection: "conn:v:1",
				incarnation: "inc:v:2",
				scope: "incarnation",
				originIncarnation: "inc:v:1",
			}).addonFact("a", "b"),
		).toBeNull();
	});

	test("换代后 connection 域仍可见", () => {
		expect(
			viewOf({
				connection: "conn:v:1",
				incarnation: "inc:v:2",
				scope: "connection",
				originIncarnation: "inc:v:1",
			}).addonFact("a", "b")?.value,
		).toEqual({ counter: 1 });
	});

	test("跨连接任何作用域都不可见", () => {
		expect(
			viewOf({
				connection: "conn:v:2",
				incarnation: "inc:v:1",
				scope: "connection",
				originIncarnation: "inc:v:1",
			}).addonFact("a", "b"),
		).toBeNull();
	});
});
