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
	 * 渲染当前处于可见状态（expanded 或 ambient）的应用视口内容文本
	 * 严格遵循：
	 * 1. 全 hidden 或无可见文本时返回空字符串（0 Token）
	 * 2. 以 [App: name] 帧标记界定各应用渲染区块（结构化包裹属展示语义，
	 *    不是现成的可信边界——不声称它构成命运攻击隔离）
	 */
	async renderViewport(): Promise<string> {
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

		if (visibleBlocks.length === 0) {
			return "";
		}

		const header = "======================= 【运行中的应用程序 / Running Apps】 =======================";
		const footer = "================================================================================";
		return [
			header,
			...visibleBlocks,
			footer,
		].join("\n");
	}

	/**
	 * 上下文视口注入（独立消息版）：追加一条独立的 user 帧承载视口文本，
	 * 绝不篡改任何既有消息（避免把瞬态应用上下文伪装成 user 输入 / 模型旧言 /
	 * 工具结果——那些是其它 owner 的消息，谁创建资源谁负责语义）。
	 *
	 * 说明：ChatMsg 契约没有 role:"custom" 变体，provider 网关把 custom 与 user
	 * 同投影为 user（context.ts convertToLlm），此处独立追加 user 帧语义等价。
	 * 视口是瞬态上下文，不落 Session；现网 app-framework 走 turn.prepare 的
	 * systemPrompt 注入，此方法作为非污染的独立注入点供直接消费方复用。
	 */
	async transformContext(messages: readonly DeepReadonly<ChatMsg>[]): Promise<ChatMsg[]> {
		const viewportText = await this.renderViewport();

		// 没有任何可见应用，0 修改直接返回
		if (!viewportText) {
			return messages as ChatMsg[];
		}

		// 独立注入：不触碰既有消息的 content。
		return [...messages, { role: "user", content: viewportText }] as ChatMsg[];
	}
}
