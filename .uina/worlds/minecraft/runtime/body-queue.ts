/**
 * Body 单槽 FIFO 队列：申请的排队、授予、释放与停止覆盖（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §3.3.1（三种情况）、
 * §3.3.2（外层退出：封闭准入 → 取消在途 → 等 close 屏障 → 下一个申请）、§2.2。
 * 职责单一：Runtime 只有身体所有权这一处串行点，本模块把它收成一个对象。
 *
 * 关键不变量（原实现缺失的三条）：
 * 1. **同步占槽**：request() 在返回 Promise 之前就把该项置为 active。否则同一 tick 的
 *    两个独立申请都会看到"槽空"并各自调用 playerPort.acquire，第二个被端口判成
 *    CONTROL_CONFLICT —— 而 §3.3.1 情况 a 要求的是排队，不是冲突。
 * 2. **授予前复验**：acquire 解析后若 signal 已中断或 owner 所在 Run 已停止，关闭会话并
 *    拒绝，绝不执行 work。排队期间发生的停止不能等调用方自己发现。
 * 3. **停止覆盖在途**：cancelRun() 既清排队项，也让正在 acquire 的项失效（其复验必失败）。
 *
 * 释放顺序：调用方先 await session.close()（close 屏障），再 release()；队列只在 release()
 * 之后才授予下一项，因此新主人拿到的客户端已证明旧写入失效（§3.3.2）。
 *
 * 抢占受理使用短 reservation，并给替代 Run 一次就绪优先机会；显式 priority 的 Run（G9）
 * 由 engine 在每次申请前重设同一一次性旗标插队；自保期间暂停普通授予，
 * safety 申请优先进入同一队列。没有常驻优先级栈。
 * 不做：通道锁与兼容性判断（§3.3.2 归 Driver adapter）、任意 Promise 依赖图检测（§3.3.1 合同
 * 要求显式停止，不做不可靠的死锁探测）。
 */

import type { BodySession, ControlOwner } from "../contracts/body.js";
import type { ControlRetirementCause } from "../contracts/runtime.js";
import type { CallFailure, Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { toCallFailure } from "./failure.js";

/** 一次授予。release 幂等，且只在 close 屏障完成后调用。 */
export interface BodyGrant {
	session: BodySession;
	release(): void;
}

export interface BodyLeaseQueueOptions {
	/** 只需要 acquire：chat 不占 Body，也不经本队列。 */
	port: { acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession> };
	/** 授予时登记归属槽（§5.4：owner→effect 关联先于授予）。 */
	onGrant(owner: ControlOwner): void;
	/** 释放时清空归属槽；与 onGrant 配对收在本模块内。 */
	onRelease(): void;
	/** owner 是否仍接受身体：Run 停止后为 false。 */
	isOwnerLive(owner: ControlOwner): boolean;
}

type RequestState = "queued" | "acquiring" | "held" | "settled";

interface RequestBase {
	owner: ControlOwner;
	call: Ref;
	signal: AbortSignal;
	state: RequestState;
	detach(): void;
	reject(err: CallFailure): void;
}

type Request = RequestBase &
	(
		| { kind: "body"; resolve(grant: BodyGrant): void }
		| { kind: "navigation"; resolve(grant: { release(): void }): void }
	);

/**
 * 授予前拒绝：此时尚未拿到 Body，not_sent 是可证明的。cause 只描述真实发起点，
 * 不把"在途旧写"混进来——那属于 engine.retirementFailure 的职责。
 */
function interrupted(message: string, cause: ControlRetirementCause = "unknown"): CallFailure {
	return callFailure({
		code: "INTERRUPTED",
		source: "environment",
		message: `${message} [${cause}]`,
		dispatch: "not_sent",
		effects: [],
		hint: `body was never granted (${cause}); re-observe before requesting a new qualification`,
		recoverable: false,
	});
}

function sameRun(owner: ControlOwner, run: Ref): boolean {
	return owner.kind === "run" && owner.run === run;
}

export class BodyLeaseQueue {
	private readonly opts: BodyLeaseQueueOptions;
	private readonly waiting: Request[] = [];
	/** 已占槽项：acquiring（acquire 在途）或 held（已授予未释放）。 */
	private active: Request | null = null;
	private reservations = 0;
	private priorityRun: Ref | null = null;
	reserve(): () => void {
		this.reservations++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservations--;
			this.pump();
		};
	}
	prioritize(run: Ref): void {
		this.priorityRun = run;
	}
	clearPriority(run: Ref): void {
		if (this.priorityRun === run) this.priorityRun = null;
	}

	constructor(opts: BodyLeaseQueueOptions) {
		this.opts = opts;
	}

	/**
	 * 提交一次身体申请。返回的 Promise 在授予时解析为 BodyGrant，在排队取消/授予失效/
	 * 端口拒绝时以 CallFailure 拒绝。同步占槽见文件头不变量 1。
	 */
	request(owner: ControlOwner, call: Ref, signal: AbortSignal): Promise<BodyGrant> {
		return new Promise((resolve, reject) =>
			this.enqueue({ kind: "body", owner, call, signal, state: "queued", detach: () => {}, resolve, reject }),
		);
	}
	requestNavigation(owner: ControlOwner, call: Ref, signal: AbortSignal): Promise<{ release(): void }> {
		return new Promise((resolve, reject) =>
			this.enqueue({ kind: "navigation", owner, call, signal, state: "queued", detach: () => {}, resolve, reject }),
		);
	}
	private enqueue(item: Request): void {
		const { owner, signal } = item;
		const onAbort = (): void => {
			// 只处理排队期；已授予的取消由 work 自身的 signal 与 close 负责
			if (item.state !== "queued") return;
			this.drop(item);
			item.state = "settled";
			item.reject(interrupted("body request cancelled while queued"));
		};
		item.detach = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		if (owner.kind === "safety") this.waiting.unshift(item);
		else this.waiting.push(item);
		if (this.priorityRun && sameRun(owner, this.priorityRun)) {
			this.waiting.pop();
			this.waiting.unshift(item);
			this.priorityRun = null;
		}
		this.pump();
	}

	/** 当前占槽项的 Call ref（acquiring 或 held）；用于情况 c 的谱系自等待检查。 */
	blockingCall(): Ref | null {
		return this.active == null ? null : this.active.call;
	}

	/** 停止一个 Run：清掉它排队中的申请，并让在途 acquire 在复验时失效。 */
	cancelRun(run: Ref): void {
		for (const item of [...this.waiting]) {
			if (!sameRun(item.owner, run)) continue;
			this.drop(item);
			item.state = "settled";
			item.reject(interrupted("run stopped while waiting for the body", "user_stop"));
		}
		// 在途项不清槽：acquire 仍会解析，届时 isOwnerLive() 已为 false → close + 拒绝。
		// 立即清槽会让下一个申请在新主人未证明屏障前就被授予（§3.3.2）。
	}

	private drop(item: Request): void {
		const idx = this.waiting.indexOf(item);
		if (idx >= 0) this.waiting.splice(idx, 1);
		item.detach();
	}

	private pump(): void {
		if (this.active != null || (this.reservations > 0 && this.waiting[0]?.owner.kind !== "safety")) return;
		const item = this.waiting.shift();
		if (item == null) return;
		item.state = "acquiring";
		this.active = item; // 同步占槽：此后任何 pump 都会在此返回
		item.detach();
		if (item.signal.aborted) {
			this.settle(item, interrupted("body request cancelled before grant"));
			return;
		}
		void this.grant(item);
	}

	private async grant(item: Request): Promise<void> {
		if (item.kind === "navigation") {
			if (item.signal.aborted || !this.opts.isOwnerLive(item.owner)) {
				this.settle(item, interrupted("navigation request expired before grant", "control_fault"));
				return;
			}
			item.state = "held";
			item.resolve({ release: () => this.release(item) });
			return;
		}
		let session: BodySession;
		try {
			session = await this.opts.port.acquire(item.owner, item.signal);
		} catch (err) {
			this.settle(item, toCallFailure(err));
			return;
		}
		// 授予前复验：排队/在途期间发生的中断或停止不得进入 work
		if (item.signal.aborted || !this.opts.isOwnerLive(item.owner)) {
			await closeQuietly(session);
			this.settle(item, interrupted("body request expired before grant", "control_fault"));
			return;
		}
		item.state = "held";
		this.opts.onGrant(item.owner);
		item.resolve({ session, release: () => this.release(item) });
	}

	/** 调用方已 await session.close()；此后才允许下一项进入 acquire。 */
	private release(item: Request): void {
		if (item.state !== "held") return;
		item.state = "settled";
		if (item.kind === "body") this.opts.onRelease();
		if (this.active === item) this.active = null;
		this.pump();
	}

	private settle(item: Request, err: CallFailure): void {
		item.state = "settled";
		if (this.active === item) this.active = null;
		item.reject(err);
		this.pump();
	}
}

async function closeQuietly(session: BodySession): Promise<void> {
	try {
		await session.close();
	} catch {
		// 关闭失败已由 Driver 记录；这里的拒绝原因是申请失效，不掩盖为该关闭错误
	}
}
