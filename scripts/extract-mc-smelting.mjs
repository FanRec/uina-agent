#!/usr/bin/env node
/**
 * 从 Paper 服务端 jar 抽取 minecraft:smelting 配方，写入
 * .uina/worlds/minecraft/driver/facts/smelting.ts 的生成段。
 *
 * 用法：node scripts/extract-mc-smelting.mjs <paper jar 路径>
 * 依赖：unzip（Git Bash / macOS / Linux 自带）。jar 不入库，故本脚本是唯一可复现路径。
 *
 * 只做 furnace 站别。blasting / smoking / campfire_cooking / stonecutting 不入表：
 * 能力的 station 与窗口布局都只到 furnace，多写就是用不上的数据。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), "../.uina/worlds/minecraft/driver/facts/smelting.ts");
const MARK_START = "// <generated>";
const MARK_END = "// </generated>";

const jar = process.argv[2];
if (!jar) {
	console.error("用法：node scripts/extract-mc-smelting.mjs <paper jar 路径>");
	process.exit(2);
}

// 一次解压整个 recipe 与 item tag 目录：逐文件 spawn unzip 会把 29MB 的 jar 读 70 多次。
const work = mkdtempSync(join(tmpdir(), "mc-recipe-"));
let files;
try {
	execFileSync("unzip", ["-o", "-q", jar, "data/minecraft/recipe/*", "data/minecraft/tags/item/*", "-d", work], {
		stdio: "pipe",
	});
	files = readdirSync(join(work, "data/minecraft/recipe")).filter((name) => name.endsWith(".json"));
} catch (error) {
	console.error(`解压 recipe 失败：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

const strip = (name) => String(name).replace(/^minecraft:/, "");

/** #tag → 物品名列表；支持嵌套标签，缺标签按空处理（不猜）。 */
const tagCache = new Map();
function expandTag(tag) {
	const name = strip(String(tag).replace(/^#/, ""));
	const cached = tagCache.get(name);
	if (cached != null) return cached;
	const path = join(work, "data/minecraft/tags/item", `${name}.json`);
	let values = [];
	try {
		values = JSON.parse(readFileSync(path, "utf8")).values ?? [];
	} catch {
		values = [];
	}
	tagCache.set(name, []);
	const out = [];
	for (const value of values) {
		const id = typeof value === "string" ? value : value?.id;
		if (typeof id !== "string") continue;
		if (id.startsWith("#")) out.push(...expandTag(id));
		else out.push(strip(id));
	}
	const unique = [...new Set(out)];
	tagCache.set(name, unique);
	return unique;
}

const rows = [];
for (const name of files.sort()) {
	const recipe = JSON.parse(readFileSync(join(work, "data/minecraft/recipe", name), "utf8"));
	if (recipe.type !== "minecraft:smelting") continue;
	const raw = Array.isArray(recipe.ingredient) ? recipe.ingredient : [recipe.ingredient];
	const inputs = raw.flatMap((entry) => {
		if (typeof entry !== "string") return [];
		return entry.startsWith("#") ? expandTag(entry) : [strip(entry)];
	});
	const result = recipe.result;
	if (inputs.length === 0 || result?.id == null) continue;
	rows.push({
		inputs,
		output: strip(result.id),
		count: typeof result.count === "number" ? result.count : 1,
		ticks: typeof recipe.cookingtime === "number" ? recipe.cookingtime : 200,
	});
}
rmSync(work, { recursive: true, force: true });

rows.sort((a, b) => a.output.localeCompare(b.output) || a.inputs[0].localeCompare(b.inputs[0]));

const body = rows
	.map(
		(row) =>
			`\t{ inputs: [${row.inputs.map((input) => JSON.stringify(input)).join(", ")}], output: ${JSON.stringify(row.output)}, count: ${row.count}, ticks: ${row.ticks} },`,
	)
	.join("\n");

const file = readFileSync(TARGET, "utf8");
const start = file.indexOf(MARK_START);
const end = file.indexOf(MARK_END);
if (start < 0 || end < 0) {
	console.error(`${TARGET} 缺少 ${MARK_START} / ${MARK_END} 标记`);
	process.exit(1);
}
writeFileSync(TARGET, `${file.slice(0, start + MARK_START.length)}\n${body}\n${file.slice(end)}`);
console.log(`写入 ${rows.length} 条 smelting 配方 → ${TARGET}`);
