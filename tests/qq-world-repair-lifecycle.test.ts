import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { QqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { createQqWorld } from "../.uina/worlds/qq/src/index.js";
import type { QqTransport, TransportEventHandler } from "../.uina/worlds/qq/src/transport.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";

it("startup enrichment cannot miss committed input settlement or strand the scheduler", async () => {
	vi.useFakeTimers();
	const dir = mkdtempSync(join(tmpdir(), "qq-startup-repair-"));
	let eventHandler: TransportEventHandler = () => {};
	const hostHandlers: ((event: unknown) => void)[] = [],
		texts: string[] = [];
	const msg = (id: number) => ({
		post_type: "message",
		message_type: "private",
		self_id: 10001,
		user_id: 20002,
		message_id: id,
		// 每条间隔 601s：msg2 走私聊沉寂复苏穿透（§5.1 规则③），兼作"调度器未被搁浅"探针
		time: 1791453600 + (id - 1) * 601,
		sender: { user_id: 20002, nickname: "甲" },
		message: [{ type: "text", data: { text: `消息${id}` } }],
	});
	const config: QqWorldConfig = {
		selfId: "10001",
		grants: { grants: ["observation"] },
		connection: {
			url: "ws://example.test",
			role: "Universal",
			accessToken: "fake",
			requestTimeoutMs: 10000,
			reconnect: { retries: 0, minDelayMs: 1, maxDelayMs: 1 },
		},
	};
	const transport: QqTransport = {
		start: async () => {
			eventHandler(msg(1));
			return { selfId: 10001 };
		},
		stop: async () => {},
		onEvent: (h) => {
			eventHandler = h;
			return () => {};
		},
		onRaw: () => () => {},
		onStatus: () => () => {},
		call: async () => {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			return { status: "ok", data: { packs: [{ emojis: [{ q_sid: "14", q_des: "微笑" }] }] } };
		},
	};
	const context = {
		signal: new AbortController().signal,
		worldDataDir: dir,
		isBusy: () => false,
		onHostEvent: (h: (event: unknown) => void) => {
			hostHandlers.push(h);
			return () => {};
		},
		emitEvent: async (e: { id: string; text: string; render?: () => Promise<string | null> }) => {
			// 延迟渲染（§5.3）：真实投递为占位 + render 闭包，测试在 emitEvent 内求值近似出队
			texts.push((await e.render?.()) ?? e.text ?? "");
			for (const h of hostHandlers) h({ type: "input_settled", inputId: e.id, outcome: "committed" });
		},
	} as unknown as ServiceCompanionContext;
	const world = createQqWorld({ config, transport });
	try {
		const started = world.onStart!(context);
		await vi.advanceTimersByTimeAsync(2500);
		await started;
		// msg1 已派发且结算已推进书签
		expect(texts).toHaveLength(1);
		eventHandler(msg(2));
		await vi.advanceTimersByTimeAsync(2500);
		// msg2 复苏穿透派发；不含消息1 恰好证明结算已推进（否则会作为新鲜正文重复呈现）
		expect(texts).toHaveLength(2);
		expect(texts[1]).toContain("消息2");
		expect(texts[1]).not.toContain("消息1");
	} finally {
		await world.onStop!(context);
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("World stop disposes transport subscriptions and a late startup completion cannot recreate timers", async () => {
	vi.useFakeTimers();
	const dir = mkdtempSync(join(tmpdir(), "qq-stop-repair-"));
	const handlers = new Map<string, Set<unknown>>();
	function subscribe(name: string, handler: unknown): () => void {
		const values = handlers.get(name) ?? new Set();
		values.add(handler);
		handlers.set(name, values);
		return () => {
			values.delete(handler);
		};
	}
	let finish: (value: { status: "ok"; data: unknown }) => void = () => {};
	const config: QqWorldConfig = {
		selfId: "10001",
		grants: { grants: ["observation"] },
		connection: {
			url: "ws://example.test",
			role: "Universal",
			accessToken: "fake",
			requestTimeoutMs: 100,
			reconnect: { retries: 0, minDelayMs: 1, maxDelayMs: 1 },
		},
	};
	const transport: QqTransport = {
		start: async () => ({ selfId: 10001 }),
		stop: async () => {},
		onEvent: (h) => subscribe("event", h),
		onRaw: (h) => subscribe("raw", h),
		onStatus: (h) => subscribe("status", h),
		call: async () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	};
	const context = { signal: new AbortController().signal, worldDataDir: dir } as ServiceCompanionContext;
	const world = createQqWorld({ config, transport });
	try {
		const started = world.onStart!(context);
		const rejected = expect(started).rejects.toThrow(/停止|取消/);
		await vi.advanceTimersByTimeAsync(1);
		await world.onStop!(context);
		finish({ status: "ok", data: { packs: [] } });
		await rejected;
		expect([...handlers.values()].map((s) => s.size)).toEqual([0, 0, 0]);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await world.onStop!(context);
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	}
});
