/**
 * G6 周期性状态摘要（节流 digest 推送）。
 *
 * 唯一定义来源：docs/proposals/mc/known-gaps.md §4 G6。
 * 模型不主动 read 就不知道世界在变；这里按查询依赖生成 digest——三个段落直接复用
 * self@1 / inventory@1 / world@1 的现有读取器，同一 facts.sample 提交边界采样，
 * 与 observe 口径一致，不建第二套事实提取。有变化才生成（规范化 JSON 哈希去重，
 * 同一份不重复）、默认 10s 前缘节流、facts reset 后即使内容相同也补发一份。
 * digest 是 ephemeral 推送：不落 world-history.db、不进 events@1，经 executor
 * 事件管道上行后以独立事件类型 minecraft_digest 交付（executor/delivery.ts）。
 */

import { createHash } from "node:crypto";
import type { QueryReader } from "../contracts/capabilities.js";
import type { ClientFactsPort, ClientFactView } from "../contracts/client-facts.js";
import type { JsonValue } from "../contracts/values.js";
import { canonical } from "./watch.js";

/** 集中策略值（DECISIONS：不新增配置面）：两次 digest 之间的最小间隔。 */
export const DIGEST_INTERVAL_MS = 10_000;

/** digest 只吃 current 读取器（同一 facts.sample 提交边界）；static 读取器不依赖视图。 */
export type CurrentReader = Extract<QueryReader, { kind: "current" }>;

export interface DigestPushOptions {
	facts: Pick<ClientFactsPort, "sample" | "subscribe">;
	readers: { self: CurrentReader; inventory: CurrentReader; world: CurrentReader };
	/** 上行出口（组合根注入 ref 发号与 onGameEvent 转发）。 */
	emit: (digest: { observedAt: string; payload: JsonValue }) => void;
}

export interface DigestPush {
	close(): void;
}

/** digest 段落：读取器抛错按该段 unknown 如实降级，不让一段失败拖垮整份摘要。 */
function section(reader: CurrentReader, view: ClientFactView, label: string, unknown: string[]): JsonValue | null {
	try {
		const fact = reader.read(view, {}) as { value: unknown; unknown?: string[] };
		for (const note of fact.unknown ?? []) unknown.push(`${label}: ${note}`);
		if (fact.value == null) return null;
		return fact.value as JsonValue;
	} catch (error) {
		unknown.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function buildDigest(options: DigestPushOptions, view: ClientFactView): JsonValue {
	const unknown: string[] = [];
	const self = section(options.readers.self, view, "self", unknown) as {
		place?: { dimension?: string; position?: { x: number; y: number; z: number } };
		health?: number | null;
		food?: number | null;
		onGround?: boolean | null;
		held?: { name: string; count: number } | null;
	} | null;
	const inventory = section(options.readers.inventory, view, "inventory", unknown) as {
		revision?: number;
		counts?: Record<string, number>;
		usedSlots?: number;
		freeSlots?: number;
	} | null;
	const world = section(options.readers.world, view, "world", unknown) as {
		timeOfDay?: string | null;
		dayCount?: number | null;
		weather?: string | null;
		biome?: string | null;
	} | null;
	const payload: JsonValue = {
		kind: "digest",
		self:
			self == null
				? null
				: {
						...(self.place?.dimension != null ? { dimension: self.place.dimension } : {}),
						...(self.place?.position != null
							? {
									position: {
										x: Math.round(self.place.position.x),
										y: Math.round(self.place.position.y),
										z: Math.round(self.place.position.z),
									},
								}
							: {}),
						...(self.health != null ? { health: self.health } : {}),
						...(self.food != null ? { food: self.food } : {}),
						...(self.onGround != null ? { onGround: self.onGround } : {}),
						...(self.held != null ? { held: { name: self.held.name, count: self.held.count } } : {}),
					},
		inventory:
			inventory == null
				? null
				: {
						...(inventory.revision != null ? { revision: inventory.revision } : {}),
						...(inventory.counts != null ? { counts: inventory.counts } : {}),
						...(inventory.usedSlots != null ? { usedSlots: inventory.usedSlots } : {}),
						...(inventory.freeSlots != null ? { freeSlots: inventory.freeSlots } : {}),
					},
		world:
			world == null
				? null
				: {
						// 时间只取粗粒度相位与天数：ticks 连续变化会让去重永远失效。
						...(world.timeOfDay != null ? { timeOfDay: world.timeOfDay } : {}),
						...(world.dayCount != null ? { dayCount: world.dayCount } : {}),
						...(world.weather != null ? { weather: world.weather } : {}),
						...(world.biome != null ? { biome: world.biome } : {}),
					},
		...(unknown.length > 0 ? { unknown } : {}),
	};
	return payload;
}

export function startDigestPush(options: DigestPushOptions): DigestPush {
	const state = {
		closed: false,
		dirty: false,
		lastHash: null as string | null,
		lastEmitAt: Number.NEGATIVE_INFINITY,
		timer: null as ReturnType<typeof setTimeout> | null,
	};
	const emit = (): void => {
		if (state.closed) return;
		state.dirty = false;
		let payload: JsonValue;
		try {
			payload = options.facts.sample((view) => buildDigest(options, view)).value;
		} catch {
			// 未附着/断线时不造摘要；重连后的 reset+changed 会再次触发。
			return;
		}
		const hash = createHash("sha256").update(canonical(payload)).digest("hex");
		if (hash === state.lastHash) return;
		state.lastHash = hash;
		state.lastEmitAt = Date.now();
		options.emit({ observedAt: new Date().toISOString(), payload });
	};
	const schedule = (): void => {
		if (state.closed || state.timer != null) return;
		const wait = Math.max(0, state.lastEmitAt + DIGEST_INTERVAL_MS - Date.now());
		state.timer = setTimeout(() => {
			state.timer = null;
			if (!state.closed && state.dirty) emit();
		}, wait);
	};
	const subscription = options.facts.subscribe((notice) => {
		if (state.closed) return;
		if (notice.kind === "reset") state.lastHash = null;
		if (notice.kind !== "changed") return;
		state.dirty = true;
		if (Date.now() - state.lastEmitAt >= DIGEST_INTERVAL_MS) {
			if (state.timer != null) {
				clearTimeout(state.timer);
				state.timer = null;
			}
			emit();
		} else schedule();
	});
	return {
		close(): void {
			if (state.closed) return;
			state.closed = true;
			if (state.timer != null) clearTimeout(state.timer);
			subscription.close();
		},
	};
}
