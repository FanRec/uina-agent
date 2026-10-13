import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../../src/extensions/world-framework/json-file.js";
import { isPlaybackMode, type PlaybackMode } from "./hud-protocol.js";

export interface JukeboxPreferences { schemaVersion: 1; playMode: PlaybackMode; volume: number; }
const defaults: JukeboxPreferences = { schemaVersion: 1, playMode: "queue_order", volume: 80 };

function clampVolume(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : defaults.volume;
}

export class PreferencesStore {
  constructor(private readonly directory: string) {}
  async load(): Promise<JukeboxPreferences> {
    try {
      const value = JSON.parse(await readFile(join(this.directory, "preferences.json"), "utf8")) as Record<string, unknown>;
      return {
        schemaVersion: 1,
        playMode: isPlaybackMode(value.playMode) ? value.playMode : defaults.playMode,
        volume: clampVolume(value.volume),
      };
    } catch {
      return { ...defaults };
    }
  }
  async save(value: Partial<JukeboxPreferences>): Promise<void> { await writeJsonAtomic(join(this.directory, "preferences.json"), { ...defaults, ...value, schemaVersion: 1 }); }
}
