/**
 * Minecraft Driver 测试共享替身装配（Driver AI 所有，前缀 minecraft-driver-*）。
 *
 * FakeClientBot 行为按 mineflayer 7b4bb8d2 已核实路径建模；
 * 这些测试证明 Driver 逻辑对形状正确的客户端成立，不证明真实服务器行为（M5 验收）。
 */

import { expect, vi } from "vitest";
import {
	createDriver,
	FakeClientBot,
	type DriverHandle,
	type DriverOptions,
} from "../.uina/worlds/minecraft/driver/index.js";

export { createDriver };
import type { ControlOwner } from "../.uina/worlds/minecraft/contracts/body.js";

export { FakeClientBot };

export const TEST_OWNER: ControlOwner = { kind: "run", run: "r-test", segment: "s-test", callId: "c-test" };

export function testOwner(n: number): ControlOwner {
	return { kind: "run", run: `r-${n}`, segment: `s-${n}`, callId: `c-${n}` };
}

export interface Harness {
	driver: DriverHandle;
	bot: FakeClientBot;
}

export async function makeDriver(bot: FakeClientBot, options: DriverOptions = {}): Promise<DriverHandle> {
	const driver = createDriver(
		{ host: "localhost", port: 25565, username: "tester", authMode: "offline" },
		{
			botFactory: () => bot,
			stallTimeoutMs: 400,
			openTimeoutMs: 400,
			feedbackValidityMs: 80,
			...options,
		},
	);
	// FakeClientBot 的登录完成 = 发出 spawn（真实 mineflayer 在协议登录后 emit spawn）。
	bot.respawn();
	await vi.waitFor(() => expect(driver.connectionState()).toBe("ready"), { timeout: 2_000 });
	return driver;
}

/** 铺设 from..to × from..to 的地面方块（fake 物理模拟需要脚下区块数据）。 */
export function layFloor(bot: FakeClientBot, from: number, to: number, y = 63, z0 = from): void {
	for (let x = from; x <= to; x++) {
		for (let z = z0; z <= to; z++) {
			bot.setBlock({ x, y, z }, { name: "stone", properties: {} });
		}
	}
}

export function flushAsync(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}
