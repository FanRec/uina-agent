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
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`无效的网易云伴生服务端口: ${port}`);
    }
  }

  async ensureRunning(apiClient: NeteaseApiClient, maxWaitMs = 10000, signal?: AbortSignal): Promise<CompanionStatus> {
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    this.startPromise = this.startInternal(apiClient, maxWaitMs, generation, signal);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(apiClient: NeteaseApiClient, maxWaitMs: number, generation: number, signal?: AbortSignal): Promise<CompanionStatus> {
    signal?.throwIfAborted();
    // 1. Check if already healthy
    const healthy = await apiClient.isHealthy(1500, signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) {
      return { running: false, spawnedByUs: false, port: this.port };
    }
    if (healthy) {
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
        signal?.throwIfAborted();
        if (generation !== this.generation) break;
        const ready = await apiClient.isHealthy(1000, signal);
        signal?.throwIfAborted();
        if (generation !== this.generation) break;
        if (ready) {
          return { running: true, spawnedByUs: true, port: this.port };
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 500);
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("伴生服务启动已取消"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }

      this.killChild(child);
      return { running: false, spawnedByUs: false, port: this.port };
    } catch (error) {
      if (this.childProcess) this.killChild(this.childProcess);
      if (signal?.aborted) throw error;
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

  private killChild(child: ChildProcess): void {
    try { child.kill(); } catch { /* already exited */ }
    if (this.childProcess === child) {
      this.childProcess = null;
      this.spawnedByUs = false;
    }
  }
}
