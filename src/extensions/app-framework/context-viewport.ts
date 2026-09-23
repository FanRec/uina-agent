import type { ChatMsg } from "../../core/types.js";
import { buildEventFrameGroup, snapshotNotice, contentAddressedEventId } from "../event-frames/projection.js";
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

		// 无装饰线：帧结构（source.type）已声明快照身份，文本内不再重复自我介绍；
		// 多应用归属由各块的 [App: name] 前缀承载。
		return visibleBlocks.join("\n");
	}

	/**
	 * 构造视口尾部帧：把当前视口快照包装为 external_event_frame 三消息组，
	 * 供 turn.transformContext（tail 相位）注入到完整上下文的最末尾。
	 *
	 * 设计要点：
	 * - 瞬态不落 Session：每请求现做现用，上下文任意时刻只有一份“此刻”视口；
	 * - eventId 内容寻址：内容不变 ⇒ 同 eventId ⇒ 帧组逐字节稳定（可被前缀缓存覆盖）；
	 * - source.kind="runtime" + origin="external"：运行时合成的环境观测，正文源自
	 *   外部世界/应用渲染，受帧协议的外部来源标注规则约束（非系统级特权位）；
	 * - 全 hidden ⇒ undefined（0 帧 0 token）。
	 */
	async buildTailFrame(): Promise<ChatMsg[] | undefined> {
		const text = await this.renderViewport();
		if (!text) return undefined;
		return buildEventFrameGroup({
			eventId: contentAddressedEventId("app-viewport", text),
			text,
			notice: snapshotNotice("应用视口"),
			source: { kind: "runtime", type: "app-viewport", origin: "external" },
		});
	}
}
