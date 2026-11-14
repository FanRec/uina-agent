/**
 * Skill 发现与快照构建。
 *
 * 递归扫描目录：发现含 SKILL.md 的文件夹即作为一个 Skill，不把其附属树里的
 * Markdown 当作新 Skill；跳过 .git、node_modules 与隐藏目录；用真实路径识别
 * 重复与环。同名按来源优先级选择唯一胜出项，被遮蔽项进入冲突诊断。
 *
 * 所有解析、冲突处理从同一不可变 Snapshot 派生；单项无效只省略该项并诊断，
 * 不阻断其他有效 Skill。
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillFile } from "./parse.js";
import type { SkillDiagnostic, SkillEntry, SkillSnapshot, SkillSource } from "./types.js";

/** 递归扫描上界：防止异常目录树拖垮发现阶段。 */
const MAX_SCAN_DEPTH = 8;
const MAX_SKILLS_PER_SOURCE = 200;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

interface RawSkill {
	sourceId: string;
	directoryName: string;
	root: string;
	file: string;
	raw: string;
}

/** 快照形状与 SkillSnapshot 一致；generation 是占位（发布方以自己的内存代次重建）。 */
export interface LoadSnapshotResult {
	snapshot: SkillSnapshot;
}

/** 读取单个来源的全部候选 Skill（不解析，供冲突处理统一裁决）。 */
async function scanSource(source: SkillSource, sourceId: string, diagnostics: SkillDiagnostic[]): Promise<RawSkill[]> {
	const root = resolve(source.directory);
	let rootStat;
	try {
		rootStat = await stat(root);
	} catch {
		// 非必需目录缺失正常忽略；显式来源的不可用由装配方在诊断中说明。
		return [];
	}
	if (!rootStat.isDirectory()) {
		diagnostics.push({
			severity: "warning",
			code: "source-not-directory",
			message: `来源不是目录: ${root}`,
			path: root,
		});
		return [];
	}
	const found: RawSkill[] = [];
	await walk(root, 0, sourceId, diagnostics, found);
	return found;
}

async function walk(
	current: string,
	depth: number,
	sourceId: string,
	diagnostics: SkillDiagnostic[],
	found: RawSkill[],
): Promise<void> {
	if (depth > MAX_SCAN_DEPTH) {
		diagnostics.push({
			severity: "warning",
			code: "scan-depth-exceeded",
			message: `目录层级超过 ${MAX_SCAN_DEPTH}，停止下钻: ${current}`,
			path: current,
		});
		return;
	}
	if (found.length >= MAX_SKILLS_PER_SOURCE) return;
	let entries;
	try {
		entries = await readdir(current, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({
			severity: "warning",
			code: "source-unreadable",
			message: `目录不可读: ${String(error)}`,
			path: current,
		});
		return;
	}
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
		const full = join(current, entry.name);
		// stat 跟随符号链接/junction（Dirent 对 Windows junction 不报 isDirectory），
		// 真实路径由 realpath 统一识别重复与环。
		const target = await stat(full).catch(() => undefined);
		if (!target?.isDirectory()) continue;
		const skillFile = join(full, "SKILL.md");
		const skillStat = await stat(skillFile).catch(() => undefined);
		if (skillStat?.isFile()) {
			let realRoot: string;
			try {
				realRoot = await realpath(full);
			} catch (error) {
				diagnostics.push({
					severity: "warning",
					code: "realpath-failed",
					message: `无法解析真实路径: ${String(error)}`,
					path: full,
				});
				continue;
			}
			// 真实路径识别环与重复：同一真实目录只收一次。
			if (found.some((candidate) => candidate.root === realRoot)) continue;
			try {
				const raw = await readFile(skillFile, "utf8");
				found.push({
					sourceId,
					directoryName: entry.name,
					root: realRoot,
					file: skillFile,
					raw,
				});
			} catch (error) {
				diagnostics.push({
					severity: "error",
					code: "read-failed",
					message: `SKILL.md 不可读: ${String(error)}`,
					path: skillFile,
				});
			}
			continue;
		}
		// 没有 SKILL.md：继续下钻找子目录里的 Skill。
		await walk(full, depth + 1, sourceId, diagnostics, found);
	}
}

/**
 * 从来源列表构建一代快照。来源按 priority 升序（先声明者优先）处理；
 * 同级以规范化真实路径稳定排序；同名先到先得，被遮蔽项报告冲突。
 */
export async function loadSnapshot(sources: readonly SkillSource[]): Promise<LoadSnapshotResult> {
	const diagnostics: SkillDiagnostic[] = [];
	const ordered = [...sources].sort((a, b) => a.priority - b.priority);
	const raws: RawSkill[] = [];
	const seenSourceRoots = new Set<string>();
	for (const source of ordered) {
		let realDirectory: string;
		try {
			realDirectory = await realpath(source.directory);
		} catch {
			realDirectory = resolve(source.directory);
		}
		// 同一真实根重复声明只扫一次（去重保留最高优先级来源的身份）。
		if (seenSourceRoots.has(realDirectory)) continue;
		seenSourceRoots.add(realDirectory);
		const sourceId = `${source.ownerId}#${source.priority}`;
		raws.push(...(await scanSource(source, sourceId, diagnostics)));
	}

	const entries: SkillEntry[] = [];
	const byName = new Map<string, SkillEntry>();
	const byRoot = new Map<string, SkillEntry>();
	for (const raw of raws) {
		const parsed = parseSkillFile(raw.raw, raw.directoryName, raw.file);
		diagnostics.push(...parsed.diagnostics);
		if (!parsed.skill) continue;
		const skill = parsed.skill;
		const winner = byName.get(skill.name);
		if (winner) {
			diagnostics.push({
				severity: "warning",
				code: "name-shadowed",
				message: `同名 Skill "${skill.name}" 被遮蔽：来源 ${raw.sourceId}（${raw.file}）让位于 ${winner.sourceId}（${winner.file}）`,
				path: raw.file,
			});
			continue;
		}
		const duplicateRoot = byRoot.get(raw.root);
		if (duplicateRoot) {
			// 同一真实目录经两个来源/链接被扫描：真实文件去重，不重复发布。
			diagnostics.push({
				severity: "warning",
				code: "duplicate-root",
				message: `同一真实目录被重复发布为不同名称（${duplicateRoot.name} 优先，忽略 ${skill.name}）: ${raw.root}`,
				path: raw.file,
			});
			continue;
		}
		const entry: SkillEntry = {
			id: `${raw.sourceId}:${raw.root}`,
			name: skill.name,
			description: skill.description,
			root: raw.root,
			file: raw.file,
			sourceId: raw.sourceId,
			revision: skill.revision,
			body: skill.body,
			modelInvocable: skill.modelInvocable,
			userInvocable: skill.userInvocable,
			...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
			...(skill.argumentNames !== undefined ? { argumentNames: skill.argumentNames } : {}),
			...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
			...(skill.license !== undefined ? { license: skill.license } : {}),
			...(skill.compatibility !== undefined ? { compatibility: skill.compatibility } : {}),
			...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
			...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
		};
		entries.push(entry);
		byName.set(skill.name, entry);
		byRoot.set(raw.root, entry);
	}

	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return {
		snapshot: Object.freeze({
			generation: 0,
			entries: Object.freeze(entries),
			diagnostics: Object.freeze(diagnostics),
		}),
	};
}

/**
 * 从 cwd 到 Git 根之间的 `.agents/skills/` 层级：越靠近 cwd 越优先。
 * 不在 Git 仓库（祖先链上无 .git）时只返回 cwd 一层（设计 §4：不越出仓库边界）。
 * 返回按近→远排序的目录列表。
 */
export function agentsSkillAncestors(cwd: string, isGitRoot: (candidate: string) => boolean): string[] {
	// 先定位包含 cwd 的最近 Git 根；找不到（非 Git 目录）时边界就是 cwd 本身。
	let current = resolve(cwd);
	let boundary = current;
	for (;;) {
		if (isGitRoot(current)) {
			boundary = current;
			break;
		}
		const parent = resolve(current, "..");
		if (parent === current) break; // 文件系统根：无 Git 仓库
		current = parent;
	}
	const directories: string[] = [];
	current = resolve(cwd);
	for (;;) {
		directories.push(join(current, ".agents", "skills"));
		if (current === boundary) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	return directories;
}
