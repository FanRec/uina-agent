import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
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
