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
};

interface SpringParamState {
	current: number;
	target: number;
	velocity: number;
	startVal?: number;
	tElapsed?: number;
	tDuration?: number;
}

/**
 * Live2D Layer 1: 动力学滤波与姿态导向器 (BodyDirector)
 * 职责：
 * 1. 二阶欠阻尼弹簧解析解 (omega = 15, zeta = 0.45)，数学上绝对稳定；
 * 2. Smootherstep 姿态平滑过渡与时间精确控制；
 * 3. 分段 C1 软限速 (140 deg/s) 与脊柱被动运动学跟随。
 */
export class BodyDirector {
	private readonly params: Map<string, SpringParamState> = new Map();
	private readonly basePoseTargets: Map<string, number> = new Map();
	private holdRemainingMs?: number;
	private livingHoldPhase = 0;

	private readonly omega: number;
	private readonly zeta: number;
	private readonly omegaD: number;
	private readonly maxAngularSpeed: number;
	private onBasePoseExpired?: () => void;

	private static readonly SPINE_COUPLING_RATIO_Z = 0.25;
	private static readonly SPINE_COUPLING_RATIO_X = 0.20;

	constructor(options?: {
		omega?: number;
		zeta?: number;
		maxAngularSpeed?: number;
		onBasePoseExpired?: () => void;
	}) {
		this.omega = options?.omega ?? 15;
		this.zeta = options?.zeta ?? 0.45;
		this.omegaD = this.omega * Math.sqrt(Math.max(0.001, 1 - this.zeta * this.zeta));
		this.maxAngularSpeed = options?.maxAngularSpeed ?? 140;
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

	setTarget(name: string, targetValue: number, additive = false): void {
		const state = this.getOrCreate(name);
		const baseVal = additive ? this.getBasePoseTarget(name) : 0;
		state.target = clampLive2DParam(name, additive ? baseVal + targetValue : targetValue);
		state.tElapsed = undefined;
		state.tDuration = undefined;
	}

	setTargets(targets: readonly Live2DParamTarget[]): void {
		for (const t of targets) {
			this.setTarget(t.name, t.value, t.additive ?? false);
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

	transitionPose(
		targets: Record<string, number>,
		durationMs = 800,
		options?: { additive?: boolean },
	): void {
		for (const [name, targetVal] of Object.entries(targets)) {
			const state = this.getOrCreate(name);
			state.startVal = state.current;
			const baseVal = options?.additive ? this.getBasePoseTarget(name) : 0;
			state.target = clampLive2DParam(name, options?.additive ? baseVal + targetVal : targetVal);
			state.tElapsed = 0;
			state.tDuration = durationMs;
			state.velocity = 0;
		}
	}

	transitionTargets(targets: readonly Live2DParamTarget[], durationMs = 250): void {
		for (const t of targets) {
			const state = this.getOrCreate(t.name);
			state.startVal = state.current;
			const baseVal = t.additive ? this.getBasePoseTarget(t.name) : 0;
			state.target = clampLive2DParam(t.name, t.additive ? baseVal + t.value : t.value);
			state.tElapsed = 0;
			state.tDuration = durationMs;
			state.velocity = 0;
		}
	}

	setBasePose(targets: Record<string, number>, durationMs = 800): void {
		this.basePoseTargets.clear();
		for (const [k, v] of Object.entries(targets)) {
			this.basePoseTargets.set(k, v);
		}
		this.transitionPose(targets, durationMs);
	}

	applyBasePose(
		name: BasePoseName,
		options?: { transitionMs?: number; holdMs?: number } | number,
	): void {
		const transitionMs = typeof options === "number" ? options : (options?.transitionMs ?? 800);
		const holdMs = typeof options === "object" ? options.holdMs : undefined;
		const pose = BASE_POSES[name] ?? BASE_POSES.relaxed;
		this.setBasePose(pose, transitionMs);
		this.holdRemainingMs = holdMs !== undefined && holdMs > 0 ? holdMs : undefined;
	}

	clearBasePose(durationMs = 600): void {
		this.basePoseTargets.clear();
		this.holdRemainingMs = undefined;
		const neutralTargets: Record<string, number> = {};
		for (const name of this.params.keys()) {
			neutralTargets[name] = this.getBasePoseTarget(name);
		}
		if (durationMs > 0) {
			this.transitionPose(neutralTargets, durationMs);
		} else {
			this.dampenToNeutral();
		}
	}

	getBasePoseTarget(name: string): number {
		return this.basePoseTargets.get(name) ?? (name.includes("Eye") && name.includes("Open") ? 1.0 : 0);
	}

	transitionToActivePose(basePose: BasePoseName = "focused"): void {
		this.applyBasePose(basePose, 800);
	}

	transitionToParkedPose(): void {
		this.applyBasePose("relaxed", 800);
	}

	dampenToNeutral(exemptParams?: readonly string[]): void {
		const exempt = exemptParams && exemptParams.length > 0 ? new Set(exemptParams) : null;
		for (const [name, state] of this.params.entries()) {
			if (exempt?.has(name)) continue;
			state.target = this.getBasePoseTarget(name);
			state.velocity *= 0.2;
			state.tElapsed = undefined;
			state.tDuration = undefined;
		}
	}

	tick(deltaMs: number, options?: { isTorsoLocked?: boolean }): Record<string, number> {
		const dt = Math.max(0.0001, deltaMs * 0.001);
		this.updatePassiveSpineCoupling(options?.isTorsoLocked ?? false);

		if (!this.isAnyTransitionActive() && this.holdRemainingMs !== undefined) {
			this.updateLivingHold(deltaMs);
		}

		const result: Record<string, number> = {};
		for (const [name, state] of this.params.entries()) {
			if (state.tElapsed !== undefined && state.tDuration !== undefined && state.startVal !== undefined) {
				this.stepSmootherstep(state, deltaMs);
			} else {
				this.stepAnalyticalOscillator(name, state, dt);
			}
			result[name] = state.current;
		}
		return result;
	}

	private updatePassiveSpineCoupling(isTorsoLocked: boolean): void {
		if (isTorsoLocked) return;

		const headZ = this.params.get("ParamAngleZ");
		if (headZ && headZ.tElapsed === undefined) {
			const deltaHeadZ = headZ.current - this.getBasePoseTarget("ParamAngleZ");
			const targetBodyZ = this.getBasePoseTarget("ParamBodyAngleZ") + BodyDirector.SPINE_COUPLING_RATIO_Z * deltaHeadZ;
			this.applyCoupledTarget("ParamBodyAngleZ", targetBodyZ);
		}

		const headX = this.params.get("ParamAngleX");
		if (headX && headX.tElapsed === undefined) {
			const deltaHeadX = headX.current - this.getBasePoseTarget("ParamAngleX");
			const targetBodyX = this.getBasePoseTarget("ParamBodyAngleX") + BodyDirector.SPINE_COUPLING_RATIO_X * deltaHeadX;
			this.applyCoupledTarget("ParamBodyAngleX", targetBodyX);
		}
	}

	private applyCoupledTarget(name: string, targetValue: number): void {
		const state = this.getOrCreate(name);
		if (state.tElapsed === undefined) {
			state.target = clampLive2DParam(name, targetValue);
		}
	}

	private isAnyTransitionActive(): boolean {
		for (const s of this.params.values()) {
			if (s.tElapsed !== undefined) return true;
		}
		return false;
	}

	private updateLivingHold(deltaMs: number): void {
		this.livingHoldPhase += deltaMs * 0.001;
		this.holdRemainingMs! -= deltaMs;
		const drift = Math.sin(this.livingHoldPhase * 3.14) * 0.05;

		for (const [name, baseVal] of this.basePoseTargets.entries()) {
			if (!name.startsWith("ParamAngle") && !name.startsWith("ParamBodyAngle")) continue;
			const state = this.params.get(name);
			if (state && state.tElapsed === undefined) {
				state.target = baseVal * (1 + drift);
			}
		}

		if (this.holdRemainingMs! <= 0) {
			this.holdRemainingMs = undefined;
			this.clearBasePose(600);
			this.onBasePoseExpired?.();
		}
	}

	private stepSmootherstep(state: SpringParamState, deltaMs: number): void {
		state.tElapsed = (state.tElapsed ?? 0) + deltaMs;
		const t = Math.min(1.0, state.tElapsed / (state.tDuration || 1));
		const s = t * t * t * (t * (t * 6 - 15) + 10);
		const start = state.startVal ?? state.current;
		state.current = start + (state.target - start) * s;

		if (t >= 1.0) {
			state.current = state.target;
			state.tElapsed = undefined;
			state.tDuration = undefined;
		}
	}

	private stepAnalyticalOscillator(name: string, state: SpringParamState, dt: number): void {
		const x0 = state.current - state.target;
		const v0 = state.velocity;

		if (Math.abs(x0) < 0.0001 && Math.abs(v0) < 0.001) {
			state.current = state.target;
			state.velocity = 0;
			return;
		}

		const c1 = x0;
		const c2 = (v0 + this.zeta * this.omega * c1) / this.omegaD;
		const decay = Math.exp(-this.zeta * this.omega * dt);
		const cosW = Math.cos(this.omegaD * dt);
		const sinW = Math.sin(this.omegaD * dt);

		const xT = decay * (c1 * cosW + c2 * sinW);
		const vT = -this.zeta * this.omega * xT + decay * this.omegaD * (-c1 * sinW + c2 * cosW);

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
