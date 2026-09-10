import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Small, explicit import rules for the runtime layers.
 * Each rule lists roots plus a predicate; every violation is reported.
 *
 * Layering (mirrors Pi): ui/core is a leaf of presentation primitives; the
 * extension contract lives in extensions/ and may only lean on that leaf;
 * extensions/ never reaches into the UI implementation.
 */
const Q = "['\"]";

/** Match any import form (static, dynamic, require) whose path contains `segment`. */
function importsSegment(source, segment) {
	const tail = "/" + segment + "(?:/|" + Q + ")";
	return new RegExp(
		"(?:from\\s*" + Q + "[^\"']*" + tail +
		"|import\\s*\\(\\s*" + Q + "[^\"']*" + tail +
		"|require\\(\\s*" + Q + "[^\"']*" + tail + ")",
	).test(source);
}

/** Match an import path ending in `/ui/<not core>/...` — the UI implementation. */
function importsUiImplementation(source) {
	return new RegExp(
		"(?:from\\s*" + Q + "[^\"']*/ui/(?!core/)" +
		"|import\\s*\\(\\s*" + Q + "[^\"']*/ui/(?!core/)" +
		"|require\\(\\s*" + Q + "[^\"']*/ui/(?!core/))",
	).test(source);
}

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
	{
		name: "UI core must stay a presentation leaf",
		roots: ["src/ui/core"],
		test: (source) =>
			["extensions", "agent", "ai", "session", "tools", "runtime", "cli"].some((segment) =>
				importsSegment(source, segment),
			),
	},
	{
		name: "extensions must not depend on the UI implementation (only ui/core)",
		roots: ["src/extensions"],
		test: (source) => importsUiImplementation(source),
	},
	{
		// 这一条是 RC-1 的结构保障：宿主拥有主体生命期，因此它不能认识任何 UI。
		// 一旦宿主 import 了 ui/，消费者分离就只是口头约定。
		name: "host must not depend on any UI module",
		roots: ["src/host"],
		test: (source) => importsSegment(source, "ui"),
	},
];

/**
 * Each rule is proven able to fail. A boundary check that has never rejected
 * anything is not evidence; these samples make that falsifiable.
 */
const selfTestSamples = [
	{
		rule: 0,
		bad: 'import { ExtensionRunner } from "../extensions/runner.js";',
		good: 'import { Subject } from "./loop.js";',
	},
	{
		rule: 1,
		bad: 'import { Subject } from "../agent/loop.js";',
		good: 'import type { SessionStore } from "./types.js";',
	},
	{
		rule: 2,
		bad: 'import { ExtensionRegistry } from "../../extensions/renderer-registry.js";',
		good: 'import { visibleWidth } from "./utils.js";',
	},
	{
		rule: 3,
		bad: 'import { UIHost } from "../ui/ui-host.js";',
		good: 'import type { Component } from "../ui/core/types.js";',
	},
	{
		rule: 4,
		bad: 'import { UIHost } from "../ui/ui-host.js";',
		good: 'import type { HostEvent } from "./events.js";',
	},
];

function runSelfTest() {
	const failures = [];
	for (const sample of selfTestSamples) {
		const rule = rules[sample.rule];
		if (!rule.test(sample.bad)) failures.push(`rule "${rule.name}" did not catch a violating sample`);
		if (rule.test(sample.good)) failures.push(`rule "${rule.name}" rejected a legal sample`);
	}
	if (failures.length > 0) throw new Error("boundary rule self-test failed:\n  " + failures.join("\n  "));
	console.log(`boundary rule self-test ok (${rules.length} rules, ${selfTestSamples.length} samples)`);
}

async function main() {
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
	console.log("boundary check ok: " + rules.length + " rules");
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

if (process.argv.includes("--selftest")) {
	runSelfTest();
} else {
	await main();
}
