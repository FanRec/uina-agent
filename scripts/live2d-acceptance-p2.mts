/**
 * P2-3 + P3-2 画面验收脚本（本机 VTS + MO 模型）。
 *
 * 运行：npx tsx scripts/live2d-acceptance-p2.mts（需 VTS Desktop 运行且已加载 MO 模型）
 *
 * 覆盖清单项：
 * - #1 低头姿态叠加点头手势（baseline-offset），手势收势后回归 -8° 低头位；
 * - #3 微笑 + 笑眼 0.8，自律眨眼仍完全闭拢再回 0.8（眼睑调制）；
 * - #4 惊跳（reflex）取消冲突手势：voluntary atomic 整场 cancelled；
 * - #6 patch 并发：姿态 patch / 表情 patch / 手势播放三者互不干扰；
 * - #5 视线锚定头动补偿（P3-2）：attention 锚定 user，头左右转时 gaze 反向补偿保持看向锚点；
 * - #2 语音电平张嘴（P3-2）：levelSink 按 20ms 窗投递 rms → 张嘴起伏；停止后失联守卫 + 50ms 释放回零。
 *
 * 脚本只驱动 director + composeTick 合成链，与生产 tick 合约同一路径。
 */
import readline from "node:readline/promises";
import { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileMotion, motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { MO_SPEECH } from "../.uina/worlds/live2d/models/mo/speech.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

const rig = await loadRig(MO_MODEL_ID);
if (!rig) {
	console.error("rig 装配失败，无法验收。");
	process.exit(1);
}

const rt = new Live2DRuntime({ client: new VTSClient(), rig, speech: MO_SPEECH });
await rt.start({} as never);

// 与 runtime.tick 相同的合约：实测 dt → composeTick（钳制 250ms）。
let last = performance.now();
const ticker = setInterval(() => {
	const now = performance.now();
	rt.composeTick(Math.min(now - last, 250));
	last = now;
}, 1000 / 60);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("Live2D P2-3 画面验收。确认 VTS 中模型已被接管（中性姿态）后开始。");

// ---------- #1 低头 + 点头回归 ----------
console.log("\n=== #1 低头姿态（head.pitch=-8）叠加点头手势，收势回归 -8° ===");
await rt.director!.setPosture({ "head.pitch": -8 });
await wait(1500);
const nod = compileMotion(
	motion(
		3200,
		track(
			"head.pitch",
			[
				[0, 0],
				[400, 3],
				[800, -1.5],
				[1200, 3],
				[1600, 0],
				[3200, 0],
			],
			"baseline-offset",
		),
	),
	rig.controls,
);
const nodHandle = rt.director!.play(nod, { category: "voluntary", fadeInMs: 150, fadeOutMs: 600 });
await nodHandle.finished;
console.log("点头已收势。观察：头部是否回到 -8° 低头位（引擎 #1）。");
await wait(1000);
await rt.director!.setPosture({});
await wait(600); // 槽位归中过渡（350ms）沉降后再切下一项

// ---------- #3 微笑眨眼闭拢 ----------
console.log("\n=== #3 微笑（mouth.form=0.7）+ 笑眼 0.8，眨眼应完全闭拢再回 0.8 ===");
await rt.director!.setExpression({ "mouth.form": 0.7, "eyes.left.open": 0.8, "eyes.right.open": 0.8 });
console.log("观察 8 秒（眨眼间隔约 2~3.5s）：每次眨眼应全闭后回到 0.8 笑眼。");
await wait(8000);
await rt.director!.setExpression({});
await wait(600);

// ---------- #4 惊跳取消冲突手势 ----------
console.log("\n=== #4 播放手势 1.2s 后惊跳（reflex），手势应整场取消 ===");
const wave = compileMotion(
	motion(
		5000,
		track("head.yaw", [
			[0, 0],
			[1250, 8],
			[2500, -8],
			[3750, 4],
			[5000, 0],
		]),
	),
	rig.controls,
);
const waveHandle = rt.director!.play(wave, { category: "voluntary" });
await wait(1200);
const startle = compileMotion(
	motion(
		700,
		track("head.yaw", [
			[0, 0],
			[80, -7],
			[160, 4],
			[260, -2],
			[700, 0],
		]),
		track("head.roll", [
			[0, 0],
			[80, 5],
			[200, -3],
			[700, 0],
		]),
	),
	rig.controls,
);
rt.director!.play(startle, { category: "reflex", fadeInMs: 0 });
const waveResult = await waveHandle.finished;
console.log(`手势结算: ${waveResult.status}（期望 cancelled）；惊跳后头部平滑回位。`);
await wait(800);

// ---------- #5 视线锚定头动补偿 ----------
console.log("\n=== #5 attention 锚定 user，头部左右慢转（±6°/3s），gaze 应反向补偿保持看向锚点 ===");
console.log("若某侧头部到位后眼球才'突然回正'，而另一侧全程锁定 → 疑似模型内部 EyeBall 物理不对称（P5 校准项）。");
rt.director!.setAttention("user", { holdMs: 13000 });
await rt.director!.setPosture({ "head.yaw": 6 }, { durationMs: 3000 });
await wait(2400);
await rt.director!.setPosture({ "head.yaw": -6 }, { durationMs: 3000 });
await wait(2400);
await rt.director!.setPosture({}, { durationMs: 1500 });
await wait(2700); // holdMs 13000 覆盖全程，此后 attention 自动清除、gaze 回中
console.log("观察要点：头转向期间眼球反向偏移（视线不离锚点），头回正后眼睛回中。");
await wait(800);

// ---------- #2 语音电平张嘴 ----------
console.log("\n=== #2 语音电平张嘴：levelSink 按 20ms 窗投递 rms（音节节奏慢包络），张嘴随语音起伏 ===");
const t0 = performance.now();
const speakTimer = setInterval(() => {
	const s = (performance.now() - t0) / 1000;
	// 音节节奏 ~3Hz 包络 + 慢调制，模拟自然语音起伏（白噪声观感过快，非链路问题）。
	const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * s + 2 * Math.sin(2 * Math.PI * 0.6 * s));
	rt.levelSink!.processLevel({ rms: 0.01 + env * 0.12 });
}, 20);
await wait(4000);
clearInterval(speakTimer);
console.log("语音结束。观察：嘴在 ~0.2s 内闭合（失联守卫 120ms + 引擎释放 50ms），不永久张嘴。");
await wait(1500);

// ---------- #6 patch 并发 ----------
console.log("\n=== #6 姿态 patch / 表情 patch / 手势播放并发，互不干扰 ===");
await rt.director!.setPosture({ "head.pitch": -5, "head.roll": 3 }, { durationMs: 800 });
rt.director!.play(
	compileMotion(
		motion(
			6000,
			track("head.yaw", [
				[0, 0],
				[1500, 6],
				[3000, -6],
				[4500, 3],
				[6000, 0],
			]),
		),
		rig.controls,
	),
	{
		category: "voluntary",
		fadeInMs: 200,
	},
);
await wait(1200); // 入槽沉降后再 patch
await Promise.all([
	rt.director!.patchPosture({ "head.roll": -3 }, { durationMs: 800 }),
	rt.director!.patchExpression({ "mouth.form": 0.5 }, { durationMs: 800 }),
]);
console.log("观察 4 秒：head.roll 缓慢变向、微笑渐现、head.yaw 摆动三者同时进行、互不中断。");
await wait(4000);
await rt.director!.setPosture({}, { durationMs: 800 });
await rt.director!.setExpression({}, { durationMs: 800 });

await wait(1000);
clearInterval(ticker);
rl.close();
await rt.stop();
console.log("\n验收脚本结束。观察结果请记录到 docs/proposals/live2d-rebuild-checklist.md P2-3 / P3-2 行。");
