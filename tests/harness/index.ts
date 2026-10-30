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

export { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
export type { SubjectHarnessOptions } from "./core/subject-harness.js";
export { SubjectHarness } from "./core/subject-harness.js";
export { IsolatedEnv } from "./environment/isolated-env.js";
export type { SilentTerminalResult } from "./environment/silent-terminal.js";
export { createSilentTerminal, stripAnsiColors } from "./environment/silent-terminal.js";
export { VirtualClock } from "./environment/virtual-clock.js";
export type { Run, VtCell } from "./environment/vt-screen.js";
export { VtScreen } from "./environment/vt-screen.js";
export type { ExtensionHarnessOptions } from "./extensions/extension-harness.js";
export { createExtensionHarness, ExtensionHarness } from "./extensions/extension-harness.js";
export type { UinaTestFixtures } from "./fixtures.js";
export { expect, mockTool, test } from "./fixtures.js";
export { EventCollector } from "./host/event-collector.js";
export type { HarnessOptions } from "./host/harness.js";
export { UinaTestHarness } from "./host/harness.js";

export { assertDAGInvariants, assertNoResourceLeaks } from "./matchers/invariants.js";
export { createScenario, mockModel, Scenario } from "./provider/scenario.js";
export { StreamBuilder, stream } from "./provider/stream-builder.js";
export { rewindTo, seedSession } from "./session/session-helpers.js";
export { assistantNode, record, thinkingNode, toolDoneNode, toolStartNode, turnNode } from "./ui/nodes.js";
export type { TestTUIOptions } from "./ui/ui-harness.js";
export {
	createTestTUI,
	dispatchUIHostInput,
	getTestTrajectoryProjection,
	getTestUIHost,
	isHeartbeatActive,
	mockModelGroups,
	renderWidget,
	UITestHarness,
} from "./ui/ui-harness.js";
