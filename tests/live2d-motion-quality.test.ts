import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RigControlDef } from "../.uina/worlds/live2d/adapter/rig.js";
import { type ActionAuthoring, compileAction } from "../.uina/worlds/live2d/authoring/action.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

/**
 * 动作质量自动回归（review E）。
 *
 * 过去 20 个动作的美学只有逐条手写 spot check（curious 的 roll 在 7.5–10 度之间…），
 * 新增或改动动作时没有任何通用网：公式写错、曲线断点、忘记回中、整体被压扁，都只能靠肉眼看。
 *
 * 这里对目录里每个动作（含变体、含背景 idle/thinking/sway）做一次通用采样，锁两样东西：
 * 1. 硬性不变量（不依赖基线表）：不出界、不跳变、非有限值为零、结束回中、动得起来。
 * 2. 基线带（fixtures/live2d-motion-profile.json）：每个轴 peak-to-peak 与残留必须落在
 *    上轮记录的宽带内。改动动作就更新基线，并把差异看清楚——这就是"审查这次改了什么"。
 */

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const PROFILE_PATH = new URL("./fixtures/live2d-motion-profile.json", import.meta.url);
const UPDATE = process.env.UINA_UPDATE_MOTION_PROFILE === "1";

type Controls = Readonly<Record<string, RigControlDef>>;

interface AxisStats {
	/** 采样窗口内峰值与谷值之差，单位与轴相同。 */
	peakToPeak: number;
	/** 单帧最大变化量：断点或瞬移会把它顶上去。 */
	maxStep: number;
	/** 淡出结束后相对中性的残留（绝对值）。 */
	residual: number;
	peak: number;
	trough: number;
}

interface MotionProfile {
	durationMs: number;
	/**
	 * 动作"主驱动"的轴（absolute 通道）。baseline-offset 通道是修正量（如 nod 的 torso.yaw 减 head），
	 * 位移本来就是亚度级；其余未列出的轴是头跟随/自主层带出来的，都不适用"作者意图"类断言。
	 */
	authored: string[];
	axes: Record<string, AxisStats>;
}

type ProfileTable = Record<string, MotionProfile>;

/** 一条待测动作：目录键 + 作者函数。 */
interface Case {
	key: string;
	authoring: ActionAuthoring;
}

/** 一次采样的结果：可写入基线的形状 + 采样过程中真的被削掉的轴（已带动作名，便于定位）。 */
interface Sample {
	profile: MotionProfile;
	clampFailures: string[];
}

function emptyStats(): AxisStats {
	return {
		peakToPeak: 0,
		maxStep: 0,
		residual: 0,
		peak: Number.NEGATIVE_INFINITY,
		trough: Number.POSITIVE_INFINITY,
	};
}

function sampleMotion(key: string, authoring: ActionAuthoring, controls: Controls): Sample {
	const compiled = compileAction(authoring, controls, () => 0.5);
	const director = new MotionDirector(controls, { diagnostics: true });
	const neutral: Record<string, number> = {};
	for (const [axis, control] of Object.entries(controls)) neutral[axis] = control.neutral;

	const axes: Record<string, AxisStats> = {};
	const clampFailures: string[] = [];
	let previous: Readonly<Record<string, number>> = {};
	const record = (frame: Readonly<Record<string, number>>) => {
		for (const [axis, value] of Object.entries(frame)) {
			if (!controls[axis]) continue;
			const stats = (axes[axis] ??= emptyStats());
			stats.peak = Math.max(stats.peak, value);
			stats.trough = Math.min(stats.trough, value);
			const before = previous[axis];
			if (before !== undefined) stats.maxStep = Math.max(stats.maxStep, Math.abs(value - before));
		}
		previous = frame;
	};

	director.play(compiled, { category: "voluntary", atomic: true, fadeInMs: 0, fadeOutMs: 250 });
	record(director.currentFrame);
	// 采样到淡出结束：自然结束后仍有 250ms 的 release，回中要算在里面。
	const totalMs = compiled.durationMs + 500;
	for (let t = FRAME_MS; t <= totalMs; t += FRAME_MS) {
		director.step(FRAME_MS);
		record(director.currentFrame);
		for (const hit of director.getActionDiagnostics()?.clampHits ?? []) {
			// 只有"真的被削掉"才算缺陷：眼皮闭合通道相加时出现 1e-16 级溢出属于浮点噪声，
			// 安全网本来就该接住它，把它当失败只会训练人忽略告警。
			if (Math.abs(hit.requested - hit.value) > 1e-6)
				clampFailures.push(`${key} ${hit.axis} 触到控制边界（requested ${hit.requested}，实际 ${hit.value}）`);
		}
	}

	for (const [axis, stats] of Object.entries(axes)) {
		stats.peakToPeak = stats.peak - stats.trough;
		stats.residual = Math.abs((previous[axis] ?? neutral[axis] ?? 0) - (neutral[axis] ?? 0));
	}
	const authored = compiled.channels.filter((channel) => channel.space === "absolute").map((channel) => channel.axis);
	return { profile: { durationMs: compiled.durationMs, authored: [...new Set(authored)], axes }, clampFailures };
}

/** 目录全量：动作主定义 + 变体 + 背景 idle/thinking/ambient。 */
function collectCases(catalog: NonNullable<ReturnType<typeof loadCatalog>>): Case[] {
	const cases: Case[] = [];
	for (const record of catalog.list("motion")) {
		cases.push({ key: record.name, authoring: record.entry.definition });
		for (const [index, variant] of (record.entry.variants ?? []).entries())
			cases.push({ key: `${record.name}#${index}`, authoring: variant });
	}
	// 背景角色（idle/thinking）同样属于"动作"，观感回归不能漏掉它们。
	const background = catalog.background as Partial<Record<string, ActionAuthoring>>;
	for (const [role, authoring] of Object.entries(background))
		if (typeof authoring === "function") cases.push({ key: `background.${role}`, authoring });
	for (const record of catalog.list("ambient"))
		for (const [index, variant] of [record.entry.motion, ...(record.entry.variants ?? [])].entries())
			cases.push({ key: `ambient.${record.name}#${index}`, authoring: variant });
	return cases;
}

/** rig 与目录只读一次：两个用例共用同一批动作，没必要各加载一遍。 */
let fixture: Promise<{ controls: Controls; cases: Case[] }> | undefined;
function loadFixture(): Promise<{ controls: Controls; cases: Case[] }> {
	fixture ??= (async () => {
		const rig = await loadRig(MO_MODEL_ID);
		if (!rig) throw new Error("MO rig 未登记");
		const catalog = loadCatalog(rig.modelID, rig);
		if (!catalog) throw new Error("MO 目录未装配");
		return { controls: rig.controls, cases: collectCases(catalog) };
	})();
	return fixture;
}

const inRange = (value: number, min: number, max: number): boolean => value >= min - 1e-6 && value <= max + 1e-6;

function invariantFailures(key: string, profile: MotionProfile, controls: Controls): string[] {
	const failures: string[] = [];
	const authored = new Set(profile.authored);
	for (const [axis, stats] of Object.entries(profile.axes)) {
		const control = controls[axis]!;
		const range = control.max - control.min;
		const label = `${key} ${axis}`;
		if (!Number.isFinite(stats.peak) || !Number.isFinite(stats.trough)) {
			failures.push(`${label} 出现非有限值`);
			continue;
		}
		if (!inRange(stats.peak, control.min, control.max) || !inRange(stats.trough, control.min, control.max))
			failures.push(
				`${label} 越界 ${stats.trough.toFixed(3)}..${stats.peak.toFixed(3)}（允许 ${control.min}..${control.max}）`,
			);
		// 单帧跳变：超过整个量程的 35% 基本只能是断点或瞬移，而不是人在动。
		if (stats.maxStep > range * 0.35)
			failures.push(`${label} 单帧跳变 ${stats.maxStep.toFixed(3)}（量程 ${range.toFixed(3)}）`);
		if (!authored.has(axis)) continue;
		// 回中：动作结束 + 淡出后不应留下明显残差（超过量程 8%）。
		if (stats.residual > range * 0.08) failures.push(`${label} 结束残留 ${stats.residual.toFixed(3)}`);
		// 动得起来：作者驱动的轴必须有可见位移。用"量程的比例"而不是绝对值，
		// 因为 gaze 这类归一化轴的 0.1 本身就是大动作，而 torso 的 0.4° 是头跟随的余量。
		if (stats.peakToPeak > 1e-9 && stats.peakToPeak < range * 0.02)
			failures.push(`${label} 位移过小 ${stats.peakToPeak.toFixed(4)}`);
	}
	return failures;
}

function driftFailures(key: string, actual: MotionProfile, expected: MotionProfile, controls: Controls): string[] {
	const drifted: string[] = [];
	if (Math.abs(actual.durationMs - expected.durationMs) > 1)
		drifted.push(`${key} 时长 ${expected.durationMs} → ${actual.durationMs}`);
	for (const [axis, stats] of Object.entries(actual.axes)) {
		const prior = expected.axes[axis];
		if (!prior) continue;
		const control = controls[axis]!;
		const range = control.max - control.min;
		// 幅度带：采样完全确定性（固定 rng + 固定步长），所以带可以收紧到 ±25%。
		// 超过就说明动作被放大/压扁了，必须显式更新基线，而不是悄悄滑过去。
		const ratio = prior.peakToPeak < 1e-6 ? 1 : stats.peakToPeak / prior.peakToPeak;
		if (ratio < 0.75 || ratio > 1.33)
			drifted.push(
				`${key} ${axis} 幅度 ${prior.peakToPeak.toFixed(3)} → ${stats.peakToPeak.toFixed(3)}（×${ratio.toFixed(2)}）`,
			);
		// 位置带：幅度没变但整体平移（比如忘了减 head、或基准换了）同样要报。
		for (const edge of ["peak", "trough"] as const)
			if (Math.abs(stats[edge] - prior[edge]) > range * 0.15)
				drifted.push(
					`${key} ${axis} ${edge} ${prior[edge].toFixed(3)} → ${stats[edge].toFixed(3)}（量程 ${range.toFixed(2)}）`,
				);
		if (Math.abs(stats.residual - prior.residual) > 0.05)
			drifted.push(`${key} ${axis} 残留 ${prior.residual.toFixed(3)} → ${stats.residual.toFixed(3)}`);
	}
	return drifted;
}

describe("Live2D 动作质量自动回归", () => {
	it("目录里每个动作都满足通用不变量", async () => {
		const { controls, cases } = await loadFixture();
		expect(cases.length).toBeGreaterThanOrEqual(25);

		const profiles: ProfileTable = {};
		const failures: string[] = [];
		for (const { key, authoring } of cases) {
			const sample = sampleMotion(key, authoring, controls);
			profiles[key] = sample.profile;
			failures.push(...sample.clampFailures, ...invariantFailures(key, sample.profile, controls));
		}
		if (UPDATE) writeFileSync(PROFILE_PATH, `${JSON.stringify(profiles, null, "\t")}\n`, "utf8");
		expect(failures, failures.join("\n")).toEqual([]);
	});

	it("动作形状与基线一致：改动必须在基线带内，否则要更新基线并说明原因", async () => {
		const { controls, cases } = await loadFixture();
		expect(existsSync(PROFILE_PATH), "基线缺失：UINA_UPDATE_MOTION_PROFILE=1 生成").toBe(true);
		const baseline = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as ProfileTable;
		const drifted: string[] = [];
		for (const { key, authoring } of cases) {
			const expected = baseline[key];
			if (!expected) {
				drifted.push(`${key} 不在基线表里（新动作：UINA_UPDATE_MOTION_PROFILE=1 重新生成）`);
				continue;
			}
			drifted.push(...driftFailures(key, sampleMotion(key, authoring, controls).profile, expected, controls));
		}
		expect(drifted, drifted.join("\n")).toEqual([]);
	});
});
