import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type { ToolExecutionContext } from "../../../src/tools/broker.js";
import type { DeliverySnapshot, InterruptResult } from "./driver.js";

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

export function emptySnapshot(muted: boolean): DeliverySnapshot {
  return { online: false, muted, submittedSegments: 0, spokenSegments: 0, pendingSegments: 0, currentSegmentIndex: null };
}

export class VoiceSession {
  private _voiceState: "enabled" | "muted" = "enabled";
  private _readAssistantText = true;
  private readonly pi?: ExtensionAPI;

  constructor(pi?: ExtensionAPI) { this.pi = pi; }
  get voiceState(): "enabled" | "muted" { return this._voiceState; }
  get readAssistantText(): boolean { return this._readAssistantText; }
  get hasDriver(): boolean { return Boolean(this.pi?.hasService?.(SNAPSHOT_SERVICE)); }

  private async call<T>(name: string, input?: unknown): Promise<T | undefined> {
    if (!this.hasDriver || typeof this.pi?.callService !== "function") return undefined;
    return await this.pi.callService<T>(name, input);
  }

  async setMuted(muted: boolean): Promise<{ success: boolean; isOnline?: boolean; reason?: string }> {
    if (muted) this._voiceState = "muted";
    const result = await this.call<{ success: boolean; isOnline?: boolean; reason?: string }>(SET_MUTED_SERVICE, { muted });
    if (!result) { if (!muted) this._voiceState = "muted"; return { success: false, isOnline: false, reason: "发声驱动未挂载" }; }
    if (result.success || muted) this._voiceState = muted ? "muted" : "enabled";
    if (result.isOnline === false && !muted) this._voiceState = "muted";
    return result;
  }

  async setTextReading(enabled: boolean): Promise<{ success: boolean; reason?: string }> {
    const result = await this.call<{ success: boolean; reason?: string }>(SET_TEXT_READING_SERVICE, { enabled });
    if (!result) return { success: false, reason: "发声驱动未挂载" };
    if (result.success) this._readAssistantText = enabled;
    return result;
  }

  async speak(text: string, replace: boolean, context?: ToolExecutionContext): Promise<unknown> {
    return await this.call(SPEAK_SERVICE, { text, replace, invocationId: context?.invocationId });
  }

  async interrupt(expectedTraceId?: string): Promise<InterruptResult> {
    return (await this.call<InterruptResult>(INTERRUPT_SERVICE, { expectedTraceId })) ?? { outcome: "failed", breakpoint: null, reason: "发声驱动未挂载" };
  }

  async getStatus(): Promise<VoiceStatus> {
    const snapshot = (await this.call<DeliverySnapshot>(SNAPSHOT_SERVICE)) ?? emptySnapshot(this._voiceState === "muted");
    return { voiceState: this._voiceState, readAssistantText: this._readAssistantText, hasDriver: this.hasDriver, snapshot };
  }
}
