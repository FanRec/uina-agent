import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
});
