/**
 * bilibili-live 应用领域类型契约 (RC1-Pure)
 * 严格遵循第一性原则、深模块设计与奥卡姆剃刀
 */

export type LiveRoomStatus = "online" | "offline" | "round" | "unknown";

/**
 * 双时钟契约模型
 * 彻底消除 Wall Clock（系统时钟）因 NTP 校时、休眠等跳变对生命周期的破坏
 */
export interface EventTime {
  /** 墙上时钟（Date.now()）：仅用于人类时间格式化 [14:20:05] 与日志落盘审计 */
  readonly wallTimeMs: number;
  /** 单调时钟（performance.now()）：专用于 minResidenceMs、超时判定与退避计算 */
  readonly monotonicTimeMs: number;
}

export function createEventTime(
  wallTimeMs: number = Date.now(),
  monotonicTimeMs: number = performance.now()
): EventTime {
  return { wallTimeMs, monotonicTimeMs };
}

/**
 * 易失感官弹幕条目（存储完整事实，展示时再截断）
 */
export interface DanmakuRecord {
  readonly id: string;            // 短 ID（如 dm_1）
  readonly uid: number;           // 首发用户 UID
  readonly uname: string;         // 首发用户昵称
  readonly text: string;          // 原始完整代表文本（全文用于聚合）
  readonly time: EventTime;       // 到达双时钟
  count: number;                  // 聚合条数
  uniqueSenders: Set<number>;     // 去重发送者 UID 集合
  firstSender: string;            // 首发用户昵称
}

/**
 * 待办事件公共基类接口
 */
export interface BasePendingEventRecord {
  readonly durableId: string;        // 内部持久化 UUID
  readonly sourceEventKey: string;   // 外部幂等去重键: "bilibili:sc:<id>" 等
  readonly alias: string;            // 模型视口短别名: "sc_1", "gd_1", "gf_1"
  readonly uid: number;              // 触发用户 UID
  readonly uname: string;            // 触发用户昵称
  readonly time: EventTime;          // 接收双时钟
  handled: boolean;                  // 是否已处理/已感谢
  handledAt?: number;                // 处理时间戳（ms）
}

/**
 * 醒目留言（SuperChat）
 */
export interface SuperChatRecord extends BasePendingEventRecord {
  readonly kind: "sc";
  readonly price: number;            // 价格（元）
  readonly message: string;          // 留言文本
}

/**
 * 大航海（上舰）
 */
export interface GuardRecord extends BasePendingEventRecord {
  readonly kind: "guard";
  readonly guardLevel: number;       // 舰队等级: 1总督, 2提督, 3舰长
  readonly giftName: string;         // 舰队头衔名称
}

/**
 * 礼物记录（达阈值进待办）
 */
export interface GiftRecord extends BasePendingEventRecord {
  readonly kind: "gift";
  readonly giftId: number;           // 礼物 ID
  readonly giftName: string;         // 礼物名称
  readonly price: number;            // 礼物价值（电池数）
  count: number;                     // 数量
}

export type PendingEventRecord = SuperChatRecord | GuardRecord | GiftRecord;

/**
 * 视口调度槽位（用于 minResidenceMs 闭环与纯函数 render 隔离）
 */
export interface VisibleSlot {
  readonly recordId: string;
  readonly fullText: string;
  readonly firstSender: string;
  readonly count: number;
  readonly uniqueSendersCount: number;
  readonly arrivalMonotonic: number;
  readonly wallTimeMs: number;
  visibleSinceMonotonic: number;      // 首次展示在视口的单调时间
}

/**
 * 应用整体运行态状态
 */
export interface LiveAppState {
  connectionStatus: "disconnected" | "connecting" | "connected" | "reconnecting";
  roomId: number | null;
  roomTitle: string | null;
  streamerName: string | null;
  roomStatus: LiveRoomStatus;
  popularity: number;
  lastHeartbeatTime: number;
}

/**
 * 视口与 Token 预算配置
 */
export interface ViewportConfig {
  approximateBudgetTokens: number; // 展开视口估算 Token 预算（默认 200）
  maxViewportChars: number;        // 展开视口硬字符上限（默认 600 字符）
  maxItems: number;                // 展开视口最大条目数（默认 20）
  minResidenceMs: number;          // 视网膜最小停留时长（默认 10000ms）
  showTimestamps: boolean;         // 是否在视口展示 HH:mm:ss 时间戳（默认 true）
  aggregationWindowMs: number;     // 弹幕行内聚合滑动窗口（默认 20000ms）
}

/**
 * 弹幕前置过滤与降噪配置
 */
export interface FilteringConfig {
  filterKeywords: string[];        // 关键词黑名单（默认空数组，保持主体注意力中立）
  ignoreEmojiOnly: boolean;        // 是否丢弃纯表情弹幕（默认 false）
  maxDanmakuLength: number;        // 展示阶段单条弹幕最大字数截断（默认 50）
}

/**
 * 礼物与待办策略配置
 */
export interface GiftsConfig {
  pendingThreshold: number;        // 进入待办队列的礼物价值下限（电池数，默认 1000 即 ￥100）
  aggregationWindowMs: number;     // 同用户同礼物连击聚合窗口（默认 10000ms）
}

/**
 * 网络与长连接重连配置
 */
export interface NetworkConfig {
  autoReconnect: boolean;          // 是否开启自动重连（默认 true）
  requestTimeoutMs: number;        // HTTP 请求超时时间（默认 5000ms）
  maxReconnectDelayMs: number;     // 指数退避重连最大等待时长（默认 30000ms）
}

/**
 * 持久化日志存储配置
 */
export interface StorageConfig {
  dataDir: string;                 // events.jsonl 存放目录（默认 "./data"）
  journalCompactionThreshold: number; // 触发日志压缩归档的行数阈值（默认 500 行）
}

/**
 * 强事件唤醒策略配置（模式二）
 */
export interface WakeupConfig {
  wakeOnSuperChat: boolean;        // 收到 SC 时是否唤醒静默中的主体（默认 true）
  superChatMinPrice: number;       // 唤醒的 SC 价格门槛（默认 0 元，即任意 SC 均唤醒）
  wakeOnGuard: boolean;            // 收到上舰时是否唤醒（默认 true）
  wakeOnGiftThreshold: number;     // 收到大额礼物唤醒的价值下限（电池数，默认 1000）
}

/**
 * 应用全量配置接口
 */
export interface LiveAppConfig {
  defaultRoomId?: number;
  sessdata?: string;
  biliJct?: string;
  buvid3?: string;
  openPlatform?: {
    accessKeyId: string;
    accessKeySecret: string;
    appId: number;
    code: string;
  };
  viewport?: Partial<ViewportConfig>;
  filtering?: Partial<FilteringConfig>;
  gifts?: Partial<GiftsConfig>;
  network?: Partial<NetworkConfig>;
  storage?: Partial<StorageConfig>;
  wakeup?: Partial<WakeupConfig>;
}

/**
 * 外部副作用动作标准执行结果模型
 */
export interface ActionOutcome<T = unknown> {
  status: "succeeded" | "failed" | "unknown";
  message: string;
  data?: T;
}
