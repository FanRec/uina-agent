/**
 * 上下文构建：把「身份 + 相关记忆 + 会话历史 + 当前输入」组装成发给模型的 messages。
 * recall 结果只允许注入 <=5 条短文本，防止检索把快路径拖慢。
 */
import type { ChatMsg } from "../core/types.js";

export interface BuildInput {
	selfName: string;
	userText: string;
	recalled: string[];
	history: ChatMsg[];
}

const MAX_HISTORY = 12;

export function buildContext(b: BuildInput): ChatMsg[] {
	const systemParts: string[] = [
		`你是 ${b.selfName}，一个住在计算机里的独立个体。与人类朋友平等相处：自然说话、有自己的判断、用中文。`,
	];

	if (b.recalled.length > 0) {
		systemParts.push(
			`以下是你以前记住的事（你的长期记忆，可以在合适时自然地联想、提起或使用）：\n${b.recalled.map((r) => `- ${r}`).join("\n")}`,
		);
	}

	const tail =
		b.history.length > MAX_HISTORY ? b.history.slice(-MAX_HISTORY) : b.history;

	return [
		{ role: "system", content: systemParts.join("\n\n") },
		...tail,
		{ role: "user", content: b.userText },
	];
}