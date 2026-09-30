import type { BroadcastHudSnapshot } from "./hud-protocol.js";

export interface BroadcastHudClientOptions {
  baseUrl?: string;
  enabled?: boolean;
  timeoutMs?: number;
}

export interface PublishResult { accepted: boolean; reason?: "disabled" | "unavailable" | "stale" | "invalid"; }

export class BroadcastHudClient {
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private lastRevision = -1;
  private publishChain: Promise<PublishResult> = Promise.resolve({ accepted: true });

  constructor(options: BroadcastHudClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:18130").replace(/\/+$/, "");
    this.enabled = options.enabled ?? true;
    this.timeoutMs = options.timeoutMs ?? 1500;
  }

  async publish(snapshot: BroadcastHudSnapshot): Promise<PublishResult> {
    const result = this.publishChain.then(() => this.publishOne(snapshot));
    this.publishChain = result.catch(() => ({ accepted: false, reason: "unavailable" as const }));
    return result;
  }

  private async publishOne(snapshot: BroadcastHudSnapshot): Promise<PublishResult> {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    if (snapshot.revision < this.lastRevision) return { accepted: false, reason: "stale" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });
      if (!response.ok) return { accepted: false, reason: response.status === 409 ? "stale" : "unavailable" };
      this.lastRevision = snapshot.revision;
      return { accepted: true };
    } catch {
      return { accepted: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
