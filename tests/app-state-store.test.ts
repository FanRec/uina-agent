import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileAppStateStore } from "../src/extensions/app-framework/app-state-store.js";

describe("AppStateStore", () => {
	it("loads missing state as an empty preference set", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-app-state-"));
		try {
			const store = createFileAppStateStore(join(dir, "nested", "apps.json"));
			expect(await store.load()).toEqual({});
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	it("filters invalid values and reports malformed documents", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-app-state-"));
		try {
			const path = join(dir, "apps.json");
			await writeFile(path, JSON.stringify({ good: true, invalid: "yes" }), "utf8");
			const reportError = vi.fn();
			expect(await createFileAppStateStore(path, reportError).load()).toEqual({ good: true });
			await writeFile(path, "[]", "utf8");
			expect(await createFileAppStateStore(path, reportError).load()).toEqual({});
			expect(reportError).toHaveBeenCalledTimes(1);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	it("saves atomically through the configured path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-app-state-"));
		try {
			const path = join(dir, "nested", "apps.json");
			await createFileAppStateStore(path).save({ ticker: false });
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ticker: false });
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});
