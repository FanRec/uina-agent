import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRhythmWorld } from "../.uina/worlds/rhythm/src/world.js";
import type { WorldEvent } from "../src/extensions/world-framework/types.js";

const temporaryDirectories: string[] = [];

async function startWorld(events: WorldEvent[], signal = new AbortController().signal) {
	const worldDataDir = await mkdtemp(join(tmpdir(), "uina-rhythm-"));
	temporaryDirectories.push(worldDataDir);
	const world = createRhythmWorld();
	await world.onStart!({
		signal,
		worldDataDir,
		emitEvent: async (event) => {
			if (signal.aborted) return;
			events.push(event);
		},
	});
	return { world, worldDataDir };
}

function runAction(world: ReturnType<typeof createRhythmWorld>, name: string, args: Record<string, unknown> = {}) {
	return world.actions[name]!.run(args, {
		operationIdentity: `world:rhythm/${name}`,
		signal: new AbortController().signal,
	});
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rhythm world actions", () => {
	it("exposes the rhythm surface: six actions, no ticker-era names", () => {
		const world = createRhythmWorld();
		expect(world.name).toBe("rhythm");
		expect(world.description).toContain("你的节拍与提醒");
		expect(world.description).toContain("安静得越久，节拍自动越慢");
		expect(Object.keys(world.actions).sort()).toEqual([
			"cancel_reminder",
			"pause",
			"remind",
			"resume",
			"set_interval",
			"status",
		]);
	});

	it("reminder lifecycle: remind returns the effective surface, status lists reminders, cancel reports honestly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T06:32:00.000Z"));
		const events: WorldEvent[] = [];
		const { world, worldDataDir } = await startWorld(events);

		const created = await runAction(world, "remind", { afterSeconds: 2, message: "看看窗边的植物" });
		expect(created).toMatchObject({
			status: "succeeded",
			result: "已记下 r1：约 2 秒后原文送到你面前。当前待触发提醒 1 件：r1。 [effect=applied]",
			details: { reminderRef: "r1", afterSeconds: 2, dueAt: "2026-10-14T06:32:02.000Z" },
		});

		const listing = await runAction(world, "status");
		expect(listing.result).toContain("· 待触发提醒 1 件：");
		expect(listing.result).toContain("r1 · 看看窗边的植物 · 2026/10/14 14:32（北京时间），约 2 秒后");

		const cancelled = await runAction(world, "cancel_reminder", { reminderRef: "r1" });
		expect(cancelled.status).toBe("succeeded");
		expect(cancelled.result).toContain("已收回提醒 r1");
		expect((await runAction(world, "status")).result).toContain("没有待触发的提醒");
		expect(await readFile(join(worldDataDir, "state.json"), "utf8")).toContain('"nextReminderSequence": 2');

		// 已过引用再次取消：如实告知找不到，并指路 status。
		const missing = await runAction(world, "cancel_reminder", { reminderRef: "r1" });
		expect(missing.status).toBe("failed");
		expect(missing.result).toContain("没有待触发的提醒 r1");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("delivers due reminders as verbatim internal events", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T06:32:00.000Z"));
		const events: WorldEvent[] = [];
		const { world } = await startWorld(events);
		await runAction(world, "remind", { afterSeconds: 2, message: "看看窗边的植物" });

		await vi.advanceTimersByTimeAsync(2_000);
		vi.useRealTimers();
		await vi.waitFor(async () => {
			expect((await runAction(world, "status")).result).toContain("没有待触发的提醒");
		});
		expect(events).toEqual([
			expect.objectContaining({
				type: "reminder-due",
				origin: "internal",
				delivery: "queued",
				channel: "world",
				text: "[提醒到期 r1]\n看看窗边的植物",
				data: expect.objectContaining({ reminderRef: "r1", dueAtEpochMs: 1_791_959_522_000 }),
			}),
		]);
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("set_interval echoes the effective pace, not just the requested base", async () => {
		const events: WorldEvent[] = [];
		const { world } = await startWorld(events);
		// 分钟必须收整数：小数会被回显 round 后谎报成别的值，schema 层直接拒绝。
		expect(world.actions.set_interval!.parameters).toMatchObject({
			properties: { minutes: { type: "integer" } },
		});
		const result = await runAction(world, "set_interval", { minutes: 10 });
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("基准已设为 10 分钟");
		expect(result.result).toContain("当前节奏：实际 10 分钟一次 · 下次自主节拍约 10 分钟后");
		expect((result.details as { effectiveIntervalMinutes: number }).effectiveIntervalMinutes).toBe(10);
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("status reports normal pace without backoff while the subject is active", async () => {
		const events: WorldEvent[] = [];
		const { world } = await startWorld(events);
		await runAction(world, "set_interval", { minutes: 1 });
		// 刚启动必然未退避；退避生效与归因文案由引擎测试（MockClock）钉住。
		const status = await runAction(world, "status");
		expect(status.result).toContain("· 运行中 · 实际 1 分钟一次");
		expect(status.result).toContain("今日已自主醒来 0 次（上限：未设）");
		expect((status.details as { nextWakeReason: string }).nextWakeReason).toBe("normal");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("pause and resume return their persisted effects", async () => {
		const events: WorldEvent[] = [];
		const { world } = await startWorld(events);
		const paused = await runAction(world, "pause", { minutes: 90 });
		expect(paused.status).toBe("succeeded");
		expect(paused.result).toContain("节拍静默 90 分钟");
		expect(paused.result).toContain("自动恢复");
		expect((await runAction(world, "status")).result).toContain("静默中");

		const resumed = await runAction(world, "resume");
		expect(resumed.status).toBe("succeeded");
		expect(resumed.result).toContain("静默已结束");
		expect(resumed.result).toContain("当前节奏：实际 3 分钟一次");
		const again = await runAction(world, "resume");
		expect(again.result).toContain("没有在静默中");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("returns failed results for invalid input and stopped world", async () => {
		const events: WorldEvent[] = [];
		const { world } = await startWorld(events);
		const invalid = await runAction(world, "remind", { afterSeconds: 0, message: " " });
		expect(invalid.status).toBe("failed");
		const unrepresentable = await runAction(world, "remind", {
			afterSeconds: Number.MAX_SAFE_INTEGER,
			message: "日期范围之外",
		});
		expect(unrepresentable).toMatchObject({ status: "failed", details: { reason: "invalid_reminder" } });
		const badRef = await runAction(world, "cancel_reminder", { reminderRef: "x1" });
		expect(badRef).toMatchObject({ status: "failed", details: { reason: "invalid_reminder_ref" } });
		await world.onStop!({ signal: new AbortController().signal });
		const stopped = await runAction(world, "status");
		expect(stopped).toMatchObject({ status: "not_started", details: { reason: "rhythm_not_started" } });
	});

	it("reports failed when cancellation cannot be persisted", async () => {
		const events: WorldEvent[] = [];
		const { world, worldDataDir } = await startWorld(events);
		await runAction(world, "remind", { afterSeconds: 50, message: "仍应保留" });
		const stateFile = join(worldDataDir, "state.json");
		await rm(stateFile, { force: true });
		await mkdir(stateFile);
		const result = await runAction(world, "cancel_reminder", { reminderRef: "r1" });
		expect(result.status).toBe("failed");
		expect(result.result).not.toContain("已收回");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("keeps an expired reminder when the world signal is already aborted", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const events: WorldEvent[] = [];
		const { world, worldDataDir } = await startWorld(events, controller.signal);
		await runAction(world, "remind", { afterSeconds: 1, message: "停用期间到期" });
		controller.abort();
		await vi.advanceTimersByTimeAsync(1_000);
		vi.useRealTimers();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		expect(events).toEqual([]);
		expect((await runAction(world, "status")).result).toContain("r1");
		expect(await readFile(join(worldDataDir, "state.json"), "utf8")).toContain('"reminderRef": "r1"');
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("loads legacy state without reminder fields as an empty reminder list", async () => {
		const events: WorldEvent[] = [];
		const worldDataDir = await mkdtemp(join(tmpdir(), "uina-rhythm-legacy-"));
		temporaryDirectories.push(worldDataDir);
		await writeFile(
			join(worldDataDir, "state.json"),
			JSON.stringify({
				baseIntervalMs: 180_000,
				pausedUntilEpochMs: null,
				dailyAttempts: { date: new Date().toDateString(), count: 0 },
			}),
		);
		const world = createRhythmWorld();
		await world.onStart!({
			signal: new AbortController().signal,
			worldDataDir,
			emitEvent: async (event) => {
				events.push(event);
			},
		});
		expect(await runAction(world, "status")).toMatchObject({
			status: "succeeded",
		});
		await world.onStop!({ signal: new AbortController().signal });
	});
});
