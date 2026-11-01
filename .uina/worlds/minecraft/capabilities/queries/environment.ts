/**
 * 环境类查询：world@1（时间/天气/维度/群系）与 entities@1（跟踪范围内的实体）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 world/entities。
 * entities 的 extent 只保证当前 tracked 集合：没找到不等于不存在（§3 entities 注释）。
 * 实体名/分类来自当前版本的静态知识；未知类型如实标 other/null。
 * 玩家实体：kind 按底层 type="player" 判定；输出 name 用名单 join 出的用户名
 * （批16），名单不可用时保持 "player"，不加 unknown——entities 的覆盖语义不含名单。
 */

import type { ClientFactView } from "../../contracts/client-facts.js";
import type { EntityRef } from "../../contracts/body.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import type { Fact, JsonValue } from "../../contracts/values.js";
import { factOf } from "../shared/facts.js";
import { EMPTY_INPUT } from "../shared/schema.js";
import { distance } from "../shared/targets.js";
import type { QuerySpec } from "../shared/query.js";

export interface EnvironmentDeps {
	knowledge: () => RegistryKnowledge | null;
}

const worldQuery: QuerySpec = {
	descriptor: {
		ref: "world@1",
		summary: "Current dimension, time of day, weather, biome and server rules",
		input: EMPTY_INPUT,
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: true,
		examples: [
			{
				input: {},
				output: {
					value: { dimension: "overworld", timeOfDay: "day", ticks: 4000, weather: "clear", biome: "plains" },
				},
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView): Fact<unknown> => {
			const world = view.world();
			return world as Fact<unknown>;
		},
	},
};

export type EntityKind = "hostile" | "passive" | "player" | "other";

export interface EntityEntry {
	ref: EntityRef;
	name: string;
	kind: EntityKind;
	position: { x: number; y: number; z: number };
	distance: number;
	/** 掉落物栈；只有 item 实体可能非 null（未收到元数据时为 null）。 */
	item: { name: string; count: number } | null;
}

const entitiesQuery = (deps: EnvironmentDeps): QuerySpec => ({
	descriptor: {
		ref: "entities@1",
		summary: "Currently tracked entities within a radius (tracked extent, not proof of absence beyond it)",
		input: {
			type: "object",
			properties: {
				radius: { type: "number", minimum: 1, maximum: 128 },
				kind: { type: "string", enum: ["hostile", "passive", "player", "all"] },
				limit: { type: "integer", minimum: 1, maximum: 128 },
			},
			additionalProperties: false,
		},
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: true,
		examples: [
			{
				input: { kind: "hostile", radius: 16 },
				output: {
					value: {
						entities: [{ name: "zombie", kind: "hostile", position: { x: 124, y: 64, z: -25 }, distance: 6.4 }],
						scanned: { radius: 16 },
					},
				},
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const raw = input as { radius?: number; kind?: "hostile" | "passive" | "player" | "all"; limit?: number };
			const radius = raw.radius ?? 32;
			const limit = raw.limit ?? 32;
			const wanted = raw.kind ?? "all";
			const self = view.self();
			if (self.value == null) return { ...self, value: null } as Fact<unknown>;
			const entities = view.entities();
			const knowledge = deps.knowledge();
			const unknown = [...entities.unknown];
			if (knowledge == null) unknown.push("entity categories unavailable: knowledge source not ready");
			// 玩家名覆写：driver 的实体 type 恒为 "player"；用户名从名单事实按跟踪代次 ref join。
			// 名单未到（players 事实为 null）时不覆写，实体名保持 "player"。
			const roster = view.players();
			const playerNamesByNetworkId = new Map<number, string>();
			if (roster.value != null) {
				for (const listed of roster.value.players) {
					if (listed.entity != null) playerNamesByNetworkId.set(listed.entity.networkId, listed.name);
				}
			}
			const origin = self.value.place.position;
			const selfId = entities.value.selfRef?.networkId ?? null;
			const matched: EntityEntry[] = [];
			for (const entity of entities.value.entities) {
				if (selfId != null && entity.ref.networkId === selfId) continue;
				if (entity.position == null) continue;
				const baseType = entity.type ?? "unknown";
				// kind 先按底层 type 判定，再覆写输出名：按覆写后的名字查分类会把玩家标成 other。
				const kind: EntityKind = knowledge?.entityKind(baseType) ?? (baseType === "player" ? "player" : "other");
				const name = baseType === "player" ? (playerNamesByNetworkId.get(entity.ref.networkId) ?? baseType) : baseType;
				if (wanted !== "all" && kind !== wanted) continue;
				const dist = distance(entity.position, origin);
				if (dist > radius) continue;
				matched.push({
					ref: entity.ref,
					name,
					kind,
					position: entity.position,
					distance: Math.round(dist * 100) / 100,
					item: entity.item,
				});
			}
			matched.sort((a, b) => a.distance - b.distance || a.ref.networkId - b.ref.networkId);
			const value = { entities: matched.slice(0, limit), scanned: { radius } };
			return factOf(value, { unknown, source: "server" });
		},
	},
});

export function environmentQueries(deps: EnvironmentDeps): QuerySpec[] {
	return [worldQuery, entitiesQuery(deps)];
}
