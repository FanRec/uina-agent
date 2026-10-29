import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { BuiltCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { describeDirectory } from "../../.uina/worlds/minecraft/companion/directory.js";
import { createLibrary } from "../../.uina/worlds/minecraft/library/index.js";

test("one discovery view ranks all kinds, pages stably, and keeps exact descriptions small", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-library-directory-"));
	const library = createLibrary({
		dataRoot: root,
		compile: async (p) => ({ ok: true, digest: p.digest }),
		readSource: async () => null,
	});
	await library.save({ name: "echo", summary: "reuse", source: "async function main(){return 1;}" });
	await library.save({
		kind: "experience",
		name: "echo",
		text: '<!-- uina {"summary":"echo judgment"} -->\nBODY IS PRIVATE',
	});
	await mkdir(join(root, "programs"), { recursive: true });
	await writeFile(join(root, "programs/bad.js"), "// uina {bad}\nasync function main(){}");
	for (let i = 0; i < 12; i++)
		await library.save({ name: `echo_${i}`, summary: "echo", source: "async function main(){}" });
	const capabilities = { queries: [], callables: [] } as unknown as BuiltCapabilities;
	const first = await describeDirectory(capabilities, library, { query: "echo" });
	expect(first).toMatchObject({ next: "10" });
	expect("items" in first && first.items.slice(0, 2)).toMatchObject([
		{ kind: "experience", name: "echo" },
		{ kind: "program", name: "echo" },
	]);
	const second = await describeDirectory(capabilities, library, { query: "echo", cursor: "10" });
	expect((second as { items: unknown[] }).items).toHaveLength(4);
	expect(JSON.stringify(await describeDirectory(capabilities, library, { selector: "echo" }))).not.toContain(
		"async function main",
	);
	expect(
		JSON.stringify(await describeDirectory(capabilities, library, { kind: "experience", name: "echo" })),
	).not.toContain("BODY IS PRIVATE");
	expect(await describeDirectory(capabilities, library, { kind: "program", name: "bad" })).toMatchObject({
		availability: { state: "unavailable" },
		program: { headerError: expect.any(String) },
	});
	expect(await describeDirectory(capabilities, library, {})).toMatchObject({ families: expect.any(Array) });
});
