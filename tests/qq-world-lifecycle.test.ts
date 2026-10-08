import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQqWorld } from "../.uina/worlds/qq/src/index.js";
import type { QqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import type {
	QqTransport,
	TransportCallOutcome,
	TransportEventHandler,
	TransportStatusHandler,
} from "../.uina/worlds/qq/src/transport.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import type { WorldEvent } from "../src/extensions/world-framework/types.js";

const SELF = "10001";

function makeConfig(selfId = SELF): QqWorldConfig {
	return {
		connection: {
			url: "ws://127.0.0.1:3001",
			role: "Universal",
			accessToken: "tok",
			requestTimeoutMs: 200,
			reconnect: { retries: 0, minDelayMs: 10, maxDelayMs: 20 },
		},
		selfId,
		grants: { grants: ["observation", "messaging"] },
	};
}

class StubTransport implements QqTransport {
	started = 0;
	stopped = 0;
	readonly eventHandlers = new Set<TransportEventHandler>();
	readonly rawHandlers = new Set<TransportEventHandler>();
	readonly calls: { action: string; params?: Record<string, unknown> }[] = [];
	constructor(private readonly selfId: number) {}
	start(): Promise<{ selfId: number }> {
		this.started++;
		return Promise.resolve({ selfId: this.selfId });
	}
	stop(): Promise<void> {
		this.stopped++;
		return Promise.resolve();
	}
	call(action: string, params?: Record<string, unknown>): Promise<TransportCallOutcome> {
		this.calls.push({ action, params });
		return Promise.resolve({ status: "ok", data: {} });
	}
	onEvent(handler: TransportEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}
	onRaw(handler: TransportEventHandler): () => void {
		this.rawHandlers.add(handler);
		return () => this.rawHandlers.delete(handler);
	}
	/** 测试注入迟到回执 raw 帧。 */
	emitRaw(raw: string): void {
		for (const handler of [...this.rawHandlers]) handler(raw);
	}
	private statusHandlers = new Set<TransportStatusHandler>();
	onStatus(h: TransportStatusHandler): () => void {
		this.statusHandlers.add(h);
		return () => this.statusHandlers.delete(h);
	}
	emitStatus(status: { connected: boolean; error?: string }): void {
		for (const h of [...this.statusHandlers]) h(status);
	}
	/** 测试注入平台事件。 */
	emit(event: unknown): void {
		for (const handler of [...this.eventHandlers]) handler(event);
	}
}

function makeContext(): { ctx: ServiceCompanionContext; worldEvents: WorldEvent[]; dataDir: string } {
	const worldEvents: WorldEvent[] = [];
	const dataDir = mkdtempSync(join(tmpdir(), "uina-qq-world-"));
	const ctx: ServiceCompanionContext = {
		signal: new AbortController().signal,
		submitInput: async () => {},
		emitEvent: async (event) => {
			worldEvents.push(event);
		},
		isBusy: () => false,
		worldDataDir: dataDir,
	};
	return { ctx, worldEvents, dataDir };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("QQ World 装配与生命周期（G7）", () => {
	it("身份核验通过：传输启动一次，停止后释放", async () => {
		const transport = new StubTransport(Number(SELF));
		const world = createQqWorld({ config: makeConfig(), transport });
		const { ctx, dataDir } = makeContext();
		try {
			await world.onStart?.(ctx);
			expect(transport.started).toBe(1);
			expect(world.actions.observe).toBeDefined();
			expect(world.actions.speak).toBeDefined();
			expect(world.executionMode).toBe("sequential");
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
		expect(transport.stopped).toBe(1);
	});

	it("新账号目录隔离旧日志，当前账号写入工具说明且重启不重复", async () => {
		const transport = new StubTransport(Number(SELF));
		const world = createQqWorld({ config: makeConfig(), transport });
		const { ctx, dataDir } = makeContext();
		const legacyPath = join(dataDir, "qq-facts.jsonl");
		const legacy = "unreadable legacy data preserved";
		writeFileSync(legacyPath, legacy);
		try {
			await world.onStart?.(ctx);
			expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
			expect(existsSync(join(dataDir, "v2", SELF, "qq-facts.jsonl"))).toBe(true);
			expect(world.description).toContain(SELF);
			const description = world.description;
			await world.onStop?.(ctx);
			await world.onStart?.(ctx);
			expect(world.description).toBe(description);
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("登录身份不符：启动失败且不开放平台写入", async () => {
		const transport = new StubTransport(99999);
		const world = createQqWorld({ config: makeConfig(), transport });
		const { ctx, dataDir } = makeContext();
		try {
			await expect(world.onStart?.(ctx)).rejects.toThrow(/不符/);
			expect(transport.stopped).toBe(1); // 不匹配即断开
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("平台事件 → 摄取 → 调度 → 一条世界事件；停止后不再派发", async () => {
		vi.useFakeTimers();
		const transport = new StubTransport(Number(SELF));
		const world = createQqWorld({ config: makeConfig(), transport });
		const { ctx, worldEvents, dataDir } = makeContext();
		try {
			await world.onStart?.(ctx);
			transport.emit({
				post_type: "message",
				message_type: "private",
				sub_type: "friend",
				time: 1791468000,
				self_id: 10001,
				message_id: 42,
				user_id: 20002,
				message: [{ type: "text", data: { text: "在不？" } }],
				raw_message: "在不？",
				font: 0,
				sender: { user_id: 20002, nickname: "小明" },
			});
			// 私聊 quiet 窗口 700ms
			await vi.advanceTimersByTimeAsync(1000);
			expect(worldEvents).toHaveLength(1);
			expect(worldEvents[0]!.text).toContain("p20002");
			expect(worldEvents[0]!.origin).toBe("external");

			// 停止后不再派发
			await world.onStop?.(ctx);
			transport.emit({
				post_type: "message",
				message_type: "private",
				sub_type: "friend",
				time: 1791469000,
				self_id: 10001,
				message_id: 43,
				user_id: 20002,
				message: [],
				raw_message: "",
				font: 0,
				sender: { user_id: 20002, nickname: "小明" },
			});
			await vi.advanceTimersByTimeAsync(5000);
			expect(worldEvents).toHaveLength(1);
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

describe("QQ World 发现与配置失败可见性", () => {
	it("工厂阶段无配置也不抛错（world 必须可被发现注册）", () => {
		expect(() => createQqWorld()).not.toThrow();
	});

	it("onStart 阶段配置非法：明确失败且原因可见（注入临时非法配置，不碰真实端口）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "uina-qq-world-"));
		const configPath = join(dir, "bad-config.json");
		writeFileSync(configPath, JSON.stringify({ connection: { url: "ws://127.0.0.1:1" }, selfId: 10001 }));
		const world = createQqWorld({ configPath });
		const ctx: ServiceCompanionContext = {
			signal: new AbortController().signal,
			worldDataDir: dir,
		};
		try {
			await expect(world.onStart?.(ctx)).rejects.toThrow(/配置加载失败/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("审查修复回归：断线/恢复与迟到回执接线", () => {
	it("断线提醒一次、恢复只对已报故障；迟到回执凭 echo 升级 unknown", async () => {
		vi.useFakeTimers();
		const transport = new StubTransport(Number(SELF));
		const world = createQqWorld({ config: makeConfig(), transport });
		const { ctx, worldEvents, dataDir } = makeContext();
		try {
			await world.onStart?.(ctx);
			const rawHandlers: TransportEventHandler[] = [];
			// 这里直接驱动 status 通道验证一次性语义。
			transport.emitStatus({ connected: false, error: "boom" });
			transport.emitStatus({ connected: false });
			transport.emitStatus({ connected: true });
			transport.emitStatus({ connected: true });
			await vi.advanceTimersByTimeAsync(2000);
			const kinds = worldEvents.map((e) => (e as { text?: string }).text ?? "");
			const disconnects = worldEvents.filter((e) => e.text?.includes("transport_disconnected"));
			const recoveries = worldEvents.filter((e) => e.text?.includes("transport_recovered"));
			expect(disconnects).toHaveLength(1);
			expect(recoveries).toHaveLength(1);
			void kinds;
			void rawHandlers;
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

describe("部署边界：grant 过滤下沉摄取层", () => {
	it("未授 observation：平台事实不入库、不产生自动机会；messaging 显式动作仍可用", async () => {
		const config: QqWorldConfig = { ...makeConfig(), grants: { grants: ["messaging"] } };
		const transport = new StubTransport(Number(SELF));
		const { ctx, worldEvents, dataDir } = makeContext();
		const world = createQqWorld({ config, transport });
		try {
			await world.onStart?.(ctx);
			// 平台群消息到达：不入库、无候选、无世界事件（ingest 同步抑制）
			transport.emit({
				post_type: "message",
				message_type: "group",
				message_id: 9001,
				group_id: 30003,
				user_id: 20002,
				self_id: Number(SELF),
				time: Math.floor(Date.parse("2026-10-08T03:00:00Z") / 1000),
				sender: { user_id: 20002, nickname: "小明", card: "" },
				message: [{ type: "text", data: { text: "群消息正文" } }],
			});
			expect(worldEvents).toHaveLength(0);
			expect(existsSync(join(dataDir, "qq-facts.jsonl"))).toBe(false);
			expect(readFileSync(join(dataDir, "v2", SELF, "qq-facts.jsonl"), "utf8").includes("群消息正文")).toBe(false);
			// messaging 显式动作不受影响：speak 走 grant 检查并派发平台调用
			const speak = world.actions.speak!;
			const result = (await speak.run(
				{ account: SELF, conversationRef: `p20002`, content: [{ type: "text", text: "hi" }] },
				{ operationIdentity: "world:qq/speak", signal: new AbortController().signal },
			)) as { status: string };
			expect(result.status).toBe("succeeded");
			expect(transport.calls.some((c) => c.action === "send_private_msg")).toBe(true);
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("recall 相关性（装配注入）：自身发言被撤唤醒；无关撤回不唤醒", async () => {
		const transport = new StubTransport(Number(SELF));
		const world = createQqWorld({ config: makeConfig(), transport });
		const { ctx, worldEvents, dataDir } = makeContext();
		const t = Math.floor(Date.parse("2026-10-08T03:00:00Z") / 1000);
		try {
			await world.onStart?.(ctx);
			// 他人普通群消息 → ordinary 候选（窗口未到，暂不派发）
			transport.emit({
				post_type: "message",
				message_type: "group",
				message_id: 1,
				group_id: 30003,
				user_id: 20002,
				self_id: Number(SELF),
				time: t,
				sender: { user_id: 20002, nickname: "小明", card: "" },
				message: [{ type: "text", data: { text: "群消息" } }],
			});
			// 无关撤回（消息未持有、无证据引用、无连续性窗口）→ 不唤醒
			transport.emit({
				post_type: "notice",
				notice_type: "group_recall",
				group_id: 30003,
				user_id: 20003,
				operator_id: 20003,
				message_id: 999,
				self_id: Number(SELF),
				time: t + 1,
			});
			// 自己发言（message_sent 回送）→ 不唤醒
			transport.emit({
				post_type: "message_sent",
				message_type: "group",
				message_id: 2,
				group_id: 30003,
				user_id: Number(SELF),
				self_id: Number(SELF),
				time: t + 2,
				sender: { user_id: Number(SELF), nickname: "我", card: "" },
				message: [{ type: "text", data: { text: "我的发言" } }],
			});
			// 撤回自己的发言 → 唤醒（direct 短窗口）
			transport.emit({
				post_type: "notice",
				notice_type: "group_recall",
				group_id: 30003,
				user_id: Number(SELF),
				operator_id: Number(SELF),
				message_id: 2,
				self_id: Number(SELF),
				time: t + 3,
			});
			await new Promise((r) => setTimeout(r, 1500));
			const recalls = worldEvents.filter((e) => e.text?.includes("trigger=recall"));
			expect(recalls).toHaveLength(1);
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("迟到回执升级已交付的 unknown → 通知主体；在途回执不通知", async () => {
		const transport = new StubTransport(Number(SELF));
		const config: QqWorldConfig = { ...makeConfig() };
		// speak 超时 → 工具结果 unknown（已交付），echo=operationRef 留待 raw 归并
		transport.call = () => Promise.resolve({ status: "failed", reason: "timed out", kind: "timeout" as const });
		const world = createQqWorld({ config, transport });
		const { ctx, worldEvents, dataDir } = makeContext();
		try {
			await world.onStart?.(ctx);
			const speak = world.actions.speak!;
			const result = (await speak.run(
				{ account: SELF, conversationRef: `p20002`, content: [{ type: "text", text: "hi" }] },
				{ operationIdentity: "world:qq/speak", signal: new AbortController().signal },
			)) as { status: string; result: string };
			expect(result.status).toBe("unknown");
			const operationRef = /operationRef=(o\d+)/.exec(result.result)?.[1];
			expect(operationRef).toBeDefined();
			// unknown 交付前无 operations 更新事件
			expect(worldEvents.filter((e) => e.text?.includes("[QQ 操作回执更新]"))).toHaveLength(0);
			// 迟到回执凭 echo 升级 → internal 通知
			transport.emitRaw(
				JSON.stringify({ echo: `${SELF}/${operationRef}`, status: "ok", retcode: 0, data: { message_id: 55 } }),
			);
			await new Promise((r) => setTimeout(r, 2200));
			const updates = worldEvents.filter((e) => e.text?.includes("[QQ 操作回执更新]"));
			expect(updates).toHaveLength(1);
			expect(updates[0]!.text).toContain(`ref=${operationRef}`);
		} finally {
			await world.onStop?.(ctx);
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
