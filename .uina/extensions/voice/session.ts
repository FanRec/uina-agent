import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type { ToolExecutionContext } from "../../../src/tools/broker.js";
import type { DeliverySnapshot, InterruptResult } from "./driver.js";
import { loadVoicePreferences, saveVoicePreferences, type VoicePreferences } from "./preferences.js";

export interface VoiceStatus {
  readonly voiceState: "enabled" | "muted";
  readonly readAssistantText: boolean;
  readonly hasDriver: boolean;
  readonly snapshot: DeliverySnapshot;
}

const SET_MUTED_SERVICE = "voice_driver:set_muted";
const SET_TEXT_READING_SERVICE = "voice_driver:set_text_reading";
const SPEAK_SERVICE = "voice_driver:speak";
const INTERRUPT_SERVICE = "voice_driver:interrupt";
const SNAPSHOT_SERVICE = "voice_driver:snapshot";
const PERCEPTION_RECORD_SERVICE = "voice_perception:record";

export function emptySnapshot(muted: boolean): DeliverySnapshot {
  return { online: false, muted, submittedSegments: 0, spokenSegments: 0, pendingSegments: 0, currentSegmentIndex: null };
}

export class VoiceSession {
  private _voiceState: "enabled" | "muted" = "enabled";
  private _readAssistantText = true;
  private readonly pi?: ExtensionAPI;
  private preferences: VoicePreferences = { muted: false, readAssistantText: true };
  private readonly preferencesReady: Promise<void>;

  constructor(pi?: ExtensionAPI) {
    this.pi = pi;
    this.preferencesReady = loadVoicePreferences(pi).then((value) => {
      this.preferences = value;
      this._voiceState = value.muted ? "muted" : "enabled";
      this._readAssistantText = value.readAssistantText;
    });
  }
  get voiceState(): "enabled" | "muted" { return this._voiceState; }
  get readAssistantText(): boolean { return this._readAssistantText; }
  get hasDriver(): boolean { return Boolean(this.pi?.hasService?.(SNAPSHOT_SERVICE)); }

  private async call<T>(name: string, input?: unknown): Promise<T | undefined> {
    if (!this.hasDriver || typeof this.pi?.callService !== "function") return undefined;
    return await this.pi.callService<T>(name, input);
  }

  private async callOptional<T>(name: string, input?: unknown): Promise<T | undefined> {
    if (typeof this.pi?.hasService !== "function" || !this.pi.hasService(name) || typeof this.pi.callService !== "function") return undefined;
    return await this.pi.callService<T>(name, input);
  }

  async setMuted(muted: boolean): Promise<{ success: boolean; isOnline?: boolean; persisted?: boolean; reason?: string }> {
    await this.preferencesReady;
    if (muted) this._voiceState = "muted";
    const result = await this.call<{ success: boolean; isOnline?: boolean; reason?: string }>(SET_MUTED_SERVICE, { muted });
    if (!result) {
      if (!muted) this._voiceState = "muted";
      return { success: false, isOnline: false, reason: "发声驱动未挂载" };
    }
    if (result.success || muted) this._voiceState = muted ? "muted" : "enabled";
    if (result.isOnline === false && !muted) this._voiceState = "muted";
    this.preferences = { ...this.preferences, muted: this._voiceState === "muted" };
    try {
      await saveVoicePreferences(this.pi, this.preferences);
      return { success: Boolean(result.success), persisted: true, isOnline: result.isOnline, ...(result.success ? {} : { reason: result.reason }) };
    } catch {
      return { success: false, persisted: false, isOnline: result.isOnline, reason: "内存已生效，但偏好持久化失败" };
    }
  }

  async setTextReading(enabled: boolean): Promise<{ success: boolean; persisted?: boolean; reason?: string }> {
    await this.preferencesReady;
    const result = await this.call<{ success: boolean; reason?: string }>(SET_TEXT_READING_SERVICE, { enabled });
    if (!result) return { success: false, persisted: false, reason: "发声驱动未挂载" };
    this.preferences = { ...this.preferences, readAssistantText: enabled };
    this._readAssistantText = enabled;
    try {
      await saveVoicePreferences(this.pi, this.preferences);
      return { success: Boolean(result.success), persisted: true, ...(result.success ? {} : { reason: result.reason }) };
    } catch {
      return { success: false, persisted: false, reason: "内存已生效，但偏好持久化失败" };
    }
  }

  async speak(text: string, replace: boolean, context?: ToolExecutionContext): Promise<unknown> {
    return await this.call(SPEAK_SERVICE, { text, replace, invocationId: context?.invocationId });
  }

  async interrupt(expectedTraceId?: string): Promise<InterruptResult> {
    const result = (await this.call<InterruptResult>(INTERRUPT_SERVICE, { expectedTraceId })) ?? { outcome: "failed", breakpoint: null, reason: "发声驱动未挂载" };
    if (result.outcome === "interrupted" || result.outcome === "unknown" || result.outcome === "failed") {
      await this.callOptional(PERCEPTION_RECORD_SERVICE, {
        fact: {
          kind: result.outcome === "interrupted" ? "interrupted" : result.outcome === "unknown" ? "delivery_unknown" : "delivery_failed",
          summary: result.outcome === "interrupted" ? "上一段声音被主动打断，后续内容未交付。" : `声音停止结果${result.outcome === "unknown" ? "未知" : "失败"}：${result.reason ?? "未取得进一步证据"}。`,
        },
      });
    }
    return result;
  }

  async getStatus(): Promise<VoiceStatus> {
    await this.preferencesReady;
    const snapshot = (await this.call<DeliverySnapshot>(SNAPSHOT_SERVICE)) ?? emptySnapshot(this._voiceState === "muted");
    return { voiceState: this._voiceState, readAssistantText: this._readAssistantText, hasDriver: this.hasDriver, snapshot };
  }
}
