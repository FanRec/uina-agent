import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NeteaseApiClient } from "./api-client.js";

export interface CompanionStatus {
  readonly running: boolean;
  readonly spawnedByUs: boolean;
  readonly port: number;
}

export class CompanionManager {
  private childProcess: ChildProcess | null = null;
  private spawnedByUs = false;
  private startPromise: Promise<CompanionStatus> | null = null;
  private generation = 0;

  constructor(
    private readonly serviceDir = "E:\\Uina\\ThirdParty\\api-enhanced",
    private readonly port = 3000,
  ) {}

  async ensureRunning(apiClient: NeteaseApiClient, maxWaitMs = 10000): Promise<CompanionStatus> {
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    this.startPromise = this.startInternal(apiClient, maxWaitMs, generation);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(apiClient: NeteaseApiClient, maxWaitMs: number, generation: number): Promise<CompanionStatus> {
    // 1. Check if already healthy
    if (await apiClient.isHealthy(1500)) {
      return { running: true, spawnedByUs: false, port: this.port };
    }

    // 2. Check if service directory exists
    const appJs = join(this.serviceDir, "app.js");
    if (!existsSync(appJs)) {
      // Service directory not found, can't spawn
      return { running: false, spawnedByUs: false, port: this.port };
    }

    // 3. Spawn child process
    try {
      const child = spawn("node", ["app.js"], {
        cwd: this.serviceDir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PORT: String(this.port),
        },
      });
      this.childProcess = child;
      this.spawnedByUs = true;

      child.once("exit", () => {
        if (this.childProcess === child) {
          this.childProcess = null;
          this.spawnedByUs = false;
        }
      });

      // 4. Poll until healthy
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        if (generation !== this.generation) {
          return { running: false, spawnedByUs: true, port: this.port };
        }
        if (await apiClient.isHealthy(1000)) {
          return { running: true, spawnedByUs: true, port: this.port };
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      try { child.kill(); } catch { /* already exited */ }
      if (this.childProcess === child) {
        this.childProcess = null;
        this.spawnedByUs = false;
      }
      return { running: false, spawnedByUs: false, port: this.port };
    } catch {
      return { running: false, spawnedByUs: false, port: this.port };
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    if (this.childProcess && this.spawnedByUs) {
      const proc = this.childProcess;
      this.childProcess = null;
      this.spawnedByUs = false;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  getStatus(): CompanionStatus {
    return {
      running: this.childProcess !== null && !this.childProcess.killed,
      spawnedByUs: this.spawnedByUs,
      port: this.port,
    };
  }
}
