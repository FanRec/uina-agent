import { spawn, type ChildProcess } from "node:child_process";
import { trackChildProcess, untrackChildProcess } from "../../../src/extensions/world-framework/child-process-registry.js";

export { resolveMpvPath } from "../../../src/extensions/world-framework/mpv-path.js";

export interface SoundPlayer {
  readonly isSimulated: boolean;
  readonly activeCount: number;
  play(filepath: string, volume: number): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export class MpvSoundPlayer implements SoundPlayer {
  readonly isSimulated = false;
  private readonly activeProcesses = new Set<ChildProcess>();

  constructor(private readonly mpvPath: string) {}

  get activeCount(): number {
    return this.activeProcesses.size;
  }

  async play(filepath: string, volume: number): Promise<void> {
    const clampedVolume = Math.max(0, Math.min(100, Math.round(volume)));
    const proc = spawn(
      this.mpvPath,
      ["--no-video", "--no-terminal", `--volume=${clampedVolume}`, filepath],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );

    this.activeProcesses.add(proc);
    trackChildProcess(proc.pid);
    const cleanup = () => {
      this.activeProcesses.delete(proc);
      untrackChildProcess(proc.pid);
    };

    proc.once("exit", cleanup);
    proc.once("error", cleanup);
  }

  async stop(): Promise<void> {
    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch {
        // ignore kill errors
      }
    }
    this.activeProcesses.clear();
  }

  async close(): Promise<void> {
    await this.stop();
  }
}

export class SimulatedSoundPlayer implements SoundPlayer {
  readonly isSimulated = true;
  private _activeCount = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  get activeCount(): number {
    return this._activeCount;
  }

  async play(_filepath: string, _volume: number): Promise<void> {
    this._activeCount++;
    const timer = setTimeout(() => {
      this._activeCount = Math.max(0, this._activeCount - 1);
      this.timers.delete(timer);
    }, 100);
    this.timers.add(timer);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this._activeCount = 0;
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
