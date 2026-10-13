import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { NeteaseApiClient } from "./api-client.js";

export interface CompanionStatus {
  readonly running: boolean;
  readonly spawnedByUs: boolean;
  readonly port: number;
  /** 启动失败时的补充诊断（如端口被其他程序占用），由 requireService 透出。 */
  readonly detail?: string;
}

export interface CompanionManagerOptions {
  readonly spawn?: typeof spawn;
  /**
   * 子进程日志目录（按天分文件）。设置后以 fd 直传方式把子进程 stdout/stderr 落盘，
   * 服务端的 [ERR] 现场不再丢失。不设置时保持 stdio: "ignore"。
   */
  readonly logDir?: string;
}

/** 本地日期戳（YYYY-MM-DD）：日志按天分文件必须跟用户时钟一致，UTC 会让本地 0-8 点的错误落进"昨天"。 */
function localDateStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("网易云服务等待已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
    if (signal.aborted) onAbort();
  });
}

export class CompanionManager {
  private childProcess: ChildProcess | null = null;
  private spawnedByUs = false;
  private startPromise: Promise<CompanionStatus> | null = null;
  private generation = 0;
  private childReady = false;
  private readonly spawnProcess: typeof spawn;
  private logDir: string | undefined;

  constructor(
    private readonly serviceDir = "E:\\Uina\\ThirdParty\\api-enhanced",
    private readonly port = 3000,
    options: CompanionManagerOptions = {},
  ) {
    this.spawnProcess = options.spawn ?? spawn;
    this.logDir = options.logDir;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`无效的网易云伴生服务端口: ${port}`);
    }
  }

  /**
   * 设置子进程日志目录。数据目录由宿主在 onStart 注入（worldDataDir），
   * 因此允许启动后补设；仅影响之后 spawn 的子进程。
   */
  setLogDir(dir: string | undefined): void {
    this.logDir = dir;
  }

  async ensureRunning(apiClient: NeteaseApiClient, maxWaitMs = 10000, signal?: AbortSignal): Promise<CompanionStatus> {
    let startPromise = this.startPromise;
    if (!startPromise) {
      const generation = ++this.generation;
      const pending = this.startInternal(apiClient, maxWaitMs, generation);
      startPromise = pending.finally(() => {
        if (this.startPromise === startPromise) this.startPromise = null;
      });
      this.startPromise = startPromise;
    }
    return waitForSignal(startPromise, signal);
  }

  private async startInternal(apiClient: NeteaseApiClient, maxWaitMs: number, generation: number): Promise<CompanionStatus> {
    // 1. Check if already healthy
    const healthy = await apiClient.isHealthy(1500);
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
      // 日志落盘：用 openSync 的 fd 直接作为子进程 stdio，父进程随即 close。
      // 不用 "pipe"——服务是被 unref 留存的常驻进程，父进程退出后 pipe 断裂会让
      // 服务端 console.log 触发 EPIPE 甚至崩溃；fd 直传由 OS 落盘，零父进程参与。
      let outputFd: number | null = null;
      let child: ChildProcess;
      try {
        if (this.logDir) {
          try {
            mkdirSync(this.logDir, { recursive: true });
            outputFd = openSync(join(this.logDir, `api-enhanced-${localDateStamp()}.log`), "a");
          } catch {
            outputFd = null;
          }
        }
        // process.execPath 而非 PATH 里的 "node"：宿主 PATH 缺 node 时 spawn("node") 会发出
        // 无监听的 'error' 事件并击穿为 uncaughtException。与 HudCompanionManager 保持一致。
        child = this.spawnProcess(process.execPath, ["app.js"], {
          cwd: this.serviceDir,
          stdio: outputFd === null ? "ignore" : ["ignore", outputFd, outputFd],
          windowsHide: true,
          env: {
            ...process.env,
            PORT: String(this.port),
          },
        });
      } finally {
        if (outputFd !== null) closeSync(outputFd);
      }
      this.childProcess = child;
      this.spawnedByUs = true;
      this.childReady = false;

      let processFailure: string | undefined;
      child.once("error", (error) => {
        processFailure = `启动网易云数据服务失败：${error.message}`;
        if (this.childProcess === child) {
          this.childProcess = null;
          this.spawnedByUs = false;
          this.childReady = false;
        }
      });
      child.once("exit", (code, signal) => {
        processFailure = signal
          ? `网易云数据服务启动后被信号 ${signal} 终止。`
          : `网易云数据服务启动后退出，退出码 ${code ?? "unknown"}。`;
        if (this.childProcess === child) {
          this.childProcess = null;
          this.spawnedByUs = false;
          this.childReady = false;
        }
      });

      // 4. Poll until healthy
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        if (generation !== this.generation) break;
        if (processFailure) return this.unhealthy(processFailure);
        const ready = await apiClient.isHealthy(1000);
        if (generation !== this.generation) break;
        if (ready) {
          this.childReady = true;
          // api-enhanced is a reusable local service and must not keep the host event loop alive.
          child.unref();
          return { running: true, spawnedByUs: true, port: this.port };
        }
        if (processFailure) return this.unhealthy(processFailure);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }

      this.killChild(child);
      // 探测无法区分"外部程序占用"与"刚 kill 的子进程尚未退出"，措辞保持留有余地。
      return this.unhealthy(
        await this.portOccupied()
          ? `端口 ${this.port} 有 HTTP 响应但未提供网易云数据服务（可能被其他程序占用）。`
          : `网易云数据服务在 ${maxWaitMs} 毫秒内未能于端口 ${this.port} 就绪。`,
      );
    } catch (error) {
      if (this.childProcess) this.killChild(this.childProcess);
      return this.unhealthy(`启动网易云数据服务失败：${error instanceof Error ? error.message : String(error)}`);
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
    if (this.childProcess && this.spawnedByUs && !this.childReady) {
      this.killChild(this.childProcess);
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
      this.childReady = false;
    }
  }
}
