import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { HudCompanionManager } from "../.uina/worlds/netease-jukebox/hud-companion-manager.js";

describe("HudCompanionManager", () => {
  it("starts at most one companion for concurrent ensure calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uina-hud-companion-"));
    try {
      await writeFile(join(directory, "server.mjs"), "");
      let started = false;
      const spawn = vi.fn(() => { started = true; return { killed: false, kill: vi.fn(), once: vi.fn() }; });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: started ? 200 : 503 }));
      const manager = new HudCompanionManager(directory, 19130, { spawn: spawn as never });
      const first = manager.ensureRunning();
      const second = manager.ensureRunning();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalled();
      await manager.stop();
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns false instead of throwing when the companion cannot spawn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uina-hud-companion-"));
    try {
      await writeFile(join(directory, "server.mjs"), "");
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
      const manager = new HudCompanionManager(directory, 19131, { spawn: (() => { throw new Error("spawn denied"); }) as never });

      await expect(manager.ensureRunning()).resolves.toBe(false);
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
