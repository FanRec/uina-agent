# 生存与脱困 — 分清即时安全与原任务

## 三种不同完成条件

1. **紧急换气 / 避险**：脱离实时危险，呼吸或生命状态**实测恢复**。由 Safety / 低层控制优先处理，不等模型完整推理。
2. **回到地表**：`surface@1` 的可站立 + 天空/环境判据真实满足；**不等于**回到指定家，也不等于恢复呼吸。
3. **返回家**：指定世界、维度、水平位置、足部高度与立足条件都经核验，由上层 Program 判断。

## 普通执行中的风险

挖隧道、采矿前注意已观察到的水、岩浆、重力方块和失足风险。能安全绕开就局部处理；未加载区域不要当成空气，先观察或靠近。危险已发生时 Safety 可以抢占，旧 Body handle 立即失效。
预防危险是 `mine/tunnel` 的事前局部判断，突发危险是 Safety 的实时介入，是否继续接受风险是 Program / 主脑的决定——三者不合并成一个"每步都过风险引擎"的架构。

## 如果被中断

查看当前 Run 的终态与最新事实：是用户 Stop、Safety 抢占还是断线？

- 用户 Stop：不自动续跑。
- Safety 暂时抢占且原目标仍要完成：先重新确认身体状态、库存、位置、危险和返回路线，再决定下一步。
- 不能因某一步逃跑成功，就宣称之前的采矿/建造目标完成。

## 不确定和死局

真实位置和氧气没有进展时，停止机械重试。可评估已知可信出口；若继续需要破坏大面积环境、承担重大生命风险或作弊脱困，先让主脑决定。
直播时可以自然说"我被水困住了，先找个能呼吸的位置"，不要假装已经逃出、已经到家。

```js
async function main(mc, input) {
  const self = await mc.read('self@1');
  const s = self.value;
  if (!s) mc.decide('读不到自身状态，无法判断脱困结果', { phase: 'unknown' });
  const home = input.home;
  const here = s.place.position;
  const atHome = s.place.dimension === home.dimension && s.onGround === true &&
    Math.hypot(here.x - home.position.x, here.z - home.position.z) <= home.tolerance &&
    Math.floor(here.y) === Math.floor(home.position.y);
  if (!atHome) mc.decide('还没回到家，不能按到家宣布完成', { phase: 'not_home', here, dimension: s.place.dimension });
  return { atHome: true };
}
```

终验只读最新事实；`goto@1` 的 proximity 成功、`surface@1` 的 `escaped` 都不是这段判据的替代品。
