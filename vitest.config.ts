import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Real subprocess, localhost provider and file-watch cases need more than
		// the 5s default; a timeout should mean a hang, not a slow machine.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		restoreMocks: true,
	},
});
