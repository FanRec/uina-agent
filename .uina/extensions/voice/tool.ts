import type { Tool, ToolExecutionContext, ToolExecutionResult } from "../../../src/tools/broker.js";
import type { PlaybackBreakpoint, InterruptResult } from "./driver.js";
import { describeDelivery } from "./driver.js";
import { VoiceSession } from "./session.js";

function describeBreakpoint(bp: PlaybackBreakpoint): string {
  const where = bp.segmentText ? `第 ${bp.segmentIndex} 句「${bp.segmentText.slice(0, 20)}」停在第 ${bp.committedCharEnd} 字` : `第 ${bp.segmentIndex} 句停在第 ${bp.committedCharEnd} 字`;
  return `（物理播放头${where}）`;
}
function renderInterruption(result: InterruptResult): Pick<ToolExecutionResult, "result" | "status"> {
  if (result.breakpoint) return { result: `已停止当前发声并清空未播内容${describeBreakpoint(result.breakpoint)}。`, status: "succeeded" };
  if (result.outcome === "no_op") return { result: `无需停止：${result.reason ?? "当前没有发声"}。`, status: "succeeded" };
  if (result.outcome === "unknown") return { result: `停止结果未知：${result.reason}。`, status: "unknown" };
  if (result.outcome === "failed") return { result: `停止失败：${result.reason}。`, status: "failed" };
  return { result: "已停止当前发声，但没有可用播放断点。", status: "succeeded" };
}

export function createVoiceTool(session: VoiceSession): Tool {
  return {
    def: { type: "function", function: {
      name: "voice",
      description: "交流发声。普通回答直接写正文即可（正文会自动朗读）。需要收住正在说的话用 interrupt；需要在正文之外独立说一句，或收住旧话后改口，用 speak(replace=true)。status 只在声音情况不明确且影响决定时查看，不用每次开口前查询。manage 改变后续发声偏好，仅按用户要求或已授权策略使用，不用于处理故障或临时打断。播放记录不代表用户听到或理解；检查发声系统问题用 tts。",
      parameters: { type: "object", additionalProperties: false, properties: { action: { type: "string" }, text: { type: "string" }, replace: { type: "boolean" }, operation: { type: "string" }, enabled: { type: "boolean" } }, oneOf: [
        { properties: { action: { const: "interrupt" } }, required: ["action"] },
        { properties: { action: { const: "status" } }, required: ["action"] },
        { properties: { action: { const: "speak" }, text: { type: "string", minLength: 1 }, replace: { type: "boolean" } }, required: ["action", "text"] },
        { properties: { action: { const: "manage" }, operation: { enum: ["mute", "unmute", "set_text_reading"] }, enabled: { type: "boolean" } }, required: ["action", "operation"] },
      ] },
    } },
    run: async (args: Record<string, unknown>, _signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const action = args.action;
      if (action === "speak") {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return { result: "speak 未执行：台词为空。", status: "not_started" };
        const result = await session.speak(text, args.replace === true, context);
        if (!result) return { result: "speak 未执行：发声驱动未挂载。", status: "not_started" };
        const outcome = result as { status?: string; reason?: string };
        if (outcome.status === "unknown" || outcome.status === "uncertain") return { result: "台词已提交但交付结果未知，未自动重播。", status: "unknown", details: result };
        if (outcome.status === "failed" || outcome.status === "rejected") return { result: `台词未接受：${outcome.reason ?? outcome.status}。`, status: "failed", details: result };
        return { result: "台词已进入当前发声路径；这不等于设备已播放完成。", status: "succeeded", details: result };
      }
      if (action === "interrupt") return { ...renderInterruption(await session.interrupt()), details: await session.getStatus() };
      if (action === "status") {
        const status = await session.getStatus();
        return { result: [
          `语音偏好：${status.voiceState === "enabled" ? "允许发声" : "已静音"}`,
          `正文朗读：${status.readAssistantText ? "开启" : "关闭"}`,
          `交付：${describeDelivery(status.snapshot)}`,
        ].join("；"), status: "succeeded", details: status };
      }
      if (action === "manage") {
        const operation = args.operation;
        if (operation === "mute" || operation === "unmute") {
          const result = await session.setMuted(operation === "mute");
          // 主副作用是偏好转换（§6.2）：偏好已改变即 succeeded；物理/持久化后果另行说明。
          const physical = result.isOnline === false || (result as { ok?: boolean }).ok === false || result.persisted === false;
          const note = operation === "unmute" && result.isOnline === false
            ? "已允许发声，但发声服务当前不可用；修复后新内容可以发声。"
            : operation === "mute" ? "已静音；后续发声不会输出。" : "已允许发声；仍需以实际交付事实为准。";
          return { result: physical ? `${note}（${result.reason ?? "附带结果见 details"}）` : note, status: "succeeded", details: result };
        }
        const enabled = typeof args.enabled === "boolean" ? args.enabled : undefined;
        if (enabled === undefined) return { result: "set_text_reading 需要 enabled 布尔值。", status: "not_started" };
        const result = await session.setTextReading(enabled);
        const note = `正文自动朗读已${enabled ? "开启" : "关闭"}。`;
        return { result: result.persisted === false || result.reason ? `${note}（${result.reason ?? "偏好仅内存生效"}）` : note, status: "succeeded", details: result };
      }
      return { result: "voice action 未执行：参数不符合 voice 合同。", status: "not_started" };
    },
  };
}
