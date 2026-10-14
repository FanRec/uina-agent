import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FileCandidateDirectoryEntry,
	type FileCandidateDirectoryReader,
	FileCandidateSearcher,
} from "../src/ui/components/editor/file-candidates.js";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "uina-file-candidates-"));
	roots.push(root);
	return root;
}

function file(name: string): FileCandidateDirectoryEntry {
	return { name, isFile: true, isDirectory: false };
}

function directory(name: string): FileCandidateDirectoryEntry {
	return { name, isFile: false, isDirectory: true };
}

describe("FileCandidateSearcher", () => {
	it("preserves name ordering when listing the root with a limited result count", async () => {
		const searcher = new FileCandidateSearcher(async function* () {
			yield file("a.txt");
			yield directory("a");
		});

		const results = await searcher.search("workspace", "", 1);

		expect(results.map((item) => item.path)).toEqual(["a/"]);
	});

	it("keeps path completion, fuzzy ranking, and ignored-directory behavior", async () => {
		const cwd = await temporaryDirectory();
		await mkdir(join(cwd, "src", "components"), { recursive: true });
		await mkdir(join(cwd, "node_modules"), { recursive: true });
		await writeFile(join(cwd, "ui.ts"), "");
		await writeFile(join(cwd, "src", "ui-host.ts"), "");
		await writeFile(join(cwd, "src", "components", "ui-button.ts"), "");
		await writeFile(join(cwd, "node_modules", "ui-dependency.ts"), "");

		const searcher = new FileCandidateSearcher();
		const rootItems = await searcher.search(cwd, "");
		const fuzzyItems = await searcher.search(cwd, "ui");
		const pathItems = await searcher.search(cwd, "src/ui");

		expect(rootItems.map((item) => item.path)).toContain("src/");
		expect(rootItems.map((item) => item.path)).not.toContain("node_modules/");
		expect(fuzzyItems[0]?.path).toBe("ui.ts");
		expect(fuzzyItems.map((item) => item.path)).toContain("src/components/ui-button.ts");
		expect(fuzzyItems.some((item) => item.path.includes("node_modules"))).toBe(false);
		expect(pathItems.map((item) => item.path)).toEqual(["src/ui-host.ts"]);
	});

	it("coalesces concurrent deep scans for the same working directory", async () => {
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const readerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let reads = 0;
		const reader: FileCandidateDirectoryReader = async function* () {
			reads++;
			started();
			await gate;
			yield file("ui.ts");
		};
		const searcher = new FileCandidateSearcher(reader);

		const first = searcher.search("workspace", "ui");
		await readerStarted;
		const second = searcher.search("workspace", "host");
		release();
		const [firstResults, secondResults] = await Promise.all([first, second]);

		expect(reads).toBe(1);
		expect(firstResults.map((item) => item.path)).toEqual(["ui.ts"]);
		expect(secondResults.map((item) => item.path)).toEqual([]);
	});

	it("coalesces concurrent path queries that enumerate the same directory", async () => {
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const readerStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let reads = 0;
		const reader: FileCandidateDirectoryReader = async function* () {
			reads++;
			started();
			await gate;
			yield file("alpha.ts");
			yield file("about.ts");
		};
		const searcher = new FileCandidateSearcher(reader);

		const first = searcher.search("workspace", "src/a");
		await readerStarted;
		const second = searcher.search("workspace", "src/ab");
		release();
		const [firstResults, secondResults] = await Promise.all([first, second]);

		expect(reads).toBe(1);
		expect(firstResults.map((item) => item.path)).toContain("src/alpha.ts");
		expect(firstResults.map((item) => item.path)).toContain("src/about.ts");
		expect(secondResults.map((item) => item.path)).toEqual(["src/about.ts"]);
	});

	it("refreshes the cached deep index after ten seconds", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		let currentName = "alpha.ts";
		let reads = 0;
		const reader: FileCandidateDirectoryReader = async function* () {
			reads++;
			yield file(currentName);
		};
		const searcher = new FileCandidateSearcher(reader);

		expect((await searcher.search("workspace", "alpha")).map((item) => item.path)).toEqual(["alpha.ts"]);
		currentName = "beta.ts";
		now.mockReturnValue(10_999);
		expect(await searcher.search("workspace", "beta")).toEqual([]);
		now.mockReturnValue(11_001);
		expect((await searcher.search("workspace", "beta")).map((item) => item.path)).toEqual(["beta.ts"]);
		expect(reads).toBe(2);
	});

	it("keeps the existing three-hundred-file fuzzy candidate quota", async () => {
		const reader: FileCandidateDirectoryReader = async function* () {
			for (let index = 0; index < 350; index++) {
				yield file(`file-${String(index).padStart(3, "0")}.ts`);
			}
		};
		const searcher = new FileCandidateSearcher(reader);

		const results = await searcher.search("workspace", "file", 500);
		expect(results).toHaveLength(300);
		expect(results.at(-1)?.path).toBe("file-299.ts");
	});

	it("keeps the existing one-hundred-directory fuzzy candidate quota", async () => {
		const reader: FileCandidateDirectoryReader = async function* (directoryPath) {
			if (directoryPath !== "workspace") return;
			for (let index = 0; index < 120; index++) {
				yield directory(`dir-${String(index).padStart(3, "0")}`);
			}
		};
		const searcher = new FileCandidateSearcher(reader);

		const results = await searcher.search("workspace", "dir", 200);

		expect(results).toHaveLength(100);
		expect(results.at(-1)?.path).toBe("dir-099/");
	});

	it("yields during a long batch of ignored directory entries", async () => {
		const reader: FileCandidateDirectoryReader = async function* () {
			for (let index = 0; index < 300; index++) {
				yield directory(`build-${index}`);
			}
		};
		const searcher = new FileCandidateSearcher(reader);
		let completed = false;
		const search = searcher.search("workspace", "needle").then((results) => {
			completed = true;
			return results;
		});

		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(completed).toBe(false);
		expect(await search).toEqual([]);
	});

	it("returns no candidates when a directory cannot be read", async () => {
		const searcher = new FileCandidateSearcher(async function* () {
			throw new Error("unreadable");
		});

		expect(await searcher.search("workspace", "missing")).toEqual([]);
	});
});
