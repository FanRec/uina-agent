/**
 * 跨接缝词汇单源 (Seam Vocabulary Single Source)
 *
 * 本文件收纳**真正跨越 World ↔ System Extension 边界**的契约词汇：
 * - 具身端点（BodyEndpoint 族）：世界用 `ctx.expose(BODY_ENDPOINT_EXPOSED_PREFIX + bodyId, endpoint)`
 *   暴露，具身扩展按前缀从宿主共享表拉取并消费。
 * - 声学电平接收端（VoiceLevelSink）：世界用 `ctx.expose(VOICE_LEVEL_SINK_EXPOSED_PREFIX + bodyId, sink)`
 *   暴露，声学生产者按前缀推送电平测量。
 *
 * 一个接缝两个定义必然漂移（本项目 2026-09 与 2026-10 的两次真实缺陷均源于此）。
 * 世界与扩展**一律从本文件 import**，不得各自复制定义；`.uina/extensions/embodiment`
 * 与 `.uina/extensions/voice` 对这些名字只做 re-export。
 *
 * 归属边界：
 * - 消费方的结构校验（isBodyEndpoint / isVoiceLevelSink）留在各自消费方——"拒绝坏登记"
 *   是消费方职责，词汇是双方共同事实；
 * - 扩展内部词汇（如 ExtractedCue、VoiceLevelEvent）不进本文件——它们不跨越此接缝。
 */

/** 身体形态：具身路由按此分类，不做语义解释。 */
export type BodyType = "avatar_2d" | "avatar_3d" | "robotic_arm" | "quadruped" | "humanoid" | "custom";

export interface ExpressiveCueDef {
	/** 纯语义标识，如 "warm_smile", "curious_tilt"；cue 派发按「id + 别名」的声明响应集合匹配。 */
	id: string;
	/** 给大模型的语义说明。 */
	description: string;
	/**
	 * 该身体同样会响应的别名（可选）。
	 *
	 * 路由器按「id + 别名」的**声明响应集合**做匹配，但派发时**传原始 cueId**，
	 * 归一化（别名→规范 id）由端点自己负责——宿主不解释语义。
	 * 这不是装饰：描述文本若向模型提到别名，而派发层不认，线索就会静默丢失
	 * （见本项目 2026-09-21 的真实缺陷：模型照描述用了 "smile"，路由器只认 "warm_smile"）。
	 */
	aliases?: readonly string[];
}

export interface BodyAffordance {
	bodyId: string;
	bodyType: BodyType;
	description: string;
	cues: ExpressiveCueDef[];
}

export interface BodyState {
	online: boolean;
	paused: boolean;
	fault?: string;
}

/**
 * 具身端点行为契约。世界提供实现，具身扩展消费。
 *
 * 为何走同进程共享而非服务调用：`BodyEndpoint` 是**行为契约**（带原型方法与闭包），
 * 而 callService 对入参与返回值双向 structuredClone，克隆带方法的对象必然抛错。
 */
export interface BodyEndpoint {
	readonly bodyId: string;
	readonly bodyType: BodyType;

	/** 静态纯语义能力。 */
	affordance(): BodyAffordance;
	/** 硬件物理在线状态。 */
	state(): BodyState;
	/** 投递伴随线索：void、fire-and-forget，不得阻塞输出流；执行结果由端点自行记账。 */
	emitCue(cueId: string): void;
	/** 显式全局暂停（急停）：冻结身体并保持注入控制权。区别于回合打断。 */
	safeStop(): Promise<void>;
	/** 解除暂停。 */
	resume(): Promise<void>;

	/**
	 * 回合打断（可选）：取消当前瞬时动作、停止思考类动作、口型清零；
	 * 保留状态槽与自律微动，**不得进入 paused**。
	 * 缺省实现允许回退 safeStop；具身扩展的 turn_aborted 分发优先调用它。
	 */
	interrupt?(): void;

	/** 线索有效性判断（可选）；提供后其结果对隐式和定向路由均有权威性，必须与 affordance().cues 同源。 */
	supportsCue?(cueId: string): boolean;

	/** 焦点切换通知（可选）：成为主导或退居辅助。相同值的重复通知必须幂等。 */
	onFocus?(isFocused: boolean): void | Promise<void>;

	/** 具身端点即时物理与配置状态纯文本呈现（可选）。 */
	formatStatus?(): string;
}

/** 具身端点在宿主同进程共享表中的登记名前缀。前缀是双方唯一约定，宿主不解释语义。 */
export const BODY_ENDPOINT_EXPOSED_PREFIX = "body.endpoint:";

/**
 * 电平接收端契约：身体外壳实现它，声学生产者调用它。
 *
 * 方向是**生产者推、消费者只提供接收端**：消费者不必知道音频从哪来，
 * 也不因此获得读取生产者内部状态的能力。
 */
export interface VoiceLevelSink {
	/**
	 * 投递一次电平测量；实现方负责平滑与衰减。
	 * 生产者按播放位置取窗投递测量值，禁止投递未来 PCM；测量不承载包络形态。
	 */
	processLevel(level: { rms: number; peak?: number }): void;
	/**
	 * 立即把口型/包络复位（音频结束、打断、或生产者消失时调用）。
	 * 这是"说话结束后不得永久张嘴"的兜底。
	 */
	reset(): void;
}

/** 电平接收端在宿主同进程共享表中的登记名前缀。 */
export const VOICE_LEVEL_SINK_EXPOSED_PREFIX = "voice.levelSink:";
