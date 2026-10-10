import { AXES, NEUTRAL_AXES, clampAxis, isMotionAxis } from "./motion-axes.js";

interface ParamMotionState {
	current: number;
	target: number;
	velocity: number;
	acceleration: number;
	omegaScale: number;
}

/** Pure parameter dynamics. Ownership and procedural movement belong to MotionDirector. */
export class BodyDirector {
	private readonly params = new Map<string, ParamMotionState>();
	private readonly maxAngularSpeed: number;
	constructor(options?: { maxAngularSpeed?: number }) {
		this.maxAngularSpeed = options?.maxAngularSpeed ?? 70;
		for (const name of Object.keys(NEUTRAL_AXES)) this.getOrCreate(name);
	}
	private getOrCreate(name: string): ParamMotionState {
		let state = this.params.get(name);
		if (!state) {
			if (!isMotionAxis(name)) throw new Error("Unknown motion axis: " + name);
			const initial = NEUTRAL_AXES[name];
			state = { current: initial, target: initial, velocity: 0, acceleration: 0, omegaScale: 1 };
			this.params.set(name, state);
		}
		return state;
	}
	setTarget(name: string, value: number, omegaScale = 1): void {
		const state = this.getOrCreate(name);
		if (!Number.isFinite(value) || !Number.isFinite(omegaScale)) throw new Error("Non-finite motion target");
		state.target = clampAxis(name, value);
		state.omegaScale = Math.max(0.25, Math.min(4, omegaScale));
	}
	tick(deltaMs: number): Record<string, number> {
		let remaining = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) / 1000 : 0;
		while (remaining > 0) {
			const dt = Math.min(remaining, 1 / 120);
			for (const [name, state] of this.params) this.step(name, state, dt);
			remaining = Math.max(0, remaining - dt);
		}
		return Object.fromEntries([...this.params].map(([name, state]) => [name, state.current]));
	}

	private step(name: string, state: ParamMotionState, dt: number): void {
		if (dt <= 0) return;
		if (!isMotionAxis(name)) throw new Error("Unknown motion axis: " + name);
		const angular = AXES[name].angular;
		// Three repeated real poles: position, velocity AND acceleration survive retargeting.
		// The old underdamped spring overshot and abruptly changed acceleration at every beat.
		const omega = (angular ? 12 : 30) * state.omegaScale;
		const error = state.current - state.target;
		const b = state.velocity + omega * error;
		const c = (state.acceleration + 2 * omega * state.velocity + omega * omega * error) / 2;
		const polynomial = error + b * dt + c * dt * dt;
		const derivative = b + 2 * c * dt;
		const decay = Math.exp(-omega * dt);
		let current = state.target + decay * polynomial;
		let velocity = decay * (derivative - omega * polynomial);
		let acceleration = decay * (2 * c - 2 * omega * derivative + omega * omega * polynomial);
		if (angular) {
			const speed = (current - state.current) / dt;
			if (Math.abs(speed) > this.maxAngularSpeed) {
				current = state.current + Math.sign(speed) * this.maxAngularSpeed * dt;
				velocity = Math.sign(speed) * this.maxAngularSpeed;
				acceleration = 0;
			}
		}
		const bounded = clampAxis(name, current);
		if (bounded !== current) velocity = acceleration = 0;
		state.current = bounded;
		state.velocity = velocity;
		state.acceleration = acceleration;
		const epsilon = angular ? 0.001 : 0.00001;
		if (
			Math.abs(state.current - state.target) < epsilon &&
			Math.abs(velocity) < epsilon * 10 &&
			Math.abs(acceleration) < epsilon * 100
		) {
			state.current = state.target;
			state.velocity = 0;
			state.acceleration = 0;
		}
	}
	getParam(name: string): number {
		return this.params.get(name)?.current ?? (isMotionAxis(name) ? NEUTRAL_AXES[name] : 0);
	}
	getParamTarget(name: string): number {
		return this.params.get(name)?.target ?? (isMotionAxis(name) ? NEUTRAL_AXES[name] : 0);
	}
}
