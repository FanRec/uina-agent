/**
 * 任务级基线的三段被测程序（Program 入口，宿主提交，不是脚本步骤表）。
 *
 * 为什么内联成常量而不是 .js 文件：`tsconfig.json` 未开 allowJs，`.js` 不会进 dist；
 * 仓内既有先例（dev/spatial.ts、program/shim.ts）也是内联源码。
 *
 * 约定：
 * - 程序只做玩法动作，不发 op 指令（准备与断言归宿主，见 dev/task.ts）。
 * - 每步先写 `STEP <name>` 到 console，失败时靠 consoleTail 定位到具体步。
 * - 程序返回的 ms 只作参考，判决用宿主墙钟（task.ts 会校验两者是否自洽）。
 */

/** 采木 → 合成 → 建 3×3 木屋。 */
export const SHELTER_PROGRAM = String.raw`
async function main(mc, input) {
  const t0 = Date.now();
  const step = (name, detail) => {
    console.log('STEP ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
    mc.progress({ step: name });
  };

  step('goto_grove', input.trees[0]);
  await mc.call('goto@1', { at: input.trees[0], tolerance: 3, maxTimeMs: 90000 });

  step('collect_logs');
  const logs = await mc.call('collect@1', { item: 'oak_log', count: input.logs, radius: 24 });
  step('collected', logs);

  step('goto_site', input.stand);
  await mc.call('goto@1', { at: input.stand, tolerance: 2, maxTimeMs: 90000 });

  step('craft_planks');
  await mc.call('craft@1', { item: 'oak_planks', count: input.planks });
  step('craft_table');
  await mc.call('craft@1', { item: 'crafting_table', count: 1 });
  step('craft_door');
  await mc.call('craft@1', { item: 'oak_door', count: input.doors });

  step('build');
  const built = await mc.call('build@1', { cells: input.cells, maxTimeMs: input.buildMs });
  step('built', built);
  return { ms: Date.now() - t0, logs: logs, built: built };
}
`;

/** 1:1 下坡走廊到矿石囊，采铁，自己走回地面。 */
export const MINE_PROGRAM = String.raw`
async function main(mc, input) {
  const t0 = Date.now();
  const step = (name, detail) => {
    console.log('STEP ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
    mc.progress({ step: name });
  };

  step('tunnel_down', input.vein);
  const dug = await mc.call('tunnel@1', { to: input.vein, maxTimeMs: input.digMs });
  step('tunnel_done', dug);

  step('collect_ore');
  const ore = await mc.call('collect@1', { item: 'raw_iron', count: input.ore, radius: 10, tool: 'stone_pickaxe' });
  step('ore_done', ore);

  let returnMode = 'goto';
  let gotoError = null;
  let surfaceError = null;
  let walkError = null;
  try {
    step('return_goto', input.start);
    // tolerance 1：GoalNear 半径 2 会把"井口内一格、低一格"判为到达（G30 缺陷 c 的
    // 早停形态）——回起点必须站上出发平台，tolerance 1 + goto 的 nodeGap 复核兜底。
    await mc.call('goto@1', { at: input.start, tolerance: 1, digThrough: true, maxTimeMs: input.returnMs });
  } catch (error) {
    gotoError = String((error && error.code) || '') + ' ' + String((error && error.message) || error);
    step('goto_failed', gotoError);
    // 井道爬不上去时先出到地面，再走回起点：surface 只保证头顶见天，
    // 不保证站在起点（批34 第一次跑就停在井口偏东 9 格、低 1 格）。
    returnMode = 'surface';
    try {
      await mc.call('surface@1', { maxTimeMs: input.surfaceMs });
      step('surface_done');
    } catch (fallback) {
      surfaceError = String((fallback && fallback.code) || '') + ' ' + String((fallback && fallback.message) || fallback);
      step('surface_failed', surfaceError);
    }
    try {
      await mc.call('goto@1', { at: input.start, tolerance: 2, maxTimeMs: input.walkMs });
      step('walk_done');
    } catch (walk) {
      walkError = String((walk && walk.code) || '') + ' ' + String((walk && walk.message) || walk);
      step('walk_failed', walkError);
    }
  }
  step('returned', returnMode);
  return {
    ms: Date.now() - t0,
    dug: dug,
    ore: ore,
    returnMode: returnMode,
    gotoError: gotoError,
    surfaceError: surfaceError,
    walkError: walkError,
  };
}
`;

/** 午夜固定窗口：有威胁就交战，血低就撤。 */
export const NIGHT_PROGRAM = String.raw`
async function main(mc, input) {
  const deadline = Date.now() + input.windowMs;
  let rounds = 0, fights = 0, flees = 0;
  while (Date.now() < deadline) {
    rounds++;
    const self = (await mc.read('self@1')).value;
    if (self && self.health !== null && self.health <= input.lowHealth) {
      flees++;
      try {
        await mc.call('flee@1', { distance: input.fleeDistance, maxTimeMs: 15000 });
      } catch (error) {
        console.log('STEP flee_failed ' + String((error && error.message) || error));
      }
      continue;
    }
    const view = (await mc.read('entities@1', { radius: input.radius, kind: 'hostile', limit: 64 })).value;
    const list = (view && view.entities) || [];
    if (list.length === 0) {
      await mc.sleep(1000);
      continue;
    }
    fights++;
    mc.progress({ step: 'fight', fights: fights });
    try {
      await mc.call('fight@1', { stance: 'balanced', radius: input.radius, maxTimeMs: 15000 });
    } catch (error) {
      console.log('STEP fight_failed ' + String((error && error.message) || error));
    }
  }
  return { ms: input.windowMs, rounds: rounds, fights: fights, flees: flees };
}
`;
