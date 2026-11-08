import { describe, expect, test } from "vitest";
import type { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import type { DriverProtocol } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";
import { createConnectionPort } from "../../.uina/worlds/minecraft/driver/protocol-extension.js";
import type { ConnectionFactSink } from "../../.uina/worlds/minecraft/contracts/protocol.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

/**
 * 连接级协议扩展（addons.md §3.2）。
 *
 * 两件事必须成立：
 * 1. 事实是**连接绑定**的：断线清空、旧连接迟到的发布不写进新连接；
 * 2. 订阅有明确生命周期：dispose 后不再回调，换代后的迟到消息被丢弃。
 * 这两条是"非原版服务器状态不能被伪造/串台"的底线。
 */

function readyHost(): ClientHost {
	return {
		state: "ready",
		identity: { connection: "conn:t:1", incarnation: "inc:t:1" },
		bot: null,
	} as unknown as ClientHost;
}

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
	const published: { addonId: string; key: string; value: JsonValue; unknown?: string[] }[] = [];
	const facts: ConnectionFactSink = {
		publishAddonFact: (addonId, key, value, unknown) => {
			published.push({ addonId, key, value, ...(unknown === undefined ? {} : { unknown }) });
		},
	};
	let current = true;
	const port = createConnectionPort({
		addonId: "example-mod",
		host: readyHost(),
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
		const seen: string[] = [];
		h.port.onCustomPayload("uina:example", () => seen.push("late"));
		h.port.publishFact("machine", { counter: 1 });
		expect(h.published).toHaveLength(1);

		h.stale();
		h.protocol.emit("uina:example", "{}");
		h.port.publishFact("machine", { counter: 2 });
		expect(seen).toEqual([]);
		expect(h.published).toHaveLength(1);
	});

	test("isCurrent 在订阅建立后变 false：回调被丢弃（不写进新连接）", () => {
		const h = harness();
		h.stale();
		const seen: string[] = [];
		h.port.onCustomPayload("uina:example", () => seen.push("x"));
		// 已退役的连接不再向协议写入登记。
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

describe("addon facts：连接绑定，断线即失效", () => {
	test("发布后可按 addonId/key 读取；来源是 server，绑定当前连接", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", {
			counter: 3,
			item: "example:uina_token",
			serverTime: "t0",
		});
		const capture = h.facts.sample((view) => view.addonFact("example-mod", "machine"));
		expect(capture.value?.value).toEqual({ counter: 3, item: "example:uina_token", serverTime: "t0" });
		expect(capture.value?.source).toBe("server");
		expect(capture.value?.coverage).toBe("complete");
		expect(capture.value?.connection).toBe("conn:t:1");
		expect(capture.value?.incarnation).toBe("inc:t:1");
	});

	test("unknown 非空即 partial（字段缺失不伪装成完整）", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: null }, ["server did not report a numeric counter"]);
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
		expect(() => h.facts.publishAddonFact("example-mod", "machine", circular as JsonValue)).toThrow(
			/not a plain JSON value/,
		);
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("断线清空；重连后旧事实不会串到新连接", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: 7 });
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value?.value).toEqual({ counter: 7 });

		h.disconnect();
		h.reconnect();
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("没有活客户端时发布被丢弃（不缓存给下一次连接）", () => {
		const h = makeFactsHarness({ state: "connecting", bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: 9 });
		h.reconnect();
		expect(h.facts.sample((view) => view.addonFact("example-mod", "machine")).value).toBeNull();
	});

	test("返回副本：调用方改不动已发布事实", () => {
		const h = makeFactsHarness({ bot: makeBot() });
		h.facts.publishAddonFact("example-mod", "machine", { counter: 1 });
		const first = h.facts.sample((view) => view.addonFact("example-mod", "machine")).value;
		(first?.value as { counter: number }).counter = 99;
		const second = h.facts.sample((view) => view.addonFact("example-mod", "machine")).value;
		expect(second?.value).toEqual({ counter: 1 });
	});
});
