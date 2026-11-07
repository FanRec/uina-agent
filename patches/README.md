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

**Executor correctness (G21, batch 19; jump decision rewritten for G30, batch 35).** `lib/physics.js`
adds `stepAt(bot, nextPoint, d)` — probe for "solid at feet level, air above" `d` blocks along the
travel direction, kept for the run-up back-off in `lib/index.js` — and `stepBlockOf(bot, nextPoint)`,
the floor block of a single-block step-up node (null for flat/drop nodes, tower moves, and nodes
whose support is missing). Upstream `canStraightLine` treated "only clears if you jump early enough"
as "walkable", so the executor never pressed jump and every one-block step ended in
`resetPath('stuck')` (which does not emit `path_stop`, so the goto promise never settled and burned
the 40s wall clock). `lib/index.js` routes every movement branch through a single `jumpNow` decision
and adds a run-up retry: touching the step face with ~zero speed backs off 200–900ms first.

Batch 19 decided `shouldJump` by probing 1.2/1.8 blocks along the bot→node direction with the 0.6
probe still clear (takeoff must start ≥0.89 blocks from the face — jumping while touching it zeroes
horizontal speed and the 0.02/tick air control cannot recover it). Batch 35 (G30, the mine-task
return leg) went through two rejected intermediate designs, each driven by 200ms-resolution
real-server probes (`dev:mc:tower-probe`): the direction probe is blind to sub-grid drift (a ±0.5
block offset tilted the probe vector into a neighbouring column, the jump key never fired), and both
successors — geometric face distance with a landing-simulation arbiter, with and without a
momentum-gated <0.6 dead band — pinned the climb one level up. On a 1-wide 1:1 staircase every jump
LANDS at the far
within a tick or two, so any touching-state refusal turns the step assist into a ledge-dropper
(backing off a one-block-deep step falls to the level below) and the climb shuttles until the
NoCloser watchdog kills it. The simulation itself is structurally optimistic about the touching
state: its reached-check is satisfied by the jump start, while Paper 1.21.11 silently bounces
exact-touch positions (the prismarine-physics WALL_GAP patch), so a sim-approved touching jump still
fails on the wire. The shipped decision is a pure node rule — press jump exactly when the next path
node is a single-block step up with support — with the two states it gets wrong owned by mechanisms
that already exist: a hop that bounces off the face ends in the step assist's run-up back-off, and a
step that genuinely cannot be cleared ends in the stall/NoCloser watchdogs with attribution. Real
server: the no-gap 1:1 corridor climb went from never-finishing to 13.7s end-to-end, and the mine
task returned 4/4 consecutive greens (`returned`+`haul`+`ore_gone` on server verdicts). T0:
`mc-pathfinder-jump-decision` (includes the legacy probe as a fixture contrast for the drift shape
and the touching states). Residual (G30 (b), probe-refined): the tower-placement chain over a
damaged step works end to end — what remained unreliable was the per-step climb after the gap
crossing (bounce lottery, ~20% red rounds). Batch 36 fixed it in `lib/index.js`: the step assist
now owns the GROUND only — on takeoff it releases its stale back key immediately (frames showed
forward+back pressed together, cancelling the arc into a vertical stall that re-landed 0.1 short
of the arrival window), while the backOff/backUntil timers persist so the assist still resumes on
the next grounded tick inside its window. The batch-19 flat-ground run-up never leaves the ground
while backing and is unaffected. Probe 10/10 consecutive greens (baseline 8/10), mine task 4/4.

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

**Dig confirmation is not a world change (G27, batch 27).** `lib/index.js`'s global `blockUpdate`
listener resets the path on any type change near the path (`block_updated`). While the executor's
own dig is in flight (`digging === true`), the confirmation update of that very dig arrives through
the same listener first (plugin listeners register before digging.js's per-dig one), so the reset
aborted the in-flight dig: `diggingAborted` won the race against digging.js's confirmation callback,
the terminated guard swallowed `diggingCompleted` (dug stayed 0), and the reset re-planned from a
half-dug state — the capped-wall digThrough arrived without ever opening the foot layer. The hunk
skips `block_updated` while `digging`; the dig's own completion keeps its normal settlement, and
world changes during the (short) dig are picked up by the next re-plan. Regression:
`pnpm dev:mc:upstream-nav` step 4 (`dug=2` on the capped wall, foot cell verified open).

**Weighted A* expansion bias (M2 search budget, batch 28).** `lib/astar.js` reads
`movements.heuristicWeight` (default 1 = upstream ordering) and scales the heuristic for expansion
ordering only: g costs, move legality, `isEnd` and `bestNode` selection (monotonic in h) are
untouched, and the `searchRadius`/`maxCost` futility bound keeps the **raw** heuristic scale so
radius semantics stay upstream-compatible regardless of the weight. Rationale: the euclidean
heuristic grossly underestimates climbing cost, so the unweighted search floods the terrain contour
around hills — measured on the real server, a 24-block natural hilltop crossing explored 58k nodes
and died at the 5s think budget (registered residual of the G25 closure), and a gain-16 hill probe
explored 10,974 nodes in 428ms. Weight 3 (set by `applyMovementsConfig`, the single Movements
config source) probes at 556 nodes / 11ms (÷20) for +6.7% path cost, deterministically across
repeats; a T0 fixture (Manhattan cone hill, goal beyond it) pins default-parity, the ÷3 node
reduction and bounded cost. Regressions watched on the real gates: `dev:mc:upstream-nav` three
consecutive 7/7 runs at weight 3 (gate/dig steps run slightly longer — the costlier-but-faster-found
paths are a few percent longer), `dev:mc:climb` 6/6, `dev:mc:terrain-nav` 6/6.

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
