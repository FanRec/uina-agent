import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// 批34：圈禁看门狗（NoCloser）。bot 一直在动（每 500ms 摆动 1 格）、从不静止、
// 也从不比历史最近距离更靠近目标——位移窗口与零移动看门狗都判"有进展"，只有
// 圈禁判定能收束它。批34 mine 基线里这种形态烧满 90s 墙钟，NoCloser 把它变成
// ~12s 的 UNREACHABLE（带 gap/bestGap progress 与挖掘提示）。
const source = `
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { GotoDirector } from '${pathToFileURL(resolve(".uina/worlds/minecraft/driver/goto.ts")).href}';
import { DriverControlArbiter } from '${pathToFileURL(resolve(".uina/worlds/minecraft/driver/control-arbiter.ts")).href}';
const require = createRequire(import.meta.url); const mf = createRequire(require.resolve('mineflayer'));
const bot = new EventEmitter();
bot.registry = mf("prismarine-registry")("1.21.11");
bot.entity = { position: { x: 5, y: 64, z: 0 } }; bot.controlState = {}; bot.targetDigBlock = null;
bot.pathfinder = {
	movements: null, goal: { x: 0, y: 64, z: 0 }, setMovements: () => {}, setGoal: () => {}, isMoving: () => true,
	goto: () => new Promise(() => {}),
};
// 摆动：1 格往返（净位移 1 < 6），与目标距离恒在 5~6 之间（从不更近 0.5）。
let swing = 0;
const wiggle = setInterval(() => {
	swing = 1 - swing;
	bot.entity.position = { x: 5 + swing, y: 64, z: 0 };
}, 500);
const director = new GotoDirector({ assertActionAllowed: () => {}, bot: () => bot, host: { state: "ready", identity: { connection: "c", incarnation: "i" }, on: () => () => {} }, arbiter: new DriverControlArbiter(), sink: { record: () => ({ instance: "w", sequence: 1 }), ensureDurable: async () => {} }, mintOp: () => "op:1", mintEff: () => "eff:1" });
const request = { at: { x: 0, y: 64, z: 0 }, tolerance: 1, sprint: false, digThrough: false, placeToReach: false, timeoutMs: 30000 };
const t0 = Date.now();
let outcome;
try { await director.goto(request, new AbortController().signal); outcome = { resolved: true }; }
catch (error) { outcome = { code: error.code, message: error.message, ms: Date.now() - t0 }; }
clearInterval(wiggle);
console.log(JSON.stringify(outcome));
`;
const outcome = JSON.parse(
	execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
		encoding: "utf8",
	}).trim(),
) as { resolved?: boolean; code?: string; message?: string; ms?: number };

test("a loitering navigation is cut by the NoCloser watchdog as UNREACHABLE with a dig hint", () => {
	expect(outcome.resolved).toBeUndefined();
	expect(outcome.code).toBe("UNREACHABLE");
	expect(outcome.message).toContain("without getting closer");
	expect(outcome.message).toContain("climb or a jump");
	// 收束时机：圈禁窗口 12s + 采样余量，远小于 30s 墙钟预算。
	expect(outcome.ms).toBeGreaterThan(11_000);
	expect(outcome.ms).toBeLessThan(20_000);
});
