import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  discoverExternalAppEntries,
  isAppDef,
  extractAppDef,
  loadExternalApps,
} from "../src/extensions/app-framework/app-loader.js";
import { AppRegistry } from "../src/extensions/app-framework/app-registry.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { Tool } from "../src/tools/broker.js";

function createMockExtensionAPI() {
  const tools = new Map<string, Tool>();
  const hooks: Record<string, Function[]> = {};
  const abortController = new AbortController();
  const errors: Error[] = [];

  const pi = {
    cwd: process.cwd(),
    signal: abortController.signal,
    registerTool: vi.fn((tool: Tool) => {
      tools.set(tool.def.function.name, tool);
      return () => {
        tools.delete(tool.def.function.name);
      };
    }),
    onHook: vi.fn((hook: string, handler: Function) => {
      if (!hooks[hook]) hooks[hook] = [];
      hooks[hook].push(handler);
      return () => {};
    }),
    reportError: vi.fn((err: unknown) => {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }),
  } as unknown as ExtensionAPI;

  return {
    pi,
    tools,
    hooks,
    abort: () => abortController.abort(),
    errors,
  };
}

describe("AppLoader - isAppDef", () => {
  it("should return true for valid AppDef", () => {
    expect(
      isAppDef({
        name: "test-app",
        description: "A test app",
        actions: {},
      }),
    ).toBe(true);
  });

  it("should return false for invalid objects", () => {
    expect(isAppDef(null)).toBe(false);
    expect(isAppDef(undefined)).toBe(false);
    expect(isAppDef("string")).toBe(false);
    expect(isAppDef({})).toBe(false);
    expect(isAppDef({ name: "", description: "test", actions: {} })).toBe(false);
    expect(isAppDef({ name: "app", description: 123, actions: {} })).toBe(false);
    expect(isAppDef({ name: "app", description: "test" })).toBe(false);
    expect(isAppDef({ name: "app", description: "test", actions: null })).toBe(false);
  });
});

describe("AppLoader - extractAppDef", () => {
  const validApp = {
    name: "my-app",
    description: "Sample",
    actions: {},
  };

  it("should extract direct AppDef", async () => {
    const mock = createMockExtensionAPI();
    const res = await extractAppDef(validApp, mock.pi);
    expect(res).toEqual(validApp);
  });

  it("should extract AppDef from factory function", async () => {
    const mock = createMockExtensionAPI();
    const factory = vi.fn((_pi) => validApp);
    const res = await extractAppDef(factory, mock.pi);
    expect(res).toEqual(validApp);
    expect(factory).toHaveBeenCalledWith(mock.pi);
  });

  it("should extract AppDef from named export appDef or app or default", async () => {
    const mock = createMockExtensionAPI();
    expect(await extractAppDef({ appDef: validApp }, mock.pi)).toEqual(validApp);
    expect(await extractAppDef({ app: validApp }, mock.pi)).toEqual(validApp);
    expect(await extractAppDef({ default: validApp }, mock.pi)).toEqual(validApp);
  });

  it("should return null for non-AppDef export", async () => {
    const mock = createMockExtensionAPI();
    expect(await extractAppDef({ invalid: true }, mock.pi)).toBeNull();
    expect(await extractAppDef("not-an-app", mock.pi)).toBeNull();
    expect(await extractAppDef(null, mock.pi)).toBeNull();
  });
});

describe("AppLoader - discoverExternalAppEntries", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "uina-app-loader-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should discover apps from standalone files and directories", async () => {
    // 1. Standalone app file
    const standaloneFile = join(tempDir, "standalone.ts");
    await writeFile(standaloneFile, "export default { name: 'standalone', description: 'desc', actions: {} };");

    // 2. Directory with default index.ts
    const dirApp1 = join(tempDir, "dir-app-1");
    await mkdir(dirApp1);
    const dirApp1Index = join(dirApp1, "index.ts");
    await writeFile(dirApp1Index, "export default { name: 'dir1', description: 'desc', actions: {} };");

    // 3. Directory with package.json pointing to custom main
    const dirApp2 = join(tempDir, "dir-app-2");
    await mkdir(dirApp2);
    await writeFile(
      join(dirApp2, "package.json"),
      JSON.stringify({ main: "./custom.ts" }),
    );
    const dirApp2Custom = join(dirApp2, "custom.ts");
    await writeFile(dirApp2Custom, "export default { name: 'dir2', description: 'desc', actions: {} };");

    // 4. Non-matching file (should be ignored)
    await writeFile(join(tempDir, "readme.txt"), "hello");

    const entries = await discoverExternalAppEntries([tempDir]);
    expect(entries.length).toBe(3);
    expect(entries.some((e) => e.includes("standalone.ts"))).toBe(true);
    expect(entries.some((e) => e.includes("index.ts"))).toBe(true);
    expect(entries.some((e) => e.includes("custom.ts"))).toBe(true);
  });

  it("should handle non-existent directories gracefully", async () => {
    const nonExistent = join(tempDir, "does-not-exist");
    const entries = await discoverExternalAppEntries([nonExistent]);
    expect(entries).toEqual([]);
  });
});

describe("AppLoader - loadExternalApps", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "uina-app-load-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should dynamically load valid apps and register with AppRegistry", async () => {
    const appDir = join(tempDir, "sample-app");
    await mkdir(appDir);
    const code = `
      export default {
        name: "sample",
        description: "A sample loaded app",
        actions: {
          ping: {
            description: "ping",
            run: () => "pong",
          }
        }
      };
    `;
    await writeFile(join(appDir, "index.ts"), code);

    const mock = createMockExtensionAPI();
    const registry = new AppRegistry(mock.pi);

    const teardown = await loadExternalApps(mock.pi, registry, [tempDir]);

    expect(registry.has("sample")).toBe(true);
    const facadeTool = mock.tools.get("sample");
    expect(facadeTool).toBeDefined();

    const res = await facadeTool!.run({ action: "ping" });
    expect(res.status).toBe("succeeded");
    expect(res.result).toBe("pong");

    // Teardown should unregister the app
    await teardown();
    expect(registry.has("sample")).toBe(false);
    expect(mock.tools.has("sample")).toBe(false);
  });

  it("should report error when app file does not export valid AppDef", async () => {
    const invalidAppDir = join(tempDir, "invalid-app");
    await mkdir(invalidAppDir);
    await writeFile(join(invalidAppDir, "index.ts"), "export default { notAnApp: true };");

    const mock = createMockExtensionAPI();
    const registry = new AppRegistry(mock.pi);

    const teardown = await loadExternalApps(mock.pi, registry, [tempDir]);

    expect(mock.errors.length).toBe(1);
    expect(mock.errors[0].message).toContain("未导出合法的 AppDef 契约");
    expect(registry.size).toBe(0);

    await teardown();
  });

  it("should report error when app module throws during import", async () => {
    const brokenAppDir = join(tempDir, "broken-app");
    await mkdir(brokenAppDir);
    await writeFile(join(brokenAppDir, "index.ts"), "throw new Error('Explosion during load');");

    const mock = createMockExtensionAPI();
    const registry = new AppRegistry(mock.pi);

    const teardown = await loadExternalApps(mock.pi, registry, [tempDir]);

    expect(mock.errors.length).toBe(1);
    expect(mock.errors[0].message).toContain("动态装载外部 App 失败");
    expect(mock.errors[0].message).toContain("Explosion during load");
    expect(registry.size).toBe(0);

    await teardown();
  });
});
