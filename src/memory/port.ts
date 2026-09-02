/**
 * 记忆端口：write / recall / correction 三行为的最小实现。
 *
 * 第一版后端：单文件 JSON（data/memory.json），进程重启后仍在。
 * recall 是关键词子串计分（大小写不敏感）——当前模型规模的够用版本；
 * 换向量检索时只改本文件实现，接口不变。
 *
 * archived 标记废弃而非物理删除——correction 需要"可回看"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface MemItem {
	id: string;
	text: string;
	ts: string;
	archived?: boolean;
}

export interface MemoryPort {
	load(): void;
	remember(text: string): MemItem;
	recall(query: string, k: number): MemItem[];
	archive(id: string): boolean;
}

export function createFileMemory(dir: string): MemoryPort {
	const file = join(dir, "memory.json");
	let items: MemItem[] = [];

	const persist = (): void => {
		writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
	};

	return {
		load() {
			if (existsSync(file)) {
				try {
					items = JSON.parse(readFileSync(file, "utf8")) as MemItem[];
				} catch {
					items = []; // 文件损坏时从空开始，不阻塞启动
				}
			} else {
				mkdirSync(dir, { recursive: true });
				persist();
			}
		},

		remember(text) {
			const item: MemItem = {
				id: randomUUID().slice(0, 8),
				text,
				ts: new Date().toISOString(),
			};
			items.push(item);
			persist();
			return item;
		},

		recall(query, k) {
			const q = query.toLowerCase();
			const scored: { m: MemItem; score: number }[] = [];
			for (const m of items) {
				if (m.archived) continue;
				const t = m.text.toLowerCase();
				let score = 0;
				for (const word of q.split(/\s+/).filter((w) => w.length > 1)) {
					if (t.includes(word)) score += word.length;
				}
				if (score > 0) scored.push({ m, score });
			}
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, k).map((x) => x.m);
		},

		archive(id) {
			const it = items.find((m) => m.id === id);
			if (!it) return false;
			it.archived = true;
			persist();
			return true;
		},
	};
}