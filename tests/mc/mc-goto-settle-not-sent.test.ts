/**
 * G35：goto 的结算事实不能把"压根没派发"写成 sent。
 *
 * 一次在规划前就失败的导航（这里用"客户端没有 pathfinder 插件"复现）如果留下
 * `cleanup: sent/unknown`，这条 effect 就会被 `unknownEffectsFor` 判成未决未知效果，
 * 整个 Run 结算成 unknown —— 而实际上它确定什么都没写出去。
 */
import { expect, test } from "vitest";
import type { DriverExecutionFact, DriverExecutionSink } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { DriverControlArbiter } from "../../.uina/worlds/minecraft/driver/control-arbiter.js";
import { GotoDirector } from "../../.uina/worlds/minecraft/driver/goto.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";

function rig() {
	const facts: DriverExecutionFact[] = [];
	const sink: DriverExecutionSink = {
		record: (fact) => {
			facts.push(fact);
			return { instance: "rw:test", sequence: facts.length };
		},
		ensureDurable: async () => {},
	};
	// 假 bot：站位在原点、没有 pathfinder 插件，loadPlugin 直接失败。
	const bot = {
		entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
		game: { dimension: "overworld" },
		controlState: {},
		loadPlugin: () => {
			throw new Error("no pathfinder plugin on this client");
		},
		on: () => {},
		removeListener: () => {},
	} as unknown as MineflayerBot;
	const director = new GotoDirector({
		assertActionAllowed: () => {},
		host: { state: "ready", identity: { connection: "conn:t1", incarnation: "inc:t1" }, on: () => () => {} },
		bot: () => bot,
		sink,
		arbiter: new DriverControlArbiter(),
		mintOp: () => "op:1",
		mintEff: () => "eff:1",
	} as never);
	return { director, facts };
}

test("a navigation that fails before dispatch settles the effect as not_sent", async () => {
	const { director, facts } = rig();
	const failure = await director
		.goto(
			{
				at: { x: 20, y: 64, z: 0 },
				tolerance: 1,
				sprint: false,
				digThrough: false,
				placeToReach: false,
				timeoutMs: 1000,
			},
			new AbortController().signal,
		)
		.then(
			() => null,
			(error: { dispatch?: string; code?: string }) => error,
		);
	// 插件缺失是环境异常，goto 不包装它（原样抛出）；关键在结算事实怎么记。
	expect(failure?.code).toBeUndefined();
	expect(String((failure as { message?: string } | null)?.message)).toMatch(/pathfinder/);
	expect(facts.some((fact) => fact.kind === "dispatch")).toBe(false);
	const cleanup = facts.find((fact) => fact.kind === "cleanup");
	expect(cleanup).toMatchObject({ dispatch: "not_sent", completion: "met" });
});

test("an already-in-range navigation also settles as not_sent instead of an unknown effect", async () => {
	const facts: DriverExecutionFact[] = [];
	const sink: DriverExecutionSink = {
		record: (fact) => {
			facts.push(fact);
			return { instance: "rw:test", sequence: facts.length };
		},
		ensureDurable: async () => {},
	};
	const director = new GotoDirector({
		assertActionAllowed: () => {},
		host: { state: "ready", identity: { connection: "conn:t1", incarnation: "inc:t1" }, on: () => () => {} },
		bot: () =>
			({
				entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
				game: { dimension: "overworld" },
				controlState: {},
				on: () => {},
				removeListener: () => {},
			}) as unknown as MineflayerBot,
		sink,
		arbiter: new DriverControlArbiter(),
		mintOp: () => "op:1",
		mintEff: () => "eff:1",
	} as never);
	// 目标就在脚下：不派发路径，直接按 not_sent/met 结算（§G35 的另一半）。
	const outcome = await director.goto(
		{ at: { x: 0, y: 64, z: 0 }, tolerance: 1, sprint: false, digThrough: false, placeToReach: false, timeoutMs: 1000 },
		new AbortController().signal,
	);
	expect(outcome.receipt).toMatchObject({ dispatch: "not_sent", completion: "met" });
	expect(facts.filter((fact) => fact.kind === "dispatch")).toHaveLength(0);
	expect(facts.find((fact) => fact.kind === "cleanup")).toMatchObject({ dispatch: "not_sent" });
});
