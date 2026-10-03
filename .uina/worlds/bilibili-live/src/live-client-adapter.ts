export type LiveClientEvent = "roomInfo" | "roomStatus" | "danmaku" | "superChat" | "guardBuy" | "gift" | "heartbeat" | "connected" | "disconnected" | "reconnecting" | "error" | "timeout";

export interface LiveClientAdapter {
	on(event: LiveClientEvent, listener: (payload: any) => void): void;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/** 登记本世界 send 动作的发送记录（文本），供客户端识别自身回声（不支持的平台可省略） */
	noteOwnSend?(text: string): void;
}
