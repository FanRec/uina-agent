/**
 * S-D2 身体资格：acquire/release FIFO、drive 按实际物理步计数、旧操作迟到写入拒绝、
 * dig/attack/interact/equip/useItem 派发与回执、并发与冲突。
 */

import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BotFailure } from "../.uina/worlds/minecraft/driver/internal/bot-shape.js";
import { FakeClientBot, TEST_OWNER, flushAsync, layFloor, makeDriver, testOwner } from "./minecraft-driver-helpers.js";

const signal = () => new AbortController().signal;

describe("minecraft driver body (S-D2)", () => {
	it("drive 按实际消费步计数：5 步返回 actualTicks=5，结束后撤销持续键", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const z0 = bot.position.z;

		const p = session.drive({ keys: { forward: true } }, 5);
		bot.stepPhysics(5);
		const r = await p;

		expect(r.actualTicks).toBe(5);
		// fake 运动学：yaw=0 面朝 +z，forward 速度 0.2/步。
		expect(r.end.value.place.position.z).toBeCloseTo(z0 + 1.0, 5);
		// 第 5 个消费步结束后、下次模拟前撤销：后续模拟不再前进。
		expect(bot.getControlState("forward")).toBe(false);
		bot.stepPhysics(2);
		expect(bot.position.z).toBeCloseTo(z0 + 1.0, 5);
		await session.close();
		await driver.close();
	});

	it("一次性 attack 在一次提交内只派发一次，不随步重放", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		bot.addEntity({
			networkId: 7,
			uuid: "u7",
			type: "minecraft:zombie",
			position: { x: 2, y: 64, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const target = {
			connection: driver.facts.sample(() => 0).stamp.connection!,
			incarnation: driver.facts.sample(() => 0).stamp.incarnation!,
			appearance: "app-placeholder",
			networkId: 7,
		};
		// appearance 从实体登记取得：直接采一个实体引用。
		const entities = driver.facts.sample((v) => v.entities()).value.value.entities;
		const ref = entities[0]!.ref;

		const p = session.drive({ keys: { forward: true }, attack: ref }, 4);
		bot.stepPhysics(4);
		await p;

		expect(bot.attackLog).toEqual([7]);
		await session.close();
		await driver.close();
		void target;
	});

	it("drive 可在首个消费步前被 close 取消：CONTROL_INVALID + 键撤销", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const p = session.drive({ keys: { sprint: true } }, 100);
		bot.stepPhysics(2);
		const closing = session.close();
		await expect(p).rejects.toMatchObject({ code: "CONTROL_INVALID" });
		await closing;
		expect(bot.getControlState("sprint")).toBe(false);
		await driver.close();
	});

	it("物理停滞返回具体故障，不无限等待", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 2);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		// 玩家走到无地面区域：模拟条件不成立，physicsTick 不再发出。
		bot.position = { x: 50, y: 64, z: 0 };
		const p = session.drive({ keys: { forward: true } }, 3);
		await expect(p).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
		await session.close();
		await driver.close();
	});

	it("acquire FIFO：A 释放后 B 按序取得新资格", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		const driver = await makeDriver(bot);
		const a = await driver.player.acquire(testOwner(1), signal());
		const pendingB = driver.player.acquire(testOwner(2), signal());
		const pendingC = driver.player.acquire(testOwner(3), signal());

		await a.close();
		const b = await pendingB;
		const bodyB = driver.facts.sample(() => 0); // 占位避免未用告警
		void bodyB;
		await b.close();
		const c = await pendingC;
		await c.close();
		await driver.close();
	});

	it("排队中的 acquire 取消后移出队列", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		const driver = await makeDriver(bot);
		const a = await driver.player.acquire(testOwner(1), signal());
		const ctrl = new AbortController();
		const pending = driver.player.acquire(testOwner(2), ctrl.signal);
		ctrl.abort();
		await expect(pending).rejects.toMatchObject({ code: "CONTROL_INVALID" });
		await a.close();
		await driver.close();
	});

	it("driver.close 结算排队中的申请：明确拒绝、不发放失效资格、不留 signal 监听", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		const driver = await makeDriver(bot);
		const a = await driver.player.acquire(testOwner(1), signal());
		const queued = new AbortController();
		const pendingB = driver.player.acquire(testOwner(2), queued.signal);
		expect(getEventListeners(queued.signal, "abort")).toHaveLength(1);

		await driver.close();
		// 关闭必须结算排队者：既不悬挂，也不把身体租约发给正在拆除的客户端。
		await expect(pendingB).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
		// 结算即摘监听：长生命周期 signal 不累积。
		expect(getEventListeners(queued.signal, "abort")).toHaveLength(0);
		// 已发放的会话随停用退役，不能继续写入。
		await expect(a.drive({ keys: {} }, 1)).rejects.toMatchObject({ code: "CONTROL_INVALID" });
	});

	it("dig(target) 派发并在完成后捕获本地预测证据；挖掘中撤销则迟到写入被拒", async () => {
		const bot = new FakeClientBot({ digTimeMs: 30 });
		layFloor(bot, 0, 8);
		bot.setBlock({ x: 2, y: 64, z: 0 }, { name: "stone", properties: {} });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const receipt = await session.dig({
			place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
			block: { x: 2, y: 64, z: 0 },
		});
		expect(receipt.dispatch).toBe("sent");
		expect(receipt.completion).toBe("met");
		// 本地预测：目标格已被预测为空气（不是服务端确认）。
		expect(bot.blockAt({ x: 2, y: 64, z: 0 })?.name).toBe("air");

		await session.close();
		await driver.close();
	});

	it("dig 预测读取标注 prediction，服务端入包恢复 server；回执携带预测证据", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 8);
		bot.setBlock({ x: 2, y: 64, z: 0 }, { name: "stone", properties: {} });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const place = { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } };

		const receipt = await session.dig({ place, block: { x: 2, y: 64, z: 0 } });
		// 回执携带已取得的预测证据 ref（§13：证据随低层完成回执交付）。
		expect(receipt.evidence.length).toBe(1);
		// 服务端确认到达前：目标格读取标注 prediction，不冒充 server 事实（§11.6）。
		const predicted = driver.facts.sample((v) => v.block({ place, block: { x: 2, y: 64, z: 0 } }));
		expect(predicted.value.source).toBe("prediction");

		// 服务端真实入包（setBlock 模拟 blockUpdate）：清除预测标记，恢复 server 标注。
		bot.setBlock({ x: 2, y: 64, z: 0 }, { name: "bedrock", properties: {} });
		await flushAsync();
		const confirmed = driver.facts.sample((v) => v.block({ place, block: { x: 2, y: 64, z: 0 } }));
		expect(confirmed.value.source).toBe("server");
		expect(confirmed.value.value.state).toMatchObject({ name: "minecraft:bedrock" });

		await session.close();
		await driver.close();
	});

	it("equip 的 minDurability 按接缝剩余耐久筛选，不从 components 猜字段", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 8);
		// 真实形状：1.20.5+ 的组件是 [{type,data}]，耐久只有一个接缝语义 remainingDurability。
		bot.setSlot(36, { name: "minecraft:iron_pickaxe", count: 1, components: null, remainingDurability: 240 });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		await expect(session.equip({ name: "minecraft:iron_pickaxe", minDurability: 100 }, "main")).resolves.toMatchObject({
			dispatch: "sent",
		});
		await expect(session.equip({ name: "minecraft:iron_pickaxe", minDurability: 250 }, "main")).rejects.toMatchObject({
			code: "TARGET_NOT_MET",
		});

		await session.close();
		await driver.close();
	});

	it("dig await 瞄准期间撤销：恢复后写入被拒，不产生 block_dig 派发", async () => {
		let releaseLook!: () => void;
		const gate = new Promise<void>((r) => {
			releaseLook = r;
		});
		const bot = new FakeClientBot({ lookGate: () => gate });
		layFloor(bot, 0, 8);
		bot.setBlock({ x: 2, y: 64, z: 0 }, { name: "stone", properties: {} });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const p = session.dig({
			place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
			block: { x: 2, y: 64, z: 0 },
		});
		// look 挂起期间撤销（§17.3）。
		await vi.waitFor(() => expect(bot.lookPending).toBe(true));
		const closing = session.close();
		releaseLook();
		await expect(p).rejects.toMatchObject({ code: "CONTROL_INVALID" });
		await closing;
		// 迟到写入被拒：没有任何 block_dig 派发。
		expect(bot.packets.filter((pk) => pk.name === "block_dig")).toEqual([]);
		await driver.close();
	});

	it("dig(preserve) 与连续 drive 并行推进；dig(target) 与连续根冲突", async () => {
		const bot = new FakeClientBot({ digTimeMs: 0 });
		layFloor(bot, 0, 16);
		bot.setBlock({ x: 3, y: 64, z: 0 }, { name: "dirt", properties: {} });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const driving = session.drive({ keys: { forward: true } }, 20);
		// 同一身体的 dig(target) 与活动连续根冲突（§6.3：瞄准会覆盖视角输出）。
		await expect(
			session.dig(
				{
					place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
					block: { x: 3, y: 64, z: 0 },
				},
				{ aim: "target" },
			),
		).rejects.toMatchObject({ code: "CONTROL_CONFLICT" });

		// preserve：不碰视角，可并行推进。
		const receipt = await session.dig(
			{
				place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
				block: { x: 3, y: 64, z: 0 },
			},
			{ aim: "preserve" },
		);
		expect(receipt.dispatch).toBe("sent");

		bot.stepPhysics(20);
		await driving;
		expect(bot.getControlState("forward")).toBe(false);
		await session.close();
		await driver.close();
	});

	it("attack 派发即回执 met；实体引用跨化身拒绝", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.addEntity({
			networkId: 9,
			uuid: "u9",
			type: "minecraft:cow",
			position: { x: 1, y: 64, z: 1 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const ref = driver.facts.sample((v) => v.entities()).value.value.entities[0]!.ref;

		const receipt = await session.attack(ref);
		expect(receipt).toMatchObject({ dispatch: "sent", completion: "met" });
		expect(bot.attackLog).toEqual([9]);

		// 伪造化身代次：REFERENCE_STALE，派发前失败。
		await expect(session.attack({ ...ref, incarnation: "inc-stale" })).rejects.toMatchObject({
			code: "REFERENCE_STALE",
		});
		expect(bot.attackLog).toEqual([9]);
		await session.close();
		await driver.close();
	});

	it("useItem 激活归 Body 使用会话；endUse 幂等；close 强制释放并留证据", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setSlot(36, { name: "minecraft:bow", count: 1, components: null, remainingDurability: null });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const r1 = await session.useItem("main");
		expect(r1).toMatchObject({ dispatch: "sent", completion: "met" });
		expect(bot.usingHeldItem()).toBe(true);

		// 幂等：无所属使用状态时 endUse 不重复派发。这里已有使用状态 → 派发 release。
		const r2 = await session.endUse();
		expect(r2.dispatch).toBe("sent");
		expect(bot.usingHeldItem()).toBe(false);
		const releaseCount = bot.packets.filter(
			(pk) => pk.name === "block_dig" && (pk.data as { status: number }).status === 5,
		).length;

		// 已结束后再 endUse：幂等 not_sent，不重复发 release。
		const r3 = await session.endUse();
		expect(r3).toMatchObject({ dispatch: "not_sent", completion: "met" });
		const releaseCount2 = bot.packets.filter(
			(pk) => pk.name === "block_dig" && (pk.data as { status: number }).status === 5,
		).length;
		expect(releaseCount2).toBe(releaseCount);

		// 空手激活：不派发，明确失败（上游静默 no-op 不能假装成功）。
		bot.setSlot(36, null);
		await expect(session.useItem("main")).rejects.toMatchObject({ code: "TARGET_NOT_MET", dispatch: "not_sent" });

		await session.close();
		await driver.close();
	});

	it("close 时强制释放蓄力使用并记录后果", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setSlot(36, { name: "minecraft:bow", count: 1, components: null, remainingDurability: null });
		const driver = await makeDriver(bot);
		const evidences: unknown[] = [];
		driver.facts.subscribe((n) => {
			if (n.kind === "evidence") evidences.push(...n.records);
		});
		const session = await driver.player.acquire(TEST_OWNER, signal());
		await session.useItem("main");
		expect(bot.usingHeldItem()).toBe(true);

		await session.close();
		expect(bot.usingHeldItem()).toBe(false);
		// 强制清理保存后果：release 是派发效果，不是零副作用清理。
		const kinds = evidences.map((e) => (e as { fact: { value: { kind?: string } } }).fact.value.kind);
		expect(kinds).toContain("forced-release");
		await driver.close();
	});

	it("equip 找到物品并派发；未找到 TARGET_NOT_MET 不派发", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setSlot(12, { name: "minecraft:iron_pickaxe", count: 1, components: null, remainingDurability: null });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const receipt = await session.equip({ name: "minecraft:iron_pickaxe" }, "main");
		expect(receipt).toMatchObject({ dispatch: "sent", completion: "met" });

		await expect(session.equip({ name: "minecraft:diamond_pickaxe" }, "main")).rejects.toMatchObject({
			code: "TARGET_NOT_MET",
			dispatch: "not_sent",
		});
		await session.close();
		await driver.close();
	});

	it("interact 校验 face/cursor 后派发；无效组合派发前失败", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:crafting_table", properties: {} });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const receipt = await session.interact({
			target: {
				place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
				block: { x: 0, y: 64, z: 0 },
			},
			hand: "main",
			face: { x: 0, y: 1, z: 0 },
			cursor: { x: 0.5, y: 1, z: 0.5 },
		});
		expect(receipt).toMatchObject({ dispatch: "sent", completion: "met" });
		expect(bot.packets.some((pk) => pk.name === "block_place")).toBe(true);

		// cursor 不在指定面上：INVALID_ARGUMENT，未派发。
		await expect(
			session.interact({
				target: {
					place: { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } },
					block: { x: 0, y: 64, z: 0 },
				},
				hand: "main",
				face: { x: 0, y: 1, z: 0 },
				cursor: { x: 0.5, y: 0.5, z: 0.5 },
			}),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await session.close();
		await driver.close();
	});

	it("interact 派发失败如实报 SOURCE_UNAVAILABLE：不谎报 sent，也不吞成参数错误", async () => {
		class FailingActivationBot extends FakeClientBot {
			override async activateBlock(): Promise<void> {
				throw new BotFailure("unavailable", "目标方块未加载");
			}

			override async activateEntity(): Promise<void> {
				throw new BotFailure("unavailable", "实体已不在跟踪表");
			}
		}
		const bot = new FailingActivationBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:crafting_table", properties: {} });
		bot.addEntity({
			networkId: 7,
			uuid: "u7",
			type: "minecraft:zombie",
			position: { x: 2, y: 64, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
		});
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const place = { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } };

		await expect(
			session.interact({ target: { place, block: { x: 0, y: 64, z: 0 } }, hand: "main" }),
		).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", dispatch: "not_sent" });

		const ref = driver.facts.sample((v) => v.entities()).value.value.entities[0]!.ref;
		await expect(session.interact({ target: ref, hand: "main" })).rejects.toMatchObject({
			code: "SOURCE_UNAVAILABLE",
			dispatch: "not_sent",
		});
		expect(bot.packets.some((pk) => pk.name === "block_place")).toBe(false);
		expect(bot.packets.some((pk) => pk.name === "use_entity")).toBe(false);
		await session.close();
		await driver.close();
	});

	it("interact 等协议派发完成才回执：上游未完成前不回执", async () => {
		class SlowActivationBot extends FakeClientBot {
			started = false;
			release: () => void = () => {};

			override async activateBlock(): Promise<void> {
				this.started = true;
				await new Promise<void>((resolve) => {
					this.release = resolve;
				});
			}
		}
		const bot = new SlowActivationBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:crafting_table", properties: {} });
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const place = { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } };

		let settled = false;
		const p = session.interact({ target: { place, block: { x: 0, y: 64, z: 0 } }, hand: "main" }).then((r) => {
			settled = true;
			return r;
		});
		await flushAsync();
		expect(bot.started).toBe(true);
		// 上游 lookAt/写包未完成 → 不得先回 sent。
		expect(settled).toBe(false);
		bot.release();
		await expect(p).resolves.toMatchObject({ dispatch: "sent", completion: "met" });
		await session.close();
		await driver.close();
	});

	it("openContainer 激活失败立即失败，不等窗口超时", async () => {
		class FailingActivationBot extends FakeClientBot {
			override async activateBlock(): Promise<void> {
				throw new BotFailure("unavailable", "目标方块未加载");
			}
		}
		const bot = new FailingActivationBot();
		layFloor(bot, 0, 4);
		bot.setBlock({ x: 0, y: 64, z: 0 }, { name: "minecraft:chest", properties: {} });
		bot.programWindow("minecraft:chest", 27, new Array(27).fill(null));
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());
		const place = { world: "w", worldRevision: "wr", dimension: "minecraft:overworld", position: { x: 0, y: 0, z: 0 } };

		const started = Date.now();
		await expect(session.openContainer({ place, block: { x: 0, y: 64, z: 0 } })).rejects.toMatchObject({
			code: "SOURCE_UNAVAILABLE",
		});
		// openTimeoutMs=400：激活失败必须立刻返回，而不是白等满超时再报 EFFECT_UNCERTAIN。
		expect(Date.now() - started).toBeLessThan(300);
		await session.close();
		await driver.close();
	});

	it("断连撤销活动资格并拒绝后续操作", async () => {
		const bot = new FakeClientBot();
		layFloor(bot, 0, 12);
		const driver = await makeDriver(bot);
		const session = await driver.player.acquire(TEST_OWNER, signal());

		const p = session.drive({ keys: { forward: true } }, 100);
		// 先挂接拒绝断言再断连：bot.end 同步撤销资格并拒绝 drive。
		const rejected = expect(p).rejects.toMatchObject({ code: "CONTROL_INVALID" });
		bot.end("kicked");
		await rejected;
		await flushAsync();
		// 会话已被强制退役：旧引用全部拒绝。
		await expect(session.drive({ keys: {} }, 1)).rejects.toMatchObject({ code: "CONTROL_INVALID" });
		await driver.close();
	});
});
