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

## 可复制采集 Program

将下方源码传给 run.code 或保存到 Library。默认寻找 16 格内的原木来源，修改 input.radius 可改变搜索策略。普通返回表示脚本执行结束，实际完成量以 acquired 和背包读数为准。

```js
async function main(mc, input) {
  const radius = input.radius ?? 16;
  const count = input.count ?? 1;
  const item = input.item ?? "oak_log";
  if (!Number.isInteger(count) || count < 1 || count > 64 ||
      !Number.isInteger(radius) || radius < 4 || radius > 64) {
    throw new Error("count must be 1–64 and radius 4–64");
  }

  const knowledge = (await mc.read("item@1", { name: item })).value;
  const name = knowledge.name;
  const bag = async () => (await mc.read("inventory@1")).value;
  const initial = await bag();
  const baseline = initial.counts[name] ?? 0;
  let acquired = 0;
  let mined = 0;
  let skipped = 0;
  const progress = () => ({ item: name, acquired, mined, skipped, remaining: Math.max(0, count - acquired) });
  const update = async () => {
    const inventory = await bag();
    acquired = Math.max(0, (inventory.counts[name] ?? 0) - baseline);
    mc.progress(progress());
    return inventory;
  };
  const matches = (selector, slot) => typeof selector === "string"
    ? slot.name === selector
    : selector.name === slot.name && (selector.slot == null || selector.slot === slot.slot);
  const tool = input.tool;
  if (tool != null && !initial.slots.some((slot) => matches(tool, slot))) {
    mc.decide("指定工具不在背包", { ...progress(), code: "MISSING_MATERIAL" });
  }
  const sources = knowledge.sources.filter((source) => source.kind === "block");
  const canHarvest = (source) => source.harvest.kind === "any" ||
    (source.harvest.kind === "tools" && initial.slots.some((slot) =>
      source.harvest.names.includes(slot.name) && (tool == null || matches(tool, slot))));
  const candidates = [];
  const seen = new Set();
  const canStore = (inventory) => inventory.freeSlots > 0 ||
    inventory.slots.some((slot) => slot.name === name && slot.count < knowledge.stackSize);
  const pickup = async (range) => {
    try {
      await mc.call("pickup@1", { item: name, radius: range, maxTimeMs: 5000 });
    } catch (error) {
      if (error.effects?.length || !["NOT_FOUND", "TIMEOUT", "INVENTORY_FULL"].includes(error.code)) throw error;
    }
    return update();
  };
  if (!canStore(initial)) mc.decide("背包没有空间", { ...progress(), code: "INVENTORY_FULL" });

  // 地上已有掉落时先捡，满足数量就可以不改变地形。
  const nearby = (await mc.read("entities@1", { radius: Math.min(radius, 8) })).value;
  if (nearby.entities.some((entity) => entity.item?.name === name)) await pickup(Math.min(radius, 8));
  if (acquired >= count) return progress();
  const harvestable = sources.filter(canHarvest);
  if (sources.length && !harvestable.length)
    mc.decide("需要可采掘工具或可用来源资料", { ...progress(), code: "MISSING_TOOL" });
  for (const source of harvestable) {
    const found = (await mc.read("blocks@1", { name: source.block, radius, limit: Math.min(256, count * 4) })).value;
    for (const { position } of found.blocks) {
      const key = [position.x, position.y, position.z].join(",");
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(position);
      }
    }
  }
  const start = (await mc.read("self@1")).value.place.position;
  const distance = (a, b) => Math.hypot(a.x + 0.5 - b.x, a.y + 0.5 - b.y, a.z + 0.5 - b.z);
  candidates.sort((a, b) => distance(a, start) - distance(b, start));
  for (const at of candidates) {
    if (acquired >= count) break;
    if (!canStore(await bag())) mc.decide("背包没有空间", { ...progress(), code: "INVENTORY_FULL" });
    const self = (await mc.read("self@1")).value.place.position;
    if (Math.floor(self.x) === at.x && Math.floor(self.z) === at.z && Math.floor(self.y) === at.y + 1) {
      skipped++;
      continue;
    }
    if (distance(at, { ...self, y: self.y + 1.62 }) > 4) {
      try {
        await mc.call("goto@1", { at: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, tolerance: 1, maxTimeMs: 10000 });
      } catch (error) {
        if (error.dispatch === "unknown" || !["UNREACHABLE", "TIMEOUT"].includes(error.code)) throw error;
        skipped++;
        continue;
      }
    }
    try {
      const result = await mc.call("mine@1", { at, collect: false, ...(tool == null ? {} : { tool }) });
      if (!result.broken) continue;
      mined++;
    } catch (error) {
      // 已派发而未确认时保留子调用错误和 Effect，不能改挖下一格。
      if (error.dispatch !== "not_sent" || !["NOT_FOUND", "UNREACHABLE"].includes(error.code)) throw error;
      skipped++;
      continue;
    }
    const before = acquired;
    await mc.waitUntil({ bag: { ref: "inventory@1" } },
      (values) => (values.bag?.counts[name] ?? 0) > baseline + before, { timeoutMs: 750 });
    await update();
    if (acquired === before) await pickup(4);
  }
  if (acquired < count) mc.decide("当前候选不足以完成采集，检查剩余数量和搜索范围", progress());
  return progress();
}
```
