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
