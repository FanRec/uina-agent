# 中断、未知副作用与继续执行

一条总原则：**动作失败不等于目标失败；动作没回执也不等于它没发生。**

| 事实 | 推荐处理 |
| --- | --- |
| 入参被拒绝，确认 `dispatch:'not_sent'` | 修正参数/条件后可以重新调用 |
| 服务器已确认效果 | 更新已完成进度，不重复同一工作 |
| 已派发但效果 `unknown` | 停止相关写入、读新状态与 Effect；无法确认就保留未知，**绝不盲重试** |
| 路径不通，观察到替代路线 | 有界局部重规划 |
| Safety 暂时抢占 | 旧控制停止；风险解除、拿到新资格后读取现场再决定 |
| 用户明确 Stop | 不自动续跑 |
| 连接/世界代次变化 | 旧 Waypoint / Fact / Window / Body 句柄重新验证 |
| 无可信解决方案或目标需改变 | `mc.decide(reason, checkpoint)` |

`recoverable:true` 只表示"存在合理后续路径"，不是重试授权。`accepted` 是受理，不是完成；`Call/Capability met` 不等于最初的 Program 目标达成。

## Checkpoint

只保存下一段所必需的：**目标、阶段、已确认效果、候选与已知障碍及其来源**。不携带 Body / Window handle，不保存"世界当前事实"（下段必须重读）。
`mc.decide` 结束当前段；`tasks.continue {task, decision, entry, environment}` 建新段，续段用只读 `mc.checkpoint` 取回检查点，重新读现场，不恢复旧 JS 调用栈。

```js
async function main(mc, input) {
  const cp = mc.checkpoint || {};
  const self = await mc.read('self@1');
  const bag = await mc.read('inventory@1');
  if (!self.value || !bag.value) mc.decide('现场不可读', { phase: 'recheck_unknown', goal: cp.goal });
  const observed = { position: self.value.place.position, dimension: self.value.place.dimension,
                     counts: bag.value.counts };
  if (!cp.goal) return { phase: 'fresh', observed };
  mc.progress({ phase: 'resumed', goal: cp.goal, observed });
  return { phase: 'resumed', observed, goal: cp.goal };
}
```

## 长任务与 Completion

顶层 `run` 受理表示后台已接单，实际阶段以任务查询为准；完成事件 `minecraft_completion` 与 `tasks.get/trace` 反映当前真实终态。
不要因为几秒没收到 Completion 就重复下单。当前 `runs`、`run.schedule` 及等待相关字段以 `describe` 的最新工具 schema 为准；旧的同步 `wait` / 短窗等待说明已由异步 Run 改造删除。

## 写经验

修复一类错误后，以相似但**不同**的环境再验证，才写 Experience。未观察的部分标为推测；已被证伪的旧方法要更新，而不是永远追加一条补丁。
官方 Guide 是随版本发布的只读资料；个人 Experience / Program 由你通过 `library` 自己保存，两者生命周期不同，不会互相覆盖。
