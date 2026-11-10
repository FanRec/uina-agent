import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/catalog.js";
import { builtinCatalog, createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
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
	const catalog = CapabilityCatalog.create([]).allDescriptors();
	const first = await describeDirectory(catalog, library, { query: "echo" });
	expect(first).toMatchObject({ next: "10" });
	expect("items" in first && first.items.slice(0, 2)).toMatchObject([
		{ kind: "experience", name: "echo" },
		{ kind: "program", name: "echo" },
	]);
	const second = await describeDirectory(catalog, library, { query: "echo", cursor: "10" });
	expect((second as { items: unknown[] }).items).toHaveLength(4);
	expect(JSON.stringify(await describeDirectory(catalog, library, { selector: "echo" }))).not.toContain(
		"async function main",
	);
	expect(JSON.stringify(await describeDirectory(catalog, library, { kind: "experience", name: "echo" }))).not.toContain(
		"BODY IS PRIVATE",
	);
	expect(await describeDirectory(catalog, library, { kind: "program", name: "bad" })).toMatchObject({
		availability: { state: "unavailable" },
		program: { headerError: expect.any(String) },
	});
	// 无参概览：家族计数保留，另给确切 ref 清单（模型的 selector 只能靠名字），不再中转一次 nextCall。
	const overview = (await describeDirectory(catalog, library, {})) as {
		families: { kind: string; count: number }[];
		reads: string[];
		acts: string[];
	};
	expect(overview.families).toEqual(expect.arrayContaining([{ kind: "capability", count: 0 }]));
	expect(overview.reads).toEqual([]);
	expect(overview.acts).toEqual([]);
	expect(overview).not.toHaveProperty("next");
	// 空结果给下一步，而不是让模型换关键词反复试探。
	expect(await describeDirectory(catalog, library, { query: "no-such-capability" })).toMatchObject({
		items: [],
		hint: expect.any(String),
	});
});

test("describe without arguments lists every capability ref in one response", async () => {
	const emptyLibrary = { list: async () => [], get: async () => null } as never;
	const overview = (await describeDirectory(createCapabilityCatalog().allDescriptors(), emptyLibrary, {})) as {
		reads: string[];
		acts: string[];
		families: { kind: string; count: number }[];
	};
	// 模型通过一次目录查询取得全部确切 selector。
	expect(overview.reads.length + overview.acts.length).toBe(55);
	expect(overview.families).toEqual(expect.arrayContaining([{ kind: "capability", count: 55 }]));
	expect(JSON.stringify(overview).length).toBeLessThanOrEqual(1600);
});

test.each([
	["原木", "collect@1", "run", "describe"],
	["采集", "collect@1", "run", "describe"],
	["WOOD", "collect@1", "run", "describe"],
	["collect，采集 原木 log", "collect@1", "run", "describe"],
	["想找个高处看看", "explore@1", "run", "describe"],
	["想继续施工", "build.resume@1", "run", "describe"],
	["施工差异", "build.plan@1", "observe", "describe"],
	["self", "self@1", "observe", "observe"],
])("discover %s as %s", async (query, name, use, action) => {
	const library = { list: async () => [], get: async () => null } as never;
	const result = await describeDirectory(createCapabilityCatalog().allDescriptors(), library, { query });
	expect("items" in result && result.items[0]).toMatchObject({
		name,
		use,
		nextCall: { action, params: { selector: name } },
		...(name === "collect@1" ? { required: ["item"], defaults: { count: 1 } } : {}),
	});
});

test("input examples explain complex shapes without dispatching them", async () => {
	const library = { list: async () => [], get: async () => null } as never;
	const descriptors = builtinCatalog.allDescriptors();
	const Ajv = createRequire(import.meta.url)("ajv");
	const ajv = new Ajv({ strict: false });
	for (const selector of ["blocks@1", "explore@1", "region@1"]) {
		const result = await describeDirectory(descriptors, library, { query: selector });
		const candidate = ("items" in result ? result.items[0] : null) as {
			inputExample: unknown;
			nextCall: unknown;
		} | null;
		expect(candidate?.inputExample).toBeDefined();
		expect(ajv.compile(descriptors.find((d) => d.ref === selector)!.input)(candidate?.inputExample)).toBe(true);
		expect(candidate?.nextCall).toEqual({ action: "describe", params: { selector } });
	}
});

test("exact discovery advertises published Programs and only includes source on request", async () => {
	const library = { list: async () => [], get: async () => null } as never;
	const descriptors = builtinCatalog.allDescriptors();
	const publishedPrograms = builtinCatalog.publishedPrograms();
	expect(publishedPrograms).toEqual(expect.arrayContaining(["collect@1", "build.resume@1"]));
	for (const selector of publishedPrograms) {
		const programSource = builtinCatalog.publishedSource(selector);
		expect(programSource).toMatchObject({
			source: expect.stringContaining("async function main"),
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		const metadata = await describeDirectory(descriptors, library, { selector }, [], {
			publishedPrograms,
			programSource: null,
		});
		expect(metadata).toMatchObject({
			sourceAvailable: true,
			sourceCall: { action: "describe", params: { selector, includeSource: true } },
		});
		expect(metadata).not.toHaveProperty("programSource");
		expect(
			await describeDirectory(descriptors, library, { selector, includeSource: true }, [], {
				publishedPrograms,
				programSource,
			}),
		).toMatchObject({ programSource });
	}
	expect(builtinCatalog.publishedSource("goto@1")).toBeNull();
});
