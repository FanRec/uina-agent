#!/usr/bin/env node
/**
 * 一次性 Persona 迁移（S1 §3.2）：旧 persona.md → 唯一可编辑 system.md。
 *
 * 用法：node scripts/migrate-persona.mjs <subjectId> [--cwd <目录>]
 *
 * 规则（设计合同）：
 * - 只做显式迁移，不在正常启动或 Reload 中自动创建/修改文件；
 * - 只有 persona.md 而无 system.md 时：使用迁移时的现行主体 System 正文
 *   （工作区 .uina/system.md 优先，否则内置默认）加旧 Persona 生成 system.md，
 *   不复制 Event Frame 协议段（协议由运行时按投影策略附加，不属于主体段）；
 * - 已有 system.md：报告需要手工合并，绝不覆盖；
 * - 原 persona.md 保留为备份，新运行时不再读取；
 * - 迁移出的 system.md 是该主体主动选择的独立覆盖版本：以后内置默认 System
 *   更新不会暗中覆盖它。
 *
 * 退出码：0 成功 / 1 无事可做或配置错误 / 2 需要手工合并。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message, code = 1) {
	process.stderr.write(`[migrate-persona] ${message}\n`);
	process.exitCode = code;
}

const argv = process.argv.slice(2);
let subjectId;
let cwd = process.cwd();
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--cwd") {
		cwd = resolve(argv[++i] ?? ".");
		continue;
	}
	if (arg.startsWith("--cwd=")) {
		cwd = resolve(arg.slice("--cwd=".length));
		continue;
	}
	if (arg === "-h" || arg === "--help") {
		process.stdout.write("用法: node scripts/migrate-persona.mjs <subjectId> [--cwd <目录>]\n");
		process.exit(0);
	}
	if (!subjectId) subjectId = arg;
}

if (!subjectId || !/^[a-z0-9][a-z0-9-_]{0,63}$/.test(subjectId)) {
	fail(
		"需要合法的 subjectId（小写字母/数字/短横线/下划线，1-64 位）。用法: node scripts/migrate-persona.mjs <subjectId>",
	);
	process.exit(1);
}

const profileRoot = join(resolve(cwd), "profiles", subjectId);
if (!existsSync(profileRoot)) {
	fail(`主体目录不存在: ${profileRoot}`);
	process.exit(1);
}
const personaPath = join(profileRoot, "persona.md");
const systemPath = join(profileRoot, "system.md");

if (!existsSync(personaPath)) {
	process.stdout.write(`[migrate-persona] ${subjectId} 没有 persona.md，无需迁移。\n`);
	process.exit(0);
}

let personaText = "";
try {
	personaText = readFileSync(personaPath, "utf8")
		.replace(/^\uFEFF/, "")
		.trim();
} catch (error) {
	fail(`persona.md 不可读（${personaPath}）: ${error?.message ?? error}`);
	process.exit(1);
}
if (!personaText) {
	process.stdout.write(`[migrate-persona] persona.md 为空（${personaPath}），无需迁移。\n`);
	process.exit(0);
}

if (existsSync(systemPath)) {
	fail(
		`已存在 ${systemPath}：需要手工把 persona.md 的有效内容并入 system.md，本次迁移绝不覆盖。` +
			"确认合并完成后可手动删除或归档 persona.md。",
		2,
	);
	process.exit(2);
}

// 迁移时的现行主体 System 正文：工作区覆盖优先，否则内置默认（源码文件优先，
// 未构建时回退 dist 副本）。只取主体段，不复制 Event Frame 协议段。
const workspaceSystem = join(resolve(cwd), ".uina", "system.md");
let subjectSegment;
if (existsSync(workspaceSystem)) {
	subjectSegment = readFileSync(workspaceSystem, "utf8")
		.replace(/^\uFEFF/, "")
		.trim();
	process.stdout.write(`[migrate-persona] 主体 System 采用工作区覆盖: ${workspaceSystem}\n`);
} else {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const builtinPath = join(repoRoot, "src", "agent", "prompts", "system.md");
	const builtinDistPath = join(repoRoot, "dist", "src", "agent", "prompts", "system.md");
	const source = existsSync(builtinPath) ? builtinPath : builtinDistPath;
	if (!existsSync(source)) {
		fail(`内置默认 System 资源缺失: ${builtinPath}（未构建且源文件不存在）`);
		process.exit(1);
	}
	subjectSegment = readFileSync(source, "utf8")
		.replace(/^\uFEFF/, "")
		.trim();
	process.stdout.write(`[migrate-persona] 主体 System 采用内置默认: ${source}\n`);
}

const merged = `${subjectSegment}\n\n${personaText}\n`;
writeFileSync(systemPath, merged, "utf8");
process.stdout.write(
	`[migrate-persona] 已生成 ${systemPath}（现行主体 System + 旧 Persona）。` +
		`persona.md 保留为备份，新运行时不再读取。` +
		"注意：迁移出的 system.md 是该主体的独立覆盖版本，以后内置默认 System 更新不会暗中覆盖它。\n",
);
