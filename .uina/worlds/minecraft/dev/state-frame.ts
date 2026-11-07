/**
 * 批37 真服验收：请求前状态帧（取代 G6 周期 digest 推送）。
 *
 * 被测行为：
 * 1. `state.snapshot` 一次采样给三段（self/inventory/world），坐标来自服务端体态；
 * 2. **空闲零事件**——世界变化不再产生任何 Subject 输入（这是本批的核心主张）；
 * 3. `/give` 后下一次采样立即反映，不依赖任何节流窗口；
 * 4. 状态帧不落 events@1（它是瞬态投影，不是历史事实）；
 * 5. `inventory@1 {since}` 增量仍在（G7 不随本批改变）。
 *
 * op 指令只供料，不代替被测行为。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameNotice } from "../contracts/executor.js";
import { closeHarness, openHarness, sleep } from "./harness.js";
import { makeScenario } from "./scenario.js";

const USER = "UinaDev";

async function main(): Promise<void> {
	const dataRoot = process.env.MC_DEV_DATA_DIR ?? mkdtempSync(join(tmpdir(), "uina-mc-state-frame-"));
	const binding = { world: "world:paper-dev", worldRevision: `revision:state-${Date.now()}` };
	const notices: GameNotice[] = [];
	const h = await openHarness("state-frame", {
		dataRoot,
		binding,
		onGameEvent: (notice) => notices.push(notice),
	});
	const s = makeScenario(h, "state-frame");

	try {
		await s.step("prepare a static environment", async () => {
			await s.command(`/execute in minecraft:overworld run tp ${USER} 9850.5 200 9850.5`);
			await sleep(800);
			await s.command(`/fill 9810 199 9810 9890 199 9890 minecraft:stone`);
			await s.command(`/fill 9810 200 9810 9890 212 9890 minecraft:air`);
			await s.command(`/gamerule doDaylightCycle false`);
			await s.command(`/time set day`);
			await s.command(`/gamerule doWeatherCycle false`);
			await s.command(`/weather clear`);
			await s.command(`/difficulty peaceful`);
			await s.command(`/gamerule spawn_mobs false`);
			await s.command(`/kill @e[type=!minecraft:player]`);
			await s.command(`/clear ${USER}`);
			return "overworld platform, locked day/clear, peaceful, mobs off, empty inventory";
		});

		await s.step("snapshot carries the three sections from one sample boundary", async () => {
			const frame = await h.snapshot();
			if (!frame.connected) throw new Error(`snapshot reports disconnected: ${frame.text}`);
			for (const needle of ["(9850,200,9850)", "生命20/20", "饥饿20/20", "day·第", "clear", "背包：空"])
				if (!frame.text.includes(needle)) throw new Error(`frame missing ${needle}: ${frame.text}`);
			// 真服上这两段本该读全：出现"未知"说明采样在真实包序列里漏了东西。
			if (frame.text.includes("未知")) throw new Error(`frame has unknown vitals: ${frame.text}`);
			if (frame.unknown.length > 0) throw new Error(`unexpected unknown sections: ${frame.unknown.join(", ")}`);
			return frame.text.replace(/\n/g, " | ");
		});

		await s.step("idle world emits no notice at all (no periodic push)", async () => {
			// 先排空 prepare 期残留（tp/fill 可能触发既有的 death/chat 类事实，但状态帧不该产生任何东西）。
			await sleep(3000);
			const drained = notices.length;
			await sleep(15_000);
			const fresh = notices.slice(drained);
			if (fresh.length > 0)
				throw new Error(`${fresh.length} notice(s) while idle: ${JSON.stringify(fresh[0]).slice(0, 240)}`);
			return `no event in 15s while idle (${drained} total before)`;
		});

		await s.step("a fresh change shows up in the very next snapshot", async () => {
			await s.command(`/clear ${USER}`);
			await s.command(`/give ${USER} minecraft:diamond 3`);
			await sleep(300);
			const frame = await h.snapshot();
			if (!frame.text.includes("diamond×3")) throw new Error(`diamond missing from frame: ${frame.text}`);
			return "diamond×3 visible without waiting for any throttle";
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
			await sleep(300);
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

		await s.step("moving 35 blocks pushes nothing, and every sample is the current cell", async () => {
			// 本批的核心主张在这里落地：走动是最密集的状态变化源，它一条消息都不该产生；
			// 而每次请求前的采样必须与身体此刻所在的那一格一致（不能滞后成上一个位置）。
			await s.command(`/kill @e[type=!minecraft:player]`);
			await s.command(`/clear ${USER}`);
			const drainAt = notices.length;
			const spawned = await s.spawn("goto@1", { at: { x: 9885, y: 200, z: 9850 }, tolerance: 1, maxTimeMs: 40000 });
			const seen = new Set<string>();
			let samples = 0;
			for (let index = 0; index < 20; index++) {
				const frame = await h.snapshot();
				const cell = /\((-?\d+),(-?\d+),(-?\d+)\)/.exec(frame.text);
				if (cell == null) throw new Error(`frame has no position: ${frame.text}`);
				seen.add(cell[0]);
				const self = await s.readSelf();
				const now = self.place.position;
				const drifted =
					Math.abs(Number(cell[1]) - Math.floor(now.x)) > 1 ||
					Math.abs(Number(cell[2]) - Math.floor(now.y)) > 1 ||
					Math.abs(Number(cell[3]) - Math.floor(now.z)) > 1;
				if (drifted) throw new Error(`stale frame: frame=${cell[0]} body=(${now.x},${now.y},${now.z})`);
				samples++;
				await sleep(1000);
			}
			const result = await s.waitCall(spawned, 45000);
			if (!result.ok) throw new Error(`goto failed: ${result.code} ${result.message}`);
			if (seen.size < 4) throw new Error(`frame did not follow the walk (only ${[...seen].join(" ")} )`);
			const fresh = notices.slice(drainAt);
			if (fresh.length > 0)
				throw new Error(`${fresh.length} notice(s) while walking: ${JSON.stringify(fresh[0]).slice(0, 240)}`);
			return `${samples} samples over ${seen.size} cells, 0 notices`;
		});

		await s.step("state frames never land in events@1", async () => {
			const page = await h.world.read<{ events?: { payload?: { kind?: string } }[] }>({
				ref: "events@1",
				input: { limit: 200 },
			});
			const leaked = (page.value?.events ?? []).filter(
				(event) => event.payload?.kind === "digest" || event.payload?.kind === "state_frame",
			);
			if (leaked.length > 0) throw new Error(`${leaked.length} state frame(s) leaked into history`);
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
