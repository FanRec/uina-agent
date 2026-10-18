/** Local audible-energy detector. It proposes sparse accents, never semantic emotions. */
export class SpeechBehavior {
	private level = 0;
	private ageMs = Infinity;
	private voicedMs = 0;
	private cooldownMs = 0;
	private candidateAgeMs = 0;
	private slowEnergy = 0;
	private armed = true;
	constructor(
		private readonly random: () => number,
		private readonly staleMs: number,
	) {}
	processLevel(level: { rms: number }): void {
		this.level = Number.isFinite(level.rms) ? Math.max(0, Math.min(1, level.rms)) : 0;
		this.ageMs = 0;
	}
	reset(): void {
		this.level = 0;
		this.ageMs = Infinity;
		this.voicedMs = this.cooldownMs = this.candidateAgeMs = this.slowEnergy = 0;
		this.armed = true;
	}
	step(dtMs: number, suppressed: boolean): boolean {
		this.ageMs += dtMs;
		this.cooldownMs = Math.max(0, this.cooldownMs - dtMs);
		const rms = this.ageMs > this.staleMs ? 0 : this.level;
		if (suppressed || rms <= 0.004) {
			this.voicedMs = this.candidateAgeMs = 0;
			this.slowEnergy = rms;
			this.armed = true;
			return false;
		}
		this.voicedMs += dtMs;
		this.candidateAgeMs += dtMs;
		const rising = rms > Math.max(0.012, this.slowEnergy * 1.35);
		this.slowEnergy += (rms - this.slowEnergy) * (1 - Math.exp(-dtMs / 350));
		if (!rising) this.armed = true;
		// Stable speech gets occasional opportunities too, without turning energy peaks into beats.
		const candidate = (rising && this.armed) || this.candidateAgeMs >= 1200;
		if (!candidate || this.voicedMs <= 500 || this.cooldownMs > 0) return false;
		this.armed = false;
		this.candidateAgeMs = 0;
		// Rejected candidates are consumed; no pending gesture is retained.
		this.cooldownMs = 2500;
		return this.random() < 0.35;
	}
}
