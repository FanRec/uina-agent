import { type BasePoseName, clampLive2DParam, type Live2DParamTarget } from "./types.js";

/**
 * 具有鲜明二次元 VTuber 辨识度的全身基准姿态定义
 */
export const BASE_POSES: Record<BasePoseName, Record<string, number>> = {
	playful: {
		ParamAngleZ: 18.0,
		ParamAngleX: -5.0,
		ParamBodyAngleX: 8.0,
		ParamEyeBallX: 0.35,
		ParamEyeBallY: 0.15,
		ParamEyeLOpen: 1.0,
		ParamEyeROpen: 1.0,
		ParamMouthForm: 0.8,
		ParamCheek: 0.5,
		ParamBrowLY: 0.2,
		ParamBrowRY: 0.2,
	},
	focused: {
		ParamAngleY: 12.0,
		ParamAngleX: 0,
		ParamAngleZ: 0,
		ParamBodyAngleY: 8.0,
		ParamEyeLOpen: 1.0,
		ParamEyeROpen: 1.0,
		ParamEyeBallX: 0,
		ParamEyeBallY: 0.15,
		ParamBrowLY: -0.15,
		ParamBrowRY: -0.15,
		ParamMouthForm: 0.1,
	},
	relaxed: {
		ParamAngleY: -10.0,
		ParamAngleZ: -8.0,
		ParamAngleX: 4.0,
		ParamBodyAngleY: -6.0,
		ParamEyeLOpen: 0.70,
		ParamEyeROpen: 0.70,
		ParamEyeBallX: 0,
		ParamEyeBallY: -0.2,
		ParamMouthForm: 0.3,
	},
	shy_side: {
		ParamAngleZ: 14.0,
		ParamAngleX: -10.0,
		ParamAngleY: -6.0,
		ParamBodyAngleX: -10.0,
		ParamEyeBallX: 0.65,
		ParamEyeBallY: -0.2,
		ParamEyeLOpen: 0.85,
		ParamEyeROpen: 0.85,
		ParamCheek: 0.85,
		ParamMouthForm: 0.4,
		ParamEyeLSmile: 0.5,
		ParamEyeRSmile: 0.5,
	},
	confident: {
		ParamAngleY: 10.0,
		ParamAngleZ: -4.0,
		ParamAngleX: 2.0,
		ParamBodyAngleY: 10.0,
		ParamBodyAngleX: 4.0,
		ParamEyeBallX: 0,
		ParamEyeBallY: 0.1,
		ParamEyeLOpen: 1.0,
		ParamEyeROpen: 1.0,
		ParamMouthForm: 0.85,
		ParamEyeRSmile: 0.6,
		ParamEyeLSmile: 0.4,
		ParamBrowRY: 0.3,
	},
	listening: {
		ParamAngleZ: -14.0,
		ParamAngleY: 6.0,
		ParamAngleX: 8.0,
		ParamBodyAngleX: 6.0,
		ParamEyeBallX: -0.35,
		ParamEyeBallY: 0.15,
		ParamEyeLOpen: 1.05,
		ParamEyeROpen: 1.05,
		ParamMouthForm: 0.4,
		ParamEyeLSmile: 0.3,
		ParamEyeRSmile: 0.3,
	},
	smug_gremlin: {
		ParamAngleY: 8.0,
		ParamAngleZ: -8.0,
		ParamAngleX: 3.0,
		ParamBodyAngleY: 6.0,
		ParamEyeBallX: 0.1,
		ParamEyeBallY: -0.15,
		ParamEyeLOpen: 0.95,
		ParamEyeROpen: 0.95,
		ParamMouthForm: 0.95,
		ParamEyeRSmile: 0.8,
		ParamEyeLSmile: 0.4,
		ParamBrowRY: 0.4,
	},
	meek_shy: {
		ParamAngleY: -8.0,
		ParamAngleZ: 10.0,
		ParamAngleX: -4.0,
		ParamBodyAngleY: -4.0,
		ParamEyeBallX: 0.2,
		ParamEyeBallY: 0.3,
		ParamEyeLOpen: 0.9,
		ParamEyeROpen: 0.9,
		ParamCheek: 0.8,
		ParamMouthForm: 0.4,
		ParamEyeLSmile: 0.5,
		ParamEyeRSmile: 0.5,
	},
	streamer_hype: {
		ParamAngleY: 10.0,
		ParamAngleZ: 6.0,
		ParamAngleX: 0,
		ParamBodyAngleY: 12.0,
		ParamEyeBallX: 0,
		ParamEyeBallY: 0.1,
		ParamEyeLOpen: 1.15,
		ParamEyeROpen: 1.15,
		ParamMouthForm: 0.9,
		ParamBrowLY: 0.3,
		ParamBrowRY: 0.3,
		ParamCheek: 0.4,
	},
};

interface SpringParamState {
	current: number;
	target: number;
	velocity: number;
	/** 本次目标所用的弹簧刚度缩放（beat 的 snappy/smooth/gentle 与姿态切换节奏由 ω 缩放表达）。 */
	omegaScale?: number;
}

/**
 * Live2D Layer 1: 动力学滤波与姿态导向器 (BodyDirector)
 * 职责：
 * 1. 二阶欠阻尼弹簧解析解 (omega = 10, zeta = 0.32)，数学上绝对稳定；
 *    ζ=0.32 产生 ~35% 过冲回弹（Q 弹感），ω=10 使默认落位进入 ~600ms 可读区间；
 * 2. 全部运动（beat、姿态切换、反射、回正）统一由弹簧承载——动量跨运动延续，
 *    落位带自然回弹；节奏差异由参数级 ω 缩放表达，不再维护第二套插值引擎；
 * 3. 分段 C1 软限速 (360 deg/s) 与脊柱被动运动学跟随。
 */
export class BodyDirector {
	private readonly params: Map<string, SpringParamState> = new Map();
	private readonly basePoseTargets: Map<string, number> = new Map();
	private holdRemainingMs?: number;
	private livingHoldPhase = 0;

	private readonly omega: number;
	private readonly zeta: number;
	private readonly sqrtOneMinusZetaSq: number;
	private readonly maxAngularSpeed: number;
	private onBasePoseExpired?: () => void;

	private static readonly SPINE_COUPLING_RATIO_Z = 0.25;
	private static readonly SPINE_COUPLING_RATIO_X = 0.20;

	// 位移感知速度封顶：欠阻尼弹簧峰值速度 ≈ 位移 × ω × PEAK_SPEED_RATIO，
	// 大位移切换（如思考姿态被 cue 直接接管，位移可达 30°+）会以同样的 ω 产生
	// 成比例的猛冲。对峰值速度封顶后，无论位移多大，切换都不超过"缓"的上限，
	// 且无需为任何衔接点（思考→cue、基准→大 cue、复位被打断）写特判。
	private static readonly MAX_PEAK_SPEED = 150; // deg/s
	private static readonly PEAK_SPEED_RATIO = 0.5; // 欠阻尼首峰速度的工程近似

	constructor(options?: {
		omega?: number;
		zeta?: number;
		maxAngularSpeed?: number;
		onBasePoseExpired?: () => void;
	}) {
		this.omega = options?.omega ?? 10;
		this.zeta = options?.zeta ?? 0.32;
		this.sqrtOneMinusZetaSq = Math.sqrt(Math.max(0.001, 1 - this.zeta * this.zeta));
		this.maxAngularSpeed = options?.maxAngularSpeed ?? 360;
		this.onBasePoseExpired = options?.onBasePoseExpired;
	}

	setOnBasePoseExpired(callback?: () => void): void {
		this.onBasePoseExpired = callback;
	}

	private getOrCreate(name: string, initialValue = 0): SpringParamState {
		let state = this.params.get(name);
		if (!state) {
			state = { current: initialValue, target: initialValue, velocity: 0 };
			this.params.set(name, state);
		}
		return state;
	}

	setTarget(name: string, targetValue: number, additive = false, omegaScale = 1): void {
		const state = this.getOrCreate(name);
		const baseVal = additive ? this.getBasePoseTarget(name) : 0;
		state.target = clampLive2DParam(name, additive ? baseVal + targetValue : targetValue);
		// 位移感知减速：delta 取写入目标与弹簧当前位置的真实距离（additive 用增量幅值），
		// 峰值速度超限时按比例压低该参数的有效 ω，小位移不受影响（节奏档位保持分层）
		const delta = Math.abs(additive ? targetValue : state.target - state.current);
		const rawSpeed = delta * this.omega * omegaScale * BodyDirector.PEAK_SPEED_RATIO;
		if (rawSpeed > BodyDirector.MAX_PEAK_SPEED) {
			omegaScale *= BodyDirector.MAX_PEAK_SPEED / rawSpeed;
		}
		state.omegaScale = omegaScale;
	}

	setTargets(targets: readonly Live2DParamTarget[], options?: { omegaScale?: number }): void {
		const omegaScale = options?.omegaScale ?? 1;
		for (const t of targets) {
			this.setTarget(t.name, t.value, t.additive ?? false, omegaScale);
		}
	}

	applyVelocityImpulse(name: string, deltaV: number): void {
		const state = this.getOrCreate(name);
		state.velocity += deltaV;
	}

	resetVelocity(name: string): void {
		const state = this.params.get(name);
		if (state) {
			state.velocity = 0;
		}
	}

	/** transitionMs（原插值时长语义）映射为弹簧刚度缩放：800ms 为基准档 ω×1.0。 */
	private omegaScaleFor(transitionMs: number): number {
		return Math.max(0.5, Math.min(4, 800 / Math.max(1, transitionMs)));
	}

	/** 设置基准姿态目标集合。注意与 runtime 的 setBasePose(姿态名) 区分：这里接收的是参数集合。 */
	setBasePoseTargets(targets: Record<string, number>, durationMs = 800): void {
		const omegaScale = this.omegaScaleFor(durationMs);
		this.basePoseTargets.clear();
		const list: Live2DParamTarget[] = [];
		for (const [k, v] of Object.entries(targets)) {
			this.basePoseTargets.set(k, v);
			list.push({ name: k, value: v });
		}
		this.setTargets(list, { omegaScale });
	}

	applyBasePose(
		name: BasePoseName,
		options?: { transitionMs?: number; holdMs?: number } | number,
	): void {
		const transitionMs = typeof options === "number" ? options : (options?.transitionMs ?? 800);
		const holdMs = typeof options === "object" ? options.holdMs : undefined;
		const pose = BASE_POSES[name] ?? BASE_POSES.relaxed;
		this.setBasePoseTargets(pose, transitionMs);
		this.holdRemainingMs = holdMs !== undefined && holdMs > 0 ? holdMs : undefined;
	}

	getBasePoseTarget(name: string): number {
		return this.basePoseTargets.get(name) ?? (name.includes("Eye") && name.includes("Open") ? 1.0 : 0);
	}

	/** 当前限时姿态的剩余保持时长（无限时则为 undefined）；供失焦停靠往返时延续倒计时。 */
	getHoldRemainingMs(): number | undefined {
		return this.holdRemainingMs;
	}

	dampenToNeutral(exemptParams?: readonly string[]): void {
		const exempt = exemptParams && exemptParams.length > 0 ? new Set(exemptParams) : null;
		for (const [name, state] of this.params.entries()) {
			if (exempt?.has(name)) continue;
			state.target = this.getBasePoseTarget(name);
			state.velocity *= 0.2;
		}
	}

	/**
	 * 精确阻尼指定参数回归至基准姿态（用于思考反射复位或指定通道复位）
	 */
	dampenParams(names: readonly string[], options?: { omegaScale?: number }): void {
		for (const name of names) {
			const state = this.params.get(name);
			if (state) {
				state.target = this.getBasePoseTarget(name);
				state.velocity *= 0.2;
				if (options?.omegaScale !== undefined) state.omegaScale = options.omegaScale;
			}
		}
	}

	tick(deltaMs: number, options?: { isTorsoLocked?: boolean }): Record<string, number> {
		const dt = Math.max(0.0001, deltaMs * 0.001);
		this.updatePassiveSpineCoupling(options?.isTorsoLocked ?? false);

		// 限时从姿态下达起算（不再区分"过渡期/保持期"——那是插值引擎时代的概念）；
		// drift 的 isNearBase 守卫足以防止踩踏正在执行的 Cue 或 Reflex。
		if (this.holdRemainingMs !== undefined) {
			this.updateLivingHold(deltaMs);
		}

		const result: Record<string, number> = {};
		for (const [name, state] of this.params.entries()) {
			this.stepAnalyticalOscillator(name, state, dt);
			result[name] = state.current;
		}
		return result;
	}

	private updatePassiveSpineCoupling(isTorsoLocked: boolean): void {
		if (isTorsoLocked) return;

		const headZ = this.params.get("ParamAngleZ");
		if (headZ) {
			const deltaHeadZ = headZ.current - this.getBasePoseTarget("ParamAngleZ");
			const targetBodyZ = this.getBasePoseTarget("ParamBodyAngleZ") + BodyDirector.SPINE_COUPLING_RATIO_Z * deltaHeadZ;
			this.applyCoupledTarget("ParamBodyAngleZ", targetBodyZ);
		}

		const headX = this.params.get("ParamAngleX");
		if (headX) {
			const deltaHeadX = headX.current - this.getBasePoseTarget("ParamAngleX");
			const targetBodyX = this.getBasePoseTarget("ParamBodyAngleX") + BodyDirector.SPINE_COUPLING_RATIO_X * deltaHeadX;
			this.applyCoupledTarget("ParamBodyAngleX", targetBodyX);
		}
	}

	private applyCoupledTarget(name: string, targetValue: number): void {
		const state = this.getOrCreate(name);
		state.target = clampLive2DParam(name, targetValue);
	}

	private updateLivingHold(deltaMs: number): void {
		this.livingHoldPhase += deltaMs * 0.001;
		this.holdRemainingMs! -= deltaMs;
		// 呼吸漂移 ±10%（2s 一个完整循环）：hold 定住时保持"活着"的起伏感
		const drift = Math.sin(this.livingHoldPhase * 3.14) * 0.1;

		for (const [name, baseVal] of this.basePoseTargets.entries()) {
			if (!name.startsWith("ParamAngle") && !name.startsWith("ParamBodyAngle")) continue;
			const state = this.params.get(name);
			if (state) {
				// 仅当参数处于基准姿态附近时叠加 living drift，防止踩踏正在执行的 Cue 或 Reflex
				const isNearBase = Math.abs(state.target - baseVal) <= Math.abs(baseVal * 0.1) + 0.15;
				if (isNearBase) {
					state.target = baseVal * (1 + drift);
				}
			}
		}

		if (this.holdRemainingMs! <= 0) {
			this.holdRemainingMs = undefined;
			// 到期回正的语义由上层决定（如切回 relaxed 待机）；本层只负责报时，
			// 不再自行清零基准目标——那会让"回正"变成"回到零位"而非回到待机姿态。
			this.onBasePoseExpired?.();
		}
	}

	private stepAnalyticalOscillator(name: string, state: SpringParamState, dt: number): void {
		// ω 按参数级缩放：beat 的 snappy/smooth/gentle 节奏由刚度表达，而非另起一套插值
		const omega = this.omega * (state.omegaScale ?? 1);
		const omegaD = omega * this.sqrtOneMinusZetaSq;
		const x0 = state.current - state.target;
		const v0 = state.velocity;

		// 贴近即吸附：弹簧渐近收敛永不精确到达，残余 <0.05° / 速度 <0.5°/s 时直接落位
		// （两者均不可感知），使落位语义与旧插值引擎的"精确到达"一致
		if (Math.abs(x0) < 0.05 && Math.abs(v0) < 0.5) {
			state.current = state.target;
			state.velocity = 0;
			return;
		}

		const c1 = x0;
		const c2 = (v0 + this.zeta * omega * c1) / omegaD;
		const decay = Math.exp(-this.zeta * omega * dt);
		const cosW = Math.cos(omegaD * dt);
		const sinW = Math.sin(omegaD * dt);

		const xT = decay * (c1 * cosW + c2 * sinW);
		const vT = -this.zeta * omega * xT + decay * omegaD * (-c1 * sinW + c2 * cosW);

		// 贴近即吸附（步末判定）：大步长单步解析解存在渐近残差且不会经历下一次入口判定，
		// 残余 <0.05° / 速度 <0.5°/s 均不可感知，直接落位使语义与旧插值引擎的"精确到达"一致
		if (Math.abs(xT) < 0.05 && Math.abs(vT) < 0.5) {
			state.current = state.target;
			state.velocity = 0;
			return;
		}

		const candidateCurrent = state.target + xT;

		// 分段 C1 软限速
		if (name.startsWith("ParamAngle") || name.startsWith("ParamBodyAngle")) {
			const unclampedDisplacement = candidateCurrent - state.current;
			const effectiveSpeed = unclampedDisplacement / dt;
			const absSpeed = Math.abs(effectiveSpeed);
			const linearLimit = this.maxAngularSpeed * 0.75;
			if (absSpeed > linearLimit) {
				const headroom = this.maxAngularSpeed - linearLimit;
				const excess = absSpeed - linearLimit;
				const compressed = linearLimit + headroom * Math.tanh(excess / headroom);
				const clampedSpeed = Math.sign(effectiveSpeed) * compressed;
				state.current = state.current + clampedSpeed * dt;
				state.velocity = clampedSpeed;
				return;
			}
		}

		state.current = candidateCurrent;
		state.velocity = vT;
	}

	getParam(name: string): number {
		return this.params.get(name)?.current ?? 0;
	}

	getParamTarget(name: string): number {
		return this.params.get(name)?.target ?? 0;
	}
}
