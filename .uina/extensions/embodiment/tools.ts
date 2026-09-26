import type { Tool, ToolExecutionResult } from "../../../src/tools/broker.js";
import type { BodyRouter } from "./body-router.js";

/**
 * 创建 body 门面工具。
 *
 * onStateChange：操作后状态摘要比对回调（由激活层提供，落史不唤醒）。
 * 只有真正改变路由状态的子操作才回调并携带 reason；list/status 是纯读，永不触发。
 */
export function createBodyTool(router: BodyRouter, onStateChange?: (reason: string) => void): Tool {
  /** 需要指定 target 的变更型子操作：统一参数校验、失败消息与落史触发。 */
  const targetedOps: Record<
    string,
    { label: string; apply: (target: string) => boolean | Promise<boolean> }
  > = {
    switch_focus: { label: "切换主导焦点至", apply: (t) => router.setFocus(t) },
    pause: { label: "暂停身体端点", apply: (t) => router.pause(t) },
    resume: { label: "恢复身体端点", apply: (t) => router.resume(t) },
  };

  return {
    def: {
      type: "function",
      function: {
        name: "body",
        description: "管理数字主体的多具身端点（查看挂载的身体、查询单端点详细状态、切换主导焦点、单独暂停或恢复特定身体的控制）。状态变化会落史（embodiment.state-change）；需要即时真值时用 status 查询。",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "status", "switch_focus", "pause", "resume", "stop_all"],
              description: "子操作名称: list(查看列表), status(查询单端点完整状态), switch_focus(切换焦点), pause(暂停身体), resume(恢复身体), stop_all(全部急停)",
            },
            target: {
              type: "string",
              description: "目标端点 bodyId（status, switch_focus, pause, resume 时指定；status 缺省为主导身体）",
            },
          },
          required: ["action"],
        },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolExecutionResult> {
      const action = String(args.action ?? "");
      const target = typeof args.target === "string" ? args.target.trim() : undefined;

      const op = targetedOps[action];
      if (op) {
        if (!target) {
          return { result: `${action} 失败：必须指定 target (目标 bodyId)`, status: "failed" };
        }
        const ok = await op.apply(target);
        if (!ok) {
          return { result: `${action} 失败：未找到有效端点 ${target}`, status: "failed" };
        }
        onStateChange?.(`${action}: ${target}`);
        return { result: `已${op.label}: ${target}`, status: "succeeded" };
      }

      switch (action) {
        case "list": {
          return {
            result: JSON.stringify(router.listEndpoints(), null, 2),
            status: "succeeded",
          };
        }

        case "status": {
          // 即时真值查询：缺省主导身体。纯读操作，永不触发落史回调。
          const endpoint = target ? router.getEndpoint(target) : router.getPrimaryEndpoint();
          if (!endpoint) {
            return {
              result: target
                ? `状态查询失败：未找到端点 ${target}`
                : "状态查询失败：当前没有任何已注册端点",
              status: "failed",
            };
          }
          const summary = router.summaryOf(endpoint.bodyId)!;
          return {
            result: JSON.stringify(
              { ...summary, cues: endpoint.affordance().cues.map((c) => c.id) },
              null,
              2,
            ),
            status: "succeeded",
          };
        }

        case "stop_all": {
          await router.stopAll();
          onStateChange?.("stop_all: all endpoints");
          return {
            result: "已执行全身体安全急停，所有外壳已静止。",
            status: "succeeded",
          };
        }

        default:
          return {
            result: `未知子操作: ${action}`,
            status: "failed",
          };
      }
    },
  };
}
