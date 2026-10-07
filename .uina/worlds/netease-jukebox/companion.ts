import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NeteaseApiClient } from "./api-client.js";

export interface CompanionStatus {
  readonly running: boolean;
  readonly spawnedByUs: boolean;
  readonly port: number;
  /** 启动失败时的补充诊断（如端口被其他程序占用），由 requireService 透出。 */
  readonly detail?: string;
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
      return this.unhealthy();
    }
    if (healthy) {
      return { running: true, spawnedByUs: false, port: this.port };
    }

    // 2. Check if service directory exists
    const appJs = join(this.serviceDir, "app.js");
    if (!existsSync(appJs)) {
      // Service directory not found, can't spawn
      return this.unhealthy("未找到 api-enhanced 服务目录，无法自动启动。");
    }

    // 3. Spawn child process
    try {
      // process.execPath 而非 PATH 里的 "node"：宿主 PATH 缺 node 时 spawn("node") 会发出
      // 无监听的 'error' 事件并击穿为 uncaughtException。与 HudCompanionManager 保持一致。
      const child = spawn(process.execPath, ["app.js"], {
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
      // 排空管道：无人读取时子进程日志写满 64KB 缓冲会阻塞在 console.log 上，永远无法 healthy。
      child.stdout?.resume();
      child.stderr?.resume();

      child.once("error", () => {
        if (this.childProcess === child) {
          this.childProcess = null;
          this.spawnedByUs = false;
        }
      });
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
      // 探测无法区分"外部程序占用"与"刚 kill 的子进程尚未退出"，措辞保持留有余地。
      return this.unhealthy(
        await this.portOccupied()
          ? `端口 ${this.port} 有 HTTP 响应但未提供网易云数据服务（可能被其他程序占用）。`
          : undefined,
      );
    } catch (error) {
      if (this.childProcess) this.killChild(this.childProcess);
      if (signal?.aborted) throw error;
      return this.unhealthy();
    }
  }

  private unhealthy(detail?: string): CompanionStatus {
    return { running: false, spawnedByUs: false, port: this.port, ...(detail ? { detail } : {}) };
  }

  /** 端口上是否有"任何"HTTP 服务在响应（无论状态码）：用于区分端口被占与服务未启动。 */
  private async portOccupied(): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${this.port}/login/status`, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
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
