import { defineConfig } from "vitest/config";

// Independent audit suite: assertions describe the required behavior.
// Existing defects intentionally fail without changing the normal test gate.
export default defineConfig({
	test: {
		include: ["docs/history/qq-reader-notification-review-2026-10-11.probes.test.ts"],
		testTimeout: 30000,
		restoreMocks: true,
	},
});
