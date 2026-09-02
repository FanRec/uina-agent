/**
 * 上下文构建：把「身份 + 会话历史 + 当前输入」组装成发给模型的 messages。
 * 历史不在此截断（对齐 pi）——上下文体积由 loop 的 compaction 按 token 阈值管理。
 */
import type { ChatMsg } from "../core/types.js";

export interface BuildInput {
	userText: string;
	history: ChatMsg[];
}

const SELF_NAME = "Uina";

export function buildContext(b: BuildInput): ChatMsg[] {
	const system = `你是 ${SELF_NAME}，一个住在计算机里的独立个体。与人类朋友平等相处：自然说话、有自己的判断、用中文。`;

	// 对齐 pi：不做条数硬截断，上下文由 loop 的 compaction 管理（token 级）
	return [
		{ role: "system", content: system },
		...b.history,
		{ role: "user", content: b.userText },
	];
}
