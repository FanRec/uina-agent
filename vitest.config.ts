import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// 终端能力固定为有颜色：TERM=dumb 的 shell 会让 C.* 全退化成空串，
		// 把"断言带样式渲染"的 UI 用例变成环境假红。降级路径由 ui-no-color 显式覆盖。
		setupFiles: ["tests/setup/ui-env.ts"],
		// Real subprocess, localhost provider and file-watch cases need more than
		// the 5s default; a timeout should mean a hang, not a slow machine.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		restoreMocks: true,
		coverage: {
			// Native binaries under src/ cannot be AST-parsed by the v8 provider's
			// uncovered-files pass; without this the whole coverage run dies.
			exclude: ["src/ui/core/native/**"],
			// Single canonical output consumed by scripts/crap.mjs --gate. Writing
			// anywhere else lets the gate silently pair current AST line ranges with
			// stale coverage (it fails closed, but with misleading "0% 函数" reports).
			reportsDirectory: "coverage-raw",
			reporter: ["json", "text"],
		},
	},
});
