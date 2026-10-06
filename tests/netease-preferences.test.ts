import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreferencesStore } from "../.uina/worlds/netease-jukebox/preferences.js";

describe("PreferencesStore", () => {
	it("maps the removed list_order mode to queue_order", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-preferences-"));
		try {
			await writeFile(
				join(directory, "preferences.json"),
				JSON.stringify({ schemaVersion: 1, playMode: "list_order", volume: 80, queueLimit: 100 }),
			);
			const loaded = await new PreferencesStore(directory).load();
			expect(loaded.playMode).toBe("queue_order");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("sanitizes corrupt persisted values instead of passing them through", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-preferences-"));
		try {
			await writeFile(
				join(directory, "preferences.json"),
				JSON.stringify({ schemaVersion: 1, playMode: "party_mix", volume: NaN, queueLimit: -3 }),
			);
			const loaded = await new PreferencesStore(directory).load();
			expect(loaded).toEqual({ schemaVersion: 1, playMode: "queue_order", volume: 80 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("ignores removed fields from legacy files instead of echoing them back", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-preferences-"));
		try {
			await writeFile(
				join(directory, "preferences.json"),
				JSON.stringify({ schemaVersion: 1, playMode: "shuffle", volume: 42, queueLimit: 7 }),
			);
			const loaded = await new PreferencesStore(directory).load();
			expect(loaded).toEqual({ schemaVersion: 1, playMode: "shuffle", volume: 42 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
