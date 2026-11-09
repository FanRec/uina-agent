/**
 * 单 active 资格槽的生命周期：结算路径里任何一步抛错都必须释放 permit。
 * 双布尔槽时代泄漏只影响一半写端，改成单槽后一次泄漏会让整个连接的所有
 * body/goto 永久 CONTROL_CONFLICT，所以 release 必须挂在 finally 上。
 */
import { expect, test } from "vitest";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import type { PlayerPortDeps } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import { PlayerPortImpl } from "../../.uina/worlds/minecraft/driver/body/player-port.js";
import { GotoDirector } from "../../.uina/worlds/minecraft/driver/goto.js";
import { makeBodyBot, openSignal, ownerT } from "./mc-fake-driver.js";

function gotoHarness() {
	const arbiter = new DriverControlArbiter();
	let sequence = 0;
	const director = new GotoDirector({
		assertActionAllowed: () => {},
		host: {
			state: "ready",
			identity: { connection: "conn:t1", incarnation: "inc:t1" },
			on: () => () => {},
		} as unknown as PlayerPortDeps["host"],
		bot: () => makeBodyBot(),
		sink: {
			record: () => {
				throw new Error("cleanup fact could not be recorded");
			},
			ensureDurable: async () => {},
		},
		arbiter,
		mintOp: () => `op:${++sequence}`,
		mintEff: () => `eff:${++sequence}`,
	});
	return { arbiter, director };
}

function portHarness() {
	const arbiter = new DriverControlArbiter();
	const host = {
		state: "ready",
		identity: { connection: "conn:t1", incarnation: "inc:t1" },
		// 宿主退订在 close 的结算中途抛错：onClosed 仍必须被调用，否则资格泄漏。
		on: () => () => {
			throw new Error("host detach failed");
		},
	} as unknown as PlayerPortDeps["host"];
	let sequence = 0;
	const port = new PlayerPortImpl({
		assertActionAllowed: () => {},
		host,
		bot: () => makeBodyBot(),
		sink: {
			record: () => ({ instance: "rw:t1", sequence: ++sequence }),
			ensureDurable: async () => {},
		},
		sampleSelf: () => null,
		arbiter,
		mintBody: () => `body:${++sequence}`,
		mintOp: () => `op:${++sequence}`,
		mintEff: () => `eff:${++sequence}`,
	});
	return { arbiter, port };
}

test("导航结算写清理事实失败时，资格仍被释放", async () => {
	const { arbiter, director } = gotoHarness();
	const permit = arbiter.claim("goto");
	expect(permit).not.toBeNull();

	// 直接驱动结算：bot=null 时 quiescence 立即为 false，唯一可能抛的就是事实写入。
	await expect(
		(director as unknown as { settle: (...args: unknown[]) => Promise<void> }).settle(
			null,
			"eff:t1",
			"op:t1",
			"settlement failed",
			permit,
		),
	).rejects.toThrow(/cleanup fact could not be recorded/);
	expect(arbiter.claim("body")).not.toBeNull();
});

test("Body 会话关闭时宿主退订抛错，资格仍被释放", async () => {
	const { arbiter, port } = portHarness();
	const session = await port.acquire(ownerT(1), openSignal());
	await expect(session.close()).rejects.toThrow(/host detach failed/);
	expect(arbiter.claim("body")).not.toBeNull();
});
