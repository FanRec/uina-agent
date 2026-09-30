import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlaybackMode } from "./hud-protocol.js";

export interface JukeboxPreferences { schemaVersion: 1; playMode: PlaybackMode; volume: number; queueLimit: number; broadcastHudMode: "disabled" | "manual" | "auto"; }
const defaults: JukeboxPreferences = { schemaVersion: 1, playMode: "queue_order", volume: 80, queueLimit: 100, broadcastHudMode: "manual" };
export class PreferencesStore {
  constructor(private readonly directory: string) {}
  async load(): Promise<JukeboxPreferences> { try { const value = JSON.parse(await readFile(join(this.directory, "preferences.json"), "utf8")) as Partial<JukeboxPreferences>; return { ...defaults, ...value, schemaVersion: 1 }; } catch { return { ...defaults }; } }
  async save(value: Partial<JukeboxPreferences>): Promise<void> { await mkdir(this.directory, { recursive: true }); await writeFile(join(this.directory, "preferences.json"), JSON.stringify({ ...defaults, ...value, schemaVersion: 1 }, null, 2), "utf8"); }
}
