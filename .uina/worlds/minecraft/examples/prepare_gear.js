/**
 * 参考 Program：用当前已具备材料备齐给定最低库存（如石镐与火把）。
 *
 * 官方只读示例，不会自动写入个人 Library；经真服验证后可自行 library.save 保存。
 * 合同（§8.2）：
 * - 多目标共享一份库存余额核算，不把同一木棍/木板/煤重复预支；
 * - recipe@1 的 plan 只是**单目标一层直接配方**；不把它当任意递归依赖闭包；
 * - 每次 craft@1 / smelt@1 之后重读库存、重算剩余，不凭动作预期先扣物资；
 * - 材料缺口、知识缺失或工作站不可用时给出具体缺口或交主脑，不自动远征采集；
 * - craft 的 station:'auto' 可能从背包放置工作台（真实世界写入，既有默认行为）；
 *   本示例不虚传"禁止放置"字段——需要该约束时由主脑另行决策；
 * - 子调用 EFFECT_UNCONFIRMED 时不盲重派：重读库存定去留，效果引用交给决策链；
 * - 最终只认 inventory@1 的实得数量；craft 返回值本身不算终验。
 */
async function main(mc, input) {
  const goals = input.goals; // [{item:'stone_pickaxe',count:1},{item:'torch',count:16}]
  if (!Array.isArray(goals) || goals.length === 0)
    throw new Error('goals is required, e.g. [{item:"stone_pickaxe",count:1},{item:"torch",count:16}]');

  async function counts() {
    const fact = await mc.read('inventory@1');
    if (!fact.value || !fact.value.counts)
      mc.decide('背包不可读，不能当 0，也不能备料', { phase: 'inventory_unknown' });
    return fact.value.counts;
  }

  // 多目标共享一份余额：后面的目标看到前面真实扣掉后的库存。
  const balance = await counts();
  const refresh = async () => {
    const fresh = await counts();
    for (const key of Object.keys(fresh)) balance[key] = fresh[key];
  };

  const produce = async (item, count, via) => {
    const short = Math.max(0, count - (balance[item] || 0));
    if (short <= 0) return;
    try {
      await mc.call(via === 'smelt' ? 'smelt@1' : 'craft@1', {
        item,
        count: short,
        ...(via === 'smelt' ? { wait: 'durable' } : {}),
      });
    } catch (error) {
      if (error.code === 'EFFECT_UNCONFIRMED') {
        // 未决写入不盲重派：以最新库存定去留；仍不足就把决定交回主脑。
        await refresh();
        if ((balance[item] || 0) < count)
          mc.decide(via + ' 结果未确认且库存不足：' + item, {
            phase: via + '_unconfirmed',
            item,
            need: count,
            have: balance[item] || 0,
            effects: error.effects || [],
          });
        return;
      }
      if (error.code === 'MISSING_MATERIAL' || error.code === 'MISSING_TOOL' || error.code === 'NOT_FOUND') {
        // 具体缺口如实交还：hint/progress 里带着缺什么、缺多少。
        mc.decide('无法备齐 ' + item + '：' + error.message, {
          phase: 'materials_short',
          item,
          need: count,
          have: balance[item] || 0,
          hint: error.hint,
          progress: error.progress,
        });
      }
      throw error;
    }
    await refresh();
  };

  for (const goal of goals) {
    const need = Math.max(1, goal.count);
    if ((balance[goal.item] || 0) >= need) continue;
    const knowledge = await mc.read('recipe@1', { item: goal.item, count: need - (balance[goal.item] || 0) });
    const value = knowledge.value;
    if (!value || !Array.isArray(value.recipes) || value.recipes.length === 0)
      mc.decide('没有已知的直接配方：' + goal.item, { phase: 'recipe_unknown', goal });
    const plan = value.plan;
    if (!plan || !Array.isArray(plan.steps))
      mc.decide('配方知识没有给出差额计划：' + goal.item, { phase: 'plan_missing', goal });
    // plan 只此一层：它的 steps 就是这条直接配方的材料单；再深的前置物按同样
    // 的"读配方→备材料"显式出现，不在这里写递归规划。
    for (const step of plan.steps) await produce(step.item, step.count, step.action);
    await produce(goal.item, need, 'craft');
  }

  // 终验：只认 inventory@1 的实得数量。
  const final = await counts();
  const unmet = goals
    .map((goal) => ({ item: goal.item, need: Math.max(1, goal.count), have: final[goal.item] || 0 }))
    .filter((entry) => entry.have < entry.need);
  if (unmet.length > 0)
    mc.decide('备料未完成：以最新库存为准仍有缺口，不假报成功', { phase: 'shortfall', unmet });
  return { prepared: goals.map((goal) => ({ item: goal.item, count: final[goal.item] || 0 })) };
}
