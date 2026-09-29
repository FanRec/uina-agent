import { readdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { SoundItem, SoundOverride, MatchResult } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a"]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描指定目录并解析所有合法音频文件为 SoundItem
 */
export async function scanSoundCatalog(
  dir: string,
  overrides: Record<string, SoundOverride> = {},
): Promise<SoundItem[]> {
  if (!(await pathExists(dir))) {
    return [];
  }

  const items: SoundItem[] = [];
  try {
    const dirEntries = await readdir(dir, { withFileTypes: true });

    for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const rawBase = basename(entry.name, ext);
      const dashIdx = rawBase.indexOf("-");

      let id = "";
      let desc = "";

      if (dashIdx > 0) {
        id = rawBase.slice(0, dashIdx).trim().toLowerCase();
        desc = rawBase.slice(dashIdx + 1).trim();
      } else {
        id = rawBase.trim().toLowerCase();
        desc = rawBase.trim();
      }

      if (!id) continue;

      const override = overrides[id];
      const name = override?.name ?? desc;
      const extraAliases = override?.aliases ?? [];
      const gainOffset = override?.gainOffset;

      const aliases = Array.from(
        new Set([id, name, desc, ...extraAliases].map((s) => s.trim()).filter(Boolean)),
      );

      items.push({
        id,
        filename: entry.name,
        filepath: join(dir, entry.name),
        name,
        description: desc,
        aliases,
        gainOffset,
      });
    }
  } catch {
    // 目录不可读时安全返回空数组
  }

  return items;
}

/**
 * 4 级确定性匹配流水线：
 * 1. 精确 ID 匹配
 * 2. 精确全名/别名匹配
 * 3. 唯一包含匹配
 * 4. 多重并列消歧
 */
export function matchSound(sounds: readonly SoundItem[], rawQuery: string): MatchResult {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return { type: "none" };
  }

  // Level 1: 精确 ID 匹配
  const exactId = sounds.find((s) => s.id === q);
  if (exactId) {
    return { type: "match", sound: exactId };
  }

  // Level 2: 精确全名/别名匹配
  const exactAlias = sounds.find(
    (s) =>
      s.name.toLowerCase() === q ||
      s.description.toLowerCase() === q ||
      s.aliases.some((a) => a.toLowerCase() === q),
  );
  if (exactAlias) {
    return { type: "match", sound: exactAlias };
  }

  // Level 3: 包含/子串匹配
  const matched = sounds.filter(
    (s) =>
      s.id.includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.aliases.some((a) => a.toLowerCase().includes(q)),
  );

  if (matched.length === 1) {
    return { type: "match", sound: matched[0] };
  }

  if (matched.length > 1) {
    return { type: "ambiguous", candidates: matched };
  }

  return { type: "none" };
}

export class SoundCatalog {
  private _sounds: SoundItem[] = [];

  async scan(dir: string, overrides: Record<string, SoundOverride> = {}): Promise<readonly SoundItem[]> {
    this._sounds = await scanSoundCatalog(dir, overrides);
    return this._sounds;
  }

  get sounds(): readonly SoundItem[] {
    return this._sounds;
  }

  get size(): number {
    return this._sounds.length;
  }

  get(id: string): SoundItem | undefined {
    return this._sounds.find((s) => s.id === id.toLowerCase());
  }

  match(query: string): MatchResult {
    return matchSound(this._sounds, query);
  }

  list(query?: string): readonly SoundItem[] {
    if (!query || !query.trim()) {
      return this._sounds;
    }
    const q = query.trim().toLowerCase();
    return this._sounds.filter(
      (s) =>
        s.id.includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }
}
