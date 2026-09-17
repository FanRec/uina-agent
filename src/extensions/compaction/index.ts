/**
 * 官方压缩 capability（P6a）：默认压缩器的所有权下沉。Subject 不再内置
 * 默认算法回退——本 capability 未激活时主体没有压缩能力，而不是静默使用
 * 隐藏的内置实现。
 *
 * 摘要调用经 pi.models.stream：传输层注入真实 runtime provider hooks，
 * 与内建路径的行为完全一致。阈值判据（defaultDecision）仍由主体按
 * CompactionSettings 计算，capability 只裁决"要不要采纳"（P6b 语义切换时
 * 随 transformContext 裁剪一并下沉）。
 */
import { streamCompactor } from "../../agent/compaction.js";
import type { ExtensionAPI } from "../runner.js";

export default function activateCompaction(pi: ExtensionAPI): void {
	// pi.models.stream 会以 runtime provider hooks 覆盖 request.providerHooks：
	// streamCompactor 内部的占位 hooks 永远不会真正生效。
	pi.registerCompactor(streamCompactor((model, request, onDelta, signal) =>
		pi.models.stream(model, request, onDelta, signal),
	), { shouldCompact: (input) => input.defaultDecision });
}
