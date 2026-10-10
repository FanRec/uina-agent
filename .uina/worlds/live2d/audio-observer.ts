import type { MotionDirector } from "./motion-director.js";

export interface AudioObserverOptions {
	gain?: number;
	releaseMs?: number;
	transientThreshold?: number;
	onsetDeltaThreshold?: number;
	refractoryPeriodMs?: number;
}

/** Playback samples are held between updates, then released if the stream goes stale. */
export class AudioObserver {
	private rms = 0;
	private envelope = 0;
	private slowRms = 0;
	private previousRms = 0;
	private ageMs = Infinity;
	private cooldownMs = 0;
	private referenceRms = 0.02;
	private mouthOpenY = 0;
	private director?: MotionDirector;
	constructor(private readonly options: AudioObserverOptions = {}) {}
	setDirector(director: MotionDirector): void {
		this.director = director;
	}
	getMouthOpenY(): number {
		return this.mouthOpenY;
	}
	getSpeechEnergy(): number {
		return Math.min(1, this.envelope / Math.max(0.002, this.referenceRms));
	}
	reset(options?: { immediate?: boolean }): void {
		this.rms = 0;
		this.previousRms = 0;
		this.slowRms = 0;
		this.ageMs = Infinity;
		this.cooldownMs = 0;
		if (options?.immediate) {
			this.envelope = 0;
			this.mouthOpenY = 0;
		}
		// Keep physical envelope and phase continuous; the next ticks release them.
	}
	tick(deltaMs: number): void {
		const elapsed = Math.max(0, deltaMs);
		this.cooldownMs = Math.max(0, this.cooldownMs - elapsed);
		this.ageMs += elapsed;
		const target = this.ageMs <= 100 ? this.rms : 0;
		const tau = target > this.envelope ? 25 : (this.options.releaseMs ?? 90);
		this.envelope += (target - this.envelope) * (1 - Math.exp(-elapsed / tau));
		if (target > 0.0001) {
			const reference = Math.max(0.002, target * 1.6);
			this.referenceRms +=
				(reference - this.referenceRms) * (1 - Math.exp(-elapsed / (reference > this.referenceRms ? 120 : 1200)));
		}
		const gain = this.options.gain ?? 1 / Math.max(0.002, this.referenceRms);
		this.mouthOpenY = Math.max(0, Math.min(1, this.envelope * gain));
		if (this.envelope < 0.000001) {
			this.envelope = 0;
			this.mouthOpenY = 0;
		}
	}
	processLevel(event: { rms: number; peak?: number }): void {
		const rms = Number.isFinite(event.rms) ? Math.max(0, Math.min(1, event.rms)) : 0;
		this.rms = rms;
		this.ageMs = 0;
		const onset = Math.max(rms - this.previousRms, rms - this.slowRms);
		const threshold = this.options.onsetDeltaThreshold ?? Math.max(0.0008, this.referenceRms * 0.15);
		if (rms > (this.options.transientThreshold ?? 0.0018) && onset >= threshold && this.cooldownMs <= 0) {
			this.director?.triggerAcousticImpulse(Math.min(1, onset / Math.max(0.0025, this.referenceRms)));
			this.cooldownMs = this.options.refractoryPeriodMs ?? 220;
		}
		this.slowRms += (rms - this.slowRms) * 0.35;
		this.previousRms = rms;
	}
}
