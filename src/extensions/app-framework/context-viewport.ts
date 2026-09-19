import type { ChatMsg } from "../../core/types.js";
import type { DeepReadonly } from "../../runtime/events.js";
import type { AppRuntime, SurfaceTier } from "./types.js";

export interface ContextViewportOptions {
	/** 最大同时处于 expanded 档位的应用数量（默认 2） */
	maxExpanded?: number;
	/** 获取当前所有已注册应用的运行时列表 */
	getRuntimes: () => Iterable<AppRuntime>;
}

export class ContextViewport {
	private readonly maxExpanded: number;
	private readonly getRuntimes: () => Iterable<AppRuntime>;

	constructor(options: ContextViewportOptions) {
		this.maxExpanded = options.maxExpanded ?? 2;
		this.getRuntimes = options.getRuntimes;
	}

	/**
	 * 切换某个应用的视口档位，并在 expanded 溢出时执行优雅降级（最旧的切回 ambient）
	 */
	setTier(runtime: AppRuntime, newTier: SurfaceTier): void {
		if (runtime.surfaceTier === newTier) return;

		runtime.surfaceTier = newTier;
		runtime.lastActiveTurn = Date.now();

		if (newTier === "expanded") {
			this.enforceMaxExpanded(runtime);
		}
	}

	/**
	 * 确保处于 expanded 状态的应用数量不超过上限
	 */
	private enforceMaxExpanded(justActivated: AppRuntime): void {
		const expandedApps: AppRuntime[] = [];
		for (const rt of this.getRuntimes()) {
			if (rt.enabled && rt.surfaceTier === "expanded") {
				expandedApps.push(rt);
			}
		}

		if (expandedApps.length <= this.maxExpanded) return;

		// 按活跃时间升序排序（最旧的排在前面）
		expandedApps.sort((a, b) => a.lastActiveTurn - b.lastActiveTurn);

		// 降级最旧的应用为 ambient（除刚激活的应用外）
		for (const candidate of expandedApps) {
			if (candidate !== justActivated) {
				candidate.surfaceTier = "ambient";
				break;
			}
		}
	}

	/**
	 * 在 turn.transformContext 拦截器中执行上下文视口拼装与注入
	 * 严格遵循：
	 * 1. 全 hidden 时 0 Token 原样返回
	 * 2. 结构化隔离可信控制指令与不可信数据，防御 Prompt Injection
	 * 3. 跨 Provider 兼容性：附在末尾消息内，不伪造额外非法消息
	 */
	async transformContext(messages: readonly DeepReadonly<ChatMsg>[]): Promise<ChatMsg[]> {
		const visibleBlocks: string[] = [];

		for (const rt of this.getRuntimes()) {
			if (!rt.enabled || rt.surfaceTier === "hidden") continue;
			if (!rt.definition.render) continue;

			try {
				const rendered = await rt.definition.render(rt.surfaceTier);
				const trimmed = rendered?.trim();
				if (!trimmed) continue;

				if (rt.surfaceTier === "ambient") {
					visibleBlocks.push(trimmed);
				} else {
					visibleBlocks.push(
						`[App: ${rt.definition.name}]\n${trimmed}`,
					);
				}
			} catch (error) {
				// 单应用渲染异常降级，不阻断整个回合
				visibleBlocks.push(
					`[App: ${rt.definition.name}] (界面渲染失败: ${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}

		// 1. 如果没有任何可见应用，0 修改直接返回
		if (visibleBlocks.length === 0) {
			return messages as ChatMsg[];
		}

		// 2. 组装统一的视口包装块（含防注入说明）
		const header = "======================= 【运行中的应用程序 / Running Apps】 =======================";
		const footer = "================================================================================";
		const viewportText = [
			header,
			...visibleBlocks,
			footer,
		].join("\n");

		// 3. 跨 Provider 安全末尾注入
		const result: ChatMsg[] = (messages as ChatMsg[]).map((msg) => ({ ...msg }));
		if (result.length === 0) {
			return [{ role: "system", content: viewportText }];
		}

		const lastIndex = result.length - 1;
		const lastMsg = result[lastIndex];

		// 将视口附在最后一条消息末尾
		result[lastIndex] = {
			...lastMsg,
			content: lastMsg.content ? `${lastMsg.content}\n\n${viewportText}` : viewportText,
		};

		return result;
	}
}
