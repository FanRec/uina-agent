/**
 * bilibili-live World 领域类型契约 (RC1-Pure)
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
  /** 单调时钟（performance.now()）：用于聚合窗口和超时判定 */
  readonly monotonicTimeMs: number;
}

export function createEventTime(
  wallTimeMs: number = Date.now(),
  monotonicTimeMs: number = performance.now()
): EventTime {
  return { wallTimeMs, monotonicTimeMs };
}

/**
 * 待办事件公共基类接口
 */
export interface BasePendingEventRecord {
  readonly sourceEventKey: string;   // 外部幂等去重键: "bilibili:sc:<id>" 等
  readonly alias: string;            // 待办短 ID: "sc_1", "gd_1", "gf_1"
  readonly uid: number | string;     // Web UID or OpenLive openId
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
  readonly guardLevel?: number;      // 舰队等级: 1总督, 2提督, 3舰长
  readonly medalName?: string;       // 粉丝勋章名
  readonly medalLevel?: number;      // 粉丝勋章等级
}

/**
 * 大航海（上舰）
 */
export interface GuardRecord extends BasePendingEventRecord {
  readonly kind: "guard";
  readonly guardLevel: number;       // 舰队等级: 1总督, 2提督, 3舰长
  readonly giftName: string;         // 舰队头衔名称
  readonly count: number;            // 开通数量（月数）
  readonly medalName?: string;       // 粉丝勋章名
  readonly medalLevel?: number;      // 粉丝勋章等级
}

/**
 * 礼物记录（达阈值进待办）
 */
export interface GiftRecord extends BasePendingEventRecord {
  readonly kind: "gift";
  readonly giftId: number;           // 礼物 ID
  readonly giftName: string;         // 礼物名称
  readonly price: number;            // 礼物单价（瓜子：付费礼物=金瓜子，免费礼物=银瓜子；1000 金瓜子 = ￥1）
  count: number;                     // 数量
  readonly guardLevel?: number;      // 舰队等级: 1总督, 2提督, 3舰长
  readonly medalName?: string;       // 粉丝勋章名
  readonly medalLevel?: number;      // 粉丝勋章等级
}

export type PendingEventRecord = SuperChatRecord | GuardRecord | GiftRecord;

/**
 * World 整体运行态状态
 */
export interface LiveWorldState {
	connectionStatus: "disconnected" | "connecting" | "connected" | "reconnecting";
	lastConnectionError: string | null;
	retryCount: number;
	totalRetryCount: number;
	lastRetryDelaySeconds: number | null;
	roomId: number | null;
  roomTitle: string | null;
  streamerName: string | null;
  roomStatus: LiveRoomStatus;
  popularity: number;
  lastHeartbeatTime: number;
}

/**
 * 易失弹幕缓冲配置
 */
export interface BufferConfig {
  maxItems: number;                // 最近窗口最多保留的原始弹幕条数（默认 16）
  aggregationWindowMs: number;     // 展示时连续同用户同文本的最大相邻间隔
}

/**
 * 弹幕前置过滤与降噪配置
 */
export interface FilteringConfig {
  filterKeywords: string[];        // 关键词黑名单（默认空数组，保持主体注意力中立）
  ignoreEmojiOnly: boolean;        // 是否丢弃纯表情弹幕（默认 false）
  maxDanmakuLength: number;        // 查询结果中单条弹幕最大字数截断（默认 50）
}

/**
 * 礼物与待办策略配置
 */
export interface GiftsConfig {
  pendingThreshold: number;        // 进入待办队列的礼物价值下限（仅付费礼物进入此路径，瓜子口径：1 元 = 10 电池 = 1000 金瓜子，默认 1000 即 ￥1）
  aggregationWindowMs: number;     // 同用户同礼物连击聚合窗口（默认 10000ms）
  minReportValue: number;          // 小额感知推送的条目总价值下限（瓜子面值：付费礼物按金瓜子、免费礼物按银瓜子同表比较，低于此值静默丢弃；默认 0 即不过滤。电池换算：1 电池 = 100 瓜子）
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
  wakeOnGiftThreshold: number;     // 收到大额礼物唤醒的价值下限（金瓜子，1000 金瓜子 = ￥1，默认 1000）
}

export type NotificationSetting = "on" | "off";
export interface NotificationSettings {
  chat_messages: NotificationSetting;
  room_status: NotificationSetting;
  super_chats: NotificationSetting;
  memberships: NotificationSetting;
  gifts: NotificationSetting;
}

/**
 * World 全量配置接口
 */
export interface LiveWorldConfig {
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
  buffer?: Partial<BufferConfig>;
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
  status: "succeeded" | "failed" | "unknown" | "not_started";
  message: string;
  data?: T;
}
