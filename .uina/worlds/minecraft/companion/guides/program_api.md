# Program API — 组合、观察、验证与交接

Program 是普通 JavaScript：`async function main(mc, input) { ... }`。不能 `import`/`require`/`fs`/`net`。
一个明确目标能由单个 Capability 完成时直接调那个能力；只有需要循环、条件判断、跨阶段持续观察时才写 Program。
能力/程序/蓝图的确切入参、completion 与示例用 `describe {selector:'collect@1'}` 或 `describe {query:'...'}` 查，本文件不复制 schema。

版本化 selector 始终从同一份能力目录解析。`collect@1` 是发布的 Program，仍以实际入包增量为完成判据。个人 Library 程序用裸名调用，成功表示脚本返回。发布的可恢复施工能力 `build.resume@1` 可以用 `mc.saveCheckpoint(state)` 等待进度提交落盘，续段仍会重新读取现场。

## 五个事实

1. `mc.call(selector, input)` **直接返回该动作的业务结果**，不是 `{value:...}` 包装。例如 `collect@1` 返回 `{mined, acquired, collected, remaining, toolsUsed}`。
2. `mc.read(ref, input)` 返回 `{value, version, unknown}`。`unknown` 非空或 `value` 缺失时，不能当成"没有"。
3. `mc.progress(obj)` 只更新当前诊断快照，**不是**持久恢复存档；对象过大或含非法值会抛 `PROGRAM_VALUE`。
4. `mc.decide(reason, checkpoint?)` 抛 `NEEDS_DECISION` 结束当前段，交还主脑；续段由 `tasks.continue` 新建，重新读取现场，不恢复旧 JS 调用栈、Body 或 Window 句柄。只读 `mc.checkpoint` 在续段取回检查点。
5. 顶层 `run` 只回受理结果。任务完成由 `minecraft_completion` 独立投递，`tasks.get` 可查当前结果。Program 内 `await mc.call(...)` 等待子动作结果。

子动作失败会抛带 `code / message / source / dispatch / effects / progress / hint / recoverable` 的 Error。

**未知效果不交付业务值**：子调用正常返回只代表已确认的成功；效果还没对账完（挖了没确认、点击没确认）会抛 `EFFECT_UNCONFIRMED`（`effects` 是待对账的效果引用，`progress` 是真实进度）。catch 后先读世界事实或用 `mc.verify` 核验原效果，再决定换路、交还或继续；不要原样重放原操作。

```js
async function main(mc, input) {
  const at = input.at;
  try {
    await mc.call('mine@1', { at });
  } catch (error) {
    if (error.code !== 'EFFECT_UNCONFIRMED') throw error;
    const seen = await mc.read('block@1', { at });
    if (!seen.value || !seen.value.block) mc.decide('目标方块无法可靠观察', { at, effects: error.effects });
    if (seen.value.block.name !== 'air') mc.decide('方块还在，需要换方案', { at, effects: error.effects });
    // 只确认"当前是空气"；旧 mine 效果的历史结论不因此改写。
  }
  return { checkedAt: at };
}
```
`recoverable:true` 只表示"存在合理的后续路径"，**不是**自动重试授权：`dispatch:'sent'` 或 `effects` 非空时先重新读世界事实，不原样重跑。

## 目标与进度

`collect@1` 的 `count` 是**本次入包增量**；若目标是"最终背包至少 N 个"，必须先读库存算差额。

```js
async function main(mc, input) {
  const need = input.need;
  const before = await mc.read('inventory@1');
  if (!before.value || !before.value.counts) mc.decide('背包不可读', { phase: 'inventory_unknown' });
  const have = before.value.counts[input.item] || 0;
  const missing = Math.max(0, need - have);
  if (missing > 0) {
    const gained = await mc.call('collect@1', { item: input.item, count: missing, radius: 12 });
    mc.progress({ phase: 'gather', acquired: gained.acquired });
  }
  const after = await mc.read('inventory@1');
  const final = (after.value && after.value.counts && after.value.counts[input.item]) || 0;
  if (final < need) mc.decide('真实库存未达到目标', { phase: 'verify_failed', observedCount: final, need: need });
  return { item: input.item, observedCount: final };
}
```

## 等待、避免轮询

要留出一段时间，可以直接 `await mc.sleep(1000)`。要等背包或方块发生变化，用 `mc.waitUntil`，让 Program 在条件满足时继续。

```js
async function main(mc, input) {
  const outcome = await mc.waitUntil(
    { bag: { ref: 'inventory@1', input: {} } },
    (values, info) => (values.bag && values.bag.counts && (values.bag.counts[input.item] || 0)) >= input.need,
    { timeoutMs: 20000 }
  );
  if (outcome.kind === 'invalidated') mc.decide('来源换代，旧游标不可用', { phase: 'invalidated' });
  if (outcome.kind !== 'met') mc.decide('等待超时后目标仍未达成', { phase: 'timeout', observed: outcome.values });
  return { kind: outcome.kind };
}
```

谓词必须**同步返回布尔**；不能是 `async`、不能返回 Promise、不能在谓词里发副作用。
`invalidated` 表示 query 来源换代，旧游标不再代表当前事实。没有明确等待条件时不要写死循环。
`mc.waitUntil` 可等 `self/inventory/block/world/entities`；历史事件先 `mc.read('events@1')` 取最终页的 `page.after` 放进 target 的 `input`。
`mc.sleep(ms)` 让出；帧窗约 250ms，长同步计算必须 `await mc.sleep(0)` 分片，否则 `apply` 报 `FRAME_EXPIRED`。

## 受理、调度与继续

- `run.schedule`：`{kind:'enqueue',priority:true}` 让身体申请插队一档（Safety 仍最前）；`{kind:'replace_pending',targets:[...]}` 用任务句柄替换排队项；`{kind:'preempt_current',expectedRun:'...'}` 用任务句柄抢占 `control=active` 的任务。`tasks.continue` 不带 schedule。
- `run/chat/tasks.continue` 返回 `accepted`（已交给运行时）、`rejected`（未受理）或 `confirming`（用原 task 调 `tasks.get` 查证）。
- 停止游戏任务用 `tasks.stop`；工具取消只结束等待。
- 程序试做成功后再用 `library.save {name,summary,from:{run,segment,call}}` 保存确切调用（先用 `tasks.trace` 找 Call）；也可以直接 `source` 保存。Experience 是有条件的判断，不是系统规则。

## 示例未验证前的边界

本文件的示例经过 Program 编译校验，但**没有**经过任意地图的真服任务验证。经过真实任务验证后才在自己的 Library 里标为推荐；不要把示例当作"任何环境都能可靠完成"的承诺。
