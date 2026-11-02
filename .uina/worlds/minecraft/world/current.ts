/**
 * World 当前读：纯当前 read/watch（不读历史存储）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5、modules/world.md §6.1、§9.2–§9.4。
 * read = facts.sample 同步采样 + 调用方给出的 resolver（返回 Fact）；cursor 取当前源
 * stamp 与确切查询/参数绑定。静态知识查询不进这里（无观察源）。
 * watch 保守失效（§9.2）：当前源任何推进即 changed（changed=[] 不做精确分类），
 * epoch/source 断裂即 reset；首次 next 立即比较（§9.3）；同一水位只交付一次提示。
 */

import type { ClientFactCapture, ClientFactStamp, ClientFactsPort, ClientFactView } from "../contracts/client-facts.js";
import type { CallFailure, Fact, JsonValue, Observation, ObservationCursor } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { WorldWatch } from "../contracts/world.js";
import { ObservationWatch, queryStream } from "./watch.js";

/** 当前查询 resolver：从同一提交边界的事实视图组装一个 Fact。 */
export type QueryResolver = (view: ClientFactView, input: JsonValue) => Fact<unknown>;

function worldFailure(code: string, message: string, hint?: string): CallFailure {
	return callFailure({ code, source: "world", message, hint, dispatch: "not_sent", effects: [], recoverable: false });
}

/** facts.sample 的结构化错误收敛为 CallFailure（capabilities §2.6 口径）。 */
function toReadFailure(err: unknown): CallFailure {
	if (
		err instanceof Error &&
		(err as CallFailure).name === "CallFailure" &&
		typeof (err as CallFailure).code === "string"
	) {
		// resolver 抛出的 CallFailure（如 INVALID_INPUT）保持原样：source/hint 是输入侧事实
		return err as CallFailure;
	}
	const code = (err as { code?: string } | null)?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (code === "WRONG_STATE") {
		// 源未附着活连接——当前读不可用（DISCONNECTED：连接断了，别重试）。
		return worldFailure("DISCONNECTED", "current facts source is not attached to a live connection", message);
	}
	if (typeof code === "string" && code.length > 0) {
		return callFailure({ code, source: "environment", message, dispatch: "not_sent", effects: [], recoverable: false });
	}
	return worldFailure("INTERNAL", `world read failed: ${message}`);
}

export class CurrentReads {
	constructor(private readonly facts: ClientFactsPort) {}
	async read<T>(ref: string, input: JsonValue, resolver: QueryResolver): Promise<Observation<T>> {
		let capture: ClientFactCapture<Fact<unknown>>;
		try {
			capture = this.facts.sample((view) => resolver(view, input));
		} catch (error) {
			throw toReadFailure(error);
		}
		return { ...capture.value, value: capture.value.value as T, cursor: this.cursor(ref, input, capture.stamp) };
	}
	private cursor(ref: string, input: JsonValue, stamp: ClientFactStamp): ObservationCursor {
		return { stream: queryStream(ref, input, stamp.source), epoch: stamp.epoch, sequence: stamp.sequence };
	}
	async watch(ref: string, input: JsonValue, signal: AbortSignal): Promise<WorldWatch> {
		signal.throwIfAborted();
		let watch: ObservationWatch | undefined;
		const subscription = this.facts.subscribe((notice) => {
			if (notice.kind === "changed" || notice.kind === "reset") watch?.update(this.cursor(ref, input, notice.stamp));
		});
		watch = new ObservationWatch(
			this.cursor(ref, input, subscription.stamp),
			() => subscription.close(),
			() => {
				try {
					return this.cursor(ref, input, this.facts.sample(() => null).stamp);
				} catch (error) {
					throw toReadFailure(error);
				}
			},
		);
		return watch;
	}
}
