/**
 * MC 测试用最小宿主替身：只实现 FactsSource / PlayerPort 实际触达的成员。
 *
 * 不是通用 mock：断言依赖"未实现即缺失"的语义（例如没有 blockAt 时 inWater 必须
 * 退化为 unknown），因此替身只提供显式 overrides 给出的字段。
 */

import type { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";
import { FactsSource } from "../../.uina/worlds/minecraft/driver/facts/index.js";

type Handler = (...args: unknown[]) => void;

export interface FakeBot {
	username: string;
	inventory: {
		slots: unknown[];
		on(event: string, fn: () => void): void;
		removeListener(event: string, fn: () => void): void;
		/** 触发已注册的槽位更新监听（updateSlot）。 */
		emit(): void;
	};
	on(event: string, fn: Handler): void;
	removeListener(event: string, fn: Handler): void;
	emit(event: string, ...args: unknown[]): void;
	[key: string]: unknown;
}

export function makeBot(overrides: Record<string, unknown> = {}): FakeBot {
	const handlers = new Map<string, Set<Handler>>();
	const invHandlers = new Set<() => void>();
	const clientHandlers = new Map<string, Set<Handler>>();
	const bot: FakeBot = {
		username: "uina",
		inventory: {
			slots: [],
			on: (_event, fn) => invHandlers.add(fn),
			removeListener: (_event, fn) => invHandlers.delete(fn),
			// 触发库存槽位更新（FactsSource 注册的 updateSlot 监听）。
			emit: () => {
				for (const fn of [...invHandlers]) fn();
			},
		},
		// 协议窄口挂在 _client 上：替身默认无事件（未实现即缺失），map 等测试显式 emit。
		_client: {
			on: (event: string, fn: Handler) => {
				const set = clientHandlers.get(event) ?? new Set<Handler>();
				set.add(fn);
				clientHandlers.set(event, set);
			},
			removeListener: (event: string, fn: Handler) => {
				clientHandlers.get(event)?.delete(fn);
			},
			emit: (event: string, ...args: unknown[]) => {
				for (const fn of [...(clientHandlers.get(event) ?? [])]) fn(...args);
			},
		},
		on: (event, fn) => {
			const set = handlers.get(event) ?? new Set<Handler>();
			set.add(fn);
			handlers.set(event, set);
		},
		removeListener: (event, fn) => {
			handlers.get(event)?.delete(fn);
		},
		emit: (event, ...args) => {
			for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
		},
		...overrides,
	};
	return bot;
}

export type HostState = "connecting" | "syncing" | "ready" | "disconnected" | "faulted";

export interface FactsHarness {
	facts: FactsSource;
	/** 改变连接状态并通知订阅者（与 ClientHost 的 state 通知同形）。 */
	setState(state: HostState): void;
	/** 连上一条新连接：换 bot 并回到 ready。 */
	reconnect(bot?: FakeBot): void;
	disconnect(): void;
	bot(): FakeBot;
	emitMessage(text: string): void;
	/** 换代但不断线：更新身份并发出 incarnation_changed。 */
	changeIncarnation(incarnation: string): void;
	/** 换服：更新连接与化身身份（不自动发通知，由调用方显式 setState/reconnect）。 */
	setIdentity(connection: string, incarnation: string): void;
}

export function makeFactsHarness(
	options: {
		bot?: FakeBot;
		state?: HostState;
		dimension?: string | null;
		namespace?: string;
		/** ClientHost.disconnectFacts 的替身；断线证据捕获会读取它。 */
		disconnectFacts?: { reason: string | null } | null;
	} = {},
): FactsHarness {
	const listeners = new Set<(notice: unknown) => void>();
	let state: HostState = options.state ?? "ready";
	let bot = options.bot ?? makeBot();
	let connection = "conn:t:1";
	let incarnation = "inc:t:1";
	const notify = (notice: unknown): void => {
		for (const fn of [...listeners]) fn(notice);
	};
	const host = {
		get state() {
			return state;
		},
		get identity() {
			return state === "ready" ? { connection, incarnation } : null;
		},
		get bot() {
			return state === "ready" ? bot : null;
		},
		get dimension() {
			return options.dimension === undefined ? "overworld" : options.dimension;
		},
		get disconnectFacts() {
			return options.disconnectFacts ?? null;
		},
		on: (fn: (notice: unknown) => void) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
	const facts = new FactsSource(host as unknown as ClientHost, {
		binding: "bind:t:1",
		world: "world:t:1",
		worldRevision: "wrev:t:1",
		streamNamespace: options.namespace ?? "t",
	});
	return {
		facts,
		setState: (next) => {
			state = next;
			notify({ kind: "state", state: next });
		},
		reconnect: (nextBot) => {
			if (nextBot != null) bot = nextBot;
			state = "ready";
			notify({ kind: "state", state: "ready" });
		},
		disconnect: () => {
			state = "disconnected";
			notify({ kind: "state", state: "disconnected" });
		},
		bot: () => bot,
		emitMessage: (text) => {
			bot.emit("messagestr", text, null, { text }, "someone");
		},
		changeIncarnation: (next) => {
			incarnation = next;
			notify({ kind: "incarnation_changed", identity: { connection, incarnation } });
		},
		setIdentity: (nextConnection, nextIncarnation) => {
			connection = nextConnection;
			incarnation = nextIncarnation;
		},
	};
}
