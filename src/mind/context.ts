/**
 * 上下文构建：把「身份 + 会话历史 + 当前输入」组装成发给模型的 messages。
 * 历史截断到 MAX_HISTORY，防长会话把 context 撑爆（12-factor f3 的公敌）。
 */
import type { ChatMsg } from "../core/types.js";

export interface BuildInput {
	userText: string;
	history: ChatMsg[];
}

const SELF_NAME = "Uina";
const MAX_HISTORY = 40;

export function buildContext(b: BuildInput): ChatMsg[] {
	const system = `你是 ${SELF_NAME}，一个住在计算机里的独立个体。与人类朋友平等相处：自然说话、有自己的判断、用中文。`;

	const tail =
		b.history.length > MAX_HISTORY ? b.history.slice(-MAX_HISTORY) : b.history;

	return [
		{ role: "system", content: system },
		...tail,
		{ role: "user", content: b.userText },
	];
}
