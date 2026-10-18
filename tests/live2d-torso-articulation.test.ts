import { describe, expect, it } from "vitest";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { absolute, compileAction, keys, motion, offset } from "../.uina/worlds/live2d/authoring/index.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

const flat = (value: number) =>
	keys([
		[0, value],
		[1200, value],
	]);

/** rig 是只读的静态资源，整个文件加载一次即可。 */
let rigPromise: Promise<ModelRig> | undefined;
function rig(): Promise<ModelRig> {
	rigPromise ??= loadRig(MO_MODEL_ID).then((loaded) => {
		if (!loaded) throw new Error("MO rig 未登记");
		return loaded;
	});
	return rigPromise;
}

/** 把 director 推进到动作稳态（默认管道有弹簧/平滑，短步长足够收敛）。 */
function settle(director: MotionDirector, durationMs = 1200): void {
	for (let elapsed = 0; elapsed < durationMs; elapsed += 20) director.step(20);
}

/**
 * torso 语义回归（review 缺陷 B）：躯干偏移"默认叠加在 head 合成结果上"是隐式约定，
 * 以前只靠注释维系——作者漏写 `- head` 会让躯干双倍旋转，而类型检查、单测、门禁全部放行。
 * 现在基线偏移的 torso 通道必须声明 `torso: "head-relative" | "absolute"`，编译期拒绝。
 */
describe("torso 语义声明", () => {
	it("baseline-offset torso 通道未声明语义时拒绝编译", async () => {
		const { controls } = await rig();
		expect(() => compileAction(motion(1200, { "torso.yaw": offset(flat(2)) }), controls)).toThrow(/未声明 torso/);
	});

	it("absolute torso 通道不需要声明：数值本身就是目标角", async () => {
		const { controls } = await rig();
		const clip = compileAction(motion(1200, { "torso.yaw": absolute(flat(2)) }), controls);
		expect(clip.torso).toBeUndefined();
	});

	// 两种语义只差"目标角怎么算"：head-relative 的躯干增量再叠加 head 合成值（4 + 2），
	// absolute 的数值本身就是目标角（2）。所以合成一条参数化用例。
	it.each([
		{ articulation: "head-relative", torsoYaw: 6 },
		{ articulation: "absolute", torsoYaw: 2 },
	] as const)("$articulation：躯干到达 $torsoYaw 度", async ({ articulation, torsoYaw }) => {
		const loaded = await rig();
		const director = new MotionDirector(loaded.controls);
		const clip = compileAction(
			motion(1200, { "head.yaw": absolute(flat(4)), "torso.yaw": offset(flat(2)) }, articulation),
			loaded.controls,
		);
		director.play(clip, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0, atomic: false });
		settle(director);
		expect(director.currentFrame["head.yaw"]).toBeCloseTo(4, 0);
		expect(director.currentFrame["torso.yaw"]).toBeCloseTo(torsoYaw, 0);
	});

	it("显式声明会随 compileAction 冻结进编译结果", async () => {
		const { controls } = await rig();
		expect(compileAction(motion(1200, { "torso.yaw": offset(flat(2)) }, "head-relative"), controls).torso).toBe(
			"head-relative",
		);
		expect(compileAction(motion(1200, { "torso.yaw": offset(flat(2)) }, "absolute"), controls).torso).toBe("absolute");
	});

	it("未知语义在编译期报错", async () => {
		const { controls } = await rig();
		expect(() =>
			compileAction(
				() => ({ ...motion(1200, { "torso.yaw": offset(flat(2)) })(() => 0.5), torso: "sideways" as never }),
				controls,
			),
		).toThrow(/未知 torso 语义/);
	});
});
