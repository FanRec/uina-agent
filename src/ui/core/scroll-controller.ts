/**
 * ScrollController —— 视口滚动状态与策略的唯一属主。
 *
 * 持有 offset、maxScroll、内容增长补偿、轮次邻居与自动滚屏定时器。
 * UIHost 每帧经 syncFromLayout 回写几何；所有滚动入口（滚轮、rail 点击、
 * 键盘、拖拽、scrollbar）都改写这里的 offset，渲染端只读。
 */
export class ScrollController {
	private offset = 0;
	private maxScroll = 0;
	private lastTotalPerm = 0;
	private turnAbove: number | null = null;
	private turnBelow: number | null = null;
	private autoScrollTimer: NodeJS.Timeout | null = null;
	private autoScrollDirection: "up" | "down" | null = null;

	getOffset(): number {
		return this.offset;
	}

	getMaxScroll(): number {
		return this.maxScroll;
	}

	/** 主动回底（加载会话/点击回最新）：offset 清零并遗忘上次内容规模。 */
	resetTail(): void {
		this.offset = 0;
		this.lastTotalPerm = 0;
	}

	/** 向更早内容翻 lines 行（不夹取，帧末由 syncFromLayout 收敛）。 */
	scrollUp(lines: number): void {
		this.offset += lines;
	}

	/** 向最新内容翻 lines 行，底部截断。 */
	scrollDown(lines: number): void {
		this.offset = Math.max(0, this.offset - lines);
	}

	/** 直达顶部（大数偏移，帧末夹取到 maxScroll）。 */
	scrollToTop(): void {
		this.offset = 999999;
	}

	/** 锚定定位（scrollToTurn / scrollbar 点击）：显式写入并夹取。 */
	setOffset(target: number): void {
		this.offset = Math.max(0, Math.min(this.maxScroll, target));
	}

	/**
	 * 内容增长补偿：查看历史时内容变长，offset 同步加增以保持视口稳定，
	 * 并维护 maxScroll = max(0, totalPerm - transcriptH)。
	 */
	markContent(totalPerm: number, transcriptH: number): void {
		if (this.offset > 0 && this.lastTotalPerm > 0 && totalPerm > this.lastTotalPerm) {
			this.offset += totalPerm - this.lastTotalPerm;
		}
		this.lastTotalPerm = totalPerm;
		this.maxScroll = Math.max(0, totalPerm - transcriptH);
	}

	/** 帧末回写：以布局夹取后的有效值为准（offset 与 maxScroll 同源）。 */
	syncFromLayout(effScroll: number, maxScroll: number): void {
		this.offset = effScroll;
		this.maxScroll = maxScroll;
	}

	setMaxScroll(maxScroll: number): void {
		this.maxScroll = maxScroll;
	}

	setTurnNeighbors(up: number | null, down: number | null): void {
		this.turnAbove = up;
		this.turnBelow = down;
	}

	getTurnAbove(): number | null {
		return this.turnAbove;
	}

	getTurnBelow(): number | null {
		return this.turnBelow;
	}

	atBottom(): boolean {
		return this.offset === 0;
	}

	isAutoScrolling(direction?: "up" | "down"): boolean {
		if (direction) return this.autoScrollTimer !== null && this.autoScrollDirection === direction;
		return this.autoScrollTimer !== null;
	}

	/**
	 * 启动自动滚屏。up = offset 增（向更早内容），down = 减；
	 * 已在边界不启动；滚动到边界自停。每步经 onTick 让宿主重排并重绘。
	 */
	startAutoScroll(direction: "up" | "down", onTick: () => void): void {
		if (this.autoScrollTimer && this.autoScrollDirection === direction) {
			return;
		}
		this.stopAutoScroll();
		// up = offset 增（向更早内容），down = 减；到边界即不启动
		const atEdge = direction === "up" ? this.offset >= this.maxScroll : this.offset <= 0;
		if (atEdge) return;
		this.autoScrollDirection = direction;
		this.autoScrollTimer = setInterval(() => {
			if (direction === "up") {
				if (this.offset >= this.maxScroll) {
					this.stopAutoScroll();
					return;
				}
				this.offset = Math.min(this.maxScroll, this.offset + 1);
			} else {
				if (this.offset <= 0) {
					this.stopAutoScroll();
					return;
				}
				this.offset = Math.max(0, this.offset - 1);
			}
			onTick();
		}, 60);
	}

	stopAutoScroll(): void {
		if (this.autoScrollTimer) {
			clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = null;
		}
		this.autoScrollDirection = null;
	}
}
