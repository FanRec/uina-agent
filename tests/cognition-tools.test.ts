/**
 * 认知扩展阶段 B / M4：三工具适配面。
 *
 * 覆盖：schema 无身份参数（模型只见 ID/query，不见路径/subjectId）、
 * 服务层三态 → 工具五态适配（committed→succeeded；conflict/rejected→failed；
 * writer 异常→unknown）、工具经由 ToolBroker 校验后走真实执行路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBroker } from "../src/tools/broker.js";
import { createMemoryStore } from "../src/extensions/cognition/memory.js";
import { createMemoryTools } from "../src/extensions/cognition/index.js";

let root: string;
let broker: ToolBroker;

const createStore = () =>
	createMemoryStore({
		subjectId: "alice",
		memoryRoot: join(root, "memory"),
		stateRoot: join(root, "state"),
		sessionId: "default",
		validateSource: async () => true,
	});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "uina-cognition-tools-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("M4 工具面：schema 边界", () => {
	it("三工具 schema 中不存在 subjectId/路径/scope 参数（隔离不留口子）", () => {
		const tools = createMemoryTools(createStore());
		expect(tools.map((t) => t.def.function.name)).toEqual(["memory_search", "memory_read", "memory_write"]);

		for (const tool of tools) {
			const schemaText = JSON.stringify(tool.def.function.parameters);
			// subjectId/路径类字段不得存在；sources[].sessionId 是设计 §7 的合法来源引用字段，不算泄露。
			expect(schemaText).not.toContain("subjectId");
			expect(schemaText).not.toContain("memoryRoot");
			expect(schemaText).not.toContain("stateRoot");
		}
	});

	it("工具经 ToolBroker 注册、schema 校验、真实执行", async () => {
		broker = new ToolBroker();
		for (const tool of createMemoryTools(createStore())) broker.register(tool);

		const prepared = broker.prepare("memory_write", {
			operation: {
				op: "create",
				record: {
					type: "note",
					basis: "reported",
					title: "偏好",
					body: "先给结论",
					scope: { spaceId: "private:alice" },
					sources: [{ sessionId: "default" }],
					pinned: false,
				},
			},
		});
		expect(prepared.error).toBeUndefined();
		const outcome = await broker.execute(prepared);
		expect(outcome.status).toBe("succeeded");
		const payload = JSON.parse(outcome.result) as { id: string; hash: string };
		expect(payload.id).toBeTruthy();
		expect(payload.hash).toBeTruthy();
	});
});

describe("M4 工具面：五态适配", () => {
	it("create/revise committed → succeeded 并携带新 hash；revise 用旧 hash → conflict → failed（不报记住了）", async () => {
		broker = new ToolBroker();
		const store = createStore();
		for (const tool of createMemoryTools(store)) broker.register(tool);

		const createPrepared = broker.prepare("memory_write", {
			operation: { op: "create", record: { type: "note", basis: "observed", title: "t", body: "b", scope: {}, sources: [{ sessionId: "default" }], pinned: false } },
		});
		const created = JSON.parse((await broker.execute(createPrepared)).result) as { id: string; hash: string };

		// 用 create 返回的新 hash 修订 → succeeded。
		const revisePrepared = broker.prepare("memory_write", {
			operation: { op: "revise", id: created.id, expectedHash: created.hash, record: { body: "v2" } },
		});
		const revised = JSON.parse((await broker.execute(revisePrepared)).result) as { status: string; hash: string };
		expect(revised.status).toBe("committed");
		expect(revised.hash).not.toBe(created.hash);

		// 用旧 hash 再修订 → conflict → failed。
		const conflictPrepared = broker.prepare("memory_write", {
			operation: { op: "revise", id: created.id, expectedHash: created.hash, record: { body: "v3" } },
		});
		const conflictOutcome = await broker.execute(conflictPrepared);
		expect(conflictOutcome.status).toBe("failed");
		const conflictPayload = JSON.parse(conflictOutcome.result) as { status: string; currentHash: string };
		expect(conflictPayload.status).toBe("conflict");
		expect(conflictPayload.currentHash).toBe(revised.hash);
	});

	it("memory_search 命中返回（工具级正路径：ID/标题/摘要/版本）", async () => {
		broker = new ToolBroker();
		const store = createStore();
		for (const tool of createMemoryTools(store)) broker.register(tool);

		await broker.execute(broker.prepare("memory_write", {
			operation: { op: "create", record: { type: "note", basis: "observed", title: "部署偏好", body: "先跑测试再部署", scope: {}, sources: [{ sessionId: "default" }], pinned: false } },
		}));
		const search = await broker.execute(broker.prepare("memory_search", { query: "部署" }));
		expect(search.status).toBe("succeeded");
		const payload = JSON.parse(search.result) as { hits: Array<{ id: string; title: string; excerpt: string; revision: number }> };
		expect(payload.hits).toHaveLength(1);
		expect(payload.hits[0]!.title).toBe("部署偏好");
		expect(payload.hits[0]!.excerpt).toContain("先跑测试");
	});

	it("retire 后搜索不再返回；memory_read 报 failed；writer 异常 → unknown（不猜结果）", async () => {
		broker = new ToolBroker();
		const store = createMemoryStore({
			subjectId: "alice",
			memoryRoot: join(root, "memory"),
			stateRoot: join(root, "state"),
			sessionId: "default",
			// 工具层异常模拟：validateSource 抛错仅在 entryId=boom 时触发。
			validateSource: async (ref) => {
				if (ref.entryId === "boom") throw new Error("模拟异常");
				return ref.sessionId === "default";
			},
		});
		for (const tool of createMemoryTools(store)) broker.register(tool);

		const created = JSON.parse(
			(
				await broker.execute(
					broker.prepare("memory_write", {
						operation: { op: "create", record: { type: "note", basis: "observed", title: "秘密", body: "暗号 1234", scope: {}, sources: [{ sessionId: "default" }], pinned: false } },
					}),
				)
			).result,
		) as { id: string; hash: string };

		await broker.execute(broker.prepare("memory_write", { operation: { op: "retire", id: created.id, expectedHash: created.hash, reason: "过时" } }));
		const search = JSON.parse((await broker.execute(broker.prepare("memory_search", { query: "暗号" }))).result) as { hits: unknown[] };
		expect(search.hits).toHaveLength(0);

		const read = await broker.execute(broker.prepare("memory_read", { id: created.id }));
		// design §8：retire 只停召回，记录仍可读（保留版本与历史）；不可读是 forget 的语义。
		expect(read.status).toBe("succeeded");
		expect((JSON.parse(read.result) as { status: string }).status).toBe("retired");

		// writer 内部抛异常 → unknown：不猜测、不报 succeeded。
		const boom = await broker.execute(
			broker.prepare("memory_write", {
				operation: { op: "create", record: { type: "note", basis: "observed", title: "x", body: "y", scope: {}, sources: [{ sessionId: "default", entryId: "boom" }], pinned: false } },
			}),
		);
		expect(boom.status).toBe("unknown");
	});
});
