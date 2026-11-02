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

`mineflayer-pathfinder@2.4.5.patch` fixes uphill step climbing (G21, batch 19).

- `lib/physics.js`: adds `stepAt(bot, nextPoint, d)` — probe for "solid at feet level, air above" `d`
  blocks along the travel direction — and rewrites `shouldJump` to jump only when a step exists at
  1.2/1.8 blocks and the 0.6 block probe is still clear. Upstream `canStraightLine` treated
  "only clears if you jump early enough" as "walkable", so the executor never pressed jump and every
  one-block step ended in `resetPath('stuck')` (which does not emit `path_stop`, so the goto promise
  never settled and burned the full 40s wall clock).
- `lib/index.js`: routes every movement branch through that single `jumpNow` decision (the
  `canSprintJump` branch used to hold jump unconditionally), and adds a run-up retry: when the bot is
  already touching the step face and horizontal speed is ~0, back off for 200–900ms and try again.
  Real-server measurement: takeoff must start ≥0.89 blocks from the face; jumping while touching it
  zeroes horizontal speed and the 0.02/tick air control cannot recover it.

`allowParkour` is disabled in our adapter (`driver/mineflayer/pathfinder.ts`) — the executor cannot
hold parkour nodes reliably. Regression: `pnpm dev:mc:climb` (one-block step, 3-level 1:1 staircase,
sealed shaft fast-fail, flat 30-block walk). Reevaluate when upgrading the pinned dependency.
