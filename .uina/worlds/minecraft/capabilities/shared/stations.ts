/**
 * 工作站的找与放：craft@1 / smelt@1 共用的两件事。
 *
 * 不放"用完拆走"：把工作站留在原地更接近真实玩法，也省掉一次破坏与掉落确认。
 * 放置点只取四个水平相邻格，且要求是空气或可替换植被——不猜方块能不能被顶掉。
 */
import type { CallContext } from "../../contracts/capabilities.js";
import type { SelfState } from "../../contracts/body.js";
import type { Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { readValue } from "./observe.js";
import { fail } from "./targets.js";
import { readBlockAt, type BlockSnapshot } from "./views.js";

const REPLACEABLE = new Set([
	"air",
	"cave_air",
	"void_air",
	"short_grass",
	"grass",
	"fern",
	"large_fern",
	"dead_bush",
	"snow",
]);

const bare = (name: string): string => name.replace(/^minecraft:/, "");

/** 附近同种工作站的最近一格；没有就返回 null（不表示世界上不存在）。 */
export async function findStation(ctx: CallContext, block: string, radius = 8): Promise<Vec3 | null> {
	const observation = await ctx.world.read<{ blocks: { position: Vec3 }[] }>({
		ref: "blocks@1",
		input: { name: block, radius, limit: 3 },
	});
	const blocks = observation.value?.blocks ?? [];
	return blocks[0]?.position ?? null;
}

/** 在玩家身边放一个工作站并把位置回读确认；放不下就明确失败。 */
export async function placeStation(ctx: CallContext, block: string): Promise<Vec3> {
	if (ctx.signal.aborted) fail("INTERRUPTED", "station placement was stopped", { recoverable: false });
	const self = await readValue<SelfState>(ctx.world, "self@1", {}, ctx.signal, "self state");
	const base = {
		x: Math.floor(self.place.position.x),
		y: Math.floor(self.place.position.y),
		z: Math.floor(self.place.position.z),
	};
	const candidates: Vec3[] = [
		{ x: base.x + 1, y: base.y, z: base.z },
		{ x: base.x - 1, y: base.y, z: base.z },
		{ x: base.x, y: base.y, z: base.z + 1 },
		{ x: base.x, y: base.y, z: base.z - 1 },
	];
	for (const at of candidates) {
		const occupied: BlockSnapshot | null = await readBlockAt(ctx.world, at);
		if (occupied != null && !REPLACEABLE.has(bare(occupied.name))) continue;
		await ctx.call("place@1", { block, at: plain(at) });
		const confirmed = await readBlockAt(ctx.world, at);
		if (confirmed != null && bare(confirmed.name) === block) return at;
	}
	fail("WRONG_STATE", `no free adjacent cell to place ${block}`, {
		hint: "stand in an open area, or place the block yourself and pass its position",
	});
}
