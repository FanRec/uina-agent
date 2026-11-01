import { describe, expect, test } from "vitest";
import type { ClientPlayersValue } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import { makeBot, makeFactsHarness, type FakeBot } from "./mc-fake.js";

/**
 * players 事实投影（capabilities.md §players / public-api §4.1）。
 *
 * 关键口径：名单未到 ≠ 空服；关联实体按采样时刻的 bot.entities 重新解析，
 * 不信任 mineflayer 只在 player_info 时刷新的 player.entity 缓存。
 */

function chatLike(text: string): unknown {
	return { toString: () => text };
}

/** 模拟 mineflayer Player：字段形状以 lib/plugins/entities.js 实测为准。 */
function listed(username: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { username, uuid: `uuid-${username}`, displayName: chatLike(username), gamemode: 0, ping: 42, ...overrides };
}

function playerEntity(id: number, username: string): Record<string, unknown> {
	return { id, type: "player", username, position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
}

function rosterBot(players: Record<string, unknown>, entities: Record<string, unknown> = {}): FakeBot {
	return makeBot({ players, entities });
}

function readPlayers(h: ReturnType<typeof makeFactsHarness>): Fact<ClientPlayersValue | null> {
	return h.facts.sample((view) => view.players()).value;
}

describe("players：名单未到 ≠ 空服", () => {
	test("未收到任何名单事件：null + unknown，不冒充空服", () => {
		const h = makeFactsHarness({ bot: rosterBot({}) });
		const players = readPlayers(h);
		expect(players.value).toBeNull();
		expect(players.unknown).toContain("server roster has not arrived yet");
		expect(players.coverage).toBe("partial");
	});

	test("收到空名单（服务器只有自己且已被移除等）：complete 空表，如实", () => {
		const bot = rosterBot({});
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("uina"));
		const players = readPlayers(h);
		expect(players.value).toEqual({ extent: "server_listed", players: [] });
		expect(players.unknown).toEqual([]);
		expect(players.coverage).toBe("complete");
	});
});

describe("players：字段投影", () => {
	test("按采样时刻的 bot.entities 关联实体；gamemode 数值映射名称", () => {
		const bot = rosterBot(
			{
				Kite: listed("Kite", { gamemode: 3, ping: 7 }),
				uina: listed("uina"),
			},
			{
				42: playerEntity(42, "Kite"),
				7: { ...playerEntity(7, "uina"), ...{ onGround: true, effects: {} } },
			},
		);
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		expect(players.value?.extent).toBe("server_listed");
		const byName = new Map(players.value?.players.map((entry) => [entry.name, entry]));
		const kite = byName.get("Kite");
		expect(kite).toMatchObject({
			name: "Kite",
			uuid: "uuid-Kite",
			displayName: "Kite",
			latencyMs: 7,
			gameMode: "spectator",
		});
		expect(kite?.entity?.networkId).toBe(42);
		expect(kite?.entity?.connection).toBe("conn:t:1");
		// 自身也在公告名单里（服务器 player_info 含自己）。
		expect(byName.get("uina")?.entity?.networkId).toBe(7);
		expect(players.unknown).toEqual([]);
	});

	test("离开跟踪范围：名单仍在、entity=null", () => {
		const bot = rosterBot({ Kite: listed("Kite") }, {});
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		expect(players.value?.players).toHaveLength(1);
		expect(players.value?.players[0]?.entity).toBeNull();
		expect(players.unknown).toEqual([]);
	});

	test("gamemode/latency 未收到：null + unknown，不填 0", () => {
		const bot = rosterBot({ Kite: listed("Kite", { gamemode: undefined, ping: undefined }) });
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		const kite = players.value?.players[0];
		expect(kite?.gameMode).toBeNull();
		expect(kite?.latencyMs).toBeNull();
		expect(players.unknown).toContain("game mode of some listed players not received yet");
	});

	test("未知 gamemode 数值：null + unknown，不猜", () => {
		const bot = rosterBot({ Kite: listed("Kite", { gamemode: 9 }) });
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		expect(players.value?.players[0]?.gameMode).toBeNull();
		expect(players.unknown).toContain("game mode of some listed players not received yet");
	});

	test("uuid 缺失：null（合同允许），displayName 形变防御为 null", () => {
		const bot = rosterBot({
			Kite: listed("Kite", { uuid: undefined, displayName: { noToString: true } }),
		});
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		const kite = players.value?.players[0];
		expect(kite?.uuid).toBeNull();
		expect(kite?.displayName).toBeNull();
	});

	test("无名条目跳过并如实计入 unknown", () => {
		const bot = rosterBot({ ghost: { uuid: "uuid-ghost" }, Kite: listed("Kite") });
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		expect(players.value?.players.map((entry) => entry.name)).toEqual(["Kite"]);
		expect(players.unknown).toContain("a listed player entry without username was skipped");
	});
});

describe("players：名单事件推进版本", () => {
	test("playerJoined/playerUpdated/playerLeft 都 commit（stamp 前进 + changed 通知）", async () => {
		const bot = rosterBot({});
		const h = makeFactsHarness({ bot });
		const notices: string[] = [];
		h.facts.subscribe((notice) => {
			if (typeof notice === "object" && notice != null && "kind" in notice)
				notices.push((notice as { kind: string }).kind);
		});
		const before = h.facts.sample(() => 0).stamp.sequence;
		bot.emit("playerJoined", listed("Kite"));
		const afterJoin = h.facts.sample(() => 0).stamp.sequence;
		expect(afterJoin).toBeGreaterThan(before);
		bot.emit("playerUpdated", listed("Kite", { ping: 51 }));
		bot.emit("playerLeft", listed("Kite"));
		const afterLeft = h.facts.sample(() => 0).stamp.sequence;
		expect(afterLeft).toBeGreaterThan(afterJoin);
		// changed 通知经 queueMicrotask 投递。
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(notices.filter((kind) => kind === "changed").length).toBeGreaterThanOrEqual(1);
	});

	test("换连接后名单重新等待：disconnect → reconnect 清零 rosterSeen", () => {
		const bot = rosterBot({ Kite: listed("Kite") });
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		expect(readPlayers(h).value).not.toBeNull();
		h.disconnect();
		// 断线后采样本身不可用（DISCONNECTED），不是"名单为空"。
		expect(() => readPlayers(h)).toThrow(/connection is disconnected/);
		const bot2 = rosterBot({});
		h.reconnect(bot2);
		expect(readPlayers(h).value).toBeNull();
		bot2.emit("playerJoined", listed("uina"));
		expect(readPlayers(h).value).not.toBeNull();
	});

	test("mineflayer 滞留的 player.entity 不参与关联：以 bot.entities 采样为准", () => {
		// player.entity 指向已 despawn 的 id；名单关联必须按 bot.entities 重新解析为空。
		const bot = rosterBot({ Kite: listed("Kite", { entity: { id: 999 } }) }, {});
		const h = makeFactsHarness({ bot });
		bot.emit("playerJoined", listed("Kite"));
		const players = readPlayers(h);
		expect(players.value?.players[0]?.entity).toBeNull();
	});
});
