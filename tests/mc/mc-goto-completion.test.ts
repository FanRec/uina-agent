import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, test } from "vitest";
const source = `
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { GotoDirector } from '${pathToFileURL(resolve(".uina/worlds/minecraft/driver/goto.ts")).href}';
import { DriverControlArbiter } from '${pathToFileURL(resolve(".uina/worlds/minecraft/driver/control-arbiter.ts")).href}';
const require = createRequire(import.meta.url); const mf = createRequire(require.resolve('mineflayer'));
function director(endX) {
	const bot = new EventEmitter();
	bot.registry = mf("prismarine-registry")("1.21.11");
	bot.entity = { position: { x: 5, y: 64, z: 0 } }; bot.controlState = {}; bot.targetDigBlock = null;
	bot.pathfinder = { movements: null, goal: null, setMovements: () => {}, goto: async () => { bot.entity.position = { x: endX, y: 64, z: 0.68 }; }, isMoving: () => false };
	let sequence = 0;
	return new GotoDirector({ assertActionAllowed: () => {}, bot: () => bot, host: { state: "ready", identity: { connection: "c", incarnation: "i" }, on: () => () => {} }, arbiter: new DriverControlArbiter(), sink: { record: () => ({ instance: "w", sequence: ++sequence }) }, mintOp: () => \`op:\${++sequence}\`, mintEff: () => \`eff:\${++sequence}\` });
}
const request = { at: { x: 0, y: 64, z: 0 }, tolerance: 1, sprint: false, digThrough: false, placeToReach: false, timeoutMs: 1000 };
const results=[];for(const x of [1.67,3.2]){try{const result=await director(x).goto(request,new AbortController().signal);results.push(result.receipt.completion);}catch(error){results.push(error.code ?? error.message);}}console.log(JSON.stringify(results));
`;
const results = JSON.parse(
	execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8" }).trim(),
) as string[];
test("post-navigation confirmation uses the same integer GoalNear rule as admission", () => {
	expect(results[0]).toBe("met");
});
test("an empty-path resolution outside GoalNear still fails", () => {
	expect(results[1]).toBe("UNREACHABLE");
});
