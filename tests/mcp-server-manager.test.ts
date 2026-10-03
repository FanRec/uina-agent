import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkErrorCode, SdkHttpError, type Transport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpCatalog } from "../.uina/extensions/mcp/catalog.js";
import type { ResolvedServerConfig } from "../.uina/extensions/mcp/config.js";
import {
	isLegacyTransportCompatibilityError,
	McpServerManager,
	McpSupersededError,
} from "../.uina/extensions/mcp/server-manager.js";
import { FakeMcpServer } from "./mcp-helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "uina-mcp-manager-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeServer(name: string, fingerprint = `fp-${name}`): ResolvedServerConfig {
	return {
		name,
		definition: { command: "unused" },
		source: "global",
		sourcePath: "test://mcp.json",
		fingerprint,
	};
}

interface Harness {
	catalog: McpCatalog;
	manager: McpServerManager;
	/** 已被消费（建连）的 fake server，按消费顺序排列。 */
	servers: FakeMcpServer[];
	/** 预置的 fake server：createTransport 优先取用，保证测试能在建连前配置它。 */
	pending: FakeMcpServer[];
	errors: string[];
}

function makeHarness(): Harness {
	const errors: string[] = [];
	const catalog = new McpCatalog(join(dir, "mcp-catalog.json"));
	const servers: FakeMcpServer[] = [];
	const pending: FakeMcpServer[] = [new FakeMcpServer()];
	const manager = new McpServerManager({
		catalog,
		version: "0.1.0",
		onError: (message) => errors.push(message),
		createTransport: () => {
			const server = pending.shift() ?? new FakeMcpServer();
			servers.push(server);
			return { transport: server.clientTransport, kind: "in-memory" };
		},
	});
	return { catalog, manager, servers, pending, errors };
}

describe("isLegacyTransportCompatibilityError 守门谓词", () => {
	it("仅 404/405/406/415 允许退避 SSE", () => {
		for (const status of [404, 405, 406, 415]) {
			const error = new SdkHttpError(SdkErrorCode.ConnectionClosed, "http", { status });
			expect(isLegacyTransportCompatibilityError(error)).toBe(true);
		}
	});

	it("认证错误、5xx、其余状态码一律拒绝退避", () => {
		for (const status of [400, 401, 403, 429, 500, 503]) {
			const error = new SdkHttpError(SdkErrorCode.ConnectionClosed, "http", { status });
			expect(isLegacyTransportCompatibilityError(error)).toBe(false);
		}
	});

	it("非 SdkHttpError 一律 false", () => {
		expect(isLegacyTransportCompatibilityError(new Error("timeout"))).toBe(false);
		expect(isLegacyTransportCompatibilityError("404")).toBe(false);
		expect(isLegacyTransportCompatibilityError(undefined)).toBe(false);
	});
});

describe("ensureClient 建连", () => {
	it("auto HTTP 仅在兼容错误时用全新 transport 退避 SSE", async () => {
		const fallbackServer = new FakeMcpServer();
		let attempts = 0;
		const manager = new McpServerManager({
			catalog: new McpCatalog(join(dir, "http-catalog.json")),
			version: "0.1.0",
			onError: () => {},
			createTransport: () => {
				attempts += 1;
				if (attempts === 1) {
					return {
						kind: "streamable-http",
						transport: {
							start: async () => {
								throw new SdkHttpError(SdkErrorCode.ConnectionClosed, "http", { status: 404 });
							},
							close: async () => {},
							send: async () => {},
						} as unknown as Transport,
					};
				}
				return { transport: fallbackServer.clientTransport, kind: "sse" };
			},
		});
		const server: ResolvedServerConfig = {
			name: "http",
			definition: { url: "https://example.test/mcp", httpTransport: "auto" },
			source: "global",
			sourcePath: "test://mcp.json",
			fingerprint: "fp-http",
		};
		const connection = await manager.ensureClient(server, 600_000, undefined);
		expect(attempts).toBe(2);
		expect(connection.transportKind).toBe("sse");
		await manager.dispose();
	});

	it("建连后 running，transportKind in-memory，抓取 instructions", async () => {
		const { manager, pending } = makeHarness();
		pending[0]!.instructions = "be helpful";
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		expect(manager.connectionState("a")).toEqual({ state: "running", inFlight: 0 });
		expect(connection.transportKind).toBe("in-memory");
		expect(connection.instructions).toBe("be helpful");
		await manager.dispose();
	});

	it("同指纹复用既有连接", async () => {
		const { manager } = makeHarness();
		const first = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		const second = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		expect(second).toBe(first);
		await manager.dispose();
	});

	it("并发同指纹共享同一次建连", async () => {
		const { manager } = makeHarness();
		const [first, second] = await Promise.all([
			manager.ensureClient(makeServer("a"), 600_000, undefined),
			manager.ensureClient(makeServer("a"), 600_000, undefined),
		]);
		expect(second).toBe(first);
		await manager.dispose();
	});

	it("成功重连后清除上一代建连错误", async () => {
		const server = new FakeMcpServer();
		let attempts = 0;
		const manager = new McpServerManager({
			catalog: new McpCatalog(join(dir, "retry-catalog.json")),
			version: "0.1.0",
			onError: () => {},
			createTransport: () => {
				attempts++;
				if (attempts === 1) {
					return {
						kind: "in-memory",
						transport: {
							start: async () => {
								throw new Error("first start failed");
							},
							close: async () => {},
							send: async () => {},
						} as unknown as Transport,
					};
				}
				return { transport: server.clientTransport, kind: "in-memory" };
			},
		});
		await expect(manager.ensureClient(makeServer("a"), 600_000, undefined)).rejects.toThrow("first start failed");
		expect(manager.lastError("a")).toContain("first start failed");
		await manager.ensureClient(makeServer("a"), 600_000, undefined);
		expect(manager.lastError("a")).toBeUndefined();
		await manager.dispose();
	});

	it("startup 超时参数透传（握手正常完成）", async () => {
		const { manager } = makeHarness();
		const connection = await manager.ensureClient(makeServer("a"), 600_000, 10_000);
		expect(manager.connectionState("a").state).toBe("running");
		expect(connection).toBeDefined();
		await manager.dispose();
	});

	it("跨代建连：配置变更后旧连接结算即 superseded", async () => {
		const { manager, pending } = makeHarness();
		const gate = pending[0]!.hold("initialize");
		const first = manager.ensureClient(makeServer("a"), 600_000, undefined);
		await gate.whenCalled;
		const second = await manager.ensureClient(makeServer("a", "fp-a2"), 600_000, undefined);
		gate.release();
		await expect(first).rejects.toBeInstanceOf(McpSupersededError);
		expect(manager.connectionState("a").state).toBe("running");
		expect(manager.connectionState("a").inFlight).toBe(0);
		expect(second.generation).toBeGreaterThan(0);
		await manager.dispose();
	});

	it("旧 starting Promise 先结算也不得越过更新中的新代", async () => {
		const { manager, pending } = makeHarness();
		const gate = pending[0]!.hold("initialize");
		const first = manager.ensureClient(makeServer("a"), 600_000, undefined);
		await gate.whenCalled;

		// 第二代使用下一个 fixture，先完成；第一代随后结算时必须被丢弃。
		const second = await manager.ensureClient(makeServer("a", "fp-a2"), 600_000, undefined);
		gate.release();
		await expect(first).rejects.toBeInstanceOf(McpSupersededError);
		expect(manager.connectionState("a").state).toBe("running");
		expect(second.serverFingerprint).toBe("fp-a2");
		await manager.dispose();
	});

	it("dispose 后 ensureClient 拒绝", async () => {
		const { manager } = makeHarness();
		await manager.dispose();
		await expect(manager.ensureClient(makeServer("a"), 600_000, undefined)).rejects.toBeInstanceOf(McpSupersededError);
	});
});

describe("refreshCatalog 与 callTool", () => {
	it("refreshCatalog 拉取工具并 commit 到目录", async () => {
		const { catalog, manager, pending } = makeHarness();
		pending[0]!.tools = [
			{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
			{ name: "ping2", title: "Ping", inputSchema: { type: "object", properties: {} } },
		];
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		const outcome = await manager.refreshCatalog(makeServer("a"), connection);
		expect(outcome.status).toBe("ok");
		const committed = catalog.get("a");
		expect(committed?.serverFingerprint).toBe("fp-a");
		expect(committed?.tools.map((tool) => tool.name)).toEqual(["echo", "ping2"]);
		expect(committed?.fetchedAt).toBeGreaterThan(0);
		await manager.dispose();
	});

	it("SDK 无参 listTools 自动聚合完整分页", async () => {
		const { catalog, manager, pending } = makeHarness();
		pending[0]!.listPages = [
			[{ name: "first", inputSchema: { type: "object" } }],
			[{ name: "second", inputSchema: { type: "object" } }],
		];
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		await manager.refreshCatalog(makeServer("a"), connection);
		expect(catalog.get("a")?.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
		await manager.dispose();
	});

	it("同一 (server, fingerprint) 的并发刷新共享同一结果", async () => {
		const { manager } = makeHarness();
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		const [left, right] = await Promise.all([
			manager.refreshCatalog(makeServer("a"), connection),
			manager.refreshCatalog(makeServer("a"), connection),
		]);
		expect(left.status).toBe("ok");
		expect(right.status).toBe("ok");
		await manager.dispose();
	});

	it("刷新期间配置变更（draining）→ superseded，不落盘", async () => {
		const { catalog, manager, servers } = makeHarness();
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		const gate = servers[0]!.hold("tools/list");
		const refreshing = manager.refreshCatalog(makeServer("a"), connection);
		await gate.whenCalled;
		// 配置变更：旧连接转 draining（inFlight=1 延迟关闭），新连接注册。
		const replacement = await manager.ensureClient(makeServer("a", "fp-a2"), 600_000, undefined);
		expect(connection.draining).toBe(true);
		gate.release();
		const outcome = await refreshing;
		expect(outcome.status).toBe("superseded");
		expect(outcome.entry?.tools).toBeDefined();
		expect(catalog.get("a")).toBeUndefined();
		expect(manager.connectionState("a").state).toBe("running");
		expect(replacement.generation).toBeGreaterThan(connection.generation);
		await manager.dispose();
	});

	it("tools/list_changed 走统一 refreshCatalog 并替换完整快照", async () => {
		const { catalog, manager, pending, servers } = makeHarness();
		pending[0]!.listChanged = true;
		pending[0]!.tools = [{ name: "old", inputSchema: { type: "object" } }];
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		await manager.refreshCatalog(makeServer("a"), connection);
		await servers[0]!.emitToolsChanged([{ name: "new", inputSchema: { type: "object" } }]);
		await sleep(500);
		expect(catalog.get("a")?.tools.map((tool) => tool.name)).toEqual(["new"]);
		await manager.dispose();
	});

	it("tools/list_changed 刷新失败时保留旧快照但标记 stale", async () => {
		const { catalog, manager, pending, servers } = makeHarness();
		pending[0]!.listChanged = true;
		pending[0]!.tools = [{ name: "old", inputSchema: { type: "object" } }];
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		await manager.refreshCatalog(makeServer("a"), connection);
		servers[0]!.listError = { code: -32603, message: "list boom" };
		await servers[0]!.emitToolsChanged([{ name: "new", inputSchema: { type: "object" } }]);
		await sleep(500);
		expect(catalog.get("a")?.tools.map((tool) => tool.name)).toEqual(["old"]);
		expect(catalog.get("a")?.stale).toBe(true);
		await manager.dispose();
	});

	it("重复工具名阻断目录提交，而不是写入歧义路由", async () => {
		const { catalog, manager, pending } = makeHarness();
		pending[0]!.tools = [
			{ name: "same", inputSchema: { type: "object" } },
			{ name: "same", inputSchema: { type: "object" } },
		];
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		await expect(manager.refreshCatalog(makeServer("a"), connection)).rejects.toThrow(/重复工具名/);
		expect(catalog.get("a")).toBeUndefined();
		await manager.dispose();
	});

	it("callTool 透传结果并计入 inFlight", async () => {
		const { manager, pending } = makeHarness();
		pending[0]!.callResult = { content: [{ type: "text", text: "hi" }] };
		const connection = await manager.ensureClient(makeServer("a"), 600_000, undefined);
		const result = await manager.callTool(connection, "echo", {}, undefined, undefined);
		expect((result.content as Array<{ type: string; text: string }>)[0]?.text).toBe("hi");
		expect(connection.inFlight).toBe(0);
		await manager.dispose();
	});
});

describe("idle 停止", () => {
	it("闲置超过 idleTimeoutMs 后连接关闭", async () => {
		const { manager } = makeHarness();
		await manager.ensureClient(makeServer("a"), 50, undefined);
		expect(manager.connectionState("a").state).toBe("running");
		await sleep(200);
		expect(manager.connectionState("a")).toEqual({ state: "stopped" });
		await manager.dispose();
	});

	it("在途交互阻止关闭，结算后重新计闲置", async () => {
		const { manager, servers } = makeHarness();
		const connection = await manager.ensureClient(makeServer("a"), 80, undefined);
		const gate = servers[0]!.hold("tools/call");
		const calling = manager.callTool(connection, "echo", {}, undefined, undefined);
		await gate.whenCalled;
		await sleep(200);
		expect(manager.connectionState("a").state).toBe("running");
		gate.release();
		await calling;
		await sleep(250);
		expect(manager.connectionState("a")).toEqual({ state: "stopped" });
		await manager.dispose();
	});
});

describe("dispose", () => {
	it("关闭全部连接并封锁后续操作", async () => {
		const { manager } = makeHarness();
		await manager.ensureClient(makeServer("a"), 600_000, undefined);
		await manager.dispose();
		expect(manager.connectionState("a")).toEqual({ state: "stopped" });
	});

	it("卸载等待正在进行的握手收口", async () => {
		const { manager, pending } = makeHarness();
		const gate = pending[0]!.hold("initialize");
		const starting = manager.ensureClient(makeServer("a"), 600_000, undefined);
		await gate.whenCalled;
		let disposed = false;
		const disposing = manager.dispose().then(() => {
			disposed = true;
		});
		await sleep(10);
		expect(disposed).toBe(false);
		gate.release();
		await expect(starting).rejects.toBeInstanceOf(McpSupersededError);
		await disposing;
		expect(disposed).toBe(true);
	});
});
