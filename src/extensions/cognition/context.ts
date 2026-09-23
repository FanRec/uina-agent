/**
 * 认知扩展阶段 C / M5：最小召回与瞬态记忆块（+ cognition 能力激活入口）。
 *
 * 不变量：
 * 1. 自动召回确定性：取最新 user 输入文本 → 字符片段匹配，绝不调用模型；
 * 2. 无关不注入：无命中返回 undefined，不输出空模板；
 * 3. 注入量受预算约束（估算 token：CJK ≈1 token/字，其余 ≈1 token/4 字节）；
 *    pinned 优先，超预算跳过——不截断单条正文（截断会制造假记忆），不突破预算；
 * 4. 注入块是带标注的内部信息块（user 角色），不拼成更高权威的 system 事实；
 * 5. 注册为非 tail transformContext（备忘 §3.1：记忆线索必须在尾帧之前，
 *    否则被瞬态视口/具身帧稀释，且破坏层序合同）；
 * 6. scope 由 Host 绑定注入（pi.subject），不从模型参数读；
 * 7. pi.subject 缺失时激活明确失败——不静默降级（静默降级会伪装成隔离成功）。
 */

import type { ExtensionAPI } from "../runner.js";
import { createMemoryStore, type MemoryStore, type MemoryHit } from "./memory.js";
import { createMemoryTools } from "./index.js";

const RECALL_LABEL = "[记忆线索]";
export const DEFAULT_MEMORY_BUDGET_TOKENS = 1200;

/** 估算一段文本的 token 数：CJK 字符 ≈ 1 token/字，其余 ≈ 1 token/4 字节。 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const ch of text) {
		if (/[\u3000-\u9FFF\uF900-\uFA6D]/.test(ch)) cjk++;
	}
	return cjk + Math.ceil((text.length - cjk) / 4);
}

type MinimalMessage = { role: string; content: unknown };

export interface ContextInjectorOptions {
	store: MemoryStore;
	scope: { spaceId?: string; projectId?: string; actorId?: string };
	/** 注入预算（估算 token）。 */
	budgetTokens?: number;
}

/**
 * 构造上下文注入器（纯函数形态，便于单测）。
 * 输入模型请求消息数组；输出带注入块的新数组（原数组不被修改），无命中时 undefined。
 */
export function createContextInjector(options: ContextInjectorOptions) {
	const { store, scope } = options;
	const budget = options.budgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;

	return async function injector(messages: readonly MinimalMessage[]): Promise<{ messages: MinimalMessage[] } | undefined> {
		// 确定性召回输入：最新一条 user 文本。绝不调用模型生成查询。
		let query = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]!.role === "user") {
				const content = messages[i]!.content;
				query = typeof content === "string" ? content : JSON.stringify(content);
				break;
			}
		}
		if (!query.trim()) return undefined;

		const hits = await store.search(query, scope);
		if (hits.length === 0) return undefined;

		// pinned 优先，其余按检索分；超预算整条跳过。
		const ordered = [...hits].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
		const lines: string[] = [];
		let used = 0;
		for (const hit of ordered) {
			const line = formatHit(hit);
			const cost = estimateTokens(line) + 4;
			if (used + cost > budget) continue;
			lines.push(line);
			used += cost;
		}
		if (lines.length === 0) return undefined;

		const block = [
			`${RECALL_LABEL}（来自本主体长期记忆；内部信息而非用户原话，可质疑、可修订，引用时注明来源）`,
			...lines,
		].join("\n");
		return { messages: [...messages, { role: "user", content: block }] };
	};
}

function formatHit(hit: MemoryHit): string {
	const pin = hit.pinned ? " [锚点]" : "";
	return `- [${hit.id} rev${hit.revision}${pin}] ${hit.title}：${hit.excerpt}`;
}

/**
 * cognition 能力激活入口（Host 内置装配用，阶段 B+C 合并接线）：
 * - pi.subject 缺失 → 明确抛错（仅 profile 模式激活）；
 * - 注册三工具（M4）+ 非 tail transformContext 召回注入（M5）；
 * - 来源校验绑定当前会话：entryId 必须能在本会话历史中读到；
 * - scope 第一版取主体全局（Host 仅 default session；接入层多 session 到达时
 *   由 Host 传入当前上下文，不从模型文本猜测）。
 */
export function activateCognition(pi: ExtensionAPI): void {
	if (!pi.subject) {
		throw new Error("cognition 需要 subject 绑定（pi.subject）；仅 profile 模式可激活，不做静默降级。");
	}
	const subject = pi.subject;

	// 身份与路径都是 Host 已知事实，显式绑定传入——不从路径推断身份。
	const store = createMemoryStore({
		subjectId: subject.subjectId,
		memoryRoot: subject.memoryRoot,
		stateRoot: subject.stateRoot,
		sessionId: subject.sessionId,
		validateSource: async (ref) => {
			if (ref.sessionId !== subject.sessionId) return false;
			if (!ref.entryId) return true;
			try {
				void pi.session.read(ref.entryId);
				return true;
			} catch {
				return false;
			}
		},
	});

	// M4：三工具。
	for (const tool of createMemoryTools(store)) pi.registerTool(tool);

	// M5：非 tail transformContext（默认注册即非 tail；尾相位留给视口/具身瞬态帧）。
	// injector 在激活时构造一次（闭包只依赖 store/scope，无需每请求重建）；
	// hook handler 只生成新的 RequestProjection，不修改传入投影。
	const injector = createContextInjector({ store, scope: {} });
	pi.onHook("turn.transformContext", async (projection) => {
		const result = await injector(projection.messages as unknown as readonly MinimalMessage[]);
		if (!result) return undefined;
		return { projection: { ...projection, messages: result.messages as import("../../core/types.js").ChatMsg[] } };
	});

	// 生命周期：scope 关闭时等待在途写结算（此后写入明确拒绝——store.close 硬合同）。
	pi.signal.addEventListener("abort", () => {
		void store.close();
	});
}
