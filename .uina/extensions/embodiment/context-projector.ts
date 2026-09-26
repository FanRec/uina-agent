import type { BodyRouter } from "./body-router.js";

/**
 * 具身上下文投影器 (Context Projector)
 *
 * 生成 tail 帧正文：只投"模型无法从内部得知的事实"（在线性、cue 能力、焦点），
 * 不投模型自己动作的后果（pose/costume 存续已在动作记忆里）。
 * 行为规范（"离线时如实告知"）已迁入系统提示一次常驻，此处不再逐轮复读。
 */
export function projectEmbodimentContext(router: BodyRouter): string | undefined {
  const primary = router.getPrimaryEndpoint();
  if (!primary) {
    return undefined;
  }

  const affordance = primary.affordance();
  const state = primary.state();
  const lines: string[] = [];

  if (state.online) {
    const cueList = affordance.cues
      .map((c) => `<cue id="${c.id}"/> (${c.description})`)
      .join("、");
    lines.push(
      `[body] ${affordance.bodyId}: 在线`,
      `- 伴随动作标签: ${cueList}`,
    );
  } else {
    lines.push(`[body] ${affordance.bodyId}: 离线 (${state.fault ?? "disconnected"})`);
  }

  const others = router
    .listEndpoints()
    .filter((e) => e.bodyId !== affordance.bodyId && e.online && !e.isPaused);

  if (others.length > 0) {
    const otherList = others.map((o) => `${o.bodyId} (${o.bodyType})`).join("、");
    lines.push(`- 辅助身体: ${otherList} (标签中带 target 属性可定向调度)`);
  }

  return lines.join("\n");
}
