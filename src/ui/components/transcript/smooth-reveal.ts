/**
 * 流式平滑揭示控制器（严格复刻 dsh-TUI / oh-my-pi Smooth Streaming 机制）。
 *
 * 特性：
 * 1. 独立 ~20fps 调度器（REVEAL_FRAME_MS = 50ms），解耦“模型交付文本速度”与“终端绘制速度”；
 * 2. 自适应指数衰减追赶算法：
 *    step = max(MIN_STEP, ceil(backlog / CATCHUP_FRAMES))
 *    大块批次吐字时前几帧消化绝大部分内容，随后平缓收尾；匀速流式保持恒定打字机节奏；
 * 3. UTF-16 代理对边界保护（safeSliceEnd）：决不在高低代理项中间切断字符，防止乱码；
 * 4. Fast-Forward 快进保护机制：在 turn_end、tool_start、中断或取消时，立即快进至 100%，
 *    确保交互零滞后。
 */

export const REVEAL_FRAME_MS = 1000 / 20; // 50ms (20fps)
export const REVEAL_MIN_STEP = 3;
export const REVEAL_CATCHUP_FRAMES = 8;

/**
 * 自适应单帧追赶步长（导出供单元测试）
 */
export function revealStep(backlog: number): number {
	return Math.max(REVEAL_MIN_STEP, Math.ceil(Math.max(0, backlog) / REVEAL_CATCHUP_FRAMES));
}

/**
 * UTF-16 边界切片保护：决不在代理对中间截断
 */
export function safeSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const code = text.charCodeAt(end - 1);
	// 若前一个字符是高位代理，且后一个字符是低位代理，则向后多取一个或向前退一个
	if (code >= 0xd800 && code <= 0xdbff) {
		return end + 1 <= text.length ? end + 1 : end - 1;
	}
	return end;
}

export interface TextRevealCursor {
	text: string;
	revealed: number;
}

export class SmoothRevealController {
	private readonly textCursors = new Map<string, TextRevealCursor>();
	private readonly completedReveals = new Set<string>();
	private static readonly COMPLETED_REVEALS_MAX = 2048;
	private timer: NodeJS.Timeout | null = null;
	private onTick?: () => void;
	private enabled = false;

	constructor(options?: { onTick?: () => void; enabled?: boolean }) {
		this.onTick = options?.onTick;
		this.enabled = options?.enabled ?? false;
	}

	private markCompleted(key: string): void {
		if (this.completedReveals.size >= SmoothRevealController.COMPLETED_REVEALS_MAX) {
			let drop = Math.floor(SmoothRevealController.COMPLETED_REVEALS_MAX / 2);
			for (const old of this.completedReveals) {
				if (drop-- <= 0) break;
				this.completedReveals.delete(old);
			}
		}
		this.completedReveals.add(key);
	}

	setOnTick(cb: () => void): void {
		this.onTick = cb;
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		if (!enabled) {
			this.snapToLatest();
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * 输入新的全量文本，更新追赶目标
	 */
	feed(key: string, fullText: string): void {
		if (!this.enabled) return;
		if (this.completedReveals.has(key)) return;

		const cursor = this.textCursors.get(key);
		if (!cursor) {
			this.completedReveals.delete(key);
			const initialStep = Math.min(fullText.length, revealStep(fullText.length));
			this.textCursors.set(key, { text: fullText, revealed: initialStep });
		} else {
			cursor.text = fullText;
		}

		this.ensureTimer();
	}

	/**
	 * 获取指定键当前已平滑释放的文本切片
	 */
	getRevealedText(key: string, fullText: string, active = true): string {
		if (!this.enabled || !active) {
			return fullText;
		}

		if (this.completedReveals.has(key)) {
			return fullText;
		}

		let cursor = this.textCursors.get(key);
		if (!cursor) {
			// 首次读取且活跃
			const initialStep = Math.min(fullText.length, revealStep(fullText.length));
			cursor = { text: fullText, revealed: initialStep };
			this.textCursors.set(key, cursor);
			this.ensureTimer();
		} else {
			cursor.text = fullText;
		}

		const safeEnd = safeSliceEnd(cursor.text, cursor.revealed);
		return cursor.text.slice(0, safeEnd);
	}

	/**
	 * 快进至 100%（针对特定 key 或全部活动游标）
	 */
	snapToLatest(key?: string): void {
		if (key !== undefined) {
			this.textCursors.delete(key);
			this.markCompleted(key);
		} else {
			for (const [k] of this.textCursors) {
				this.markCompleted(k);
			}
			this.textCursors.clear();
		}
		this.stopTimerIfIdle();
	}

	/**
	 * 是否全部揭示完成
	 */
	isSettled(key?: string): boolean {
		if (key !== undefined) {
			if (this.completedReveals.has(key)) return true;
			const cursor = this.textCursors.get(key);
			if (!cursor) return true;
			return cursor.revealed >= cursor.text.length;
		}
		return this.textCursors.size === 0;
	}

	/**
	 * 重置清空所有状态
	 */
	reset(): void {
		this.snapToLatest();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private ensureTimer(): void {
		if (this.timer === null && this.textCursors.size > 0) {
			this.timer = setInterval(() => this.tick(), REVEAL_FRAME_MS);
			this.timer.unref?.();
		}
	}

	private stopTimerIfIdle(): void {
		if (this.textCursors.size === 0 && this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private tick(): void {
		let advanced = false;
		for (const [key, cursor] of this.textCursors) {
			const total = cursor.text.length;
			if (cursor.revealed >= total) {
				this.textCursors.delete(key);
				this.markCompleted(key);
				continue;
			}

			const step = revealStep(total - cursor.revealed);
			cursor.revealed = Math.min(total, cursor.revealed + step);
			advanced = true;
		}

		if (advanced) {
			this.onTick?.();
		} else {
			this.stopTimerIfIdle();
		}
	}
}
