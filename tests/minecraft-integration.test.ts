/**
 * Minecraft Driver → World 跨模块集成（lead 所有）。
 *
 * 用真实模块端口装配：FakeClientBot → createDriver → ClientFactsPort → createWorld（真实 SQLite）。
 * 验证完整数据路径：Driver 当前事实/证据 → World 接收 → 查询/持久化 → Watch 失效，
 * 以及断连 reset、存储故障降级、ACK 材料回收。不伪造运行管理；不冒充实服验收。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDriver, FakeClientBot, layFloor } from "./minecraft-driver-helpers.js";
import type { DriverHandle } from "../.uina/worlds/minecraft/driver/index.js";
import { createWorld, type WorldHandle } from "../.uina/worlds/minecraft/world/index.js";
import { MemoryWorldStore, UnavailableWorldStore } from "../.uina/worlds/minecraft/world/internal/store.js";

const WORLD_BINDING = { world: "mcw:test-world", worldRevision: "rev-1" };

interface Harness {
	driver: DriverHandle;
	bot: FakeClientBot;
	world: WorldHandle;
	dataDir: string;
}

async function makeHarness(store?: MemoryWorldStore | UnavailableWorldStore): Promise<Harness> {
	const bot = new FakeClientBot();
	layFloor(bot, -8, 8);
	const driver = createDriver(
		{ host: "localhost", port: 25565, username: "tester", authMode: "offline" },
		{
			botFactory: () => bot,
			stallTimeoutMs: 400,
			openTimeoutMs: 400,
			feedbackValidityMs: 80,
			worldBinding: WORLD_BINDING,
		},
	);
	bot.respawn();
	await vi.waitFor(() => expect(driver.connectionState()).toBe("ready"), { timeout: 2_000 });
	const dataDir = mkdtempSync(join(tmpdir(), "mc-integration-"));
	const world = await createWorld({ facts: driver.facts, dataDir }, store ? { store } : {});
	await world.historySettled; // 历史侧打开/播种完成（当前事实能力不等它）
	return { driver, bot, world, dataDir };
}

async function teardown(h: Harness): Promise<void> {
	await h.world.close();
	h.driver.close();
	rmSync(h.dataDir, { recursive: true, force: true });
}

describe("minecraft driver → world integration", () => {
	it("当前事实路径：Driver 状态变化后 World read 观察到新值", async () => {
		const h = await makeHarness();
		try {
			const before = await h.world.read({ ref: "self@1", input: {} });
			expect(before.value).not.toBeNull();
			expect(before.cursor.stream).toContain("self@1");

			h.bot.setHealth(7);
			h.bot.position = { x: 3, y: 64, z: 4 };
			h.bot.setFood(19);
			await flushMicrotasks();

			const after = await h.world.read({ ref: "self@1", input: {} });
			const value = after.value as {
				health: number;
				food: number;
				place: { world: string; position: { x: number; z: number } };
			};
			expect(value.health).toBe(7);
			expect(value.food).toBe(19);
			expect(value.place.position).toMatchObject({ x: 3, z: 4 });
			// 世界绑定来自 Driver 注入，World 不从地址推断。
			expect(value.place.world).toBe(WORLD_BINDING.world);
		} finally {
			await teardown(h);
		}
	});

	it("瞬态事实：实体消失后已捕获历史仍可查询（选定证据不被合并掉）", async () => {
		const h = await makeHarness();
		try {
			h.bot.addEntity({
				networkId: 42,
				uuid: "z-1",
				type: "zombie",
				position: { x: 1, y: 64, z: 1 },
				velocity: { x: 0, y: 0, z: 0 },
			});
			h.bot.removeEntity(42);
			await flushMicrotasks();
			const history = await h.world.read({
				ref: "evidence.list@1",
				input: { schema: "client.entities@1", limit: 50 },
			});
			const items = (history.value as { items: { kind: string; fact?: { value: { kind?: string } } }[] }).items;
			expect(items.length).toBeGreaterThan(0);
			expect(items.every((i) => i.kind === "fact")).toBe(true);
			const capturedKinds = items.map((i) => i.fact?.value?.kind);
			expect(capturedKinds).toContain("entityGone");
		} finally {
			await teardown(h);
		}
	});

	it("ACK 材料回收：World 持久提交后 durable ACK，Driver 释放已覆盖材料", async () => {
		const h = await makeHarness();
		try {
			h.bot.addEntity({
				networkId: 7,
				uuid: "c-1",
				type: "cow",
				position: { x: 2, y: 64, z: 2 },
				velocity: { x: 0, y: 0, z: 0 },
			});
			h.bot.removeEntity(7);
			// World 接收 evidence → 微任务 flush → committed → durable ACK → Driver 回收。
			await flushMicrotasks();
			await flushMicrotasks();
			const history = await h.world.read({
				ref: "evidence.list@1",
				input: { schema: "client.entities@1", limit: 50 },
			});
			const items = (history.value as { items: { stream: string }[] }).items;
			expect(items.length).toBeGreaterThan(0);
			const factsSource = h.driver.facts as unknown as { materialCount(stream: string): number };
			for (const stream of [...new Set(items.map((i) => i.stream))]) {
				expect(factsSource.materialCount(stream)).toBe(0);
			}
		} finally {
			await teardown(h);
		}
	});

	it("read → watch → next：Driver 变化无漏投递，无新变化不自激", async () => {
		const h = await makeHarness();
		try {
			// 正确顺序：read 取真实 cursor → watch → next。
			const obs = await h.world.read({ ref: "self@1", input: {} });
			const watch = await h.world.watch({ ref: "self@1", input: {} }, obs.cursor, new AbortController().signal);
			h.bot.setHealth(9);
			const change = await watch.next(obs.cursor, new AbortController().signal);
			expect(change.kind).toBe("changed");

			// 无新变化时 next 不自激（150ms 静默窗口）。
			const noChange = await Promise.race([
				watch.next(change.cursor, new AbortController().signal).then(() => "fired"),
				new Promise((r) => setTimeout(() => r("silent"), 150)),
			]);
			expect(noChange).toBe("silent");
			await watch.close();
		} finally {
			await teardown(h);
		}
	});

	it("断连：Driver reset → World watch 收到 reset；断连后当前读如实返回不可用 null", async () => {
		const h = await makeHarness();
		try {
			const obs = await h.world.read({ ref: "self@1", input: {} });
			const watch = await h.world.watch({ ref: "self@1", input: {} }, obs.cursor, new AbortController().signal);
			const resetPromise = watch.next(obs.cursor, new AbortController().signal);
			h.bot.end("server restart");
			const change = await resetPromise;
			expect(change.kind).toBe("reset");
			// self@1 合同：客户端不可用时值为 null（不冒充最后状态），cursor 已随 epoch 更换。
			const after = await h.world.read({ ref: "self@1", input: {} });
			expect(after.value).toBeNull();
			expect(after.cursor.epoch).not.toBe(obs.cursor.epoch);
		} finally {
			await teardown(h);
		}
	});

	it("存储故障：历史不可用但当前读不受影响（不变量 A）", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, -8, 8);
		const driver = createDriver(
			{ host: "localhost", port: 25565, username: "tester", authMode: "offline" },
			{ botFactory: () => bot, worldBinding: WORLD_BINDING },
		);
		bot.respawn();
		await vi.waitFor(() => expect(driver.connectionState()).toBe("ready"), { timeout: 2_000 });
		const dataDir = mkdtempSync(join(tmpdir(), "mc-integ-fail-"));
		const world = await createWorld(
			{ facts: driver.facts, dataDir },
			{ store: new UnavailableWorldStore("模拟 SQLite 打开失败") },
		);
		try {
			const current = await world.read({ ref: "self@1", input: {} });
			expect(current.value).not.toBeNull();
			await expect(world.read({ ref: "evidence.list@1", input: {} })).rejects.toMatchObject({
				code: "STORE_UNAVAILABLE",
			});
			const status = await world.status();
			expect(status.history.state).toBe("unavailable");
			expect(status.current.state).toBe("ready");
		} finally {
			await world.close();
			driver.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("内存存储模式：接收-查询-记录 CAS 路径语义一致", async () => {
		const h = await makeHarness(new MemoryWorldStore());
		try {
			h.bot.addEntity({
				networkId: 5,
				uuid: "s-1",
				type: "sheep",
				position: { x: 1, y: 64, z: 1 },
				velocity: { x: 0, y: 0, z: 0 },
			});
			h.bot.removeEntity(5);
			await flushMicrotasks();
			const history = await h.world.read({ ref: "evidence.list@1", input: { schema: "client.entities@1" } });
			expect((history.value as { items: unknown[] }).items.length).toBeGreaterThan(0);
			const record = await h.world.writeRecord({
				schema: "test.note@1",
				world: WORLD_BINDING.world,
				worldRevision: "rev-1",
				expectedRevision: null,
				value: { note: "integration" },
				evidence: [],
			});
			expect(record.revision).toBe(1);
			// 合法 CAS：expectedRevision 匹配当前版本 → 前进到 v2。
			const v2 = await h.world.writeRecord({
				ref: record.ref,
				schema: "test.note@1",
				world: WORLD_BINDING.world,
				worldRevision: "rev-1",
				expectedRevision: 1,
				value: { note: "v2" },
				evidence: [],
			});
			expect(v2.revision).toBe(2);
			// 对已前进版本重复同一 expectedRevision → RECORD_CHANGED，不自动改基版。
			await expect(
				h.world.writeRecord({
					ref: record.ref,
					schema: "test.note@1",
					world: WORLD_BINDING.world,
					worldRevision: "rev-1",
					expectedRevision: 1,
					value: { note: "v3" },
					evidence: [],
				}),
			).rejects.toMatchObject({ code: "RECORD_CHANGED" });
		} finally {
			await teardown(h);
		}
	});

	it("存储 Worker 脱离主事件循环；崩溃后历史显式不可用、当前读不受影响", async () => {
		const h = await makeHarness();
		try {
			const world = h.world as unknown as { store: { workerThreadId: number } };
			const threadId = world.store.workerThreadId;
			expect(threadId).toBeGreaterThan(0); // 专用线程，不是主线程（主线程 threadId=0）

			h.bot.addEntity({
				networkId: 9,
				uuid: "crash-1",
				type: "cow",
				position: { x: 1, y: 64, z: 1 },
				velocity: { x: 0, y: 0, z: 0 },
			});
			h.bot.removeEntity(9);

			// 模拟 Worker 崩溃：硬杀线程。在途提交与后续历史读显式失败，不静默。
			const impl = h.world as unknown as { store: { worker: { terminate(): Promise<number> } } };
			void (await impl.store.worker.terminate());

			await expect(h.world.read({ ref: "evidence.list@1", input: {} })).rejects.toMatchObject({
				code: "STORE_UNAVAILABLE",
			});
			const status = await h.world.status();
			expect(status.history.state).toBe("unavailable");
			// 当前事实不经过存储：崩溃后照常可读（不变量 A）。
			h.bot.setHealth(11);
			await flushMicrotasks();
			const current = await h.world.read({ ref: "self@1", input: {} });
			expect((current.value as { health: number }).health).toBe(11);
		} finally {
			await teardown(h);
		}
	});

	it("提交屏障：查询开始前已接收的证据不因未落盘被静默遗漏", async () => {
		const h = await makeHarness();
		try {
			// 接收证据后立即读历史：不先手工等冲刷——屏障等待该上界提交完成再读。
			h.bot.addEntity({
				networkId: 21,
				uuid: "barrier-1",
				type: "pig",
				position: { x: 2, y: 64, z: 2 },
				velocity: { x: 0, y: 0, z: 0 },
			});
			h.bot.removeEntity(21);
			const history = await h.world.read({
				ref: "evidence.list@1",
				input: { schema: "client.entities@1", limit: 50 },
			});
			const items = (history.value as { items: { kind: string }[] }).items;
			expect(items.length).toBeGreaterThan(0);
			// durable ACK 已随提交发布（同一续体），Driver 材料可回收。
			const factsSource = h.driver.facts as unknown as { materialCount(stream: string): number };
			for (const stream of [
				...new Set((history.value as { items: { stream: string }[] }).items.map((i) => i.stream)),
			]) {
				expect(factsSource.materialCount(stream)).toBe(0);
			}
		} finally {
			await teardown(h);
		}
	});

	it("历史 watch 无漏：read 之后新提交的证据由 next 交付", async () => {
		const h = await makeHarness();
		try {
			const first = await h.world.read({ ref: "evidence.list@1", input: {} });
			const watch = await h.world.watch(
				{ ref: "evidence.list@1", input: {} },
				first.cursor,
				new AbortController().signal,
			);
			const pending = watch.next(first.cursor, new AbortController().signal);
			h.bot.addEntity({
				networkId: 33,
				uuid: "hist-watch-1",
				type: "sheep",
				position: { x: 3, y: 64, z: 3 },
				velocity: { x: 0, y: 0, z: 0 },
			});
			h.bot.removeEntity(33);
			const change = await pending;
			expect(change.kind).toBe("changed");
			await watch.close();
		} finally {
			await teardown(h);
		}
	});
});

function flushMicrotasks(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}
