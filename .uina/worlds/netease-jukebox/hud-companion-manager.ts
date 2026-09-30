import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class HudCompanionManager {
  private child: ChildProcess | null = null;
  private owned = false;
  constructor(private readonly directory: string, private readonly port: number) {}

  async ensureRunning(signal?: AbortSignal): Promise<boolean> {
    if (await this.healthy(signal)) return true;
    const entry = join(this.directory, "server.mjs");
    if (!existsSync(entry)) return false;
    this.child = spawn(process.execPath, [entry], { cwd: this.directory, windowsHide: true, stdio: "ignore", env: { ...process.env, PORT: String(this.port) } });
    this.owned = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await this.healthy(signal)) return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    if (!this.owned || !this.child) return;
    const child = this.child; this.child = null; this.owned = false;
    if (!child.killed) child.kill();
  }

  private async healthy(signal?: AbortSignal): Promise<boolean> {
    try { const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal }); return response.ok; } catch { return false; }
  }
}
