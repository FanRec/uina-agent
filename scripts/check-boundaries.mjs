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
		"(?:from\\s*" +
			Q +
			"[^\"']*" +
			tail +
			"|import\\s*\\(\\s*" +
			Q +
			"[^\"']*" +
			tail +
			"|require\\(\\s*" +
			Q +
			"[^\"']*" +
			tail +
			")",
	).test(source);
}

/** Match an import path ending in `/ui/<not core>/...` — the UI implementation. */
function importsUiImplementation(source) {
	return new RegExp(
		"(?:from\\s*" +
			Q +
			"[^\"']*/ui/(?!core/)" +
			"|import\\s*\\(\\s*" +
			Q +
			"[^\"']*/ui/(?!core/)" +
			"|require\\(\\s*" +
			Q +
			"[^\"']*/ui/(?!core/))",
	).test(source);
}

/** Match any import form (static, dynamic, require) of the bare package `name`. */
function importsPackage(source, name) {
	const body = "(?:" + name + "(?:/[^\"']*)?)";
	return new RegExp(
		"(?:from\\s*" + Q + body + Q + "|import\\s*\\(\\s*" + Q + body + Q + "|require\\(\\s*" + Q + body + Q + ")",
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
	{
		// Subject Runtime P0 冻结：内核五目录只依赖彼此与 node 内置，
		// 宿主装配（host）、UI 实现（ui）与 AI 配置层（ai）一律不可达。
		name: "kernel must not depend on host, ui or ai config layers",
		roots: ["src/agent", "src/session", "src/core", "src/tools", "src/runtime"],
		test: (source) => ["host", "ui", "ai"].some((segment) => importsSegment(source, segment)),
	},
	{
		// 世界层禁止横向抓取系统扩展：World↔Extension 只经 expose 共享表交互，
		// 类型词汇一律取自 world-framework/seams。横向 import 会造成接缝双源漂移。
		name: "worlds must not import sibling system extensions",
		roots: [".uina/worlds"],
		test: (source) => /(\.\.\/)+extensions\//.test(source) || /\.uina\/extensions/.test(source),
	},
	{
		// live2d 重写世界的 src 依赖白名单：world-framework（契约与接缝词汇）与
		// src/tools/broker（ToolExecutionResult 结果形状）。agent/ai/ui/session/host/core/runtime
		// 一律不可达。其余既有世界不回溯约束。
		name: "live2d world may import src only via world-framework and broker result types",
		roots: [".uina/worlds/live2d"],
		test: (source) =>
			["/src/agent/", "/src/ai/", "/src/ui/", "/src/session/", "/src/host/", "/src/core/", "/src/runtime/"].some(
				(segment) => source.includes(segment),
			) ||
			(source.includes("/extensions/") && !source.includes("world-framework")),
	},
	{
		// modules/driver.md §3.1：原始 bot 只允许 Driver 边界内经审查的原生适配实现持有。
		// 若 Driver 其余子模块（或它的消费者）也能 import mineflayer，换客户端就只是口头约定；
		// vec3 同理（它是 mineflayer 的协议坐标类型，不是 Driver 的通用词汇）。
		name: "mineflayer and vec3 only inside the native adapter (driver/mineflayer)",
		roots: [".uina/worlds/minecraft"],
		test: (source, file) => {
			const path = String(file ?? "").replaceAll("\\", "/");
			if (path.includes("/driver/mineflayer/")) return false;
			return importsPackage(source, "mineflayer") || importsPackage(source, "vec3");
		},
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
	{
		rule: 5,
		bad: 'import { loadConfig } from "../ai/config.js";',
		good: 'import type { SessionStore } from "../session/types.js";',
	},
	{
		rule: 6,
		bad: 'import { BodyRouter } from "../../extensions/embodiment/body-router.js";',
		good: 'import type { BodyEndpoint } from "../../../src/extensions/world-framework/seams.js";',
	},
	{
		rule: 7,
		bad: 'import { Subject } from "../../../src/agent/loop.js";',
		good: 'import type { ToolExecutionResult } from "../../../src/tools/broker.js";',
	},
	{
		rule: 8,
		file: ".uina/worlds/minecraft/driver/index.ts",
		bad: 'import { createBot } from "mineflayer";',
		good: 'import type { PlayerPort } from "./contracts/body.js";',
	},
	{
		rule: 8,
		file: ".uina/worlds/minecraft/driver/mineflayer/adapter.ts",
		// 适配层内两种 import 都合法：这条样本只验证白名单在同一规则下真的放行。
		bad: 'import { createBot } from "mineflayer";',
		good: 'import vec3Module, { type Vec3 } from "vec3";',
		expectBad: false,
	},
];

function runSelfTest() {
	const failures = [];
	for (const sample of selfTestSamples) {
		const rule = rules[sample.rule];
		if (sample.expectBad !== false && !rule.test(sample.bad, sample.file)) {
			failures.push(`rule "${rule.name}" did not catch a violating sample`);
		}
		if (rule.test(sample.good, sample.file)) {
			failures.push(`rule "${rule.name}" rejected a legal sample`);
		}
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
				if (rule.test(source, file)) violations.push(rule.name + ": " + file);
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
