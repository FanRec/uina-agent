/**
 * players@1：服务器实际公告的玩家名单（K6 玩家名单）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §3 players。
 * 名单只说明服务器公告了谁：未公告不证明离线，服务器插件隐藏的人也不凭空出现；
 * 离开实体跟踪范围仍在名单里，但 tracked=null（关联实体与位置按当前跟踪代次
 * join，join 不中如实 unknown）。不读历史，也不为名单主动发送 /list。
 */

import type { EntityRef } from "../../contracts/body.js";
import type { ClientFactView } from "../../contracts/client-facts.js";
import type { Fact, JsonValue, Vec3 } from "../../contracts/values.js";
import { factOf } from "../shared/facts.js";
import type { QuerySpec } from "../shared/query.js";
import { distance } from "../shared/targets.js";

interface RosterRow {
	name: string;
	uuid: string | null;
	displayName: string | null;
	latencyMs: number | null;
	gameMode: string | null;
	entity: EntityRef | null;
}

const playersQuery: QuerySpec = {
	descriptor: {
		ref: "players@1",
		// 名单为主体，tracked 实体与自身排除也参与。
		facts: ["players", "entities", "self"],
		summary:
			"Server-announced player roster with tracked-entity links; absence from the list is not proof of being offline",
		input: {
			type: "object",
			properties: {
				name: { type: "string", minLength: 1 },
				limit: { type: "integer", minimum: 1, maximum: 256 },
			},
			additionalProperties: false,
		},
		output: { type: "object" },
		access: "read",
		watchable: true,
		feedback: false,
		examples: [
			{
				input: { name: "kite" },
				output: {
					value: {
						extent: "server_listed",
						players: [
							{
								name: "Kite",
								uuid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
								displayName: "Kite",
								latencyMs: 42,
								gameMode: "survival",
								tracked: { ref: "s3:7:1042", position: { x: 124, y: 64, z: -25 }, distance: 6.4 },
							},
						],
						listedCount: 1,
						truncated: false,
					},
				},
			},
		],
	},
	reader: {
		kind: "current",
		read: (view: ClientFactView, input: JsonValue): Fact<unknown> => {
			const raw = input as { name?: string; limit?: number };
			const nameFilter = raw.name?.toLowerCase();
			const limit = raw.limit ?? 64;
			const roster = view.players();
			if (roster.value == null) {
				// 名单未到：空表 + unknown（coverage partial），不冒充空服（capabilities.md §players）。
				return factOf(
					{ extent: "server_listed", players: [], listedCount: 0, truncated: false },
					{ unknown: roster.unknown, source: "server" },
				);
			}
			const entities = view.entities();
			const byNetworkId = new Map<number, { ref: EntityRef; position: Vec3 | null }>();
			for (const entry of entities.value.entities) {
				byNetworkId.set(entry.ref.networkId, { ref: entry.ref, position: entry.position });
			}
			const self = view.self();
			const origin = self.value?.place.position ?? null;
			const unknown = [...roster.unknown];
			if (origin == null) unknown.push("self position unavailable; tracked positions not resolved");
			const filtered = roster.value.players.filter(
				(player) => nameFilter == null || player.name.toLowerCase() === nameFilter,
			);
			const listedCount = filtered.length;
			// 名单唯一一份来源不保证顺序；按 name/uuid 稳定排序后截断（capabilities.md §players）。
			const sorted = [...filtered].sort((a, b) => {
				if (a.name !== b.name) return a.name < b.name ? -1 : 1;
				const au = a.uuid ?? "";
				const bu = b.uuid ?? "";
				return au === bu ? 0 : au < bu ? -1 : 1;
			});
			let unresolvedLinks = 0;
			const players = sorted.slice(0, limit).map((row: RosterRow) => {
				let tracked: { ref: EntityRef; position: Vec3; distance: number } | null = null;
				if (row.entity != null && origin != null) {
					const entry = byNetworkId.get(row.entity.networkId);
					if (entry != null && entry.position != null) {
						tracked = {
							ref: entry.ref,
							position: entry.position,
							distance: Math.round(distance(entry.position, origin) * 100) / 100,
						};
					} else if (entry == null) {
						unresolvedLinks += 1;
					}
				}
				return {
					name: row.name,
					uuid: row.uuid,
					displayName: row.displayName,
					latencyMs: row.latencyMs,
					gameMode: row.gameMode,
					tracked,
				};
			});
			if (unresolvedLinks > 0) {
				unknown.push("tracked entity refs of some listed players were not observed in the current tracking generation");
			}
			return factOf(
				{ extent: "server_listed", players, listedCount, truncated: listedCount > limit },
				{ unknown, source: "server" },
			);
		},
	},
};

export function playerQueries(): QuerySpec[] {
	return [playersQuery];
}
