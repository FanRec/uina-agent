import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ProgramPort } from "../../.uina/worlds/minecraft/contracts/program.js";
import { methods } from "../../.uina/worlds/minecraft/executor/protocol.js";
import { createLibrary } from "../../.uina/worlds/minecraft/library/index.js";
import { createProgram } from "../../.uina/worlds/minecraft/program/index.js";

const ports: ProgramPort[] = [];
afterEach(async () => {
	await Promise.all(ports.splice(0).map((p) => p.close()));
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-library-"));
	const program = await createProgram({ dataRoot: root, loadProgram: (name) => library.loadProgram(name) });
	ports.push(program);
	const library = createLibrary({ dataRoot: root, compile: (p) => program.validate(p), readSource: async () => null });
	return { root, library, program };
}
const source = "async function main(mc,input){return input;}\r\n";

test("program create, metadata patch and full replacement validate without executing", async () => {
	const { library, root } = await setup();
	const saved = await library.save({
		name: "test",
		summary: "echo\u2028line",
		source: "throw Error('must not execute');\n" + source,
		tags: ["echo"],
	});
	expect(saved).toMatchObject({ kind: "program", name: "test", summary: "echo\u2028line" });
	const first = await library.get("program", "test");
	expect(first?.kind).toBe("program");
	const patched = await library.update({
		name: "test",
		metadata: { tags: null, input: { type: "number" } },
		expectedDigest: saved.digest,
	});
	expect(patched.tags).toEqual([]);
	expect(await readFile(join(root, "programs/test.js"), "utf8")).toContain(
		"throw Error('must not execute');\n" + source,
	);
	await expect(library.update({ name: "test", source, expectedDigest: saved.digest })).rejects.toMatchObject({
		code: "DIGEST_CONFLICT",
	});
	await expect(library.save({ name: "test", summary: "duplicate", source })).rejects.toMatchObject({
		code: "NAME_EXISTS",
	});
	await expect(library.update({ name: "test", source: "function (" })).rejects.toMatchObject({
		code: "PROGRAM_INVALID",
	});
	expect((await library.get("program", "test"))?.digest).toBe(patched.digest);
	await library.update({ name: "test", source });
	expect(await library.get("program", "test")).toMatchObject({ summary: null, source });
	expect((await readdir(join(root, "programs"))).filter((x) => x.endsWith(".tmp"))).toEqual([]);
});

test("bad headers remain discoverable and readable, full replacement repairs them", async () => {
	const { root, library } = await setup();
	await mkdir(join(root, "programs/nested"), { recursive: true });
	await writeFile(join(root, "programs/nested/bad.js"), "// uina {bad}\n" + source);
	expect(await library.list()).toMatchObject([{ name: "bad", headerError: expect.any(String) }]);
	expect(await library.get("program", "bad")).toMatchObject({
		source: "// uina {bad}\n" + source,
		headerError: expect.any(String),
	});
	await expect(library.loadProgram("bad")).rejects.toMatchObject({ code: "PROGRAM_INVALID" });
	await expect(library.update({ name: "bad", metadata: { summary: "discard old?" } })).rejects.toMatchObject({
		code: "HEADER_INVALID",
	});
	await library.update({ name: "bad", source });
	expect((await library.loadProgram("bad")).source).toBe(source);
	await writeFile(join(root, "programs/bad.js"), source);
	await expect(library.loadProgram("bad")).rejects.toMatchObject({ code: "PROGRAM_CONFLICT" });
	await expect(library.loadProgram("bad")).rejects.toMatchObject({ name: "CallFailure", source: "program" });
	await expect(library.loadProgram("../bad")).rejects.toMatchObject({ code: "SELECTOR_INVALID", source: "program" });
	expect(await library.list()).toMatchObject([
		{ name: "bad", headerError: expect.stringContaining("PROGRAM_CONFLICT") },
	]);
});

test("concurrent digest updates cannot overwrite each other; names and library escapes reject", async () => {
	const { library, root } = await setup();
	const saved = await library.save({ name: "same", summary: "v1", source });
	const results = await Promise.allSettled(
		["v2", "v3"].map((summary) =>
			library.update({ name: "same", metadata: { summary }, expectedDigest: saved.digest }),
		),
	);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { code: "DIGEST_CONFLICT" } }]);
	for (const name of ["../escape", "CON", "Upper", "a/b", "nul", "lpt1"])
		await expect(library.save({ name, summary: "x", source })).rejects.toMatchObject({ code: "NAME_INVALID" });
	const outside = await mkdtemp(join(tmpdir(), "uina-library-outside-"));
	await writeFile(join(outside, "escape.js"), source);
	await symlink(outside, join(root, "programs/linked"), "junction");
	await expect(library.loadProgram("escape")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("experience and blueprint CRUD keep raw bytes and same-kind identities separate", async () => {
	const { library, root } = await setup();
	await library.save({ name: "hut", summary: "program", source });
	await library.save({ kind: "experience", name: "hut", text: "No structured header.\r\n" });
	await expect(library.save({ kind: "blueprint", name: "hut", summary: "hut" })).rejects.toMatchObject({
		code: "BLUEPRINT_SOURCE_MISSING",
	});
	await mkdir(join(root, "blueprints/hut"), { recursive: true });
	const bytes = Buffer.from([0, 255, 1, 3]);
	await writeFile(join(root, "blueprints/hut/design.schem"), bytes);
	expect(await library.list({ kind: "blueprint" })).toMatchObject([{ name: "hut", summary: null }]);
	await library.save({ kind: "blueprint", name: "hut", summary: "raw only" });
	expect(await library.get("blueprint", "hut")).toMatchObject({ formatHint: "schem", size: 4 });
	await library.update({ kind: "blueprint", name: "hut", metadata: { tags: ["wood"] } });
	expect(await readFile(join(root, "blueprints/hut/design.schem"))).toEqual(bytes);
	await writeFile(join(root, "blueprints/hut/about.json"), "bad json");
	expect(await library.get("blueprint", "hut")).toMatchObject({ about: null, aboutError: expect.any(String), size: 4 });
	await writeFile(join(root, "blueprints/hut/design.nbt"), bytes);
	await expect(library.get("blueprint", "hut")).rejects.toMatchObject({ code: "BLUEPRINT_AMBIGUOUS" });
	await library.update({
		kind: "experience",
		name: "hut",
		metadata: { summary: "conditional judgment", applies: ["building"] },
	});
	expect(await library.get("experience", "hut")).toMatchObject({
		summary: "conditional judgment",
		header: { applies: ["building"] },
		text: expect.stringContaining("No structured header.\r\n"),
	});
	expect(await library.list()).toHaveLength(3);
	await library.delete("blueprint", "hut");
	expect(await library.get("blueprint", "hut")).toBeNull();
	expect(await library.get("program", "hut")).not.toBeNull();
});

test("header contracts, examples, BOM and exact body bytes survive file iteration", async () => {
	const { library, root } = await setup();
	const code = '\uFEFF// uina {"tags":["old"],"input":{"type":"number"},"examples":[{"input":2}]}\r\n' + source;
	await library.save({ name: "contract", summary: "keep contract", source: code });
	expect(await library.get("program", "contract")).toMatchObject({
		input: { type: "number" },
		tags: ["old"],
		examples: [{ input: 2 }],
		source: expect.stringContaining("\uFEFF// uina "),
	});
	expect((await readFile(join(root, "programs/contract.js"), "utf8")).endsWith(source)).toBe(true);
	await expect(library.update({ name: "contract", metadata: { examples: [{ input: "bad" }] } })).rejects.toMatchObject({
		code: "HEADER_INVALID",
	});
	await expect(
		library.save({ name: "duplicate", summary: "bad", source: "// uina {}\n// uina {}\n" + source }),
	).rejects.toMatchObject({ code: "HEADER_INVALID" });
	await expect(
		library.save({ name: "schema", summary: "bad", input: { type: "no-such-type" }, source }),
	).rejects.toMatchObject({ code: "HEADER_INVALID" });
	await library.save({ kind: "experience", name: "bad", text: "no header" });
	await writeFile(join(root, "experiences/bad.md"), "<!-- uina {broken} -->\nOriginal judgment");
	expect(await library.get("experience", "bad")).toMatchObject({
		headerError: expect.any(String),
		text: expect.stringContaining("Original judgment"),
	});
	await expect(library.update({ kind: "experience", name: "bad", metadata: { tags: ["x"] } })).rejects.toMatchObject({
		code: "HEADER_INVALID",
	});
	await library.update({ kind: "experience", name: "bad", text: "Repaired judgment" });
	expect(await library.get("experience", "bad")).toMatchObject({ header: null, text: "Repaired judgment" });
});

test("updates and deletion leave segment-fixed program material intact; new segments reload", async () => {
	const { library, program } = await setup();
	await library.save({ name: "fixed", summary: "old", source: "async function main(){return 1;}" });
	const signal = new AbortController().signal;
	const old = program.openSegment({ run: "run:fixed", segment: "segment:old", signal });
	try {
		const original = await old.resolve("fixed");
		await library.update({ name: "fixed", source: "async function main(){return 2;}" });
		expect((await old.resolve("fixed")).source).toBe(original.source);
		const next = program.openSegment({ run: "run:fixed", segment: "segment:new", signal });
		try {
			expect((await next.resolve("fixed")).source).toContain("return 2");
		} finally {
			await next.close("finished");
		}
		await library.delete("program", "fixed");
		expect((await old.resolve("fixed")).source).toBe(original.source);
		await expect(program.resolve({ name: "fixed" })).rejects.toMatchObject({ code: "PROGRAM_NOT_FOUND" });
	} finally {
		await old.close("finished");
	}
});

test("blueprint registration rejects a directory pretending to be a design file", async () => {
	const { library, root } = await setup();
	const path = join(root, "blueprints", "invalid");
	await mkdir(join(path, "design.schem"), { recursive: true });
	await expect(library.save({ kind: "blueprint", name: "invalid", summary: "not a raw file" })).rejects.toMatchObject({
		code: "BLUEPRINT_CORRUPT",
	});
	await expect(readFile(join(path, "about.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("ordinary comments sharing the uina prefix are not parsed or removed as metadata", async () => {
	const { library } = await setup();
	const code = "// uina-helper is an ordinary comment\n" + source;
	await library.save({ name: "commented", summary: "comment preserved", source: code });
	expect(await library.get("program", "commented")).toMatchObject({ source: expect.stringContaining(code) });
	await library.update({ name: "commented", metadata: { tags: ["comment"] } });
	expect((await library.loadProgram("commented")).source).toContain(code);
	const note = "<!-- uina-related notes are ordinary prose -->\nKeep this text";
	await library.save({ kind: "experience", name: "commented", text: note });
	await library.update({ kind: "experience", name: "commented", metadata: { summary: "note" } });
	expect(await library.get("experience", "commented")).toMatchObject({ text: expect.stringContaining(note) });
});

test("invalid saved fields reject updates and remain readable as diagnostics in working files", async () => {
	const { library, root } = await setup();
	const initial = await library.save({ name: "origin", summary: "valid", source });
	const invalid =
		'// uina {"saved":{"run":"r","segment":"s","call":"c","digest":"d","at":"a","extra":"hint"}}\n' + source;
	await expect(library.update({ name: "origin", source: invalid })).rejects.toMatchObject({ code: "HEADER_INVALID" });
	expect((await library.get("program", "origin"))?.digest).toBe(initial.digest);
	await writeFile(join(root, "programs/origin.js"), invalid);
	const detail = await library.get("program", "origin");
	expect(detail).toMatchObject({ source: invalid, headerError: expect.any(String) });
	expect(methods.get("library")!.output(detail)).toBe(true);
	await expect(library.loadProgram("origin")).rejects.toMatchObject({ code: "PROGRAM_INVALID", source: "program" });
});
