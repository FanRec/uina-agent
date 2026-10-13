import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPacingTickerWorld } from "../.uina/worlds/pacing-ticker/src/app.js";
import type { WorldEvent } from "../src/extensions/world-framework/types.js";

const temporaryDirectories: string[] = [];

async function startWorld(events: WorldEvent[], signal = new AbortController().signal) {
	const worldDataDir = await mkdtemp(join(tmpdir(), "uina-ticker-reminder-"));
	temporaryDirectories.push(worldDataDir);
	const world = createPacingTickerWorld();
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

function runAction(
	world: ReturnType<typeof createPacingTickerWorld>,
	name: string,
	args: Record<string, unknown> = {},
) {
	return world.actions[name]!.run(args, {
		operationIdentity: `world:ticker/${name}`,
		signal: new AbortController().signal,
	});
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pacing ticker reminder actions", () => {
	it("describes reminders briefly and supports set, list, cancel, and queued due events", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T06:32:00.000Z"));
		const events: WorldEvent[] = [];
		const { world, worldDataDir } = await startWorld(events);
		expect(world.description).toBe("自主节拍与一次性提醒；到期时再次呈现提醒内容，由你决定如何处理。");
		expect(world.actions.set_reminder!.description).toBe("设置一次性提醒；到期时再次呈现提醒内容，由你决定如何处理。");
		expect(world.actions.list_reminders!.description).toBe("查看尚未触发的提醒及到期时间。");
		expect(world.actions.cancel_reminder!.description).toBe("取消尚未触发的提醒；已入队的提醒不能撤回。");
		expect(world.actions.status!.description).toBe(
			"查询自主节拍状态；暂停只影响周期，remainingSeconds 表示周期与提醒中的下一次唤醒。",
		);

		const created = await runAction(world, "set_reminder", { afterSeconds: 2, message: "看看窗边的植物" });
		expect(created).toMatchObject({
			status: "succeeded",
			result: "已设提醒 r1：2 秒后到期。 [effect=applied]",
			details: {
				reminderRef: "r1",
				afterSeconds: 2,
				dueAt: "2026-10-14T06:32:02.000Z",
				dueAtLocal: "2026/10/14 14:32:02",
				timeZone: "Asia/Shanghai",
			},
		});
		expect((await runAction(world, "list_reminders")).result).toContain("r1");
		expect(await readFile(join(worldDataDir, "state.json"), "utf8")).toContain('"nextReminderSequence": 2');

		await vi.advanceTimersByTimeAsync(2_000);
		vi.useRealTimers();
		await vi.waitFor(async () => {
			expect((await runAction(world, "list_reminders")).result).toBe("没有待触发的提醒。");
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
		expect((await runAction(world, "list_reminders")).result).toBe("没有待触发的提醒。");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("returns failed results for invalid input and missing reminders", async () => {
		const events: WorldEvent[] = [];
		const { world } = await startWorld(events);
		const invalid = await runAction(world, "set_reminder", { afterSeconds: 0, message: " " });
		expect(invalid.status).toBe("failed");
		const unrepresentable = await runAction(world, "set_reminder", {
			afterSeconds: Number.MAX_SAFE_INTEGER,
			message: "日期范围之外",
		});
		expect(unrepresentable).toMatchObject({ status: "failed", details: { reason: "invalid_reminder" } });
		const created = await runAction(world, "set_reminder", { afterSeconds: 50, message: "取消我" });
		expect(created.status).toBe("succeeded");
		const cancelled = await runAction(world, "cancel_reminder", { reminderRef: "r1" });
		expect(cancelled).toMatchObject({ result: "已取消提醒 r1。 [effect=applied]", status: "succeeded" });
		const missing = await runAction(world, "cancel_reminder", { reminderRef: "r9" });
		expect(missing.status).toBe("failed");
		expect(missing.result).toContain("找不到待触发的提醒");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("reports failed when cancellation cannot be persisted", async () => {
		const events: WorldEvent[] = [];
		const { world, worldDataDir } = await startWorld(events);
		await runAction(world, "set_reminder", { afterSeconds: 50, message: "仍应保留" });
		const stateFile = join(worldDataDir, "state.json");
		await rm(stateFile, { force: true });
		await mkdir(stateFile);
		const result = await runAction(world, "cancel_reminder", { reminderRef: "r1" });
		expect(result.status).toBe("failed");
		expect(result.result).not.toContain("已取消");
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("keeps an expired reminder when the world signal is already aborted", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const events: WorldEvent[] = [];
		const { world, worldDataDir } = await startWorld(events, controller.signal);
		await runAction(world, "set_reminder", { afterSeconds: 1, message: "停用期间到期" });
		controller.abort();
		await vi.advanceTimersByTimeAsync(1_000);
		vi.useRealTimers();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		expect(events).toEqual([]);
		expect((await runAction(world, "list_reminders")).result).toContain("r1");
		expect(await readFile(join(worldDataDir, "state.json"), "utf8")).toContain('"reminderRef": "r1"');
		await world.onStop!({ signal: new AbortController().signal });
	});

	it("loads legacy state without reminder fields as an empty reminder list", async () => {
		const events: WorldEvent[] = [];
		const worldDataDir = await mkdtemp(join(tmpdir(), "uina-ticker-legacy-"));
		temporaryDirectories.push(worldDataDir);
		await writeFile(
			join(worldDataDir, "state.json"),
			JSON.stringify({
				baseIntervalMs: 180_000,
				pausedUntilEpochMs: null,
				dailyAttempts: { date: new Date().toDateString(), count: 0 },
			}),
		);
		const world = createPacingTickerWorld();
		await world.onStart!({
			signal: new AbortController().signal,
			worldDataDir,
			emitEvent: async (event) => {
				events.push(event);
			},
		});
		expect(await runAction(world, "list_reminders")).toMatchObject({
			result: "没有待触发的提醒。",
			status: "succeeded",
		});
		await world.onStop!({ signal: new AbortController().signal });
	});
});
