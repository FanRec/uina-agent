/**
 * 参考 Program：给定可达矿点区域、最终背包目标与返家坐标时的最小任务闭环。
 *
 * 不是万能自动找矿脚本：未知矿脉探索、复杂安全风险与持久化由 Playbook / 主脑负责。
 * 官方只读示例，不会自动写入个人 Library；经真服验证后可自行 library.save 保存。
 * 每个终态都以最新 self@1 / inventory@1 事实核验，失败一律交还主脑，不假报成功。
 */
async function main(mc, input) {
  const item = input.item || 'raw_iron';
  const targetCount = input.finalCount;
  const home = input.home; // { world?, dimension, position:{x,y,z}, tolerance? }
  if (!home || !home.position || !Number.isInteger(targetCount) || targetCount < 1)
    throw new Error('finalCount and home are required');
  const tolerance = home.tolerance || 1.5;

  async function currentInventory() {
    const fact = await mc.read('inventory@1');
    if (!fact.value || !fact.value.counts)
      mc.decide('无法确认背包内容，不能继续采矿或宣称完成', { item, targetCount, home, phase: 'inventory_unknown' });
    return fact.value.counts;
  }

  const beforeCounts = await currentInventory();
  const missing = Math.max(0, targetCount - (beforeCounts[item] || 0));
  mc.progress({ phase: 'gather', required: targetCount, current: beforeCounts[item] || 0, item });

  if (missing > 0) {
    try {
      // 能力内部已有候选搜索、挖掘、拾取与实际入包确认。
      await mc.call('collect@1', { item, count: missing, radius: input.radius || 12 });
    } catch (error) {
      const counts = await currentInventory();
      // 先重新观察事实；对可能已派发的动作绝不自动再调一次。
      mc.decide('采集未完整结束，需要根据现场决定新的资源路径', {
        item, targetCount, home, phase: 'gather_blocked',
        observedCount: counts[item] || 0,
        failure: { code: error.code || 'UNKNOWN', dispatch: error.dispatch || 'unknown', effects: error.effects || [] }
      });
    }
  }

  const gatheredCounts = await currentInventory();
  if ((gatheredCounts[item] || 0) < targetCount) {
    mc.decide('真实库存没有达到原始目标', {
      item, targetCount, home, phase: 'gather_incomplete',
      observedCount: gatheredCounts[item] || 0
    });
  }

  mc.progress({ phase: 'return', item, observedCount: gatheredCounts[item] || 0 });
  try {
    await mc.call('goto@1', {
      at: home.position, tolerance: 1,
      digThrough: false, placeToReach: false,
      maxTimeMs: input.returnMs || 90000
    });
  } catch (error) {
    mc.decide('采集已完成，但返程失败，需要根据最新路径与危险决定下一步', {
      item, targetCount, home, phase: 'return_blocked',
      failure: { code: error.code || 'UNKNOWN', dispatch: error.dispatch || 'unknown', effects: error.effects || [] }
    });
  }

  // 领域终验：goto 成功不等于到家，必须重读最新位置、维度与背包。
  const self = await mc.read('self@1');
  const counts = await currentInventory();
  const s = self.value;
  if (!s) mc.decide('无法确认当前站位，不能宣布返家成功', { item, targetCount, home, phase: 'verify_unknown' });
  const here = s.place.position;
  const sameDimension = s.place.dimension === home.dimension;
  const sameWorld = home.world == null || s.place.world === home.world;
  const atHome = Boolean(
    sameDimension && sameWorld && s.onGround === true && here &&
    Math.hypot(here.x - home.position.x, here.z - home.position.z) <= tolerance &&
    Math.floor(here.y) === Math.floor(home.position.y)
  );
  if (!atHome || (counts[item] || 0) < targetCount) {
    mc.decide('返程后真实目标核验未通过', {
      item, targetCount, home, phase: 'verify_failed',
      observedCount: counts[item] || 0,
      observedPosition: here || null,
      observedDimension: s.place.dimension || null
    });
  }

  mc.progress({ phase: 'done', item, observedCount: counts[item] || 0 });
  return { goalMet: true, item, observedCount: counts[item] || 0, atHome: true };
}
