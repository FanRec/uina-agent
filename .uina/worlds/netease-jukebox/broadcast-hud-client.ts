import type { BroadcastHudSnapshot } from "./hud-protocol.js";

export interface BroadcastHudClientOptions {
  baseUrl?: string;
  enabled?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface PublishResult { accepted: boolean; reason?: "disabled" | "unavailable" | "stale" | "invalid"; }

export class BroadcastHudClient {
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;
  private lastRevision = -1;
  private pending: { snapshot: BroadcastHudSnapshot; resolve: (result: PublishResult) => void } | null = null;
  private activeController: AbortController | null = null;
  private drainPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: BroadcastHudClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:18130").replace(/\/+$/, "");
    this.enabled = options.enabled ?? true;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get isClosed(): boolean { return this.closed; }

  async publish(snapshot: BroadcastHudSnapshot): Promise<PublishResult> {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    if (this.closed) return { accepted: false, reason: "unavailable" };
    const result = new Promise<PublishResult>(resolve => this.replacePending(snapshot, resolve));
    this.startDrain();
    return result;
  }

  private replacePending(snapshot: BroadcastHudSnapshot, resolve: (result: PublishResult) => void): void {
    this.pending?.resolve({ accepted: false, reason: "stale" });
    this.pending = { snapshot, resolve };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pending?.resolve({ accepted: false, reason: "unavailable" });
    this.pending = null;
    this.activeController?.abort(new Error("HUD client closed"));
    await this.drainPromise;
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.pending && !this.closed) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve(await this.publishOne(pending.snapshot));
    }
  }

  private async publishOne(snapshot: BroadcastHudSnapshot): Promise<PublishResult> {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    if (snapshot.revision < this.lastRevision) return { accepted: false, reason: "stale" };
    const controller = new AbortController();
    this.activeController = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(`${this.baseUrl}/state`, {
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
      if (this.activeController === controller) this.activeController = null;
    }
  }
}
