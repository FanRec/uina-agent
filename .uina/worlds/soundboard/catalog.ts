import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { MatchResult, SoundItem, SoundOverride } from "./types.js";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a"]);

/**
 * 扫描音效目录。
 *
 * 文件名即元数据：`<id>-<名称>.<ext>`，按**第一个** `-` 切分（名称里可以再有 `-`）。
 * 没有 `-` 时 id 与名称都取整个基名。目录不存在或读不了就返回空数组，
 * 由调用方决定怎么报告——"没有音效"和"目录坏了"在工具结果里是同一回事。
 */
export async function scanSounds(dir: string, overrides: Record<string, SoundOverride> = {}): Promise<SoundItem[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return [];

	const items: SoundItem[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const ext = extname(entry.name).toLowerCase();
		if (!AUDIO_EXTENSIONS.has(ext)) continue;

		const base = entry.name.slice(0, entry.name.length - ext.length).trim();
		const dash = base.indexOf("-");
		const id = (dash > 0 ? base.slice(0, dash) : base).trim().toLowerCase();
		if (!id) continue;

		const rawName = (dash > 0 ? base.slice(dash + 1) : base).trim();
		const override = overrides[id];
		const name = override?.name ?? rawName;
		items.push({
			id,
			filename: entry.name,
			filepath: join(dir, entry.name),
			name,
			aliases: uniqueWords([id, name, rawName, ...(override?.aliases ?? [])]),
			volumeOffset: override?.volumeOffset,
		});
	}

	return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 解一个用户/模型给的名字。四级确定性匹配，命中即返回，绝不猜：
 * 精确 id → 精确名称或别名 → 唯一子串 → 歧义 → 无。
 */
export function matchSounds(sounds: readonly SoundItem[], rawQuery: string): MatchResult {
	const query = rawQuery.trim().toLowerCase();
	if (!query) return { type: "none" };

	const byId = sounds.find((sound) => sound.id === query);
	if (byId) return { type: "match", sound: byId };

	const byWord = sounds.find((sound) => exactWords(sound).includes(query));
	if (byWord) return { type: "match", sound: byWord };

	const hits = sounds.filter((sound) => matches(sound, query));
	if (hits.length === 1) return { type: "match", sound: hits[0] };
	if (hits.length > 1) return { type: "ambiguous", candidates: hits };
	return { type: "none" };
}

/** list 的过滤：空查询原样返回，否则子串过滤。 */
export function filterSounds(sounds: readonly SoundItem[], rawQuery: string): SoundItem[] {
	const query = rawQuery.trim().toLowerCase();
	return query ? sounds.filter((sound) => matches(sound, query)) : [...sounds];
}

function matches(sound: SoundItem, query: string): boolean {
	return exactWords(sound).some((word) => word.includes(query));
}

function exactWords(sound: SoundItem): string[] {
	return [sound.id, sound.name, ...sound.aliases].map((word) => word.toLowerCase());
}

function uniqueWords(values: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const value of values) {
		const word = value.trim();
		if (word) seen.add(word);
	}
	return [...seen];
}
