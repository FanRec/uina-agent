/**
 * 模型目录渲染：一条固定 Guidance 的正文。
 *
 * 全部模型可调用的 Skill 集中成 <available_skills>；统一说明只需一句：任务匹配
 * 描述时通过 read_skill 加载正文，再按需读取附属资源。不注入完整正文，不列绝对
 * 路径；名称、描述经 XML 转义。目录为空时不创建 Guidance。
 */

import type { SkillEntry, SkillSnapshot } from "./types.js";

/** 单条描述的长度上限：优先压缩冗长而低价值的描述，不突破目录预算。 */
const MAX_CATALOG_DESCRIPTION_LENGTH = 300;

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function catalogDescription(entry: SkillEntry): string {
	const parts = [entry.description];
	if (entry.whenToUse) parts.push(entry.whenToUse);
	const merged = parts.join("；适用条件：");
	if (merged.length <= MAX_CATALOG_DESCRIPTION_LENGTH) return merged;
	return `${merged.slice(0, MAX_CATALOG_DESCRIPTION_LENGTH - 1)}…`;
}

/** 模型可调用的条目才进入目录；仅手动调用的不出现。 */
function modelInvocableEntries(snapshot: SkillSnapshot): readonly SkillEntry[] {
	return snapshot.entries.filter((entry) => entry.modelInvocable);
}

/** 渲染 Catalog 正文；无模型可调用条目时返回空字符串（不创建空 Guidance）。 */
export function renderCatalog(snapshot: SkillSnapshot): string {
	const entries = modelInvocableEntries(snapshot);
	if (entries.length === 0) return "";
	const items = entries.map(
		(entry) =>
			`  <skill>\n    <name>${escapeXml(entry.name)}</name>\n    <description>${escapeXml(catalogDescription(entry))}</description>\n  </skill>`,
	);
	return [
		"<available_skills>",
		...items,
		"</available_skills>",
		"",
		"以上是当前可用的 Skill 索引。当某个任务与其中描述匹配时，先用 read_skill 加载该 Skill 的正文（再按需用 read_skill 的 resource 参数读取附属文件）；不相关的任务不要加载。",
	].join("\n");
}
