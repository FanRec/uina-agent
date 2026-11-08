/**
 * Minecraft 状态帧：模型请求前的瞬态观察正文（批37 取代 G6 周期 digest 推送）。
 *
 * 唯一定义来源：docs/proposals/mc/known-gaps.md §4 G6。
 * 与 observe 同口径——self / inventory / world 三段复用 self@1 / inventory@1 / world@1 的
 * 读取器，同一 facts.sample 提交边界采样，不建第二套事实提取（经验 48）。
 *
 * 这里只有采样与文本投影：没有定时器、没有订阅、没有哈希去重、不落历史、不发消息。
 * 状态不是待办事项，旧坐标与旧背包没有排队等模型处理的价值；模型每次决策前读一份
 * 当前快照即可（WorldDef.requestContext → turn.transformContext tail 帧）。
 */

import type { QueryReader } from "../contracts/capabilities.js";
import type { ClientFactsPort, ClientFactView } from "../contracts/client-facts.js";

/** 背包列出上限：超出只报种类数与剩余项，不把整包塞进每次请求。 */
const INVENTORY_LIMIT = 10;

/** 状态帧只吃 current 读取器（同一 facts.sample 提交边界）；static 读取器不依赖视图。 */
export type CurrentReader = Extract<QueryReader, { kind: "current" }>;

export interface StateFrameOptions {
	facts: Pick<ClientFactsPort, "sample">;
	readers: { self: CurrentReader; inventory: CurrentReader; world: CurrentReader };
}

export interface StateFrame {
	/** 面向模型的单帧正文；connected=false 时是明确的不可用说明。 */
	text: string;
	sampledAt: string;
	connected: boolean;
	/** 整段读不到的段落（诊断用）。字段级覆盖由 observe 负责，不在这里重复报告。 */
	unknown: string[];
}

/** 段落读取：抛错按该段缺失如实降级，不让一段失败拖垮整帧。 */
function section(
	reader: CurrentReader,
	view: ClientFactView,
	label: string,
	failed: string[],
): Record<string, unknown> | null {
	try {
		const fact = reader.read(view, {}) as { value: unknown };
		return fact.value == null ? null : (fact.value as Record<string, unknown>);
	} catch (error) {
		failed.push(label);
		return null;
	}
}

/** 站位取整用 floor：全世界的方块坐标都是这么算的（脚下那一格），四舍五入会指到隔壁方块。 */
function positionText(place: unknown): string | null {
	const p = (place as { position?: { x?: number; y?: number; z?: number } } | undefined)?.position;
	if (p == null || typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return null;
	return `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;
}

function dimensionText(place: unknown): string | null {
	const dimension = (place as { dimension?: unknown } | undefined)?.dimension;
	return typeof dimension === "string" ? dimension.replace(/^minecraft:/, "") : null;
}

/**
 * 生命/饥饿：null = 本帧没读到。这里显式说"未知"而不是省略——省略会被读成满血，
 * 而"没收到生命值"恰恰是最需要模型去确认的时候（0 更不能填，那会被读成已死）。
 */
function vitalsText(self: Record<string, unknown> | null): string[] {
	if (self == null) return [];
	const parts: string[] = [];
	const health = self.health;
	const maxHealth = self.maxHealth;
	if (typeof health === "number") parts.push(`生命${health}${typeof maxHealth === "number" ? `/${maxHealth}` : ""}`);
	else if (health === null) parts.push("生命未知");
	const food = self.food;
	if (typeof food === "number") parts.push(`饥饿${food}/20`);
	else if (food === null) parts.push("饥饿未知");
	if (self.inLava === true) parts.push("在岩浆里");
	else if (self.inWater === true) parts.push(`在水里${typeof self.oxygen === "number" ? `(氧${self.oxygen})` : ""}`);
	else if (self.onGround === true) parts.push("在地面");
	else if (self.onGround === false) {
		// 刚连上时物理还没跑第一拍：onGround 是 false 但人站在地上。只有真在下落才说，
		// 否则模型会照着"悬在空中"解释一件没发生的事（真模型第一轮就这么说过）。
		const falling = (self.velocity as { y?: number } | null | undefined)?.y;
		if (typeof falling === "number" && falling < 0) parts.push("在下落");
	}
	const held = self.held as { name?: unknown; count?: unknown } | undefined;
	if (typeof held?.name === "string") parts.push(`手持${held.name}×${typeof held.count === "number" ? held.count : 1}`);
	return parts;
}

function worldText(world: Record<string, unknown> | null): string | null {
	if (world == null) return null;
	const parts: string[] = [];
	if (typeof world.timeOfDay === "string")
		parts.push(typeof world.dayCount === "number" ? `${world.timeOfDay}·第${world.dayCount}天` : world.timeOfDay);
	if (typeof world.weather === "string") parts.push(world.weather);
	if (typeof world.biome === "string") parts.push(world.biome);
	return parts.length > 0 ? parts.join("·") : null;
}

function inventoryText(inventory: Record<string, unknown> | null): string | null {
	if (inventory == null) return null;
	const counts = inventory.counts as Record<string, number> | undefined;
	const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const free = typeof inventory.freeSlots === "number" ? inventory.freeSlots : null;
	if (entries.length === 0) return `背包：空${free == null ? "" : `（${free}格全空）`}`;
	const head = entries.slice(0, INVENTORY_LIMIT).map(([name, count]) => `${name}×${count}`);
	const folded = entries.length - head.length;
	const used = typeof inventory.usedSlots === "number" ? `/${inventory.usedSlots}格` : "";
	return `背包${entries.length}种${used}${free == null ? "" : ` 空${free}格`}：${head.join(" ")}${folded > 0 ? ` …+${folded}种` : ""}`;
}

function buildText(options: StateFrameOptions, view: ClientFactView, failed: string[]): string {
	const self = section(options.readers.self, view, "self", failed);
	const inventory = section(options.readers.inventory, view, "inventory", failed);
	const world = section(options.readers.world, view, "world", failed);
	const lines: string[] = [];
	const head: string[] = [];
	const dimension = dimensionText(self?.place);
	if (dimension) head.push(dimension);
	const position = positionText(self?.place);
	if (position) head.push(position);
	head.push(...vitalsText(self));
	if (head.length > 0) lines.push(head.join(" "));
	const environment = worldText(world);
	if (environment) lines.push(environment);
	const bag = inventoryText(inventory);
	if (bag) lines.push(bag);
	// 段落整段读不到必须说出来：留空会让模型以为"那里什么都没有"。
	if (lines.length === 0) lines.push(`Minecraft 状态不可读（缺失段落：${failed.join("、") || "全部"}）`);
	return lines.join("\n");
}

/**
 * 采样一份当前状态帧。未附着活连接时返回 connected=false 的明确文本：
 * 断线后继续沿用旧坐标是伪造观察，比不给状态更糟。
 */
export function sampleStateFrame(options: StateFrameOptions): StateFrame {
	const sampledAt = new Date().toISOString();
	const failed: string[] = [];
	let text: string;
	try {
		text = options.facts.sample((view) => buildText(options, view, failed)).value;
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		const message = error instanceof Error ? error.message : String(error);
		return {
			text:
				code === "WRONG_STATE"
					? "Minecraft 未连接：当前没有可用的世界观察；连接建立前不要按旧坐标或旧背包行动。"
					: `Minecraft 状态不可用：${message}`,
			sampledAt,
			connected: false,
			unknown: [message],
		};
	}
	return { text, sampledAt, connected: true, unknown: failed };
}
