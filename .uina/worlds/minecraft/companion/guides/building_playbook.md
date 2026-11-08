# 建造实践 — 先验收目标，再选择施工

1. 明确结构形状、材料、占地、替换条件、朝向与期望完成判据。修一堵墙、建完整房子、清空地基是不同目标。
2. 复杂建筑先做蓝图 / 方块格规划，执行前读 `build.plan@1`：材料是否足够、占用冲突、哪些格已满足、哪些还需要施工。蓝图 `digest` 是计划与执行之间唯一的跨调用身份；设计变了必须重读计划。
3. 不要默认 `replace:true`。只有用户授权清空或明确施工范围才替换现有方块；普通移动也不应顺手改地形。
4. `build@1` 即使放好了一部分方块，也不代表整套结构完成。以 Plan 与世界实际格状态为准；`CONFLICT`（预检冲突）与 `TARGET_NOT_MET`（施工后仍有剩余格）是两件不同的事。
5. 中断后重新读 `build.plan@1`，只施工剩余格；已完成的不重做，蓝图 digest 变了不沿用旧图。
6. 长施工可用 Program 组织资源获取、合成、Plan、Build 与最终核验。用户对美术布局有不同要求时选对应策略，不强制统一风格。

`build.plan@1` 是查询，在 Program 里用 `mc.read`（动作才用 `mc.call`；用错会得到 `USE_MC_READ` / `USE_MC_CALL`）。

```js
async function main(mc, input) {
  const request = { from: input.blueprint, at: input.at, airPolicy: 'preserve' };
  const planned = await mc.read('build.plan@1', request);
  const plan = planned.value;
  if (!plan) mc.decide('计划不可读', { phase: 'plan_unknown', unknown: planned.unknown });
  if (plan.blocked && plan.blocked.length > 0)
    mc.decide('目标格被占用，需要授权替换或改设计', { phase: 'conflict', sample: plan.blocked.slice(0, 5) });
  if (Object.keys(plan.missing || {}).length > 0)
    mc.decide('材料不足，先备料', { phase: 'materials', missing: plan.missing });
  const built = await mc.call('build@1', { ...request, replace: false });
  const after = await mc.read('build.plan@1', request);
  if (after.value && Object.keys(after.value.need || {}).length > 0)
    mc.decide('施工后仍有目标格未满足', { phase: 'partial', stillNeeded: after.value.need, built });
  return built;
}
```

精确字段以 `describe {selector:'build.plan@1'}` / `describe {selector:'build@1'}` 为准；`need` 是仍需放置的方块数，`missing` 是缺口，`blocked` 是冲突格。

如要照明，可复用经过验证的照明 Program：在环境事实允许下选择墙面和间距，避免"四面连续插火把"的机械布局；但用户希望故意做火把墙也可以。基础 `place@1` 不负责美学，火把间距属于场景策略。
