import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "../../../src/extensions/runner.js";

export interface VoicePreferences {
  muted: boolean;
  readAssistantText: boolean;
  textAccessibilityHint?: string;
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = { muted: false, readAssistantText: true };

function canPersist(pi?: ExtensionAPI): boolean {
  return Boolean(pi && typeof pi.path === "string");
}

export function voicePreferencesPath(pi?: ExtensionAPI): string {
  const root = pi?.subject?.stateRoot ?? join(process.env.UINA_HOME ?? homedir(), ".uina");
  return join(root, "voice-preferences.json");
}

export async function loadVoicePreferences(pi?: ExtensionAPI): Promise<VoicePreferences> {
  if (!canPersist(pi)) return { ...DEFAULT_VOICE_PREFERENCES };
  try {
    const parsed = JSON.parse(await readFile(voicePreferencesPath(pi), "utf8")) as Record<string, unknown>;
    return {
      muted: typeof parsed.muted === "boolean" ? parsed.muted : false,
      readAssistantText: typeof parsed.readAssistantText === "boolean" ? parsed.readAssistantText : true,
      ...(typeof parsed.textAccessibilityHint === "string" ? { textAccessibilityHint: parsed.textAccessibilityHint } : {}),
    };
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }
}

export async function saveVoicePreferences(pi: ExtensionAPI | undefined, preferences: VoicePreferences): Promise<void> {
  if (!canPersist(pi)) return;
  const path = voicePreferencesPath(pi);
  const temp = `${path}.tmp`;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(temp, `${JSON.stringify(preferences, null, "\t")}\n`, "utf8");
  await rename(temp, path);
}
