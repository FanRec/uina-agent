import { spawn, exec, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TtsExtensionConfig } from "./config.js";
import { TtsBridgeClient } from "./client.js";

export interface CompanionHandle {
  readonly didSpawn: boolean;
  readonly pid?: number;
  stop(): Promise<void>;
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      exec(`taskkill /F /T /PID ${pid}`, () => resolve());
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Ignore if process already exited
        }
      }
      resolve();
    }
  });
}

export async function ensureCompanion(
  config: TtsExtensionConfig,
  signal?: AbortSignal,
): Promise<CompanionHandle> {
  const client = new TtsBridgeClient(config.serviceUrl, 1500);

  // 1. 探测优先：如果已有服务运行，直接复用，绝不杀死外部服务
  if (await client.isHealthy()) {
    return {
      didSpawn: false,
      stop: async () => {},
    };
  }

  // 如果未配置自动拉起且当前未运行，明确抛错以触发静音降级
  if (!config.autoSpawn) {
    throw new Error("TTS companion is not running and autoSpawn is disabled");
  }

  // 2. 检查 Python 与执行脚本路径
  if (!existsSync(config.pythonPath)) {
    throw new Error(`TTS companion failed: python executable not found at ${config.pythonPath}`);
  }
  if (!existsSync(config.bridgeScript)) {
    throw new Error(`TTS companion failed: bridge script not found at ${config.bridgeScript}`);
  }

  const args = [config.bridgeScript, "--serve"];
  if (config.bridgeConfig && existsSync(config.bridgeConfig)) {
    args.push("--config", config.bridgeConfig);
  }

  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };

  const child: ChildProcess = spawn(config.pythonPath, args, {
    cwd: dirname(config.bridgeScript),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });

  const pid = child.pid;
  if (!pid) {
    throw new Error("TTS companion failed to spawn process");
  }

  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (data: string) => {
    stdoutBuffer = (stdoutBuffer + data).slice(-2000);
  });

  let stderrBuffer = "";
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (data: string) => {
    stderrBuffer = (stderrBuffer + data).slice(-2000);
  });

  const state = {
    spawnError: null as Error | null,
  };
  child.on("error", (err) => {
    state.spawnError = err;
  });

  const getLogDetail = (): string => {
    const parts: string[] = [];
    if (stdoutBuffer.trim()) parts.push(`stdout: ${stdoutBuffer.trim()}`);
    if (stderrBuffer.trim()) parts.push(`stderr: ${stderrBuffer.trim()}`);
    return parts.length > 0 ? `\n${parts.join("\n")}` : "";
  };

  let isStopped = false;
  let exitPromise: Promise<void> | undefined;
  const waitForExit = (): Promise<void> => {
    exitPromise ??= new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
    return exitPromise;
  };

  /**
   * 停止本函数拉起的伴生进程（幂等）。
   *
   * 所有权契约：谁调 ensureCompanion 谁负责在卸载时 await stop()——
   * 本函数不自行注册 abort 监听，避免“未等待的 void stop()”让卸载方
   * 误以为进程已结束。复用外部服务时 didSpawn=false，stop 是 no-op。
   */
  const stop = async (): Promise<void> => {
    if (isStopped) {
      await waitForExit();
      return;
    }
    isStopped = true;
    await killProcessTree(pid);
    // 杀完必须等到进程树确认退出：句柄消费方（teardown）据此才能声明资源已回收。
    await waitForExit();
  };

  // 3. 轮询健康检查直至就绪
  const startTime = Date.now();
  const timeoutMs = config.startupTimeoutMs || 30000;

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      await stop();
      throw new Error("TTS companion startup aborted by signal");
    }
    if (state.spawnError) {
      await stop();
      throw new Error(`TTS companion process error: ${state.spawnError.message}${getLogDetail()}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`TTS companion process exited prematurely with code ${child.exitCode}${getLogDetail()}`);
    }

    if (await client.isHealthy()) {
      return {
        didSpawn: true,
        pid,
        stop,
      };
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  // 超时清理
  await stop();
  throw new Error(`TTS companion failed to become healthy within ${timeoutMs}ms${getLogDetail()}`);
}
