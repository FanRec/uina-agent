/**
 * 记忆端口：write / recall / use / correction 四行为的最小实现。
 *
 * 第一版后端：单文件 JSON（data/memory.json），进程重启后仍在。
 * recall 是关键词子串计分（大写不敏感）——当前模型规模的够用版本；
 * 换向量检索时只改本文件实现，接口不变。
 *
 * kind 区分：
 *  - fact     : remember 工具写入的经历（recall 只查这一类 + self）
 *  - self     : 关于主体自身的事实（同样可被 recall）
 *  - history  : 对话流水（自动落盘，供将来训练/复盘，不直接召回）
 * archived 标记废弃而非物理删除——correction 需要"可回看"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface MemItem {
	id: string;
	text: string;
	ts: string;
	kind: "fact" | "self" | "history";
	archived?: boolean;
}

export interface MemoryPort {
	load(): void;
	remember(text: string, kind: MemItem["kind"]): MemItem;
	recall(query: string, k: number): MemItem[];
	all(kind?: MemItem["kind"]): MemItem[];
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

		remember(text, kind) {
			const item: MemItem = {
				id: randomUUID().slice(0, 8),
				text,
				ts: new Date().toISOString(),
				kind,
			};
			items.push(item);
			persist();
			return item;
		},

		recall(query, k) {
			const q = query.toLowerCase();
			const scored: { m: MemItem; score: number }[] = [];
			for (const m of items) {
				if (m.archived || m.kind === "history") continue;
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

		all(kind) {
			return items.filter((m) => !kind || m.kind === kind);
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
