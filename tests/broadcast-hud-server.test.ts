import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const directory = "E:\\Uina\\ThirdParty\\broadcast-hud";
const entry = `${directory}\\server.mjs`;
const port = 18200 + Math.floor(Math.random() * 200);
let child: ChildProcess;

function snapshot(revision: number) {
  return {
    version: 1,
    sourceInstance: "test-instance",
    revision,
    updatedAt: new Date().toISOString(),
    source: { id: "jukebox", kind: "music", label: "test" },
    connection: { status: "connected", lastError: null },
    playback: { status: "idle", playMode: "queue_order", volumePercent: 80, currentTrack: null, positionMs: 0, durationMs: null },
    lyrics: { previous: null, current: null, next: null },
    queue: { items: [], total: 0 },
    spectrum: { source: "silent", bands: Array(32).fill(0), energy: 0, beat: 0 },
  };
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("HUD server did not start");
}

describe("broadcast HUD server protocol", () => {
  beforeAll(async () => {
    child = spawn(process.execPath, [entry], { cwd: directory, env: { ...process.env, PORT: String(port) }, stdio: "ignore", windowsHide: true });
    await waitForHealth();
  });

  afterAll(() => { if (child && !child.killed) child.kill(); });

  it("rejects a snapshot with invalid nested playback fields", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, sourceInstance: "bad", revision: 0, source: { id: "jukebox" }, playback: {}, lyrics: {}, queue: {}, spectrum: {} }) });
    expect(response.status).toBe(400);
  });

  it("includes source identity and revision in overlay state", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot(7)) });
    expect(response.status).toBe(200);
    const state = await (await fetch(`http://127.0.0.1:${port}/overlay/state`)).json() as { state: { sourceInstance?: string; revision?: number } };
    expect(state.state).toMatchObject({ sourceInstance: "test-instance", revision: 7 });
  });

  it("rejects an older revision from the same producer", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot(6)) });
    expect(response.status).toBe(409);
  });
});
