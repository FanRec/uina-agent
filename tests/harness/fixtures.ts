import { test as baseTest, expect } from "vitest";
import "./matchers/custom-matchers.js";
import { IsolatedEnv } from "./environment/isolated-env.js";
import { VirtualClock } from "./environment/virtual-clock.js";
import { createSilentTerminal, type SilentTerminalResult } from "./environment/silent-terminal.js";
import { Scenario } from "./provider/scenario.js";
import { UinaTestHarness } from "./host/harness.js";

export interface UinaTestFixtures {
	/** 隔离的临时文件沙箱环境（自动清理） */
	env: IsolatedEnv;
	/** 声明式大模型剧本提供者 */
	scenario: Scenario;
	/** 静音的虚拟终端（捕获屏幕帧，杜绝控制台刷屏） */
	terminal: SilentTerminalResult;
	/** 确定性虚拟时钟（瞬间快进逻辑时间，消灭 setTimeout 等待） */
	clock: VirtualClock;
	/** 核心测试驱动门面（组装好全部组件的 UinaHost） */
	uina: UinaTestHarness;
}

/**
 * Uina 专用测试运行器（继承自 Vitest test）：
 * 支持按需解构治具，所有治具在测试结束后严格自动执行 RAII 销毁与资源释放。
 */
export const test = baseTest.extend<UinaTestFixtures>({
	env: async ({}, use) => {
		const env = await IsolatedEnv.create();
		await use(env);
		await env.dispose();
	},

	scenario: async ({}, use) => {
		const scenario = new Scenario();
		await use(scenario);
	},

	terminal: async ({}, use) => {
		const terminal = createSilentTerminal();
		await use(terminal);
	},

	clock: async ({}, use) => {
		const clock = new VirtualClock();
		await use(clock);
		clock.dispose();
	},

	uina: async ({ env, scenario, terminal }, use) => {
		const harness = await UinaTestHarness.create({ env, scenario, terminal });
		await use(harness);
		await harness.dispose();
	},
});

export { expect };
export { mockTool } from "./core/subject-harness.js";
