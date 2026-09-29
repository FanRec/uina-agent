export interface LyricLine {
  readonly timeMs: number;
  readonly text: string;
}

export function parseLrc(raw: string): readonly LyricLine[] {
  const lines: LyricLine[] = [];
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const source of raw.split(/\r?\n/)) {
    timestamp.lastIndex = 0;
    const matches = [...source.matchAll(timestamp)];
    if (matches.length === 0) continue;
    const text = source.replace(timestamp, "").trim();
    if (!text) continue;
    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(match[3].padEnd(3, "0")) : 0;
      if (!Number.isSafeInteger(minutes) || seconds >= 60 || !Number.isFinite(fraction)) continue;
      lines.push({ timeMs: (minutes * 60 + seconds) * 1000 + fraction, text });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function formatLyrics(lines: readonly LyricLine[]): string {
  return lines.map((line) => line.text).join("\n");
}
