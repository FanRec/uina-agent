/**
 * C07 / C08：普通导航默认不改造世界，且 route.plan 的 dry-run 与 goto 执行
 * 共用同一份 movement 配置，不会因为默认值不同给出一个"更可达"的假计划。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { HarnessState } from "./mc-capability-harness.js";
import { makeHarness } from "./mc-capability-harness.js";

const url = (relative: string) => pathToFileURL(resolve(relative)).href;

async function captured(input: Record<string, unknown>) {
	const state: HarnessState = { blocks: new Map(), inventory: { slots: [], counts: {} } };
	let seen: Record<string, unknown> | null = null;
	const harness = makeHarness(state, { onGoto: (request) => (seen = request as Record<string, unknown>) });
	await harness.callable("goto@1").invoke(harness.ctx, input as JsonValue);
	return seen;
}

test("C07 goto@1 未授权时不垫块；显式 true 才允许施工", async () => {
	const plain = await captured({ at: { x: 12, y: 64, z: 10 }, tolerance: 2 });
	expect(plain).toMatchObject({ placeToReach: false, digThrough: false });
	const authorized = await captured({ at: { x: 12, y: 64, z: 10 }, tolerance: 2, placeToReach: true });
	expect(authorized).toMatchObject({ placeToReach: true });
	// descriptor 的公开文案必须与实际默认一致，不能教模型一个已经不存在的默认。
	const descriptor = createCapabilityCatalog()
		.allDescriptors()
		.find((d) => d.ref === "goto@1")!;
	expect(JSON.stringify(descriptor.input)).toContain("default false");
});

test("C08 route.plan@1 声明与 goto 一致，且试算与执行共用同一份 movement 配置", () => {
	const planDescriptor = createCapabilityCatalog()
		.allDescriptors()
		.find((d) => d.ref === "route.plan@1")!;
	expect(JSON.stringify(planDescriptor.input)).toContain("default false");
	const program = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { GotoDirector } from ${JSON.stringify(url(".uina/worlds/minecraft/driver/goto.ts"))};
import { DriverControlArbiter } from ${JSON.stringify(url(".uina/worlds/minecraft/driver/control-arbiter.ts"))};
import { configureMovements } from ${JSON.stringify(url(".uina/worlds/minecraft/driver/mineflayer/pathfinder.ts"))};
const require = createRequire(import.meta.url);
const mfRequire = createRequire(require.resolve('mineflayer'));
const registry = mfRequire('prismarine-registry')('1.21.11');
const Block = mfRequire('prismarine-block')(registry);
const { Vec3 } = mfRequire('vec3');
let captured = null;
const bot = {
  registry,
  game: { dimension: 'minecraft:overworld' },
  entity: { position: new Vec3(0, 64, 0) },
  inventory: { items: () => [{ type: registry.itemsByName.dirt.id, count: 10 }] },
  blockAt(p) { const b = Block.fromStateId(0, 0); b.position = p; return b; },
  loadPlugin() {},
  pathfinder: {
    movements: null,
    setMovements(v) { this.movements = v; },
    getPathFromTo(movements) {
      captured = { scaffolds: movements.scafoldingBlocks.length, tower: movements.allow1by1towers,
                   dig: movements.canDig, sprint: movements.allowSprinting };
      return (function* () { yield { result: { status: 'success', cost: 0, path: [] } }; })();
    }
  }
};
const director = new GotoDirector({
  assertActionAllowed: () => {}, bot: () => bot,
  host: { state: 'ready', identity: { connection: 'c', incarnation: 'i' }, on: () => () => {} },
  sink: { record: () => ({ instance: 'w', sequence: 1 }), ensureDurable: async () => {} },
  arbiter: new DriverControlArbiter(), mintOp: () => 'op:1', mintEff: () => 'eff:1'
});
await director.plan({ at: { x: 5, y: 64, z: 0 }, tolerance: 2 });
assert.deepEqual(captured, { scaffolds: 0, tower: false, dig: false, sprint: true });
configureMovements(bot, { sprint: true, digThrough: false, placeToReach: false });
assert.equal(bot.pathfinder.movements.scafoldingBlocks.length, 0);
configureMovements(bot, { sprint: true, digThrough: false, placeToReach: true });
assert.ok(bot.pathfinder.movements.scafoldingBlocks.length > 0);
console.log(JSON.stringify({ plan: captured }));
`;
	const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
		encoding: "utf8",
		stdio: "pipe",
	}).trim();
	expect(JSON.parse(output).plan).toEqual({ scaffolds: 0, tower: false, dig: false, sprint: true });
});
