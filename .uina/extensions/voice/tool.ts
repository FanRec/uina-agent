import type { Tool, ToolExecutionResult } from "../../../src/tools/broker.js";
import { describeDelivery, type PlaybackBreakpoint } from "./driver.js";
import { VoiceSession } from "./session.js";

function describeBreakpoint(bp: PlaybackBreakpoint): string {
  const where = bp.segmentText
    ? `第 ${bp.segmentIndex} 句「${bp.segmentText.slice(0, 20)}」停在第 ${bp.committedCharEnd} 字`
    : `第 ${bp.segmentIndex} 句停在第 ${bp.committedCharEnd} 字`;
  return `（物理播放头${where}）`;
}

export function createVoiceTool(session: VoiceSession): Tool {
  return {
    def: {
      type: "function",
      function: {
        name: "voice",
        description: "初奈语音发声与状态控制（支持开麦、关麦、打断发音与状态查询）",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: `子操作名称:
- "mute": 关麦/静音（后续回复只打字不发音）
- "unmute": 开麦（恢复语音发音）
- "interrupt": 立即掐断当前发音并清空未播排队
- "status": 查看开麦状态、物理播放状态与交付进度（说到第几句、还有多少未播完）`,
            },
            params: {
              type: "object",
              properties: {
                expectedTraceId: {
                  type: "string",
                  description: "可选。指定要打断的 traceId，若当前播放轮次已变更则不误杀下一轮",
                },
              },
              description: "子操作参数（可选）",
            },
          },
          required: ["action"],
        },
      },
    },
    run: async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      const action = String(args.action ?? "").trim().toLowerCase();
      const params = (args.params && typeof args.params === "object" ? args.params : {}) as Record<string, unknown>;

      switch (action) {
        case "mute": {
          const res = await session.setMuted(true);
          if (res.isOnline === false) {
            return {
              result: `已关麦。${res.reason ?? "发声驱动不可用"}——本来也不会出声。`,
              status: "succeeded",
            };
          }
          return {
            result: "麦克风已关麦（静音模式，后续回答只打字不发音）。",
            status: "succeeded",
          };
        }
        case "unmute": {
          const res = await session.setMuted(false);
          if (res.isOnline === false) {
            return {
              result: `开麦提示：${res.reason ?? "发声伴生服务离线"}。当前保持纯打字模式，可在后台启动服务后再次调用开麦。`,
              status: "succeeded",
            };
          }
          return {
            result: "麦克风已开麦（已连接发声服务，恢复语音发声）。",
            status: "succeeded",
          };
        }
        case "interrupt": {
          const expectedTraceId = typeof params.expectedTraceId === "string" ? params.expectedTraceId : undefined;
          const bp = await session.interrupt(expectedTraceId);
          const detail = bp ? describeBreakpoint(bp) : "（当前无发声或未捕获断点）";
          return {
            result: `已立即掐断当前发音并清空排队${detail}。`,
            status: "succeeded",
          };
        }
        case "status": {
          const status = await session.getStatus();
          const text = [
            `发声意志: ${status.voiceState === "enabled" ? "🎙️ 开麦中" : "🔇 已关麦"}`,
            `物理播放: ${describeDelivery(status.snapshot)}`,
            `驱动挂载: ${status.hasDriver ? "✅ 已连接" : "⚠️ 未挂载"}`,
          ].join(" | ");

          return {
            result: text,
            status: "succeeded",
            details: status,
          };
        }
        default: {
          return {
            result: `未知的 voice 子操作: "${action}"。可用操作: mute, unmute, interrupt, status。`,
            status: "failed",
          };
        }
      }
    },
  };
}
