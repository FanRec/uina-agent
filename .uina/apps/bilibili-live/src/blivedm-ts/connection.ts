import { EventEmitter } from "node:events";
import {
  Operation,
  encodePacket,
  unpackPackets,
  type RawPacket,
} from "./protocol.js";

/**
 * 客户端连接状态
 */
export enum ClientState {
  DISCONNECTED = "DISCONNECTED",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  RECONNECTING = "RECONNECTING",
}

/**
 * 重连退避策略函数
 */
export type RetryPolicy = (retryCount: number, totalRetryCount: number) => number;

/**
 * 基础客户端选项
 */
export interface BaseClientOptions {
  heartbeatInterval?: number;   // 发送心跳间隔时间（秒），默认 30
  receiveTimeout?: number;      // 接收假死超时（秒），默认 heartbeatInterval + 5
  retryPolicy?: RetryPolicy;    // 重试退避策略
  autoReconnect?: boolean;      // 是否开启断线自动重连，默认 true
}

/**
 * 线性退避重试策略生成器
 */
export function makeLinearRetryPolicy(
  startInterval: number = 1,
  intervalStep: number = 1,
  maxInterval: number = 10
): RetryPolicy {
  return (retryCount: number) => {
    return Math.min(startInterval + Math.max(0, retryCount - 1) * intervalStep, maxInterval);
  };
}

/**
 * 常量重试策略生成器
 */
export function makeConstantRetryPolicy(interval: number = 1): RetryPolicy {
  return () => interval;
}

export const DEFAULT_RETRY_POLICY = makeLinearRetryPolicy(1, 1, 10);

/**
 * 弹力长连接传输基类 (WebSocketClientBase)
 * 采用代际控制 (Epoch Pattern) 彻底消除幽灵连接与重连风暴，
 * 具备多节点故障转移、假死超时检测与严格 AUTH_REPLY 校验。
 */
export abstract class WebSocketClientBase extends EventEmitter {
  protected options: BaseClientOptions;
  protected state: ClientState = ClientState.DISCONNECTED;
  protected ws: WebSocket | null = null;

  // 连接代际计数器：每次 connect/disconnect 递增，使所有挂起的旧异步任务自动作废
  private epoch = 0;

  protected retryCount = 0;
  protected totalRetryCount = 0;
  protected needInitRoom = true;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private receiveTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private forceCloseTimer: NodeJS.Timeout | null = null;

  constructor(options: BaseClientOptions = {}) {
    super();
    this.options = {
      ...options,
      heartbeatInterval: options.heartbeatInterval ?? 30,
      receiveTimeout: options.receiveTimeout ?? (options.heartbeatInterval ?? 30) + 5,
      retryPolicy: options.retryPolicy ?? DEFAULT_RETRY_POLICY,
      autoReconnect: options.autoReconnect ?? true,
    };
  }

  public get currentState(): ClientState {
    return this.state;
  }

  public get isConnected(): boolean {
    return this.state === ClientState.CONNECTED;
  }

  public get currentRetryCount(): number {
    return this.retryCount;
  }

  public get currentTotalRetryCount(): number {
    return this.totalRetryCount;
  }

  /**
   * 初始化房间信息与获取弹幕服务器节点
   */
  public abstract initRoom(): Promise<boolean>;

  /**
   * 获取下一次尝试连接的 WebSocket URL
   */
  public abstract getWsUrl(retryCount: number): string;

  /**
   * 发送 WebSocket 认证包
   */
  public abstract sendAuth(): Promise<void> | void;

  /**
   * 业务消息分发
   */
  public abstract handleBusinessMessage(packet: RawPacket): void;

  /**
   * 启动连接（严格拦截 CONNECTING / CONNECTED / RECONNECTING 重入）
   */
  public async connect(): Promise<void> {
    if (
      this.state === ClientState.CONNECTING ||
      this.state === ClientState.CONNECTED ||
      this.state === ClientState.RECONNECTING
    ) {
      return;
    }

    this.state = ClientState.CONNECTING;
    const currentEpoch = ++this.epoch;
    await this.runConnectionLoop(currentEpoch);
  }

  /**
   * 主动断开连接并释放资源（递增代际，彻底销毁底层 Socket 并防止双重事件）
   */
  public async disconnect(): Promise<void> {
    const previousState = this.state;
    if (previousState === ClientState.DISCONNECTED) {
      return;
    }

    // 递增代际，使所有挂起的 initRoom / timer / ws 回调全部失效
    this.epoch++;
    this.state = ClientState.DISCONNECTED;
    this.cleanupTimers();

    if (this.ws) {
      const activeWs = this.ws;
      this.ws = null;
      // 解绑所有原生监听器，防止晚到的 close/error 回调造成二次事件
      activeWs.onopen = null;
      activeWs.onmessage = null;
      activeWs.onerror = null;
      activeWs.onclose = null;
      try {
        activeWs.close();
      } catch {
        // ignore
      }
    }

    this.emit("disconnected");
  }

  /**
   * 发送底层协议包
   */
  public sendPacket(operation: Operation, body: string | Buffer | Record<string, any> = ""): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const packet = encodePacket(operation, body);
      this.ws.send(packet);
    }
  }

  /**
   * 确保房间信息已初始化
   */
  private async ensureRoomInitialized(currentEpoch: number): Promise<boolean> {
    if (!this.needInitRoom) {
      return true;
    }
    const ok = await this.initRoom();
    if (this.epoch !== currentEpoch) {
      return false;
    }
    if (!ok) {
      this.handleConnectionFailure(currentEpoch, new Error("initRoom failed"));
      return false;
    }
    this.needInitRoom = false;
    return true;
  }

  /**
   * 执行受代际保护的单次连接循环
   */
  private async runConnectionLoop(currentEpoch: number): Promise<void> {
    if (this.epoch !== currentEpoch) {
      return;
    }

    try {
      const initialized = await this.ensureRoomInitialized(currentEpoch);
      if (!initialized || this.epoch !== currentEpoch) {
        return;
      }

      const wsUrl = this.getWsUrl(this.retryCount);
      if (!wsUrl) {
        this.handleConnectionFailure(currentEpoch, new Error("No available WebSocket URL"));
        return;
      }

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = async () => {
        if (this.epoch !== currentEpoch) {
          try { ws.close(); } catch {}
          return;
        }

        this.resetReceiveTimeout(currentEpoch);
        try {
          await this.sendAuth();
        } catch (err) {
          this.emitError(err);
          this.forceCloseSocket(currentEpoch);
        }
      };

      ws.onmessage = (event) => {
        if (this.epoch !== currentEpoch) {
          return;
        }

        this.resetReceiveTimeout(currentEpoch);

        try {
          const rawBuffer = Buffer.from(event.data as ArrayBuffer);
          const packets = unpackPackets(rawBuffer);

          for (const packet of packets) {
            this.handleInternalPacket(packet, currentEpoch);
          }
        } catch (err) {
          this.emitError(err);
        }
      };

      ws.onclose = () => {
        if (this.epoch !== currentEpoch) {
          return;
        }
        this.handleConnectionFailure(currentEpoch, null);
      };

      ws.onerror = (err) => {
        if (this.epoch !== currentEpoch) {
          return;
        }
        this.emitError(err);
      };
    } catch (err) {
      if (this.epoch !== currentEpoch) {
        return;
      }
      this.handleConnectionFailure(currentEpoch, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 处理握手鉴权响应
   */
  private handleAuthReply(body: unknown, currentEpoch: number): void {
    if (body && typeof body === "object" && typeof (body as any).code === "number" && (body as any).code !== 0) {
      this.needInitRoom = true;
      this.emitError(new Error(`Authentication failed with Bilibili code ${(body as any).code}: ${JSON.stringify(body)}`));
      this.forceCloseSocket(currentEpoch);
      return;
    }

    this.state = ClientState.CONNECTED;
    this.retryCount = 0;
    this.emit("connected");

    this.sendHeartbeat();
    const intervalMs = (this.options.heartbeatInterval ?? 30) * 1000;
    this.heartbeatTimer = setInterval(() => {
      if (this.epoch === currentEpoch) {
        this.sendHeartbeat();
      }
    }, intervalMs);
  }

  /**
   * 内部处理底层包（严格校验 AUTH_REPLY，杜绝假成功）
   */
  private handleInternalPacket(packet: RawPacket, currentEpoch: number): void {
    const { header, body } = packet;

    if (header.operation === Operation.AUTH_REPLY) {
      this.handleAuthReply(body, currentEpoch);
    } else if (header.operation === Operation.HEARTBEAT_REPLY) {
      this.emit("heartbeat", { popularity: body?.popularity || 0 });
    } else if (header.operation === Operation.SEND_MSG_REPLY) {
      this.handleBusinessMessage(packet);
    } else {
      this.emit("raw", body);
    }
  }

  /**
   * 发送心跳包
   */
  protected sendHeartbeat(): void {
    this.sendPacket(Operation.HEARTBEAT, "");
  }

  /**
   * 假死超时检测：若指定时间内未收到任何网络帧，判定连接僵死并强退重连
   */
  private resetReceiveTimeout(currentEpoch: number): void {
    if (this.receiveTimeoutTimer) {
      clearTimeout(this.receiveTimeoutTimer);
    }

    const timeoutMs = (this.options.receiveTimeout ?? 35) * 1000;
    this.receiveTimeoutTimer = setTimeout(() => {
      if (this.epoch !== currentEpoch) {
        return;
      }
      this.emit("timeout", new Error(`Receive timeout: no data received for ${timeoutMs / 1000}s`));
      this.forceCloseSocket(currentEpoch);
    }, timeoutMs);
  }

  /**
   * 强制关闭当前 Socket（带 1 秒兜底强退，防止 dead socket 挂死）
   */
  private forceCloseSocket(currentEpoch: number): void {
    if (!this.ws) {
      return;
    }

    const socketToClose = this.ws;
    try {
      socketToClose.close();
    } catch {
      // ignore
    }

    // 兜底定时器：若 1 秒内底层系统没有触发 onclose，强制介入
    if (this.forceCloseTimer) {
      clearTimeout(this.forceCloseTimer);
    }
    this.forceCloseTimer = setTimeout(() => {
      if (this.epoch === currentEpoch && this.ws === socketToClose) {
        this.handleConnectionFailure(currentEpoch, null);
      }
    }, 1000);
  }

  /**
   * 统一连接失败与自愈流转
   */
  private handleConnectionFailure(currentEpoch: number, err: Error | null): void {
    if (this.epoch !== currentEpoch) {
      return;
    }

    this.cleanupTimers();

    if (this.ws) {
      const activeWs = this.ws;
      this.ws = null;
      activeWs.onopen = null;
      activeWs.onmessage = null;
      activeWs.onerror = null;
      activeWs.onclose = null;
      try { activeWs.close(); } catch {}
    }

    if (err) {
      this.emitError(err);
    }

    if (this.options.autoReconnect) {
      this.scheduleReconnect(currentEpoch);
    } else {
      this.state = ClientState.DISCONNECTED;
      this.emit("disconnected");
    }
  }

  /**
   * 调度下一次重试
   */
  private scheduleReconnect(currentEpoch: number): void {
    this.state = ClientState.RECONNECTING;
    this.retryCount++;
    this.totalRetryCount++;

    // 连续重试达到阈值（如 3 次），重新调用 initRoom 刷新 Token 与 CDN
    if (this.retryCount % 3 === 0) {
      this.needInitRoom = true;
    }

    const retryPolicy = this.options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const delaySeconds = retryPolicy(this.retryCount, this.totalRetryCount);
    this.emit("reconnecting", {
      retryCount: this.retryCount,
      totalRetryCount: this.totalRetryCount,
      delaySeconds,
    });

    this.reconnectTimer = setTimeout(() => {
      if (this.epoch === currentEpoch) {
        this.runConnectionLoop(currentEpoch);
      }
    }, delaySeconds * 1000);
  }

  /**
   * 安全发射 error 事件（无监听器时不抛出 unhandled error）
   */
  protected emitError(err: any): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  /**
   * 清理所有定时器
   */
  private cleanupTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.receiveTimeoutTimer) {
      clearTimeout(this.receiveTimeoutTimer);
      this.receiveTimeoutTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.forceCloseTimer) {
      clearTimeout(this.forceCloseTimer);
      this.forceCloseTimer = null;
    }
  }
}
