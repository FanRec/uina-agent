/**
 * S-D3 反馈流：帧序/单帧单消费/validUntil/appliedStep/关闭撤销持续输入/传感校验。
 */

import { describe, expect, it } from "vitest";
import { FakeClientBot, TEST_OWNER, flushAsync, layFloor, makeDriver } from "./minecraft-driver-helpers.js";
import type { ControlInput, FeedbackFrame, FeedbackStream } from "../.uina/worlds/minecraft/contracts/body.js";

const signal = () => new AbortController().signal;

function makeSensorDriver(bot: FakeClientBot) {
	return makeDriver(bot, {
		sensors: {
			"test.nearby@1": (b) => ({
				value: b.entities().length,
				observedAt: new Date().toISOString(),
				source: "server",
				coverage: "complete",
				unknown: [],
				evidence: [],
			}),
		},
	});
}

describe("minecraft driver feedback (S-D3)", () => {
	it("帧序递增、self 必有、传感逐键返回", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		bot.addEntity({
			networkId: 3,
			uuid: "u3",
			type: "minecraft:pig",
			position: { x: 2, y: 64, z: 2 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream: FeedbackStream = await session.feedback({ nearby: { ref: "test.nearby@1", input: {} } });

		bot.stepPhysics(1);
		const f1: FeedbackFrame = await stream.next(null, signal());
		expect(f1.sequence).toBe(1);
		expect(f1.self.value).not.toBeNull();
		expect(f1.self.value!.health).toBe(20);
		expect(f1.sensors.nearby.value).toBe(1);
		expect(f1.step.sequence).toBeGreaterThan(0);

		bot.stepPhysics(1);
		const f2 = await stream.next(f1.sequence, signal());
		expect(f2.sequence).toBe(2);

		await stream.close();
		await session.close();
		await driver.close();
	});

	it("latest-only 待交付槽：新采样替换旧槽，next 交付最新帧", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});

		bot.stepPhysics(3); // 连续三步无消费者：槽中只保留最新帧。
		const f = await stream.next(null, signal());
		expect(f.sequence).toBe(3); // 不是 1。
		await stream.close();
		await session.close();
		await driver.close();
	});

	it("after 滞后时不重复交付已过帧", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		bot.stepPhysics(2);
		const f = await stream.next(null, signal());
		// after = f.sequence：槽为空 → 等待下一帧，不重复交付。
		const pending = stream.next(f.sequence, signal());
		bot.stepPhysics(1);
		const f2 = await pending;
		expect(f2.sequence).toBe(f.sequence + 1);
		await stream.close();
		await session.close();
		await driver.close();
	});

	it("apply 正常返回 appliedStep（输出被后续物理步消费，不只入队）", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 20);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		bot.stepPhysics(1);
		const f = await stream.next(null, signal());
		const stepBefore = f.step.sequence;
		const x0 = bot.position.x;

		const p = stream.apply({ stream: f.stream, sequence: f.sequence }, { keys: { forward: true } });
		bot.stepPhysics(1);
		const { appliedStep } = await p;
		expect(appliedStep.sequence).toBe(stepBefore + 1); // M > N。
		expect(bot.getControlState("forward")).toBe(true);

		// 关流撤销持续输入（不依赖消费者 finally）。
		await stream.close();
		expect(bot.getControlState("forward")).toBe(false);
		await session.close();
		await driver.close();
		void x0;
	});

	it("同一帧最多消费一次；未交付/乱序帧在任何副作用前失败", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		bot.stepPhysics(2);
		const f = await stream.next(null, signal());

		const p = stream.apply({ stream: f.stream, sequence: f.sequence }, { keys: { jump: true } });
		bot.stepPhysics(1);
		await p;
		expect(bot.getControlState("jump")).toBe(true);

		// 重复消费同一帧：拒绝。
		await expect(stream.apply({ stream: f.stream, sequence: f.sequence }, { keys: {} })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
		});
		// 乱序：未来序号。
		await expect(stream.apply({ stream: f.stream, sequence: f.sequence + 5 }, { keys: {} })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
		});
		// 错误流身份。
		await expect(stream.apply({ stream: "other-stream", sequence: f.sequence }, { keys: {} })).rejects.toMatchObject({
			code: "CONTROL_CONFLICT",
		});

		await stream.close();
		await session.close();
		await driver.close();
	});

	it("每流一个顺序在算帧：并发 next 拒绝", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		const p1 = stream.next(null, signal());
		await expect(stream.next(null, signal())).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });
		bot.stepPhysics(1);
		await p1;
		await stream.close();
		await session.close();
		await driver.close();
	});

	it("过期帧拒绝应用并撤销持续输入", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});

		// 建立持续输入（apply 一次成功）。
		bot.stepPhysics(1);
		const f1 = await stream.next(null, signal());
		const p1 = stream.apply({ stream: f1.stream, sequence: f1.sequence }, { keys: { forward: true } });
		bot.stepPhysics(1);
		await p1;
		expect(bot.getControlState("forward")).toBe(true);

		// 等待超过有效期（feedbackValidityMs=80ms）且无新 apply → 看门狗撤销。
		await new Promise((r) => setTimeout(r, 200));
		expect(bot.getControlState("forward")).toBe(false);
		// 故障已记录（选定证据）。
		await stream.close();
		await session.close();
		await driver.close();
	});

	it("未登记传感在建流前 SENSOR_UNAVAILABLE；不静默漏键", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		await expect(session.feedback({ ghost: { ref: "no.such@1", input: {} } })).rejects.toMatchObject({
			code: "SENSOR_UNAVAILABLE",
		});
		await session.close();
		await driver.close();
	});

	it("第二个连续控制根被拒：drive 与 feedback 互斥（无协调关系）", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		await expect(session.drive({ keys: { forward: true } }, 3)).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });

		await stream.close();
		// 流关闭后连续根释放，drive 可用。
		const r = session.drive({ keys: { forward: true } }, 2);
		bot.stepPhysics(2);
		const done = await r;
		expect(done.actualTicks).toBe(2);
		expect(bot.getControlState("forward")).toBe(false);
		await session.close();
		await driver.close();
	});

	it("断连后流关闭，旧 apply/next 拒绝", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});
		bot.stepPhysics(1);
		const f = await stream.next(null, signal());

		bot.end("net down");
		await flushAsync();
		await expect(
			stream.apply({ stream: f.stream, sequence: f.sequence }, { keys: { forward: true } }),
		).rejects.toMatchObject({
			code: "CONTROL_INVALID",
		});
		await session.close();
		await driver.close();
	});

	it("使用归属经会话唯一权威：反馈流持有 use 时 useItem 冲突，关流释放后可用", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		bot.setSlot(36, { name: "minecraft:stick", count: 1, components: null, remainingDurability: null }); // 主手物品
		const driver = await makeSensorDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const stream = await session.feedback({});

		bot.stepPhysics(1);
		const frame = await stream.next(null, signal());
		const input: ControlInput = { keys: {}, use: { mode: "hold", hand: "main" } };
		const applying = stream.apply({ stream: frame.stream, sequence: frame.sequence }, input);
		bot.stepPhysics(1); // 消费步：安装的输入被下一个物理步消费。
		const applied = await applying;
		expect(applied.receipt.dispatch).toBe("sent");

		// 反馈流持有原生使用状态：useItem 被会话级归属拒绝（同一权威）。
		await expect(session.useItem("main")).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });

		// 关流释放归属 → useItem 可用。
		await stream.close();
		const receipt = await session.useItem("main");
		expect(receipt.dispatch).toBe("sent");

		await session.close();
		await driver.close();
	});
});
