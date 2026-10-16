import { opendir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface FileItem {
	path: string;
	name: string;
	kind: "file" | "directory";
	score?: number;
}

export interface FileCandidateDirectoryEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
}

export type FileCandidateDirectoryReader = (directory: string) => AsyncIterable<FileCandidateDirectoryEntry>;

const CACHE_TTL_MS = 10_000;
const YIELD_EVERY_ENTRIES = 256;
const YIELD_EVERY_SORT_OPERATIONS = 1024;

const SKIP = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".DS_Store",
	"dist",
	".next",
	"build",
	"coverage",
	".gemini",
	".system_generated",
	"tmp",
	".turbo",
	// 本地过程/工具目录：不入候选（gitignored 或纯缓存），避免耗尽深扫描预算
	// 挤掉真实源码候选（2026-10-16 集成发现：.artifacts/.uina 增量使根 package.json
	// 落出 300+100 预算，@ 联想丢失根级文件）。
	".agents",
	".artifacts",
	".workbuddy",
	".pytest_cache",
	".VSCodeCounter",
]);
const BUILD_DIR = /^(?:build(?:[-_].*)?|cmake-build(?:[-_].*)?)$/i;
const pathSeparators = /[\\/]/;

const readDirectory: FileCandidateDirectoryReader = async function* (directory) {
	const handle = await opendir(directory);
	for await (const entry of handle) {
		yield {
			name: entry.name,
			isFile: entry.isFile(),
			isDirectory: entry.isDirectory(),
		};
	}
};

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function shouldYield(count: number): boolean {
	return count > 0 && count % YIELD_EVERY_ENTRIES === 0;
}

async function sortEntries<T>(entries: T[], compare: (left: T, right: T) => number): Promise<T[]> {
	if (entries.length < 2) return entries;

	let source = entries;
	let target = new Array<T>(entries.length);
	let operations = 0;
	for (let width = 1; width < entries.length; width *= 2) {
		for (let start = 0; start < entries.length; start += width * 2) {
			const middle = Math.min(start + width, entries.length);
			const end = Math.min(start + width * 2, entries.length);
			let left = start;
			let right = middle;
			let output = start;

			while (left < middle && right < end) {
				target[output++] = compare(source[left]!, source[right]!) <= 0 ? source[left++]! : source[right++]!;
				if (++operations % YIELD_EVERY_SORT_OPERATIONS === 0) await yieldToEventLoop();
			}
			while (left < middle) {
				target[output++] = source[left++]!;
				if (++operations % YIELD_EVERY_SORT_OPERATIONS === 0) await yieldToEventLoop();
			}
			while (right < end) {
				target[output++] = source[right++]!;
				if (++operations % YIELD_EVERY_SORT_OPERATIONS === 0) await yieldToEventLoop();
			}
		}
		[source, target] = [target, source];
	}
	return source;
}

class BestItems<T> {
	private readonly heap: T[] = [];

	constructor(
		private readonly limit: number,
		private readonly compare: (left: T, right: T) => number,
	) {}

	add(item: T): void {
		if (this.limit <= 0) return;
		if (this.heap.length < this.limit) {
			this.heap.push(item);
			this.bubbleUp(this.heap.length - 1);
			return;
		}

		if (this.compare(item, this.heap[0]!) >= 0) return;
		this.heap[0] = item;
		this.bubbleDown(0);
	}

	sorted(): T[] {
		return [...this.heap].sort(this.compare);
	}

	private bubbleUp(index: number): void {
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (this.compare(this.heap[parent]!, this.heap[index]!) >= 0) return;
			[this.heap[parent], this.heap[index]] = [this.heap[index]!, this.heap[parent]!];
			index = parent;
		}
	}

	private bubbleDown(index: number): void {
		while (true) {
			const left = index * 2 + 1;
			const right = left + 1;
			let worse = index;
			if (left < this.heap.length && this.compare(this.heap[left]!, this.heap[worse]!) > 0) worse = left;
			if (right < this.heap.length && this.compare(this.heap[right]!, this.heap[worse]!) > 0) worse = right;
			if (worse === index) return;
			[this.heap[index], this.heap[worse]] = [this.heap[worse]!, this.heap[index]!];
			index = worse;
		}
	}
}

function comparePath(left: FileItem, right: FileItem): number {
	return left.path.localeCompare(right.path);
}

function compareName(left: FileItem, right: FileItem): number {
	return left.name.localeCompare(right.name);
}

function compareRanked(query: string): (left: FileItem, right: FileItem) => number {
	const normalizedQuery = query.toLocaleLowerCase();
	return (left, right) => {
		const leftDirectFile = left.kind === "file" && left.name.toLocaleLowerCase().startsWith(normalizedQuery) ? 1 : 0;
		const rightDirectFile = right.kind === "file" && right.name.toLocaleLowerCase().startsWith(normalizedQuery) ? 1 : 0;
		return (
			rightDirectFile - leftDirectFile ||
			(right.score ?? 0) - (left.score ?? 0) ||
			left.kind.localeCompare(right.kind) ||
			left.path.localeCompare(right.path)
		);
	};
}

/** Fuzzy subsequence score used by file suggestions. */
export function fuzzySubsequenceScore(query: string, candidate: string): number | undefined {
	const needle = query.toLowerCase();
	const haystack = candidate.toLowerCase();
	if (!needle) return 0;

	let cursor = 0;
	let first = -1;
	let gaps = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, cursor);
		if (found === -1) return undefined;
		if (first === -1) first = found;
		gaps += found - cursor;
		cursor = found + 1;
	}

	const prefixBonus = first === 0 ? 25 : 0;
	const boundaryBonus = first > 0 && /[\\/_. -]/.test(haystack[first - 1] ?? "") ? 12 : 0;
	return needle.length * 10 + prefixBonus + boundaryBonus - gaps - haystack.length / 100;
}

/** Whether a query identifies a directory or absolute path instead of a global fuzzy search. */
export function isPathLikeQuery(query: string): boolean {
	return (
		query.startsWith(".") ||
		query.startsWith("~") ||
		query.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(query) ||
		pathSeparators.test(query)
	);
}

function rankedItem(candidate: FileItem, query: string): FileItem | undefined {
	const score = fuzzySubsequenceScore(query, `${candidate.path} ${candidate.name}`);
	return score === undefined ? undefined : { ...candidate, score };
}

function rankFileCandidates(candidates: FileItem[], query: string, topK: number): FileItem[] {
	if (!query) return candidates.slice(0, topK);
	const best = new BestItems<FileItem>(topK, compareRanked(query));
	for (const candidate of candidates) {
		const ranked = rankedItem(candidate, query);
		if (ranked) best.add(ranked);
	}
	return best.sorted();
}

async function readSharedDirectoryEntries(
	reader: FileCandidateDirectoryReader,
	directory: string,
	pendingReads: Map<string, Promise<FileCandidateDirectoryEntry[]>>,
): Promise<FileCandidateDirectoryEntry[]> {
	let scan = pendingReads.get(directory);
	if (!scan) {
		scan = (async () => {
			const entries: FileCandidateDirectoryEntry[] = [];
			let count = 0;
			for await (const entry of reader(directory)) {
				entries.push(entry);
				if (shouldYield(++count)) await yieldToEventLoop();
			}
			return entries;
		})();
		pendingReads.set(directory, scan);
	}

	try {
		return await scan;
	} finally {
		if (pendingReads.get(directory) === scan) pendingReads.delete(directory);
	}
}

async function listPathCandidates(
	reader: FileCandidateDirectoryReader,
	pendingReads: Map<string, Promise<FileCandidateDirectoryEntry[]>>,
	cwd: string,
	query: string,
	topK: number,
): Promise<FileItem[]> {
	const normalized = query.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	const bareDir = slash < 0 && (normalized === "." || normalized === ".." || normalized === "~");
	const directoryPart = slash < 0 ? (bareDir ? `${normalized}/` : "") : normalized.slice(0, slash + 1);
	const nameQuery = slash < 0 || bareDir ? "" : normalized.slice(slash + 1);

	let expanded = directoryPart;
	if (directoryPart === "~/" || directoryPart === "~") {
		expanded = `${os.homedir()}/`;
	} else if (directoryPart.startsWith("/") || /^[A-Za-z]:\//.test(directoryPart)) {
		expanded = directoryPart;
	} else {
		expanded = path.resolve(cwd, directoryPart || ".");
	}

	const comparator = nameQuery ? compareRanked(nameQuery) : compareName;
	const best = new BestItems<FileItem>(topK, comparator);
	try {
		const entries = await readSharedDirectoryEntries(reader, path.resolve(expanded), pendingReads);
		let count = 0;
		for (const entry of entries) {
			if (shouldYield(++count)) await yieldToEventLoop();
			if (
				(!entry.isFile && !entry.isDirectory) ||
				(SKIP.has(entry.name) && !nameQuery.startsWith(".") && !directoryPart.includes(entry.name))
			) {
				continue;
			}

			const isDirectory = entry.isDirectory;
			const candidate: FileItem = {
				path: `${directoryPart}${entry.name}${isDirectory ? "/" : ""}`,
				name: entry.name,
				kind: isDirectory ? "directory" : "file",
				score: 0,
			};
			const ranked = nameQuery ? rankedItem(candidate, nameQuery) : candidate;
			if (ranked) best.add(ranked);
		}
	} catch {
		return [];
	}
	return best.sorted();
}

interface DeepEntry {
	name: string;
	isDirectory: boolean;
}

interface DeepNode {
	directory: string;
	prefix: string;
	entries?: DeepEntry[];
	index: number;
}

export class FileCandidateSearcher {
	private cachedRoot = "";
	private cachedItems: FileItem[] | null = null;
	private cachedAt = 0;
	private readonly pendingDirectoryReads = new Map<string, Promise<FileCandidateDirectoryEntry[]>>();
	private readonly pendingDeepScans = new Map<string, Promise<FileItem[]>>();

	constructor(private readonly reader: FileCandidateDirectoryReader = readDirectory) {}

	async search(cwd: string, query: string, topK = 50): Promise<FileItem[]> {
		if (!query || isPathLikeQuery(query)) {
			return listPathCandidates(this.reader, this.pendingDirectoryReads, cwd, query, topK);
		}
		return rankFileCandidates(await this.deepCandidates(cwd), query, topK);
	}

	private async deepCandidates(root: string): Promise<FileItem[]> {
		if (this.cachedRoot === root && this.cachedItems && Date.now() - this.cachedAt < CACHE_TTL_MS) {
			return this.cachedItems;
		}
		const pending = this.pendingDeepScans.get(root);
		if (pending) return pending;

		const scan = this.scanDeepCandidates(root);
		this.pendingDeepScans.set(root, scan);
		try {
			const items = await scan;
			this.cachedRoot = root;
			this.cachedItems = items;
			this.cachedAt = Date.now();
			return items;
		} finally {
			if (this.pendingDeepScans.get(root) === scan) this.pendingDeepScans.delete(root);
		}
	}

	private async readSortedDirectory(directory: string): Promise<DeepEntry[]> {
		const entries: DeepEntry[] = [];
		let count = 0;
		for await (const entry of this.reader(directory)) {
			if (shouldYield(++count)) await yieldToEventLoop();
			if (SKIP.has(entry.name) || BUILD_DIR.test(entry.name)) continue;
			entries.push({ name: entry.name, isDirectory: entry.isDirectory });
		}
		return sortEntries(entries, (left, right) => left.name.localeCompare(right.name));
	}

	private async scanDeepCandidates(root: string): Promise<FileItem[]> {
		const out: FileItem[] = [];
		const queue: DeepNode[] = [{ directory: root, prefix: "", index: 0 }];
		const visited = new Set<string>();
		const maxFiles = 300;
		const maxDirectories = 100;
		let fileCount = 0;
		let dirCount = 0;
		let operations = 0;

		while (queue.length && (fileCount < maxFiles || dirCount < maxDirectories)) {
			const current = queue.shift()!;
			if (!current.entries) {
				try {
					if (visited.has(current.directory)) continue;
					visited.add(current.directory);
					current.entries = await this.readSortedDirectory(current.directory);
				} catch {
					continue;
				}
			}

			const entry = current.entries[current.index++];
			if (!entry) continue;
			if (current.index < current.entries.length) queue.push(current);

			const relativePath = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory) {
				if (dirCount < maxDirectories) {
					out.push({ path: `${relativePath}/`, name: entry.name, kind: "directory", score: 0 });
					dirCount++;
					queue.push({ directory: path.join(current.directory, entry.name), prefix: relativePath, index: 0 });
				}
			} else if (fileCount < maxFiles) {
				out.push({ path: relativePath, name: entry.name, kind: "file", score: 0 });
				fileCount++;
			}
			if (shouldYield(++operations)) await yieldToEventLoop();
		}

		return out.sort(comparePath);
	}
}

const defaultSearcher = new FileCandidateSearcher();

export function searchFileCandidates(cwd: string, query: string, topK = 50): Promise<FileItem[]> {
	return defaultSearcher.search(cwd, query, topK);
}
