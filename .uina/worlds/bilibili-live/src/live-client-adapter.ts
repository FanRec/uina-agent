export type LiveClientEvent = "roomInfo" | "roomStatus" | "danmaku" | "superChat" | "guardBuy" | "gift" | "heartbeat" | "connected" | "disconnected" | "reconnecting" | "error" | "timeout";

export interface LiveClientAdapter {
	on(event: LiveClientEvent, listener: (payload: any) => void): void;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
}
