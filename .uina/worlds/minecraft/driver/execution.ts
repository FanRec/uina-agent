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
