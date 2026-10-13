import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVoicePreferences, saveVoicePreferences } from "../.uina/extensions/voice/preferences.js";
import { VoiceSession } from "../.uina/extensions/voice/session.js";

describe("Voice preferences", () => {
	it("saves mute even when the physical control call fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-voice-failed-stop-"));
		const pi = {
			path: join(root, "extension.ts"),
			subject: { stateRoot: root },
			hasService: () => true,
			callService: async () => {
				throw new Error("reply lost");
			},
		} as never;
		const session = new VoiceSession(pi);
		expect(await session.setMuted(true)).toMatchObject({ persisted: true, status: "unknown" });
		expect(await loadVoicePreferences(pi)).toMatchObject({ muted: true });
	});
	it("persists muted and text-reading preferences across reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-voice-preferences-"));
		const pi = { path: join(root, "extension.ts"), subject: { stateRoot: root } } as never;
		await saveVoicePreferences(pi, { muted: true, readAssistantText: false, textAccessibilityHint: "逐句" });
		expect(JSON.parse(await readFile(join(root, "voice-preferences.json"), "utf8"))).toMatchObject({
			muted: true,
			readAssistantText: false,
		});
		await expect(loadVoicePreferences(pi)).resolves.toEqual({
			muted: true,
			readAssistantText: false,
			textAccessibilityHint: "逐句",
		});
	});
});
