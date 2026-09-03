import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src/core", "src/runtime", "src/agent", "src/ai", "src/session", "src/tools"];
const forbidden = /(?:from\s+["'][^"']*\/extensions\/|import\s*\(["'][^"']*\/extensions\/|\bExtensionHost\b|\bextensionHost\b)/;

for (const root of roots) {
	for await (const file of files(root)) {
		if (!file.endsWith(".ts")) continue;
		const source = await readFile(file, "utf8");
		if (forbidden.test(source)) throw new Error(`runtime boundary violation: ${file} depends on extensions`);
	}
}

async function* files(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else yield path;
	}
}
