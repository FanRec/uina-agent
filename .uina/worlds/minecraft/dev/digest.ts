/**
 * 批 20 真服验收：G6 节流 digest 推送与 G7 inventory@1 增量游标。
 *
 * 被测行为：digest（world/digest.ts）按查询依赖采样、前缘节流、内容哈希去重；
 * /give 改库存后 digest 反映变化且 digest 不落 events@1；inventory@1 {since}
 * 回差量（changes + 变化后 counts）。facts reset 放行与段落降级由
 * mc-world-digest.test.ts 覆盖；DeliveryPump 的事件分类/忙时合并由
 * mc-delivery-pump.test.ts 用真实泵验证。
 * op 指令只供料（/give），不代替被测行为。digest 经 harness 的 onGameEvent 收集——
 * 与正式链路（side → executor 事件 → DeliveryPump → emitEvent）同一 payload 形状。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameNotice } from "../contracts/executor.js";
import { DIGEST_INTERVAL_MS } from "../world/digest.js";
import { closeHarness, openHarness, sleep } from "./harness.js";
import { makeScenario } from "./scenario.js";

const USER = "UinaDev";

interface DigestNotice {
	at: number;
	payload: {
		kind: "digest";
		self: { dimension?: string; position?: { x: number; y: number; z: number }; health?: number } | null;
		inventory: { revision?: number; counts?: Record<string, number>; usedSlots?: number; freeSlots?: number } | null;
		world: {
			timeOfDay?: string | null;
			dayCount?: number | null;
			weather?: string | null;
			biome?: string | null;
		} | null;
		unknown?: string[];
	};
}

const asDigest = (notice: GameNotice): DigestNotice | null => {
	const payload = notice.payload as DigestNotice["payload"] | undefined;
	return payload?.kind === "digest" ? { at: Date.parse(notice.observedAt), payload } : null;
};

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-digest-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:digest-${Date.now()}` };
	const digests: DigestNotice[] = [];
	const h = await openHarness("digest", {
		dataRoot,
		binding,
		onGameEvent: (notice) => {
			const digest = asDigest(notice);
			if (digest) digests.push(digest);
		},
	});
	const s = makeScenario(h, "digest");

	const waitForDigest = async (
		predicate: (digest: DigestNotice) => boolean,
		timeoutMs: number,
		from = 0,
	): Promise<DigestNotice> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = digests.slice(from).find(predicate);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`no matching digest within ${timeoutMs}ms (have ${digests.length})`);
			await sleep(250);
		}
	};

	try {
		await s.step("prepare a static environment", async () => {
			// 批19 的 transit 可能把身体留在下界：显式回主世界。锁时间/天气/和平 + 禁刷怪，
			// 让空闲期所有 digest 段落真正静止——"空闲零 digest"断言才有意义（环境准备，同 climb）。
			await s.command(`/execute in minecraft:overworld run tp ${USER} 9850.5 200 9850.5`);
			await sleep(800);
			// 批19 climb 同款平台：保证落点实心、头顶无遮挡（位置稳定是空闲断言的前提）。
			await s.command(`/fill 9810 199 9810 9890 199 9890 minecraft:stone`);
			await s.command(`/fill 9810 200 9810 9890 212 9890 minecraft:air`);
			await s.command(`/gamerule doDaylightCycle false`);
			await s.command(`/time set day`);
			await s.command(`/gamerule doWeatherCycle false`);
			await s.command(`/weather clear`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/kill @e[type=!minecraft:player]`);
			// 清背包：后续 /give 的 digest 匹配必须唯一（残留会让谓词命中旧 digest）。
			await s.command(`/clear ${USER}`);
			return "overworld platform, locked day/clear, peaceful, mobs off, empty inventory";
		});

		await s.step("baseline digest carries the three sections", async () => {
			const first = await waitForDigest(
				(digest) => digest.payload.self != null && digest.payload.inventory != null && digest.payload.world != null,
				20000,
			);
			const p = first.payload;
			if (typeof p.self?.dimension !== "string") throw new Error("self.dimension missing");
			if (p.inventory == null || typeof p.inventory.counts !== "object" || p.inventory.revision == null)
				throw new Error("inventory section incomplete");
			if (p.world == null || p.world.timeOfDay === undefined) throw new Error("world section incomplete");
			return `self.dim=${p.self.dimension} inv.rev=${p.inventory.revision} time=${p.world.timeOfDay} weather=${p.world.weather}`;
		});

		await s.step("idle window emits nothing (content hash dedupe)", async () => {
			// 先排空 prepare 变化的节流尾流（trailing 在 lastEmit+10s 内可能落地），再断言静止。
			await sleep(12_000);
			const drained = digests.length;
			await sleep(15_000);
			const fresh = digests.slice(drained);
			if (fresh.length > 0)
				throw new Error(
					`${fresh.length} digest(es) while idle; dedupe failed: ${JSON.stringify(fresh[0].payload).slice(0, 200)}`,
				);
			return `no digest in 15s while idle (${drained} total so far)`;
		});

		await s.step("/give shows up in a digest within the throttle window", async () => {
			await s.command(`/clear ${USER}`);
			const from = digests.length;
			await s.command(`/give ${USER} minecraft:diamond 3`);
			const found = await waitForDigest((digest) => (digest.payload.inventory?.counts?.diamond ?? 0) >= 3, 15000, from);
			return `diamond=3 in digest, inv.rev=${found.payload.inventory?.revision}`;
		});

		await s.step("inventory@1 {since} returns the delta after a change", async () => {
			const base = await h.world.read<{ revision: number }>({ ref: "inventory@1", input: {} });
			const r0 = base.value?.revision;
			if (r0 == null) throw new Error("inventory revision unavailable");
			const same = await h.world.read<{ revision: number; changes: unknown[] }>({
				ref: "inventory@1",
				input: { since: r0 },
			});
			if (same.value?.revision !== r0 || (same.value.changes?.length ?? -1) !== 0)
				throw new Error(`same-cursor read drifted: ${JSON.stringify(same.value).slice(0, 200)}`);
			await s.command(`/give ${USER} minecraft:emerald 2`);
			const delta = await h.world.read<{
				revision: number;
				changes: { slot: number; item: { name: string; count: number } | null }[];
				counts: Record<string, number>;
			}>({ ref: "inventory@1", input: { since: r0 } });
			const emerald = delta.value?.changes.find((change) => change.item?.name === "emerald");
			if (emerald == null || (emerald.item?.count ?? 0) < 2)
				throw new Error(`delta missing emerald: ${JSON.stringify(delta.value).slice(0, 240)}`);
			if ((delta.value?.counts.emerald ?? 0) < 2) throw new Error("delta counts missing emerald total");
			return `rev ${r0}→${delta.value?.revision}, changes=${delta.value?.changes.length} (emerald +2)`;
		});

		await s.step("a change inside the throttle window waits for the interval", async () => {
			// 锚点只认此刻已有的 digest，匹配只认本步骤新增的 digest：
			// 节流合并可能让"含目标物品"的旧 digest 早于数组末尾，回看历史会拿到负 gap。
			const last = digests.at(-1);
			if (last == null) throw new Error("no prior digest to anchor the throttle");
			const from = digests.length;
			await s.command(`/give ${USER} minecraft:cobblestone 1`);
			const next = await waitForDigest(
				(digest) => (digest.payload.inventory?.counts?.cobblestone ?? 0) >= 1,
				15000,
				from,
			);
			const gap = next.at - last.at;
			if (gap < DIGEST_INTERVAL_MS - 500)
				throw new Error(`digest gap ${gap}ms < throttle window ${DIGEST_INTERVAL_MS}ms`);
			return `digest gap ${gap}ms (≥ ${DIGEST_INTERVAL_MS}ms)`;
		});

		await s.step("digest never lands in events@1", async () => {
			const page = await h.world.read<{ events?: { payload?: { kind?: string } }[] }>({
				ref: "events@1",
				input: { limit: 200 },
			});
			const leaked = (page.value?.events ?? []).filter((event) => event.payload?.kind === "digest");
			if (leaked.length > 0) throw new Error(`${leaked.length} digest records leaked into history`);
			return "events@1 clean";
		});
	} finally {
		s.finish();
		await closeHarness(h);
		await sleep(200);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
