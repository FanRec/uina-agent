export type BodyType =
  | "avatar_2d"
  | "avatar_3d"
  | "robotic_arm"
  | "quadruped"
  | "humanoid"
  | "custom";

export interface ExpressiveCueDef {
  /** 纯语义标识，如 "warm_smile", "curious_tilt", "wave_hand", "wag_tail" */
  id: string;
  /** 给大模型的语义说明 */
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
  fault?: string;
}

export interface BodyEndpoint {
  readonly bodyId: string;
  readonly bodyType: BodyType;

  /** 静态纯语义能力 */
  affordance(): BodyAffordance;
  /** 硬件物理在线状态 */
  state(): BodyState;
  /** 投递伴随线索 (Track A) */
  emitCue(cueId: string): void;
  /** 响应打断，安全受控急停 */
  safeStop(): Promise<void>;

  /** 可选: 焦点切换通知 (成为主导或退居辅助) */
  onFocus?(isFocused: boolean): void | Promise<void>;
}

export interface ExtractedCue {
	id: string;
	target?: string;
	rawTag: string;
}

/**
 * 具身端点在宿主同进程共享表中的登记名前缀。
 *
 * 端点提供方（如 Live2D App）用 `ctx.expose(PREFIX + bodyId, endpoint)` 暴露自己；
 * 具身路由扩展用 `pi.shared(APP_EXPOSED_SHARED_NAME)` 拉取全部登记项并按此前缀筛选。
 * 前缀是双方唯一的约定，宿主不解释它的语义。
 *
 * 为何走同进程共享而非服务调用：`BodyEndpoint` 是**行为契约**（带原型方法与闭包），
 * 而 callService 对入参与返回值双向 structuredClone，克隆带方法的对象必然抛错。
 */
export const BODY_ENDPOINT_EXPOSED_PREFIX = "body.endpoint:";
