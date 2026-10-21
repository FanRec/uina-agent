import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** api-enhanced 把 xeapi 通道的公钥写死在 `os.tmpdir()/xeapi_public_key`。 */
const KEY_FILE = "xeapi_public_key";
/** generateConfig 内部的 HTTP 请求没有超时，这里兜住网络挂起。 */
const GENERATE_TIMEOUT_MS = 15_000;

/**
 * 确保 api-enhanced 的 xeapi 公钥存在；返回补写失败的原因，成功或文件已存在时为 undefined。
 *
 * 服务只在进程启动时拉取一次公钥，失败时把异常吞进 console.log 后照常监听端口：
 * 端口健康、搜索正常，但所有 xeapi 接口（`/song/url/v1` 等）统一返回由内部异常
 * 合成的 `404 Not Found`。公钥由服务自带的 `generateConfig` 生成，这里只在文件
 * 缺失时补跑一次，不改动其代码。
 */
export async function ensureXeapiPublicKey(serviceDir: string): Promise<string | undefined> {
  const keyPath = join(tmpdir(), KEY_FILE);
  if (existsSync(keyPath)) return undefined;

  const output = await runGenerateConfig(serviceDir);
  // generateConfig 逐段 catch 内部错误、异常只打到控制台，退出码永远为 0：
  // 唯一可信的成功信号是文件落盘，失败原因取控制台输出的末行。
  if (existsSync(keyPath)) return undefined;
  return output.trim().split(/\r?\n/).filter(Boolean).pop() ?? "generateConfig 未写出公钥。";
}

function runGenerateConfig(serviceDir: string): Promise<string> {
  const entry = join(serviceDir, "generateConfig.js");
  const script = `require(${JSON.stringify(entry)})().then(() => process.exit(0), () => process.exit(1))`;
  return new Promise((resolve) => {
    // 一次性子进程，父进程只要活到它退出即可：与常驻服务必须用 fd 直传的理由不同，pipe 足够。
    const child = spawn(process.execPath, ["-e", script], {
      cwd: serviceDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-400);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      resolve(`生成公钥超时（${GENERATE_TIMEOUT_MS} 毫秒）。`);
    }, GENERATE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(`${output}\n启动 generateConfig 失败（cwd: ${serviceDir}）：${error.message}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : `${output}\ngenerateConfig 退出码 ${code ?? "unknown"}。`);
    });
  });
}
