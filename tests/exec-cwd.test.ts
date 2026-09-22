import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommandDirect } from "../src/extensions/runtime-tools/exec-command/index.js";

/**
 * cwd 单一事实来源：exec_command 必须以传入的 cwd 为工作目录，
 * 而不是隐式读 process.cwd()——否则 Host cwd 与 Node 进程 cwd 不同时，
 * read_file("src/a.ts") 与 exec_command("cat src/a.ts") 会落在不同项目。
 */
describe("exec_command 工作目录 = api.cwd（而非 process.cwd()）", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "uina-exec-a-"));
    dirB = await mkdtemp(join(tmpdir(), "uina-exec-b-"));
    await writeFile(join(dirA, "marker.txt"), "A");
    await writeFile(join(dirB, "marker.txt"), "B");
  });

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("显式 cwd 生效：spawn 落在 cwd 而非 process.cwd()", async () => {
    // 制造「进程 cwd != 目标 cwd」的条件：process.cwd() 是项目根。
    const result = await execCommandDirect('node -p "process.cwd()"', undefined, { cwd: dirB });
    expect(result.code).toBe(0);
    const cwdFromChild = result.stdout.trim();
    // node 子进程报出的 cwd 必须等于传入的 cwd（而不是被 spawn 忽略后落到进程 cwd）
    expect(cwdFromChild).not.toBe(process.cwd());
    expect(cwdFromChild).toBe(dirB);
  });

  it("文件工具与 shell 落同一目录：在 cwd 下用 read 语义读写同一文件", async () => {
    // 用 shell 在 dirB 写文件，再确认它出现在 dirB 而非进程 cwd
    const pathInChild = join(dirB, "probe.txt").replace(/\\/g, "/");
    const cmd = process.platform === "win32"
      ? `Set-Content -Path '${pathInChild}' -Value 'probe'`
      : `printf 'probe' > '${pathInChild}'`;
    const write = await execCommandDirect(cmd, undefined, { cwd: dirB });
    expect(write.code).toBe(0);
    const content = await (await import("node:fs/promises")).readFile(join(dirB, "probe.txt"), "utf8");
    expect(content.trim()).toBe("probe");
  });
});