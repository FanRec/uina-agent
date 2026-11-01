/**
 * 批 16 真服验收：players@1 玩家名单（K6 前半）。
 *
 * 被测行为全部走正式查询面（World read）；op 指令只备场地与移动第二玩家，
 * 不代替任何被测读数。第二玩家用生产类 ClientHost 真连接（离线服同名互踢，
 * 必须用不同用户名），场景结束时显式关闭——harness.close 不管它。
 *
 * 关键口径（capabilities.md §players）：名单只说明服务器公告了谁；离开实体
 * 跟踪范围仍在名单里但 tracked=null；未公告不证明离线；UUID 不认证正版。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../contracts/values.js";
import { ClientHost } from "../driver/client-host.js";
import { closeHarness, openHarness, sleep, waitForStill } from "./harness.js";
import { makeScenario, type PlayersView } from "./scenario.js";

const USER = "UinaDev";
const OTHER = "KiteDev";
const CENTER = { x: 8900, y: 200, z: 8900 };
const PLATFORM = { x1: 8896, y: 199, z1: 8896, x2: 8904, z2: 8904 };
/** 远处落脚台：超出玩家实体跟踪范围（Paper 默认 48），落点有地面不会摔死。 */
const FAR = { x: 9162, z: 8900 };

function rosterOf(view: PlayersView): Map<string, PlayersView["players"][number]> {
	return new Map(view.players.map((row) => [row.name, row]));
}

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-players-"));
	const h = await openHarness("players", { dataRoot });
	const s = makeScenario(h, "players");
	const bot = h.bot;

	/** 第二玩家连接：生产类 ClientHost，raw 连接（不装配 Runtime）。 */
	const other = new ClientHost();

	try {
		await s.step("备场地：平台 + 清怪", async () => {
			await s.command("/gamemode creative");
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await sleep(2200);
			await s.command(
				`/fill ${PLATFORM.x1} ${PLATFORM.y} ${PLATFORM.z1} ${PLATFORM.x2} ${PLATFORM.y} ${PLATFORM.z2} minecraft:stone`,
			);
			// 远处落脚台：目标区块未加载时 /fill 会静默失败——先过去加载区块，填完再回来，
			// 否则第二玩家会被摔死重生到世界出生点，tracked 恒 null（批16 首跑踩过）。
			// 填完立即用 block@1 复核（此刻区块仍在加载态，回到主平台后就读不到了）。
			await s.command(`/tp ${USER} ${FAR.x + 0.5} ${CENTER.y} ${FAR.z + 0.5}`);
			await sleep(1600);
			await s.command(
				`/fill ${FAR.x - 2} ${CENTER.y - 1} ${FAR.z - 2} ${FAR.x + 2} ${CENTER.y - 1} ${FAR.z + 2} minecraft:stone`,
			);
			const pad = await s.readBlock({ x: FAR.x, y: CENTER.y - 1, z: FAR.z });
			if (pad?.name !== "stone") throw new Error(`far pad missing after fill: ${pad?.name ?? "null"}`);
			await s.command(`/kill @e[type=!player]`);
			await s.command(`/tp ${USER} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await s.command("/gamemode survival");
			await sleep(900);
			await waitForStill(bot, s.log);
			return `platform ready at ${CENTER.x},${CENTER.y},${CENTER.z}; far pad at ${FAR.x},${CENTER.y - 1},${FAR.z} verified stone`;
		});

		await s.step("初始名单：服务器公告含自己，字段成形", async () => {
			const view = await s.readPlayers();
			const self = rosterOf(view).get(USER);
			if (self == null) throw new Error(`roster lacks self (${USER}): ${JSON.stringify(view)}`);
			if (view.extent !== "server_listed") throw new Error(`extent ${view.extent}`);
			if (self.uuid == null || self.uuid.length === 0)
				throw new Error("offline uuid should be present (not proof of authenticity)");
			if (self.gameMode !== "survival") throw new Error(`gameMode ${self.gameMode}`);
			if (typeof self.latencyMs !== "number") throw new Error(`latencyMs ${self.latencyMs}`);
			if (self.tracked == null) throw new Error("self should be tracked (own entity is in range)");
			return `players=[${view.players.map((row) => row.name).join(",")}] listedCount=${view.listedCount}`;
		});

		await s.step("第二玩家未加入前不在名单", async () => {
			const view = await s.readPlayers({ name: OTHER });
			if (view.listedCount !== 0)
				throw new Error(`${OTHER} should not be announced yet: ${JSON.stringify(view.players)}`);
			return "absent as expected";
		});

		await s.step("第二玩家加入后进入名单并跟踪", async () => {
			await other.connect({ host: "127.0.0.1", port: 25565, username: OTHER, version: "1.21.11" });
			// 落到 UinaDev 身边（否则出生点在远处，彼此都看不到对方实体）。
			await s.command(`/tp ${OTHER} ${CENTER.x + 1.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await sleep(1800);
			const view = await s.readPlayers();
			const row = rosterOf(view).get(OTHER);
			if (row == null) throw new Error(`${OTHER} missing from roster after join`);
			if (row.tracked == null) throw new Error(`${OTHER} joined nearby but tracked=null`);
			return `tracked ref=${row.tracked.ref.networkId} distance=${row.tracked.distance}`;
		});

		await s.step("tracked 与 entities@1 对拍：同 networkId 同位置，玩家名覆写生效", async () => {
			const [view, entities] = await Promise.all([s.readPlayers(), s.readEntities(48)]);
			const row = rosterOf(view).get(OTHER);
			if (row?.tracked == null) throw new Error(`${OTHER} not tracked`);
			const entity = entities.find((entry) => entry.ref.networkId === row.tracked!.ref.networkId);
			if (entity == null) throw new Error(`networkId ${row.tracked.ref.networkId} not in entities@1`);
			const drift =
				Math.abs(entity.position.x - row.tracked.position.x) + Math.abs(entity.position.z - row.tracked.position.z);
			if (drift > 0.5) throw new Error(`position drift ${drift} between players@1 and entities@1`);
			if (entity.name !== OTHER) throw new Error(`entities@1 name should be the username, got ${entity.name}`);
			if (entity.kind !== "player") throw new Error(`kind ${entity.kind}`);
			return `name=${entity.name} kind=${entity.kind} drift=${drift.toFixed(3)}`;
		});

		await s.step("players@1 watch：名单公告推进版本", async () => {
			const observation = await h.world.read({ ref: "players@1", input: {} });
			if (observation.cursor == null) throw new Error("players@1 read should carry an observation cursor");
			const watch = await h.world.watch({ ref: "players@1", input: {} }, observation.cursor, AbortSignal.timeout(5000));
			try {
				// 玩家名单的延迟/位置公告随连接持续到达；changed 由通用 current watch 机制投递。
				const next = await watch.next(observation.cursor!, AbortSignal.timeout(5000));
				if (next.kind !== "changed") throw new Error(`expected changed, got ${next.kind}`);
				return `watch delivered ${next.kind}`;
			} finally {
				await watch.close();
			}
		});

		await s.step("离开跟踪范围：名单仍在、tracked=null", async () => {
			await s.command(`/tp ${OTHER} ${FAR.x + 0.5} ${CENTER.y} ${FAR.z + 0.5}`);
			await sleep(1800);
			const view = await s.readPlayers();
			const row = rosterOf(view).get(OTHER);
			if (row == null) throw new Error(`${OTHER} should stay listed while out of tracking range`);
			if (row.tracked != null)
				throw new Error(`tracked should be null out of range, got ${JSON.stringify(row.tracked)}`);
			return "listed=true tracked=null";
		});

		await s.step("回到跟踪范围：tracked 恢复", async () => {
			await s.command(`/tp ${OTHER} ${CENTER.x + 1.5} ${CENTER.y} ${CENTER.z + 0.5}`);
			await sleep(1800);
			const view = await s.readPlayers();
			const row = rosterOf(view).get(OTHER);
			if (row?.tracked == null) throw new Error(`${OTHER} back in range but tracked=null`);
			return `tracked distance=${row.tracked.distance}`;
		});

		await s.step("name 精确筛选（大小写不敏感）", async () => {
			const hit = await s.readPlayers({ name: OTHER.toLowerCase() });
			if (hit.listedCount !== 1 || hit.players[0]?.name !== OTHER)
				throw new Error(`case-insensitive filter failed: ${JSON.stringify(hit.players)}`);
			const miss = await s.readPlayers({ name: "nobody" });
			if (miss.listedCount !== 0 || miss.players.length !== 0 || miss.truncated)
				throw new Error("unknown name should filter to empty");
			return "hit=1 miss=0";
		});

		await s.step("INVALID_INPUT 边界在 World 校验层拒绝", async () => {
			const bad: { [key: string]: JsonValue }[] = [
				{ limit: 0 },
				{ limit: 257 },
				{ name: "" },
				{ name: "kite", extra: true },
			];
			for (const input of bad) {
				const failure = await h.world.read({ ref: "players@1", input }).then(
					() => null,
					(error: unknown) => error as { code?: string },
				);
				if (failure?.code !== "INVALID_INPUT")
					throw new Error(`input ${JSON.stringify(input)} should be INVALID_INPUT`);
			}
			return `rejected ${bad.length} malformed inputs`;
		});

		await s.step("第二玩家退出：名单移除，自己仍在", async () => {
			await other.close();
			await sleep(1800);
			const view = await s.readPlayers();
			if (rosterOf(view).has(OTHER)) throw new Error(`${OTHER} should be removed after disconnect`);
			if (rosterOf(view).get(USER) == null) throw new Error(`${USER} should stay listed`);
			return `players=[${view.players.map((row) => row.name).join(",")}]`;
		});
	} finally {
		await other.close().catch(() => {});
		await closeHarness(h);
	}
	const failed = s.finish();
	process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
