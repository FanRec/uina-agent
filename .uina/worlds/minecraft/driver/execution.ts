/**
 * Driver 执行侧公共设施：失败构造、事实记录、纯 JSON 化。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4、§7.1；modules/driver.md §11（事实）。
 * session / player-port / goto 三处原本各有一份逐字相同的 fail()、plain()、nowIso()
 * 与 recordFact()；收在这里，避免改一处忘两处。
 */

import type { DriverExecutionFact, DriverExecutionSink } from "../contracts/runtime.js";
import type { CallFailure, ExactRef, JsonValue, Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";

export function nowIso(): string {
	return new Date().toISOString();
}

/** 结构化失败构造：字段与 CallFailure 一一对应，省略 effects 即空数组。 */
export function fail(data: {
	code: string;
	source: CallFailure["source"];
	message: string;
	hint?: string;
	dispatch: CallFailure["dispatch"];
	progress?: { summary?: string } & Record<string, JsonValue>;
	effects?: Ref[];
	recoverable: boolean;
}): CallFailure {
	return callFailure({
		code: data.code,
		source: data.source,
		message: data.message,
		hint: data.hint,
		dispatch: data.dispatch,
		progress: data.progress,
		effects: data.effects ?? [],
		recoverable: data.recoverable,
	});
}

type FactKind = DriverExecutionFact["kind"];
type FactDispatch = DriverExecutionFact["dispatch"];
type FactCompletion = DriverExecutionFact["completion"];

/**
 * 效果事实记录器：绑定单一 ExecutionSink，并把"写不进去"锁存为 recorder fault
 * （§7.1：记录故障封闭新副作用，而不是静默丢事实）。
 */
export class EffectRecorder {
	private faulted = false;

	constructor(private readonly sink: DriverExecutionSink) {}

	get isFaulted(): boolean {
		return this.faulted;
	}

	/** 外部已知故障（如会话侧锁存）同步过来。 */
	markFaulted(): void {
		this.faulted = true;
	}

	/**
	 * 写前意图（§5.3）：在不可安全重放的业务写派发之前，先落一条 intent 事实并
	 * 等它真正提交。崩溃矩阵 (1) 前可判 not_sent；(1) 后、(3) 前只剩 intent 时
	 * 一律是 unknown，恢复不得盲重放。intent 的 dispatch 用 unknown，绝不能用
	 * not_sent —— 后者会把"可能已发出"谎报成"确定没发"。
	 *
	 * 失败的 dispatch 只有三种可判定情况：recorder 已故障 / sink 拒收（这次没有
	 * intent，确定没发）；屏障没拿到 ACK（无法证明 intent 是否提交，按 unknown）。
	 * 派发方据此收口并追加终态事实，这里不做降级重试。
	 */
	async beforeWrite(effect: Ref, operation: Ref, contract: ExactRef, detail?: JsonValue): Promise<void> {
		if (this.faulted)
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: "effect recorder is faulted; dispatch is blocked",
				dispatch: "not_sent",
				recoverable: false,
			});
		const ticket = this.sink.record({
			effect,
			operation,
			contract,
			observedAt: nowIso(),
			kind: "intent",
			dispatch: "unknown",
			completion: "unknown",
			evidence: [],
			detail,
		});
		if (ticket == null) {
			this.faulted = true;
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: "effect intent was not accepted; dispatch is blocked",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		try {
			await this.sink.ensureDurable(ticket);
		} catch (error) {
			// ACK 丢失不等于没落盘：intent 可能已经提交，此时宣称 not_sent 会让
			// 调用方重放一次不可撤销的业务写。封闭 recorder 并按 unknown 上报。
			this.faulted = true;
			throw fail({
				code: "INTERNAL",
				source: "environment",
				message: `effect intent durability is unknown: ${error instanceof Error ? error.message : String(error)}`,
				dispatch: "unknown",
				effects: [effect],
				recoverable: false,
			});
		}
	}

	record(
		effect: Ref,
		operation: Ref,
		contract: ExactRef,
		kind: FactKind,
		dispatch: FactDispatch,
		completion: FactCompletion,
		detail?: JsonValue,
	): void {
		const ticket = this.sink.record({
			effect,
			operation,
			contract,
			observedAt: nowIso(),
			kind,
			dispatch,
			completion,
			evidence: [],
			detail,
		});
		if (ticket == null) this.faulted = true;
	}
}
