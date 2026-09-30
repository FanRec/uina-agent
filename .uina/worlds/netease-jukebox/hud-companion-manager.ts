import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface HudCompanionManagerOptions {
  spawn?: typeof spawn;
}

export class HudCompanionManager {
  private child: ChildProcess | null = null;
  private owned = false;
  private starting: Promise<boolean> | null = null;
  private readonly spawnProcess: typeof spawn;
  constructor(private readonly directory: string, private readonly port: number, options: HudCompanionManagerOptions = {}) {
    this.spawnProcess = options.spawn ?? spawn;
  }

  async ensureRunning(signal?: AbortSignal): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = this.startInternal(signal);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(signal?: AbortSignal): Promise<boolean> {
    if (await this.healthy(signal)) return true;
    const entry = join(this.directory, "server.mjs");
    if (!existsSync(entry)) return false;
    if (signal?.aborted) return false;
    try {
      const child = this.spawnProcess(process.execPath, [entry], { cwd: this.directory, windowsHide: true, stdio: "ignore", env: { ...process.env, PORT: String(this.port) } });
      this.child = child;
      child.once?.("error", () => this.release(child));
      child.once?.("exit", () => this.release(child));
    } catch {
      return false;
    }
    this.owned = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (signal?.aborted) { await this.stop(); return false; }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await this.healthy(signal)) return true;
    }
    await this.stop();
    return false;
  }

  async stop(): Promise<void> {
    if (!this.owned || !this.child) return;
    const child = this.child; this.child = null; this.owned = false;
    if (!child.killed) child.kill();
  }

  private release(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.owned = false;
  }

  private async healthy(signal?: AbortSignal): Promise<boolean> {
    try { const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal }); return response.ok; } catch { return false; }
  }
}
