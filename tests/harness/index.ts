/**
 * Uina Test Kit (Uina 专用测试框架)
 *
 * 统一门面导出：
 * - test / expect: 携带 UinaTestFixtures 的 Vitest 扩展运行器
 * - defineExtensionConformanceTests: 扩展契约合规性标准化测试生成器
 * - Scenario / createScenario: 声明式大模型剧本模拟器
 * - StreamBuilder / stream: 流式输出 Chunk 生成器
 * - UinaTestHarness: 核心测试驱动门面
 * - VirtualClock: 确定性虚拟时钟
 * - IsolatedEnv: 临时文件系统沙箱
 * - createSilentTerminal: 静音虚拟终端
 */

export { test, expect } from "./fixtures.js";
export type { UinaTestFixtures } from "./fixtures.js";
export { describe, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

export { defineExtensionConformanceTests } from "./conformance/extension-conformance.js";

export { Scenario, createScenario, mockModel } from "./provider/scenario.js";
export { StreamBuilder, stream } from "./provider/stream-builder.js";

export { UinaTestHarness } from "./host/harness.js";
export type { HarnessOptions } from "./host/harness.js";

export { EventCollector } from "./host/event-collector.js";

export { VirtualClock } from "./environment/virtual-clock.js";
export { IsolatedEnv } from "./environment/isolated-env.js";
export { createSilentTerminal, stripAnsiColors } from "./environment/silent-terminal.js";
export type { SilentTerminalResult } from "./environment/silent-terminal.js";
export { VtScreen } from "./environment/vt-screen.js";
export type { VtCell, Run } from "./environment/vt-screen.js";

export { assertDAGInvariants, assertNoResourceLeaks } from "./matchers/invariants.js";
