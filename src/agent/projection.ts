import type { AgentMessage, ChatMsg } from "../core/types.js";
import { convertToLlm } from "./context.js";
import { projectAgentHistory, protectRewindContext, type CanonicalState } from "../session/recovery.js";
import type { SessionEntry } from "../session/types.js";

/** Projects the ordered journal into the effective provider history. A
 * compaction replaces only model-visible history; the journal itself remains
 * intact. Lives in agent/ because it is an agent projection rule, not a
 * session storage concern (session must not depend on agent). */
export function projectModelHistory(entries: readonly SessionEntry[]): ChatMsg[] {
	return convertToLlm(projectAgentHistory(entries));
}

/**
 * 投影 Replacement 缝（执行稿 v6 L6）：两个函数各自可整层替换，同一时刻只有
 * 一个 owner（Subject 实例）；不做 contributor chain、不造 ProjectorPipeline。
 * 普通 capability（含官方 Compaction）默认不占它——占用 = 宣告"我要替换整层
 * 历史/形塑解释"。
 */
export interface ProjectionPolicy {
	/** journal→memory 投影（大半径极少使用；state 供 policy 访问 auxiliary timeline）。 */
	projectHistory?: (entries: readonly SessionEntry[], state: CanonicalState) => AgentMessage[];
	/** memory→provider 形塑（provider 边界；每请求态，失败只报 provider 错、不伤 journal）。 */
	convertToLlm?: (
		messages: readonly (AgentMessage | ChatMsg)[],
		opts?: { includeThinking?: boolean },
	) => ChatMsg[];
}

/** 解析后的策略：两个字段均为现役实现（缺省回落默认，无静默空位）。 */
export type ResolvedProjection = Required<ProjectionPolicy>;

/** Core invariant（P2-B 升格，替代"默认路径 no-op 但自定义路径裸奔"的旧状）：
 * 任何 journal→memory 投影不得擦除最新的已提交回溯事实——rewind notice 被裁掉
 * 时主线会伪装成"从未回溯"。默认实现由 projectAgentHistory 内建同一规则
 * （零开销，不双重包裹）；自定义 policy 一律经此装饰器。 */
function protectCanonicalContinuity(
	project: (entries: readonly SessionEntry[], state: CanonicalState) => AgentMessage[],
): (entries: readonly SessionEntry[], state: CanonicalState) => AgentMessage[] {
	return (entries, state) => protectRewindContext(project(entries, state), entries);
}

/** 默认解析单点：Subject 构造时调用；默认实现即本模块组合的两个自由函数。 */
export function resolveProjectionPolicy(policy?: ProjectionPolicy): ResolvedProjection {
	return {
		projectHistory: policy?.projectHistory
			? protectCanonicalContinuity(policy.projectHistory)
			: (entries) => projectAgentHistory(entries),
		convertToLlm: policy?.convertToLlm ?? ((messages, opts) => convertToLlm(messages, opts)),
	};
}
