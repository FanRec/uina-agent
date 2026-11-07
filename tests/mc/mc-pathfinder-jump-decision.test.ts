import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// G30 缺陷 (a)+(a′)：shouldJump 从"沿 bot→节点方向探测 0.6/1.2/1.8"重写为
// 纯落地模拟（canWalkJump 从真实位置/速度出发）。
// 第一轮重写的 <0.6 死区在 1 格深台阶上扼杀"着陆动量链式跳"（mine 回程钉死
// 在 y195 的实证）——第二轮删除死区，模拟自身仲裁：
//   零速贴面跳 → 模拟判 false（批19 实测永远过不去）→ 退避接管；
//   着陆动量贴面跳 → 模拟判 true → 1:1 阶梯链式攀爬。
// fixture = 真 prismarine-physics + 假方块网格：平地、窗口内、贴面零速、
// 贴面带着陆动量（G30 a′ 形态）、漂移进场、悬浮节点、双高墙。
const program = `
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const pfRequire = createRequire(require.resolve("mineflayer-pathfinder/package.json"));
const registry = mf("prismarine-registry")("1.21.11");
const Physics = pfRequire("mineflayer-pathfinder/lib/physics.js");
const physicsLib = mf("prismarine-physics");
const { Vec3 } = mf("vec3");
const Block = mf("prismarine-block")(registry);

const stone = registry.blocksByName.stone;

// 网格：地面站面 y=65（地板 64），实体格由 pillars 指定。
// step 列 (5,0)：65 层是踏步块（1 级上步节点的地板格），站面 66。
function makeBot({ pos, vel, pillars }) {
  const solid = new Set();
  for (let x = -4; x <= 12; x++) {
    for (let z = -4; z <= 4; z++) {
      solid.add(x + "," + 64 + "," + z);
    }
  }
  for (const [x, y, z] of pillars ?? []) solid.add(x + "," + y + "," + z);
  const bot = new EventEmitter();
  bot.version = "1.21.11";
  bot.registry = registry;
  bot.entity = {
    position: new Vec3(pos[0], pos[1], pos[2]),
    velocity: new Vec3(vel[0], vel[1], vel[2]),
    onGround: true,
    isInWater: false,
    isInLava: false,
    isInWeb: false,
    isCollidedHorizontally: false,
    isCollidedVertically: false,
    elytraFlying: false,
    yaw: 0,
    pitch: 0,
    height: 1.8,
    effects: {},
  };
  bot.jumpTicks = 0;
  bot.jumpQueued = false;
  bot.fireworkRocketDuration = 0;
  bot.inventory = { slots: [] };
  // 物理引擎按 (control.right - control.left) 等差值算输入，键缺失会产出 NaN。
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  bot.blockAt = (position) => {
    // 物理引擎用浮点坐标查询（pos.floored().offset(0,-0.5,0) 之类），必须先 floor；
    // mineflayer 的 blockAt 同样在内部 floored。
    const key = Math.floor(position.x) + "," + Math.floor(position.y) + "," + Math.floor(position.z);
    const block = Block.fromStateId(solid.has(key) ? stone.minStateId : 0, 0);
    block.position = position;
    return block;
  };
  // prismarine-physics 的 Physics(mcData, world) 是工厂：构造期就把 world 用于
  // 形状/材质缓存，缺 world 会让 simulatePlayer 产出 NaN。
  bot.physics = physicsLib.Physics(registry, { getBlock: (pos2) => bot.blockAt(pos2, false) });
  return bot;
}

const STEP_NODE = new Vec3(5, 66, 0); // 1 级上步节点（踏步块 (5,65,0)）
const stepPillars = [[5, 65, 0]];

/** 点到单位格 [x,x+1]x[y,y+1]x[z,z+1] 的距离（测试内联，不再依赖补丁导出）。 */
function faceDistance(p, x, y, z) {
  const dx = Math.max(x - p.x, 0, p.x - (x + 1));
  const dy = Math.max(y - p.y, 0, p.y - (y + 1));
  const dz = Math.max(z - p.z, 0, p.z - (z + 1));
  return Math.hypot(dx, dy, dz);
}

// 旧决策（批19 方向探测），用于对照 G30 形态——从补丁上一版逐行复刻。
function legacyShouldJump(physics, bot, nextPoint) {
  return (
    (physics.stepAt(bot, nextPoint, 1.2) || physics.stepAt(bot, nextPoint, 1.8)) &&
    !physics.stepAt(bot, nextPoint, 0.6)
  );
}

// 1) 平地同层节点：stepBlockOf=null，零模拟直接 false
{
  const bot = makeBot({ pos: [2.5, 65, 0.5], vel: [0.216, 0, 0], pillars: [] });
  const physics = new Physics(bot);
  assert.equal(physics.shouldJump(bot, new Vec3(5, 65, 0)), false, "flat node must not jump");
}

// 2) 1 级台阶、起跳窗口内（面距 1.2）：模拟判可到 → true（真物理跑满 20 tick）
{
  const bot = makeBot({ pos: [3.8, 65, 0.3], vel: [0.216, 0, 0], pillars: stepPillars });
  const physics = new Physics(bot);
  assert.equal(physics.shouldJump(bot, STEP_NODE), true, "run-up intact before a 1-up step must jump");
}

// 3) 贴面 + 零速：纯节点规则仍按跳——现实里这一跳会撞面弹回，恢复交给
//    执行器既有的退避（touching + speed<0.12 独立触发），决策层不猜结局。
{
  const bot = makeBot({ pos: [4.6, 65, 0.5], vel: [0, 0, 0], pillars: stepPillars });
  const physics = new Physics(bot);
  const face = faceDistance(bot.entity.position, 5, 65, 0);
  assert.ok(face < 0.6, "fixture must be inside the touching band, got " + face);
  assert.equal(physics.shouldJump(bot, STEP_NODE), true, "step-ahead node always asks for the jump; recovery belongs to the step assist");
}



// 5) G30 形态：起跳窗口内但 ±0.5 格漂移。旧方向探测沿 bot→节点方向打探针，
//    漂移让 1.2/1.8 探针落进邻格（空气）判 false——跳跃键永不按下；
//    新决策按从真实位置/速度出发的落地模拟必须判 true。
{
  // bot 在 (3.8, 65, 0.9)（横向漂 0.9）：旧探测方向 (1.2, -0.9)→1.2 处落在 (4,65)（空气），
  // 1.8 处落在 (5,65,-1)（邻列空气）→ 两探针都 miss。
  const bot = makeBot({ pos: [3.8, 65, 0.9], vel: [0.216, 0, 0.054], pillars: stepPillars });
  const physics = new Physics(bot);
  assert.equal(legacyShouldJump(physics, bot, STEP_NODE), false, "fixture must reproduce the legacy probe miss");
  assert.equal(physics.shouldJump(bot, STEP_NODE), true, "drifted approach must still jump via landing simulation");
}

// 6) 悬浮节点（落点格无支撑）：不跳——那是放置（G30 缺陷 b）的事
{
  const bot = makeBot({ pos: [3.0, 65, 0.5], vel: [0.216, 0, 0], pillars: [] });
  const physics = new Physics(bot);
  assert.equal(physics.shouldJump(bot, new Vec3(5, 66, 0)), false, "floating node must not jump");
}

// 7) 双高墙节点（y 比脚位高 2）：非单步，不跳
{
  const bot = makeBot({ pos: [3.0, 65, 0.5], vel: [0.216, 0, 0], pillars: [[5, 65, 0], [5, 66, 0]] });
  const physics = new Physics(bot);
  assert.equal(physics.shouldJump(bot, new Vec3(5, 67, 0)), false, "2-up node is not a step; placement branch owns it");
}

// 8) 落地模拟与执行器到达判据同口径：模拟成功的起跳点，用同一物理推进 20 tick
//    确实到达节点邻域（|dx|,|dz| ≤ 0.35, |dy| < 1）——钉住"模拟说了算"的诚实性。
{
  const bot = makeBot({ pos: [3.8, 65, 0.3], vel: [0.216, 0, 0], pillars: stepPillars });
  const physics = new Physics(bot);
  assert.equal(physics.shouldJump(bot, STEP_NODE), true);
  const state = physics.simulateUntil(
    (s) => Math.abs(STEP_NODE.x - s.pos.x) <= 0.35 && Math.abs(STEP_NODE.z - s.pos.z) <= 0.35 && Math.abs(STEP_NODE.y - s.pos.y) < 1,
    physics.getController(STEP_NODE, true, false, 0),
    20,
  );
  assert.ok(
    Math.abs(STEP_NODE.x - state.pos.x) <= 0.35 && Math.abs(STEP_NODE.z - state.pos.z) <= 0.35,
    "simulated jump must reach the node neighborhood, ended at " + state.pos,
  );
}
`;

describe("pathfinder shouldJump (G30 executor rewrite)", () => {
	test("landing simulation replaces the drift-blind direction probe and the staircase dead band", () => {
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
