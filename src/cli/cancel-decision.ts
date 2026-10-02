/**
 * 取消/退出的纯决策层：给定来源与宿主状态快照，产出动作序列。
 *
 * 从 runApp 的 handleCancel 闭包中抽出，使 ctrl+c / escape 两套阶梯
 * （打断→强退熔断、空闲防抖、队列回退）可被穷举测试，
 * app.ts 侧只剩无决策的执行器。
 */

export type CancelSource = "escape" | "ctrl+c";

/** 决策所需的宿主/进程状态快照（app.ts 在调用点现场采集）。 */
export interface CancelState {
	/** 宿主回合是否在跑（host.isBusy()）。 */
	busy: boolean;
	/** `!` 直跑命令是否在执行。 */
	execRunning: boolean;
	/** 防抖/取消标记是否已挂起。 */
	cancellationPending: boolean;
	/** 当前排队消息数。 */
	queuedCount: number;
}

export type CancelAction =
	/** 立即硬退出（process.exit(0)）。 */
	| { kind: "force-exit" }
	/** 走优雅退出协调器。 */
	| { kind: "graceful-exit" }
	/** 中止 `!` 直跑命令。 */
	| { kind: "abort-exec" }
	/** 打断当前回合。 */
	| { kind: "interrupt" }
	/** 打断当前回合并立即投递排队消息。 */
	| { kind: "deliver-queued" }
	/** 将排队消息退回输入栏（fire-and-forget）。 */
	| { kind: "restore-queue" }
	/** 挂起取消标记并启动防抖定时器。 */
	| { kind: "arm-pending"; debounceMs: number }
	/** 向用户展示提示。 */
	| { kind: "notify"; text: string };

export function resolveCancelActions(source: CancelSource, s: CancelState): CancelAction[] {
	if (source === "ctrl+c") {
		if (s.busy) {
			// 工作态：第 1 次打断本轮；取消流程中再次按下则直接强退。
			// arm-pending 必须先于 interrupt（原实现先置标记再打断；
			// 若打断同步引发 abort 事件，render 侧会清标记——时序在此保真）。
			if (s.cancellationPending) return [{ kind: "force-exit" }];
			const actions: CancelAction[] = [{ kind: "arm-pending", debounceMs: 2000 }];
			if (s.queuedCount > 0) actions.push({ kind: "restore-queue" });
			actions.push({ kind: "interrupt" });
			return actions;
		}
		if (s.execRunning) return [{ kind: "abort-exec" }];
		// 空闲态：防抖 2 秒内再次按下触发退出
		if (s.cancellationPending) return [{ kind: "graceful-exit" }];
		return [
			{ kind: "notify", text: "再按一次 Ctrl+C 退出程序" },
			{ kind: "arm-pending", debounceMs: 2000 },
		];
	}

	// escape：busy 时不退出，只打断/投递；直跑命令在逃逸时也要中止
	if (s.busy) {
		if (s.queuedCount > 0) return [{ kind: "deliver-queued" }];
		const actions: CancelAction[] = [{ kind: "interrupt" }];
		if (s.execRunning) actions.push({ kind: "abort-exec" });
		return actions;
	}
	return s.execRunning ? [{ kind: "abort-exec" }] : [];
}

/** 动作执行端的效果回调集（app.ts 用闭包装配；测试用 mock 断言调用序）。 */
export interface CancelHandlers {
	forceExit(): void;
	gracefulExit(): void;
	abortExec(): void;
	interrupt(): void;
	deliverQueued(): void;
	restoreQueue(): void;
	armPending(debounceMs: number): void;
	notify(text: string): void;
}

/**
 * 依序执行动作序列。force-exit / graceful-exit / deliver-queued 为终态动作：
 * 执行后立即返回，不再处理后续动作（与抽取前的早退语义逐条对齐）。
 */
export function executeCancelActions(actions: readonly CancelAction[], h: CancelHandlers): void {
	for (const action of actions) {
		switch (action.kind) {
			case "force-exit":
				h.forceExit();
				return;
			case "graceful-exit":
				h.gracefulExit();
				return;
			case "deliver-queued":
				h.deliverQueued();
				return;
			case "abort-exec":
				h.abortExec();
				break;
			case "interrupt":
				h.interrupt();
				break;
			case "restore-queue":
				h.restoreQueue();
				break;
			case "arm-pending":
				h.armPending(action.debounceMs);
				break;
			case "notify":
				h.notify(action.text);
				break;
		}
	}
}
