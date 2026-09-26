import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type { PlaybackBreakpoint, DeliverySnapshot } from "./driver.js";

export interface VoiceStatus {
  readonly voiceState: "enabled" | "muted";
  readonly hasDriver: boolean;
  readonly snapshot: DeliverySnapshot;
}

/**
 * voice 与 tts 之间唯一的接缝：三个服务名，一条路。
 * 这里不提供"同进程直连驱动"的第二条路 —— 一个接缝两条路，只有一条会被测试，
 * 另一条会在生产里悄悄烂掉。
 */
const SET_MUTED_SERVICE = "voice_driver:set_muted";
const INTERRUPT_SERVICE = "voice_driver:interrupt";
const SNAPSHOT_SERVICE = "voice_driver:snapshot";

/** 无驱动时的空事实：不假装在线，也不假装在说话。 */
export function emptySnapshot(muted: boolean): DeliverySnapshot {
  return {
    online: false,
    muted,
    submittedSegments: 0,
    spokenSegments: 0,
    pendingSegments: 0,
    currentSegmentIndex: null,
  };
}

/**
 * VoiceSession: 主体声音意志
 *
 * 权威拥有：`_voiceState`（主体是否愿意发声）。
 * 除此之外它什么也不拥有——交付事实（说到哪句、还有多少未播完）归驱动快照，
 * 交付视口投影归事实拥有者 tts 扩展。旧版在这里自建的"单轮退火断点"已删除：
 * 同一事实两处记账，迟早互相打脸。
 */
export class VoiceSession {
  private _voiceState: "enabled" | "muted" = "enabled";
  private readonly pi?: ExtensionAPI;

  constructor(pi?: ExtensionAPI) {
    this.pi = pi;
  }

  get voiceState(): "enabled" | "muted" {
    return this._voiceState;
  }

  get hasDriver(): boolean {
    return Boolean(
      this.pi &&
      typeof this.pi.hasService === "function" &&
      this.pi.hasService(SNAPSHOT_SERVICE)
    );
  }

  /** 服务代理：不可用时返回 undefined，由调用方按"无驱动"语义兜底。 */
  private async call<T>(name: string, input?: unknown): Promise<T | undefined> {
    if (!this.hasDriver) return undefined;
    if (typeof this.pi?.callService !== "function") return undefined;
    return await this.pi.callService<T>(name, input);
  }

  async setMuted(muted: boolean): Promise<{ success: boolean; isOnline?: boolean; reason?: string }> {
    this._voiceState = muted ? "muted" : "enabled";

    const result = await this.call<{ success: boolean; isOnline?: boolean; reason?: string }>(
      SET_MUTED_SERVICE,
      { muted },
    );

    if (!result) {
      // 无驱动：物理层不存在。意志照记，但"已开麦"不能是个谎言。
      if (!muted) this._voiceState = "muted";
      return { success: false, isOnline: false, reason: "发声驱动未挂载" };
    }
    if (result.isOnline === false && !muted) {
      // 想开麦但物理层起不来：意志不能停在"已开麦"，否则我会以为自己有声音
      this._voiceState = "muted";
    }
    return result;
  }

  /** 打断只是转发：断点由驱动给出，交付提示由投影方（tts）落账。 */
  async interrupt(expectedTraceId?: string): Promise<PlaybackBreakpoint | null> {
    return (await this.call<PlaybackBreakpoint | null>(INTERRUPT_SERVICE, { expectedTraceId })) ?? null;
  }

  async getStatus(): Promise<VoiceStatus> {
    const snapshot =
      (await this.call<DeliverySnapshot>(SNAPSHOT_SERVICE)) ?? emptySnapshot(this._voiceState === "muted");

    return {
      voiceState: this._voiceState,
      hasDriver: this.hasDriver,
      snapshot,
    };
  }
}
