import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// 放置失败黑名单（movements.filterRefusedPlacements + 执行器 place_error 记录）：
// 键 = 实际落点格（参照+面向量，不是参照格），只匹配"服务端明确拒绝时那一格的
// 方块名"；TTL 过期或方块已变 → 放行重试。写入侧只记 err.refused === true
// （超时/缺料/取消不写，执行器侧见补丁）。
const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const pfRequire = createRequire(require.resolve("mineflayer-pathfinder/package.json"));
const registry = mf("prismarine-registry")("1.21.11");
const { Movements } = pfRequire("mineflayer-pathfinder");
const { Vec3 } = mf("vec3");
const Block = mf("prismarine-block")(registry);
const stone = registry.blocksByName.stone.minStateId;
const air = 0;

function fixture(misses, carveTarget) {
	const bot = {
		registry,
		entity: { position: new Vec3(0, 64, 0), effects: {} },
		inventory: { items: () => [{ type: registry.itemsByName.dirt.id, count: 10 }], slots: [] },
		pathfinder: { bestHarvestTool: () => null },
		game: { minY: -64 },
		placeMisses: misses,
		blockAt: (position) => {
			const solid = position.y < 64 && !(carveTarget && position.toString() === carveTarget);
			const block = Block.fromStateId(solid ? stone : air, 0);
			block.position = position;
			return block;
		},
	};
	return new Movements(bot);
}

// 搭桥节点：站在 (0,64,0)，前方 (1,63,0) 被挖空 → getMoveForward 生成
// 放置目标 (1,63,0)（参照 (0,63,0) 顶面 + 东面）。走 getNeighbors 全链路
// （黑名单过滤挂在 getNeighbors 出口，直调 getMoveForward 会绕过它）。
function bridgeMove(movements) {
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 10;
	return movements.getNeighbors(node).filter((mv) =>
		(mv.toPlace ?? []).some((p) => p.x + p.dx === 1 && p.y + p.dy === 63 && p.z + p.dz === 0),
	);
}

const TARGET = new Vec3(1, 63, 0).toString();

// 1) 同格同块拒绝 → 整个移动候选被剔除（拒绝时那格是 air、现在仍是 air）
{
	const movements = fixture([{ x: 1, y: 63, z: 0, was: "air", at: Date.now() }], TARGET);
	assert.equal(bridgeMove(movements).length, 0, "placement into a refused cell must be filtered");
}
// 2) 方块已变 → 放行
{
	const movements = fixture([{ x: 1, y: 63, z: 0, was: "dirt", at: Date.now() }], TARGET);
	assert.ok(bridgeMove(movements).length >= 1, "cell changed since the refusal: retry allowed");
}
// 3) TTL 过期 → 放行
{
	const movements = fixture([{ x: 1, y: 63, z: 0, was: "air", at: Date.now() - 181000 }], TARGET);
	assert.ok(bridgeMove(movements).length >= 1, "TTL expired: retry allowed");
}
// 4) 无黑名单 → 原行为
{
	const movements = fixture([], TARGET);
	assert.ok(bridgeMove(movements).length >= 1);
}
`;

describe("placement refusal blacklist", () => {
	test("same-cell same-block refusals filter the move; changed block, TTL expiry and empty list allow", () => {
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
