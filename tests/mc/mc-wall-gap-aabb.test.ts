import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mfRequire = createRequire(require.resolve("mineflayer"));
const registry = mfRequire("prismarine-registry")("1.21.11");
const Block = mfRequire("prismarine-block")(registry);
const { Vec3 } = mfRequire("vec3");
const { Physics, PlayerState } = mfRequire("prismarine-physics");
const AABB = mfRequire("prismarine-physics/lib/aabb.js");

// Patched criterion: movement toward a block side face stops WALL_GAP short, and
// pressing inward while already touching backs off the same amount. Paper 1.21.11
// rejects gap <= 0 side-face positions silently; vertical contact stays exact.
const WALL_GAP = 1e-5;

// Block box [10,64,10]..[11,65,11]; entity is 0.6 wide.
const blockBB = () => new AABB(10, 64, 10, 11, 65, 11);
const entityAt = (maxX, minX, y = 64.0, zMin = 10.2, zMax = 10.8) =>
	new AABB(minX, y, zMin, maxX, y + 1.8, zMax);

// Far from the face, movement smaller than the clearance: untouched.
assert.equal(blockBB().computeOffsetX(entityAt(9, 8.4), 0.3), 0.3);
// Face closer than the movement: stop WALL_GAP short (old code stopped at exactly 0).
{
	const offset = blockBB().computeOffsetX(entityAt(9.9, 9.3), 0.3);
	assert.ok(Math.abs(offset - 0.09999) < 1e-9, offset);
	assert.ok(Math.abs(10 - (9.9 + offset) - WALL_GAP) < 1e-12); // new maxX = 9.9 + offset
}
// Already touching (gap 0, e.g. a server-side teleport put us there) and still
// pressing inward: back off WALL_GAP instead of staying glued to the face.
assert.equal(blockBB().computeOffsetX(entityAt(10, 9.4), 0.3), -WALL_GAP);
// Overlapping by less than WALL_GAP (float residue): back off through the overlap.
assert.ok(Math.abs(blockBB().computeOffsetX(entityAt(10.000005, 9.400005), 0.3) + 1.5e-5) < 1e-12);
// Pressing outward while touching: untouched.
assert.equal(blockBB().computeOffsetX(entityAt(10, 9.4), -0.3), -0.3);
// Standing still: no branch fires, no drift.
assert.equal(blockBB().computeOffsetX(entityAt(10, 9.4), 0), 0);
// No overlap on the other axes: no clamp at all (entity fully below the block band).
assert.equal(blockBB().computeOffsetX(entityAt(9.9, 9.3, 62.0), 0.3), 0.3);
assert.equal(blockBB().computeOffsetX(entityAt(9.9, 9.3, 64.0, 11.2, 11.8), 0.3), 0.3);
// Z axis: same criterion (entity inside the block's X band, facing the Z face).
assert.ok(
	Math.abs(blockBB().computeOffsetZ(entityAt(10.8, 10.2, 64.0, 9.4, 9.9), 0.3) - 0.09999) < 1e-9,
);
// Already resting exactly at WALL_GAP on Z: no further inward drift (float epsilon).
assert.ok(Math.abs(blockBB().computeOffsetZ(entityAt(10.8, 10.2, 64.0, 9.4, 9.99999), 0.3)) < 1e-12);
// Y axis untouched: resting/falling onto the top face still clamps to exact contact.
{
	const floor = new AABB(10, 63, 10, 11, 64, 11);
	const standing = new AABB(10.2, 64, 10.2, 10.8, 65.8, 10.8);
	assert.equal(floor.computeOffsetY(standing, -0.0784), 0);
	assert.equal(floor.computeOffsetY(standing, 0.0784), 0.0784);
}

// Physics integration: walk straight into a wall; the resolved position must keep
// a positive gap (old code landed exactly on the face and 1.21.11 teleported back).
const stone = registry.blocksByName.stone.minStateId;
const air = 0;
function worldAt(position) {
	const solid = position.y >= 63 && position.y <= 67 && (position.y === 63 || position.x === 10);
	const block = Block.fromStateId(solid ? stone : air, 0);
	block.position = position;
	return block;
}
const world = { getBlock: (cursor) => worldAt(cursor) };
const fakeBot = {
	version: registry.version.minecraftVersion,
	jumpTicks: 0,
	jumpQueued: false,
	fireworkRocketDuration: 0,
	inventory: { slots: [] },
	entity: {
		position: new Vec3(5.5, 64, 10.5),
		velocity: new Vec3(0, 0, 0),
		onGround: true,
		isInWater: false,
		isInLava: false,
		isInWeb: false,
		isCollidedHorizontally: false,
		isCollidedVertically: false,
		elytraFlying: false,
		yaw: 0,
		pitch: 0,
		effects: {},
		attributes: {},
	},
};
const state = new PlayerState(fakeBot, { forward: true, jump: false, sprint: false, sneak: false, back: false, left: false, right: false });
state.yaw = -Math.PI / 2; // face +x (mineflayer convention: atan2(-dx, -dz))
const physics = Physics(registry, world);
for (let i = 0; i < 120; i++) physics.simulatePlayer(state, world);
const gap = 10 - (state.pos.x + 0.3);
assert.ok(gap > 0, "gap after wall contact must be positive, got " + gap);
assert.ok(gap <= WALL_GAP + 1e-9, "gap should be the wall gap, got " + gap);
assert.ok(state.pos.x > 7, "the bot must still make progress toward the wall, got " + state.pos.x);
`;

describe("prismarine-physics wall gap (1.21.11 side-face criterion)", () => {
	test("movement toward a face stops short; contact backs off; walking still converges", () => {
		// The patched AABB is process-local; keep this real dependency check outside vmThreads.
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
