import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompanionHandle } from "./companion.js";
import type { TtsExtensionConfig } from "./config.js";

const STOP_TIMEOUT_MS = 5000;
type SubtitleConfig = Required<Pick<TtsExtensionConfig,
  "subtitleServiceUrl" | "subtitleServiceDir" | "subtitleAutoSpawn" | "subtitleStartupTimeoutMs">>;

export interface SubtitleCompanionOptions {
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  killProcessTree?: (pid: number) => Promise<void>;
}

function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 3000 }, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  try { process.kill(pid, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return Promise.reject(error);
  }
  return Promise.resolve();
}

async function healthPid(url: string, fetchImpl: typeof fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const body = await response.json() as {
      service?: string; version?: number; process?: { ready?: boolean; pid?: number };
    };
    const pid = body.process?.pid;
    return body.service === "realtime-subtitles" && body.version === 1 && body.process?.ready === true &&
      typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode != null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("subtitle service did not exit after stop"));
    }, STOP_TIMEOUT_MS);
    child.once("exit", onExit);
  });
}

export async function ensureSubtitleService(
  config: SubtitleConfig,
  signal?: AbortSignal,
  options: SubtitleCompanionOptions = {},
): Promise<CompanionHandle> {
  const url = new URL(config.subtitleServiceUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host) ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("subtitle service URL must be a local HTTP origin");
  }
  const timeoutMs = config.subtitleStartupTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new Error("subtitle startup timeout must be a positive finite timer duration");
  }
  function checkCancelled(): void {
    if (signal?.aborted) throw new Error("subtitle service startup aborted");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  checkCancelled();
  const existingPid = await healthPid(url.origin, fetchImpl);
  checkCancelled();
  if (existingPid !== null) return { didSpawn: false, stop: async () => {} };
  if (!config.subtitleAutoSpawn) throw new Error("subtitle service is not running and subtitleAutoSpawn is disabled");

  const dir = config.subtitleServiceDir;
  const built = join(dir, "dist", "main.js");
  const source = join(dir, "src", "main.ts");
  const tsx = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
  const args = existsSync(built) ? [built] : [tsx, source];
  if (!existsSync(built) && (!existsSync(source) || !existsSync(tsx))) {
    throw new Error(`subtitle service has no build or tsx runtime: ${dir}`);
  }
  args.push("--host", host, "--port", url.port || "80");
  const child = (options.spawnProcess ?? spawn)(process.execPath, args, {
    cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  const childPid = child.pid;
  if (!childPid) throw new Error("subtitle service failed to spawn");
  const pid: number = childPid;

  let logs = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (data: string) => { logs = (logs + data).slice(-4000); });
  }
  const killProcessTree = options.killProcessTree ?? killTree;
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (hasExited(child)) return;
      try { await killProcessTree(pid); }
      catch (error) { if (!hasExited(child)) throw error; }
      await waitForExit(child);
    })();
    return stopping;
  }

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkCancelled();
      if (spawnError) throw spawnError;
      if (hasExited(child)) throw new Error("subtitle service exited during startup");
      const readyPid = await healthPid(url.origin, fetchImpl);
      checkCancelled();
      if (hasExited(child)) throw new Error("subtitle service exited during startup");
      if (readyPid === pid) return { didSpawn: true, pid, stop };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`subtitle service failed to become healthy within ${timeoutMs}ms`);
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "subtitle startup and cleanup failed"); }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${logs.trim() ? `\n${logs.trim()}` : ""}`, { cause: error });
  }
}
