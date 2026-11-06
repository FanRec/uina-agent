# QuickJS 0.32.0 host patch
`quickjs-emscripten-core@0.32.0.patch` changes one ESM host expression in `executePendingJobs`.
Read the returned context pointer through a fresh view of `module.HEAPU8.buffer` after the FFI call,
because executing a job can grow WASM memory and detach the view allocated before the call.

Without the fix, the host creates an unmanaged context and `JS_FreeRuntime` can assert during disposal.
Upstream report: https://github.com/justjake/quickjs-emscripten/issues/240 (also diagnosed in issue 269).
The real Worker regression in `tests/mc/mc-program.test.ts` grows arrays across pending jobs and verifies
local memory failure, disposal and another invocation on the same Worker. This patch does not repair
Emscripten's undercounted realloc memory accounting; Program also checks actual managed heap at yields.

Program imports the ESM build. Reevaluate/remove this patch when upgrading the pinned dependency,
using that regression rather than a version-number assumption.

# mineflayer-pathfinder 2.4.5 patch

`mineflayer-pathfinder@2.4.5.patch` carries three layers of work over upstream 2.4.5. All hunks are
validated together on Paper 1.21.11 via `pnpm dev:mc:climb` (one-block step, 3-level 1:1 staircase,
ascending corridor, sealed-shaft fast-fail, flat 30-block walk) and `pnpm dev:mc:terrain-nav`
(mountain lane pillar bypass, tree bypass, digThrough, honest fast-fail boundaries); `tests/mc` path
and goto suites cover the planner side. Reevaluate the whole file when upgrading the pinned
dependency.

**Executor correctness (G21, batch 19).** `lib/physics.js` adds `stepAt(bot, nextPoint, d)` — probe
for "solid at feet level, air above" `d` blocks along the travel direction — and rewrites `shouldJump`
to jump only when a step exists at 1.2/1.8 blocks with the 0.6 probe still clear. Upstream
`canStraightLine` treated "only clears if you jump early enough" as "walkable", so the executor never
pressed jump and every one-block step ended in `resetPath('stuck')` (which does not emit `path_stop`,
so the goto promise never settled and burned the 40s wall clock). `lib/index.js` routes every
movement branch through that single `jumpNow` decision and adds a run-up retry: touching the step
face with ~zero speed backs off 200–900ms first. Real-server measurement: takeoff must start ≥0.89
blocks from the face; jumping while touching it zeroes horizontal speed and the 0.02/tick air control
cannot recover it.

**Search legality (G25, batch 26).** `lib/movements.js` `getMoveDiagonal` used to validate only the
cheaper of the two orthogonal corner lines (`min(cost1, cost2)`), so a diagonal whose *other* corner
line held a solid cell was accepted. A 0.6-wide hitbox walking that diagonal wedges into the corner
(with the prismarine-physics patch below this is a server-bounce pin, without it an exact-touch pin),
and the executor stayed there while every 3.5s re-plan reproduced the same impossible move —
`route.plan` showed the identical path, hence "plan ok steps=5 but goto zero displacement". The hunk
rejects diagonals unless both corner lines' feet/head cells are safe; the A* then reroutes via
straight moves, which the executor walks cleanly.

**Planner hardening and search cost (batch 26, absorbed from the installed dependency state).** These
were live in the installed package before the patch file captured them; a clean reinstall would have
silently dropped everything below.

- `lib/astar.js` + `lib/movements.js`: search-scoped block cache. `AStar.compute()` attaches a fresh
  `__sliceCache` and detaches it in `finally` — block reads, `safeToBreak` verdicts and the
  (tool+digTime → labor cost) computation are memoized within one compute chunk and never leak
  across chunks. Unloaded columns (stubs without a type) are never cached. `blockC.height` mutation
  in the jump-up path became a local `landHeight` because cached blocks are shared.
- `lib/movements.js` door semantics: the openable set covers `*_door` (not just `*gate*`); an open
  door/gate is passable (`safe`, non-physical); only closed ones are "used" open; the upper half of a
  door is head clearance, never a landing node; diagonal candidates into door cells are dropped —
  doors are entered head-on.
- `lib/movements.js` water semantics: tower/bridge placements need a real floor in deep water; the
  jump-up take-off height from a swimming node is the node itself, not the liquid block below.
- Placement blacklist: `lib/index.js` records `bot.placeMisses` (target cell, current block name,
  timestamp; cap 64) **only** on explicit server refusals (`err.refused` from the prismarine-item
  family of fixes — timeouts prove nothing and are not recorded); `filterRefusedPlacements` drops
  candidate moves onto a still-identical refused cell (TTL 180s, released by any world change).
  This breaks the refuse→re-plan→refuse loop that previously only ended at the caller's wall clock.
- `lib/goto.js`: a finished `noPath` search now rejects with NoPath. Upstream checked
  `path.length === 0` first and resolved ANY empty-path update as success — including a genuine
  noPath whose best node was still the start. An empty best path on a partial is "not found yet":
  keep waiting for the next chunk.
- `lib/index.js` `bestHarvestTool` + `lib/movements.js` labor cost read enchantments via
  `tool?.enchants` (prismarine-item patch) — 1.20.5+ components carry no nbt, so Efficiency and
  friends were silently lost to tool selection and dig-time costs.
- `lib/index.js` protocol repairs: the gate-opening branch guards `toPlace` exhaustion
  (`placingBlock` undefined fell through to scaffolding placement), verifies the door actually opened
  after activation (`door_error` re-plan instead of looping re-activation), and releases
  `lockEquipItem` when the pre-placement equip rejects.

`allowParkour` is disabled in our adapter (`driver/mineflayer/pathfinder.ts`) — the executor cannot
hold parkour nodes reliably.

# prismarine-physics 1.11.1 patch

`prismarine-physics@1.11.1.patch` adds `WALL_GAP = 1e-5` horizontal clearance in `AABB.computeOffsetX/Z`.

Paper 1.21.11 rejects player positions whose bounding box touches a block's side face exactly
(gap 0 or negative): it teleports the player back **silently** — no "moved wrongly" in the server log
(1.21.10 and earlier accept them; measured on Paper 1.21.11 build 132 down to 1e-7). The unpatched
collision solver clamps movement to exactly touching, so wall sliding, step faces and 1-wide squeezes
got pinned every tick: the client clamped to the face, the server bounced it back, and the bot
oscillated ~0.02 blocks with zero net motion — observed with a pathfinder-free probe pressing into a
pillar corner (G25 wedge mechanism). Vertical faces are the only criterion that changed; resting on
top faces or under ceilings is still accepted, so `computeOffsetY` stays untouched.

Regression: `pnpm dev:mc:terrain-nav` (mountain lane bypass now slides around corners) and
`pnpm dev:mc:climb` (step faces no longer pin the run-up). Reevaluate when upgrading the pinned
dependency or when the server version stops rejecting exact-touch positions.

# prismarine-item 1.18.0 patch

`prismarine-item@1.18.0.patch` normalizes the 1.20.5+ `enchantments` component shape in
`Item.enchantments`.

The component map carries the raw wire shape (a container with numeric `{id, level}` entries), while
the nbt branches of the same getter produce normalized `[{name, lvl}]` — consumers (`mineflayer`
`digTime`, `prismarine-block` `getEnchantmentLevel`, the pathfinder's `bestHarvestTool`) expect the
normalized list and break on the raw object (a non-array that cannot be iterated/concat'd). The patch
maps `{id, level}` to `{name, lvl}` (namespaced ids stripped via `minecraft:`) and returns `[]` when
the shape is neither array nor container.

Regression: tool-dependent dig time (`tests/mc` pathfinder/goto suites) and real-server mining
(`dev:mc:repair`). Reevaluate when upgrading the pinned dependency.

# mineflayer 4.39.0 patch

`mineflayer@4.39.0.patch` (wired in `pnpm-workspace.yaml`, batch 26) repairs the two protocol truths
the executor's dig/place paths still consume through `bot.dig`/`bot.placeBlock` (Uina's own capability
layer bypasses these; only the pathfinder executor routes through them):

- `lib/plugins/digging.js`: completion is the server changing that cell to a **different type** —
  the old `finishDigging` wrote the block as air locally and resolved on the client-estimated
  timer, so a refused/slow dig "succeeded" and the executor walked into the solid block. Terminal
  states are now exclusive (confirmed / cancelled / budget `max(8s, digTime×3)`) with one cleanup;
  `bot.targetDigBlock` stays set until a terminal state so `stopDigging` still cancels during the
  confirmation window and stall watchdogs are not fooled. Late updates after a terminal state are
  ignored (terminated guard).
- `lib/plugins/place_block.js`: explicit server refusals throw with `err.refused = true` — the
  executor records those into `bot.placeMisses` (the planner blacklist); timeouts prove nothing and
  are not recorded.

Regressions: `tests/mc/mc-upstream-dig.test.ts` (lifecycle), `dev:mc:upstream-nav` step 4 (real-server
digThrough with water behind). Reevaluate when upgrading the pinned dependency.
