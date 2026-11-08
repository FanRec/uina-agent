# 采矿实践 — 从资源目标到安全返程

## 目标先行

想要"16 个粗铁"，先确认是**最终背包数量至少 16**还是**新采集 16 个**。`collect@1` 按本次实际入包增量核验；已有库存要先 `mc.read('inventory@1')` 再算差额。
`iron_ore` 是方块名，常规掉落物是 `raw_iron`；精准采集等条件会改变产物。按当前版本的 `item@1` / Knowledge 查来源，别把名字当无条件别名。

## 能力选择

| 意图 | 优先方式 |
| --- | --- |
| 打掉一格确定方块 | `mine@1` |
| 从可达资源中取得物品数量 | `collect@1` |
| 挖出可行走的通道 / 楼梯 | `tunnel@1` |
| 找未知矿脉或拓展观察 | `explore@1` 与 `blocks@1` 等查询 |
| 明确清空一块空间 | `excavate@1` |
| 采矿、换工具、脱困、返回家这一整项任务 | Program 编排 |

"获得铁"不是"清空一个方体"。`excavate@1` 用于明确指定体积的清空，不用于采矿。

## 行动顺序

1. 读位置、维度、库存、工具、生命与已知环境，记下真实起点（含 Y）。
2. 判断矿是否已知且可达。已知可达就 `collect@1`；需要挖路用 `tunnel@1`。未知先探索，"没看见"不等于"没有"。
3. 新的矿道段执行前检查可见的水、岩浆、砂砾和站位安全。普通移动默认不建脚手架（`placeToReach:false`）；确实要施工时由调用方显式授权。
4. 每段用库存与位置事实核对进度，而不是仅凭工具文字成功。
5. 采集足量后按已经过、可信的少量 waypoint 返程；路径失效时重新观察，无法确认安全方案时交主脑。
6. 最终在家坐标的合适高度、维度、立足状态核验，并确认目标物品仍在背包。`surface@1` 只说明上到地表，**不等于回家**。

```js
async function main(mc, input) {
  const item = input.item || 'raw_iron';
  const home = input.home;
  const self = await mc.read('self@1');
  const bag = await mc.read('inventory@1');
  if (!self.value || !bag.value) mc.decide('起点或背包不可读', { phase: 'start_unknown' });
  const start = { place: self.value.place, onGround: self.value.onGround };
  mc.progress({ phase: 'gather', item, need: input.finalCount, have: bag.value.counts[item] || 0 });
  return { start, home, observedCount: bag.value.counts[item] || 0 };
}
```

上面的片段故意只做"读起点 + 报告差额"：采集与返程要按现场事实分阶段做，不能把未验证的路径写死成完成。

## 失败

- `NOT_FOUND`：查看观察覆盖与矿物来源，换地点或扩大探索；不是对同一格反复挖。
- `UNREACHABLE`：具体路线失败时换可观测路线；需要修改地形才能让主脑决定。
- `TIMEOUT`：先看 `dispatch/effects/progress`。已派发的动作不可盲重放，先重新观察方块与库存。
- `INTERRUPTED`：观察 Safety / Stop / 断线原因；用户 Stop 不自动继续。
- Window / Body `unknown`：先恢复可信状态，不因"还没成功"就重复写入。
