/**
 * Uina 语音交付事实的单一说法（输出表达体系 §5.1/§5.2）。
 *
 * 权威划分（只此一份，不设第二账本）：
 * - **文本归属提交方**：句子是 Speech 交给驱动的，所以断点能说出"是哪一句"。
 * - **进度归属 bridge**：播完几句、哪句在播、念到第几字，只有物理层知道；驱动只代理。
 *
 * 读取路径收敛成一条：`snapshot()` —— 同步、零 IO。
 * 刷新由拥有 IO 的一方（tts 扩展的进度探测）在后台推进，渲染路径永远只读内存快照。
 */

export interface PlaybackBreakpoint {
	readonly traceId: string;
	readonly segmentIndex: number;
	readonly committedCharEnd: number; // 音频播放头已越过的文本物理字符边界
	/** 被打断那一句的文本（作者侧记账；无记账时缺席，不臆造） */
	readonly segmentText?: string;
}

export type InterruptResult =
	| { readonly outcome: "interrupted"; readonly breakpoint: PlaybackBreakpoint | null }
	| { readonly outcome: "no_op"; readonly breakpoint: null; readonly reason?: string }
	| { readonly outcome: "failed"; readonly breakpoint: null; readonly reason: string }
	| { readonly outcome: "unknown"; readonly breakpoint: null; readonly reason: string };

/**
 * 交付快照：某一时刻"我说到哪了"的全部已知事实。
 * 每个字段都是已归零的观测；读取不触发任何 IO。
 */
export interface DeliverySnapshot {
	readonly online: boolean;
	readonly muted: boolean;
	/** 已提交句数（作者侧记账） */
	readonly submittedSegments: number;
	/** 已播完句数（桥侧物理事实） */
	readonly spokenSegments: number;
	/** 尚未播完的句数，**含正在播的那句** */
	readonly pendingSegments: number;
	/** 正在播的那句序号（1 起）；无在播时为 null */
	readonly currentSegmentIndex: number | null;
	/** 正在播的那句文本（作者侧记账） */
	readonly currentSegmentText?: string;
	/** 播放头已越过的字符边界 */
	readonly committedCharEnd?: number;
	readonly failedSegments?: number;
	readonly cancelledSegments?: number;
	readonly unknownSegments?: number;
	readonly observedAt?: number;
	readonly stopUnconfirmed?: boolean;
}

/**
 * 播放事实（Driver → Speech 的单向通知）：交付路径上的状态迁移。
 * Speech 据此对齐 Cue 边界、维护"正在说"观察与交付结局。
 */
export interface PlaybackFact {
	readonly traceId: string;
	readonly segmentIndex: number;
	readonly kind: "started" | "completed" | "failed";
}

/**
 * 交付事实的**单一说法**。
 *
 * 谁要"用一句话说清现在交付到哪了"（人的状态栏、模型的视口）都从这里取，
 * 各自再决定加不加自己的前缀、要不要干脆不说。措辞只有一份，
 * 才不会出现"两处各自描述同一状态、然后慢慢漂移"。
 *
 * 措辞上刻意不含糊：在播的那句还没念完，它算在"未播完"里，不写成"排队"。
 */
export function describeDelivery(snapshot: DeliverySnapshot): string {
	if (snapshot.stopUnconfirmed)
		return snapshot.muted ? "已设置静音，但当前声音是否停止未确认" : "当前声音是否停止未确认";
	if (!snapshot.online) return "发声服务未连接";
	if (snapshot.muted) return "已静音";
	if (snapshot.unknownSegments)
		return `${snapshot.currentSegmentIndex !== null ? "仍有声音在播放；" : ""}有 ${snapshot.unknownSegments} 句播放结果无法确认`;
	if (snapshot.failedSegments && snapshot.pendingSegments === 0) return `有 ${snapshot.failedSegments} 句未能播完`;
	if (snapshot.cancelledSegments && snapshot.pendingSegments === 0) return "未播完的内容已取消";
	if (snapshot.submittedSegments === 0) return "空闲 (本轮还没说话)";

	const total = snapshot.submittedSegments;
	if (snapshot.currentSegmentIndex !== null) {
		return snapshot.pendingSegments > 1
			? `播放 第 ${snapshot.currentSegmentIndex}/${total} 句（未播完 ${snapshot.pendingSegments} 句）`
			: `播放 第 ${snapshot.currentSegmentIndex}/${total} 句（最后一句）`;
	}
	if (snapshot.pendingSegments > 0) return `待播 ${snapshot.pendingSegments}/${total} 句`;
	return `已播完 ${total} 句`;
}
