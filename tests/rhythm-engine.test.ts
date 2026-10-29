import { beforeEach, describe, expect, it } from "vitest";
import { type ClockSource, RhythmEngine } from "../.uina/worlds/rhythm/src/engine.js";
import type { RhythmDurableState, RhythmHostPort } from "../.uina/worlds/rhythm/src/types.js";

/**
 * 确定性模拟时钟 (支持时间旅行与虚拟定时器触发)
 */
class MockClock implements ClockSource {
	monoMs = 1_000_000;
	epochMs = 1_700_000_000_000;
	private timers = new Map<number, { dueMono: number; fn: () => void }>();
	private nextId = 1;

	nowMono(): number {
		return this.monoMs;
	}

	nowEpoch(): number {
		return this.epochMs;
	}

	setTimeout(fn: () => void, delayMs: number): NodeJS.Timeout {
		const id = this.nextId++;
		this.timers.set(id, { dueMono: this.monoMs + delayMs, fn });
		return id as unknown as NodeJS.Timeout;
	}

	clearTimeout(timer: NodeJS.Timeout): void {
		this.timers.delete(Number(timer));
	}

	/**
	 * 快进时间并触发所有到期定时器 (按时间先后保序执行)
	 */
	async advanceTime(deltaMs: number): Promise<void> {
		const targetMono = this.monoMs + deltaMs;
		this.epochMs += deltaMs;

		while (true) {
			let earliestId: number | null = null;
			let earliestDue = Infinity;

			for (const [id, t] of this.timers.entries()) {
				if (t.dueMono <= targetMono && t.dueMono < earliestDue) {
					earliestDue = t.dueMono;
					earliestId = id;
				}
			}

			if (earliestId === null) {
				break;
			}

			const timer = this.timers.get(earliestId)!;
			this.timers.delete(earliestId);
			this.monoMs = timer.dueMono;
			timer.fn();
			// 等待保存与投递的 Promise 链完成，再观察下一次调度。
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		this.monoMs = targetMono;
	}
}

describe("RhythmEngine (自主节拍引擎)", () => {
	let clock: MockClock;
	let submittedOpportunities: string[];
	let persistedStates: RhythmDurableState[];
	let busy = false;

	const createHost = (): RhythmHostPort => ({
		isBusy: () => busy,
		submitOpportunity: async (text) => {
			submittedOpportunities.push(text);
		},
		submitReminder: async () => {},
		saveDurableState: async (state) => {
			persistedStates.push(JSON.parse(JSON.stringify(state)));
		},
	});

	beforeEach(() => {
		clock = new MockClock();
		submittedOpportunities = [];
		persistedStates = [];
		busy = false;
	});

	it("常态步进：按基准周期 (3分钟) 准时投递机会", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 快进 2 分钟，未到期
		await clock.advanceTime(120_000);
		expect(submittedOpportunities).toHaveLength(0);

		// 快进 1 分钟，刚好 3 分钟到期
		await clock.advanceTime(60_000);
		expect(submittedOpportunities).toHaveLength(1);
		expect(submittedOpportunities[0]).toContain("[自主节拍]");

		// 再快进 3 分钟，触发第二次
		await clock.advanceTime(180_000);
		expect(submittedOpportunities).toHaveLength(2);
		engine.stop();
	});

	it("退避逻辑：外部空闲 15m 退至 10m，1h 退至 30m，绝不反向加速", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 初始基准 3m
		expect(engine.calculateNextInterval()).toBe(180_000);

		// 快进 16 分钟无外部事件，应退避至 10m
		await clock.advanceTime(16 * 60_000);
		expect(engine.calculateNextInterval()).toBe(600_000);

		// 快进至 65 分钟无外部事件，应退避至 30m
		await clock.advanceTime(50 * 60_000);
		expect(engine.calculateNextInterval()).toBe(1800_000);

		// 防反向加速测试：若基准设为 60 分钟，空闲 16 分钟时不应反向加速至 10 分钟
		await engine.setInterval(60);
		expect(engine.calculateNextInterval()).toBe(60 * 60_000);
		engine.stop();
	});

	it("高频外部事件防抖与防饥饿：连续外部事件下依然稳定触发，不被无限推迟", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 模拟每 20 秒到达一次外部事件，持续 4 分钟
		for (let i = 0; i < 12; i++) {
			await clock.advanceTime(20_000);
			engine.notifyActivity({ origin: "external" });
		}

		// 在高频事件下，原本 3 分钟的唤醒绝不应该被无限向后推迟饿死
		expect(submittedOpportunities.length).toBeGreaterThanOrEqual(1);
		engine.stop();
	});

	it("内部活动过滤：origin 为 runtime 的事件绝不更新外部活动时间戳", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 快进 20 分钟（处于 10m 退避期）
		await clock.advanceTime(20 * 60_000);
		expect(engine.calculateNextInterval()).toBe(600_000);

		// 主体自身调用工具产生的内部事件
		engine.notifyActivity({ origin: "runtime" });

		// 退避时间戳不应被重置，依然保持退避
		expect(engine.calculateNextInterval()).toBe(600_000);
		engine.stop();
	});

	it("忙碌避让：主脑 busy 时避让退后 15 秒，不并发堆叠", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 在第 2 分 59 秒主脑变为 busy
		await clock.advanceTime(179_000);
		busy = true;

		// 3 分钟到期，由于 busy，应避让退后 15 秒
		await clock.advanceTime(2000);
		expect(submittedOpportunities).toHaveLength(0);

		// 快进 10 秒，仍 busy，未发拍
		await clock.advanceTime(10_000);
		expect(submittedOpportunities).toHaveLength(0);

		// 主脑忙碌结束，再过 5 秒（满 15 秒探测期），成功投递
		busy = false;
		await clock.advanceTime(5000);
		expect(submittedOpportunities).toHaveLength(1);
		engine.stop();
	});

	it("人类交互避让：人类发言 30 秒内主动退后", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 快进到 2 分 50 秒，人类说话
		await clock.advanceTime(170_000);
		engine.notifyActivity({ origin: "human" });

		// 快进 15 秒（总时间 3 分 05 秒，但距人类发言仅 15 秒 < 30 秒冷却）
		await clock.advanceTime(15_000);
		expect(submittedOpportunities).toHaveLength(0);

		// 人类停止说话超过 30 秒后，顺利触发 (等待 20 秒，累计 35 秒)
		await clock.advanceTime(20_000);
		expect(submittedOpportunities.length).toBeGreaterThanOrEqual(1);
		engine.stop();
	});

	it("精确 Pause Deadline：准时在指定分钟后苏醒，外部活动不打断 pause", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();

		// 主体请求暂停 10 分钟
		await engine.pause(10);
		expect(persistedStates.at(-1)?.pausedUntilEpochMs).not.toBeNull();

		// 快进 5 分钟，外部来了一条弹幕
		await clock.advanceTime(5 * 60_000);
		engine.notifyActivity({ origin: "external" });

		// 暂停未到期，绝不触发唤醒
		expect(submittedOpportunities).toHaveLength(0);

		// 快进满 10 分钟，准时苏醒发拍
		await clock.advanceTime(5 * 60_000);
		expect(submittedOpportunities).toHaveLength(1);
		engine.stop();
	});

	it("跨重启恢复：未到期的 pause 跨重启无缝继续倒计时", async () => {
		const host = createHost();
		// 模拟上次落盘的状态：还有 5 分钟暂停
		const savedState: RhythmDurableState = {
			baseIntervalMs: 180_000,
			pausedUntilEpochMs: clock.nowEpoch() + 300_000,
			dailyAttempts: { date: new Date(clock.nowEpoch()).toDateString(), count: 3 },
			reminders: [],
			nextReminderSequence: 1,
		};

		const restoredEngine = new RhythmEngine(host, savedState, undefined, clock);
		restoredEngine.start();

		// 快进 4 分钟，未到期
		await clock.advanceTime(240_000);
		expect(submittedOpportunities).toHaveLength(0);

		// 快进 1 分钟（满 5 分钟），成功恢复发拍
		await clock.advanceTime(60_000);
		expect(submittedOpportunities).toHaveLength(1);
		restoredEngine.stop();
	});

	it("日限额熔断与跨日重置：达到上限停止发拍，次日自动清零恢复", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 60_000 }, { maxDailyAttempts: 2 }, clock);
		engine.start();

		// 触发 2 次唤醒
		await clock.advanceTime(60_000);
		await clock.advanceTime(60_000);
		expect(submittedOpportunities).toHaveLength(2);

		// 达到限额，第 3 次被熔断跳过
		await clock.advanceTime(60_000);
		expect(submittedOpportunities).toHaveLength(2);

		// 跨日（快进 24 小时）
		await clock.advanceTime(24 * 3600_000);
		// 新的一天恢复发拍
		expect(submittedOpportunities.length).toBeGreaterThanOrEqual(3);
		engine.stop();
	});

	it("getStatus 状态快照：诚实反映基准、外部静默、实际周期与倒计时", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, { maxDailyAttempts: 50 }, clock);
		engine.start();

		// 快进 60 秒
		await clock.advanceTime(60_000);
		const status = engine.getStatus();

		expect(status.baseIntervalMinutes).toBe(3);
		expect(status.quietMinutes).toBe(1);
		expect(status.effectiveIntervalMinutes).toBe(3);
		expect(status.nextPacingWakeInSeconds).toBe(120);
		expect(status.isPaused).toBe(false);
		expect(status.dailyAttemptsLimit).toBe(50);
		engine.stop();
	});

	it("节拍推送正文自带现场节奏行", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 180_000 }, undefined, clock);
		engine.start();
		await clock.advanceTime(180_000);
		expect(submittedOpportunities).toHaveLength(1);
		const text = submittedOpportunities[0]!;
		expect(text.startsWith("[自主节拍]\n现在是 ")).toBe(true);
		expect(text).toContain("距上次节拍到来约 3 分钟");
		// "下次"是从这次醒来算起的真实未来，不是已经到期的 0 秒。
		expect(text).toContain("当前节奏：实际 3 分钟一次 · 下次自主节拍约 3 分钟后");
		expect(text).toContain("你可以留意世界、思考、行动，也可以只是待着。");
		engine.stop();
	});

	it("推送正文如实标注安静退避，退避中不谎称基准", async () => {
		const engine = new RhythmEngine(createHost(), { baseIntervalMs: 60_000 }, undefined, clock);
		engine.start();
		// 快进 16 分钟：1 分钟基准 + 安静超 15 分钟 → 至少 10 分钟一次；期间节拍照常到来。
		await clock.advanceTime(16 * 60_000);
		const last = submittedOpportunities.at(-1)!;
		expect(last).toContain("实际 10 分钟一次（基准 1 分钟，安静自动放慢）");
		expect(engine.getStatus().nextWakeReason).toBe("backoff");
		engine.stop();
	});
});
