import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../../../src/tools/broker.js";
import type { TtsVoiceOutputDriver } from "./driver-impl.js";

type Component = "bridge" | "vendor" | "player" | "extension";

export function createTtsTool(driver: TtsVoiceOutputDriver): Tool {
  return {
    executionMode: "sequential",
    def: { type: "function", function: {
      name: "tts",
      description: "按需检查和有限维护发声系统；检查、启动和连通不等于声音已恢复。",
      parameters: { type: "object", additionalProperties: false, properties: { action: { type: "string" }, component: { type: "string" }, operation: { type: "string" }, target: { type: "string" }, scope: { type: "string" }, session_id: { type: "string" } }, oneOf: [
        { properties: { action: { const: "inspect" }, component: { enum: ["bridge", "vendor", "player", "extension"] } }, required: ["action"] },
        { properties: { action: { const: "recover" }, operation: { enum: ["reconnect", "reset"] } }, required: ["action", "operation"] },
        { properties: { action: { const: "recover" }, operation: { const: "restart" }, target: { enum: ["bridge", "vendor"] } }, required: ["action", "operation", "target"] },
        { properties: { action: { const: "test" }, scope: { enum: ["synthesis", "playback"] } }, required: ["action"] },
      ] },
    } },
    run: async (args: Record<string, unknown>, _signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const action = args.action;
      if (action === "inspect") {
        const details = await driver.inspect();
        const component = args.component as Component | undefined;
        return { result: renderInspect(details, component), status: details.status === "unknown" ? "unknown" : "succeeded", details };
      }
      if (action === "test") {
        const scope = (args.scope === "playback" ? "playback" : "synthesis") as "synthesis" | "playback";
        const details = await driver.test(scope);
        return { result: renderTest(details), status: toToolStatus(details.status), details };
      }
      if (action === "recover") {
        if (args.operation === "restart") {
          return { result: "restart 未实现：当前 Companion 只提供扩展拥有的启动/停止句柄，不能把端口或 PID 当作可重启所有权。", status: "not_started", details: { target: args.target, ownership: "unverified" } };
        }
        const details = await driver.recover(args.operation as "reconnect" | "reset", context?.invocationId);
        return { result: renderRecover(details), status: toToolStatus(details.status), details };
      }
      return { result: "tts action 未执行：参数不符合维护合同。", status: "not_started" };
    },
  };
}

function toToolStatus(value: unknown): ToolExecutionResult["status"] {
  if (value === "failed") return "failed";
  if (value === "unknown" || value === "uncertain") return "unknown";
  if (value === "not_started") return "not_started";
  return "succeeded";
}
function renderInspect(details: Record<string, unknown>, component?: Component): string {
  if (details.status === "unknown") return `检查${component ? ` ${component}` : "发声系统"}未完成：${String(details.reason ?? "当前无法观察 Bridge")}。`;
  const health = details.health as Record<string, unknown> | undefined;
  const facts = health ? Object.entries(health).filter(([key]) => !/token|secret|password|text|prompt|log/i.test(key)).map(([key, value]) => `${key}=${String(value)}`).join("；") : "Bridge 返回了可观察结果";
  return `检查完成${component ? `（${component}）` : ""}：已确认 HTTP/Bridge 可观察。${facts}。尚未由此证明模型可合成、设备已播放或用户已听见。`;
}
function renderTest(details: Record<string, unknown>): string {
  if (details.status === "unknown") return `测试结果未知：${String(details.reason ?? "验证边界不可观察")}。没有把受理或 /docs 可达当作测试通过。`;
  if (details.status === "failed") return `测试失败：${String(details.reason ?? "实际验证路径失败")}。`;
  return `已执行 ${String(details.scope ?? "synthesis")} 测试并返回结果；仅证明该测试声明的范围，不证明用户听见。`;
}
function renderRecover(details: Record<string, unknown>): string {
  if (details.status === "unknown") return `已发起${String(details.operation)}，但结果未知：${String(details.reason ?? "未取得确认")}。不会清除 unknown，也不会自动重播旧台词。`;
  return `${String(details.operation)} 已执行；返回结果只覆盖连接/epoch 对账范围，不等于声音已经恢复。`;
}
