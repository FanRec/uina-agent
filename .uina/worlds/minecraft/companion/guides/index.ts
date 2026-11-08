/**
 * 官方只读 Guide 注册表。
 *
 * 边界：随版本发布、包内静态资源、只读；不是 Library 资产，不写用户 Experience，
 * 不参与 run 选择，永远 callable:false。按需检索（query）只吃这里的小摘要，
 * 精确读取（kind:'guide'）才加载正文并缓存，避免每回合重复读盘。
 *
 * 文件必须与本模块同目录一起打包（scripts/copy-assets.mjs），不使用开发目录绝对路径。
 */
import { readFile } from "node:fs/promises";

export interface GuideEntry {
	readonly name: string;
	readonly summary: string;
	readonly tags: readonly string[];
	readonly file: string;
}

/** name 稳定、不带版本后缀；正文正确性由 tests/mc/mc-guide-examples.test.ts 校验。 */
export const GUIDES: readonly GuideEntry[] = Object.freeze([
	{
		name: "program_api",
		summary: "mc.call/read/waitUntil/progress/decide 的真实返回形状、受理与完成、检查点与续段",
		tags: ["program", "api", "contract", "decide"],
		file: "program_api.md",
	},
	{
		name: "body_api",
		summary: "mc.withBody、同步 feedback step、Window unknown 与控制资格退场",
		tags: ["body", "api", "window", "control"],
		file: "body_api.md",
	},
	{
		name: "mining_playbook",
		summary: "资源目标、collect/tunnel/mine/explore 的选择、库存差额与返程终验",
		tags: ["mining", "resource", "collect", "playbook"],
		file: "mining_playbook.md",
	},
	{
		name: "building_playbook",
		summary: "先 build.plan 预检、材料与冲突、部分完成、按世界状态验收",
		tags: ["building", "plan", "materials", "playbook"],
		file: "building_playbook.md",
	},
	{
		name: "survival_playbook",
		summary: "紧急换气、回到地表、返回家三种判据；危险预防与 Safety 分工",
		tags: ["survival", "safety", "surface", "playbook"],
		file: "survival_playbook.md",
	},
	{
		name: "recovery_playbook",
		summary: "UNKNOWN / INTERRUPTED / Stop / checkpoint / 异步 Completion 的处理边界",
		tags: ["recovery", "unknown", "interrupted", "checkpoint", "playbook"],
		file: "recovery_playbook.md",
	},
]);

export function guideSummaries(): readonly GuideEntry[] {
	return GUIDES;
}

export function findGuide(name: string): GuideEntry | null {
	return GUIDES.find((guide) => guide.name === name) ?? null;
}

const cached = new Map<string, Promise<string>>();

/** 精确读取正文；失败不留在缓存里，避免一次坏打包永久变成空文档。 */
export async function readGuide(name: string): Promise<string | null> {
	const entry = findGuide(name);
	if (!entry) return null;
	let pending = cached.get(name);
	if (!pending) {
		pending = readFile(new URL(entry.file, import.meta.url), "utf8");
		cached.set(name, pending);
		void pending.catch(() => cached.delete(name));
	}
	return pending;
}
