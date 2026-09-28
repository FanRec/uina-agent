export type LiveClientEvent = "roomInfo" | "danmaku" | "superChat" | "guardBuy" | "gift" | "heartbeat" | "connected" | "disconnected" | "reconnecting";

export interface LiveClientAdapter {
	on(event: LiveClientEvent, listener: (payload: any) => void): void;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
}
