import type { ResolvedLiveWorldConfig } from "./config.js";
import { LiveEventBuffer } from "./buffer.js";
import { normalizeOpenDanmaku, normalizeOpenGift, normalizeOpenGuard, normalizeOpenSuperChat, normalizeWebDanmaku, normalizeWebGift, normalizeWebGuard, normalizeWebSuperChat } from "./normalize.js";
import type { LiveClientAdapter } from "./live-client-adapter.js";
import type { DanmakuRecord } from "./types.js";

export type WakeDecision = { readonly sourceEventKey: string; readonly reason: "superChat" | "guard" | "gift" };
export type LiveConnectionUpdate =
	| { readonly type: "roomInfo"; readonly payload: any }
	| { readonly type: "roomStatus"; readonly payload: { readonly status: "online" | "offline" } }
	| { readonly type: "heartbeat"; readonly payload: any }
	| { readonly type: "connected" | "disconnected" }
	| { readonly type: "reconnecting"; readonly payload: { readonly retryCount: number; readonly totalRetryCount: number; readonly delaySeconds: number } }
	| { readonly type: "error" | "timeout"; readonly payload: unknown };

export class LiveEventIngestion {
	private generation = 0;
	private client: LiveClientAdapter | null = null;

	constructor(private readonly config: ResolvedLiveWorldConfig, private readonly buffer: LiveEventBuffer, private readonly onUpdate: (update: LiveConnectionUpdate) => void, private readonly onWake: (decision: WakeDecision) => void, private readonly onDanmaku?: (record: DanmakuRecord) => void, private readonly onSmallGift?: () => void) {}

	replace(client: LiveClientAdapter): LiveClientAdapter {
		const generation = ++this.generation;
		void this.client?.disconnect();
		this.client = client;
		const guarded = (event: LiveConnectionUpdate["type"], payload?: any) => { if (generation === this.generation) this.onUpdate({ type: event, payload }); };
		client.on("roomInfo", (info) => guarded("roomInfo", info));
		client.on("roomStatus", (status) => guarded("roomStatus", status));
		client.on("heartbeat", (event) => guarded("heartbeat", event));
		client.on("connected", () => guarded("connected"));
		client.on("disconnected", () => guarded("disconnected"));
		client.on("reconnecting", (info) => guarded("reconnecting", info));
		client.on("error", (error) => guarded("error", error));
		client.on("timeout", (error) => guarded("timeout", error));
		client.on("danmaku", (raw) => { if (generation === this.generation) { const event = this.config.openPlatform ? normalizeOpenDanmaku(raw) : normalizeWebDanmaku(raw); const record = this.buffer.addDanmaku(event.actor.value, event.actor.name, String(event.payload.text), { wallTimeMs: event.occurredAtMs, monotonicTimeMs: performance.now() }); if (record) this.onDanmaku?.(record); } });
		client.on("superChat", (raw) => { if (generation !== this.generation) return; const event = this.config.openPlatform ? normalizeOpenSuperChat(raw) : normalizeWebSuperChat(raw); const p = event.payload; const result = this.buffer.ingestSuperChat({ id: event.eventId, uid: event.actor.value, uname: event.actor.name, price: Number(p.price ?? 0), message: String(p.message ?? ""), timestamp: event.occurredAtMs }); if (result.shouldWake && result.record) this.onWake({ sourceEventKey: result.record.sourceEventKey, reason: "superChat" }); });
		client.on("guardBuy", (raw) => { if (generation !== this.generation) return; const event = this.config.openPlatform ? normalizeOpenGuard(raw) : normalizeWebGuard(raw); const p = event.payload; const result = this.buffer.ingestGuard({ uid: event.actor.value, uname: event.actor.name, guardLevel: Number(p.guardLevel ?? 0), giftName: String(p.giftName ?? ""), timestamp: event.occurredAtMs }); if (result.shouldWake && result.record) this.onWake({ sourceEventKey: result.record.sourceEventKey, reason: "guard" }); });
		client.on("gift", (raw) => { if (generation !== this.generation) return; const event = this.config.openPlatform ? normalizeOpenGift(raw) : normalizeWebGift(raw); const p = event.payload; const result = this.buffer.ingestGift({ uid: event.actor.value, uname: event.actor.name, giftId: Number(p.giftId ?? 0), giftName: String(p.giftName ?? ""), price: Number(p.price ?? 0), count: Number(p.count ?? 0), paid: p.paid === undefined ? undefined : Boolean(p.paid), timestamp: event.occurredAtMs }); if (result.shouldWake && result.record) this.onWake({ sourceEventKey: result.record.sourceEventKey, reason: "gift" }); else if (result.transient) this.onSmallGift?.(); });
		return client;
	}

	async stop(): Promise<void> { ++this.generation; const client = this.client; this.client = null; if (client) await client.disconnect(); }
	async disconnect(): Promise<void> { await this.stop(); }
	noteOwnSend(text: string): void { this.client?.noteOwnSend?.(text); }
}
