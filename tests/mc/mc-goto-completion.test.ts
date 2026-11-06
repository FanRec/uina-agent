import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// 上游 lib/goto.js 补丁后：noPath/timeout 空 best 路径按错误名拒绝（不再假 resolve）。
// 本测试锚定 GotoDirector 的两个结算面：goal_reached 的到达确认用与准入同一条
// nodeGap 整数规则；上游 NoPath 拒绝映射为 UNREACHABLE。到达校验（reached 分支
// 的 nodeGap 复核）仍保留——GoalNear 的 isEnd(floored+1) 容忍与 nodeGap 口径有
// 已知语义差，到达精度权威归 Uina（见 goto.ts 内注释）。
const source = `
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { GotoDirector } from '${pathToFileURL(resolve(".uina/worlds/minecraft/driver/goto.ts")).href}';
import { DriverControlArbiter } from '${pathToFileURL(resolve(".uina/worlds/minecraft/driver/control-arbiter.ts")).href}';
const require = createRequire(import.meta.url); const mf = createRequire(require.resolve('mineflayer'));
function director(mode, endX) {
	const bot = new EventEmitter();
	bot.registry = mf("prismarine-registry")("1.21.11");
	bot.entity = { position: { x: 5, y: 64, z: 0 } }; bot.controlState = {}; bot.targetDigBlock = null;
	// 修补后的上游语义形态：goal_reached（真实邻域内 resolve）与 noPath 拒绝。
	const goto = mode === "reached"
		? async () => { bot.entity.position = { x: endX, y: 64, z: 0.68 }; }
		: async () => { const error = new Error("No path to the goal!"); error.name = "NoPath"; throw error; };
	bot.pathfinder = { movements: null, goal: null, setMovements: () => {}, goto, isMoving: () => false };
	let sequence = 0;
	return new GotoDirector({ assertActionAllowed: () => {}, bot: () => bot, host: { state: "ready", identity: { connection: "c", incarnation: "i" }, on: () => () => {} }, arbiter: new DriverControlArbiter(), sink: { record: () => ({ instance: "w", sequence: ++sequence }) }, mintOp: () => \`op:\${++sequence}\`, mintEff: () => \`eff:\${++sequence}\` });
}
const request = { at: { x: 0, y: 64, z: 0 }, tolerance: 1, sprint: false, digThrough: false, placeToReach: false, timeoutMs: 1000 };
const results = [];
try { const result = await director("reached", 1.67).goto(request, new AbortController().signal); results.push(result.receipt.completion); } catch (error) { results.push(error.code ?? error.message); }
try { await director("noPath", 0).goto(request, new AbortController().signal); results.push("resolved"); } catch (error) { results.push(error.code ?? error.message); }
console.log(JSON.stringify(results));
`;
const results = JSON.parse(
	execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8" }).trim(),
) as string[];
test("post-navigation confirmation uses the same integer GoalNear rule as admission", () => {
	expect(results[0]).toBe("met");
});
test("an upstream NoPath rejection maps to UNREACHABLE", () => {
	expect(results[1]).toBe("UNREACHABLE");
});
