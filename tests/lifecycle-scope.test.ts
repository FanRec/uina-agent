import { describe, expect, it } from "vitest";
import { ResourceScope } from "../src/extensions/lifecycle-scope.js";

describe("ResourceScope", () => {
  it("cancels and waits for accepted work before cleanup", async () => {
    const scope = new ResourceScope("test");
    let finished = false;
    let cleaned = false;
    const work = scope.run(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      finished = true;
    });
    scope.onDispose(() => {
      if (!finished) throw new Error("cleanup ran before work finished");
      cleaned = true;
    });

    await Promise.resolve();
    await scope.close();

    expect(finished).toBe(true);
    expect(cleaned).toBe(true);
    await expect(work).resolves.toBeUndefined();
  });

  it("does not start queued work after close", async () => {
    const scope = new ResourceScope("test");
    let started = false;
    const work = scope.run(async () => {
      started = true;
    });

    await scope.close();

    expect(started).toBe(false);
    await expect(work).rejects.toThrow("Resource scope is closed: test");
  });

  it("closes only once and reports cleanup failures", async () => {
    const scope = new ResourceScope("test");
    let cleanupCount = 0;
    scope.onDispose(() => {
      cleanupCount += 1;
      throw new Error("cleanup failed");
    });

    const first = scope.close();
    const second = scope.close();

    expect(first).toBe(second);
    await expect(first).rejects.toThrow("Resource scope cleanup failed: test");
    expect(cleanupCount).toBe(1);
  });
});
