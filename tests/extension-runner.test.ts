import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("project extension runner", () => {
	it("owns registrations, persists custom records through its ports, and invalidates old ctx on reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "sample.js"), `export default async function(pi) {
 globalThis.__uinaTestExtension = pi;
 pi.registerCommand({ name: 'hello', description: 'hello' });
 await pi.sendMessage({ customType: 'test.message', content: 'visible to provider' });
 await pi.appendEntry({ customType: 'test.entry', data: { ok: true } });
 return () => { globalThis.__uinaDisposed = true; };
}`, "utf8");
		const messages: unknown[] = [];
		const entries: unknown[] = [];
		const runner = new ExtensionRunner({ cwd: root, tools: new ToolBroker(), onCustomMessage: async (value) => { messages.push(value); }, onCustomEntry: async (value) => { entries.push(value); } });
		await runner.load();
		expect(runner.registry.getCommand("hello")).toBeDefined();
		expect(messages).toEqual([{ customType: "test.message", content: "visible to provider" }]);
		expect(entries).toEqual([{ customType: "test.entry", data: { ok: true } }]);
		const old = (globalThis as Record<string, unknown>).__uinaTestExtension as { ui: { getEditorText(): string } };
		await runner.reload();
		expect((globalThis as Record<string, unknown>).__uinaDisposed).toBe(true);
		expect(() => old.ui.getEditorText()).toThrow(/已失效/);
		await runner.dispose();
	});

	it("reports activation failures instead of silently swallowing them", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-ext-"));
		roots.push(root);
		const directory = join(root, ".uina", "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "bad.js"), "export default function() { throw new Error('broken extension'); }", "utf8");
		const onError = vi.fn();
		const runner = new ExtensionRunner({ cwd: root, tools: new ToolBroker(), onError });
		await runner.load();
		expect(onError).toHaveBeenCalledWith(expect.stringContaining("broken extension"));
	});
});
