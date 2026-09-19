import { vi } from "vitest";

/**
 * 确定性虚拟时钟：
 * 包装 Vitest fake timers，提供直观的毫秒级时间步进与快进能力，
 * 消除真实物理时间等待（setTimeout），杜绝 CI 上的 Flaky Tests。
 */
export class VirtualClock {
	private active = false;

	start(initialTime: number | Date = 1_700_000_000_000): this {
		if (!this.active) {
			vi.useFakeTimers();
			this.active = true;
		}
		vi.setSystemTime(initialTime);
		return this;
	}

	setSystemTime(time: number | Date): void {
		if (!this.active) this.start(time);
		else vi.setSystemTime(time);
	}

	advanceTime(ms: number): void {
		if (!this.active) this.start();
		vi.advanceTimersByTime(ms);
	}

	runAllTimers(): void {
		if (this.active) vi.runAllTimers();
	}

	now(): number {
		return Date.now();
	}

	dispose(): void {
		if (this.active) {
			vi.useRealTimers();
			this.active = false;
		}
	}
}
