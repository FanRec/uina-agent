import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Small, explicit import rules for the runtime layers.
 * Each rule lists roots plus a predicate; every violation is reported.
 */
const Q = "[\"']";
const rules = [
	{
		name: "runtime layers must not depend on extensions",
		roots: ["src/core", "src/runtime", "src/agent", "src/ai", "src/session", "src/tools"],
		test: (source) => importsSegment(source, "extensions") || /\bExtensionHost\b/.test(source),
	},
	{
		name: "session must not depend on agent",
		roots: ["src/session"],
		test: (source) => importsSegment(source, "agent"),
	},
];

const violations = [];
for (const rule of rules) {
	for (const root of rule.roots) {
		for await (const file of files(root)) {
			if (!file.endsWith(".ts")) continue;
			const source = stripComments(await readFile(file, "utf8"));
			if (rule.test(source)) violations.push(rule.name + ": " + file);
		}
	}
}

if (violations.length > 0) {
	throw new Error("runtime boundary violations:\n  " + violations.join("\n  "));
}

/** Match static, side-effect, dynamic and require() imports of a path segment. */
function importsSegment(source, segment) {
	const tail = "/" + segment + "(?:/|" + Q + ")";
	const pattern = new RegExp(
		"(?:from\\s*" + Q + "[^\"']*" + tail +
		"|import\\s*\\(\\s*" + Q + "[^\"']*" + tail +
		"|require\\(\\s*" + Q + "[^\"']*" + tail + ")",
	);
	return pattern.test(source);
}

/** Drop comment-only lines so prose cannot trip the rules. */
function stripComments(source) {
	return source
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
		})
		.join("\n");
}

async function* files(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else yield path;
	}
}
