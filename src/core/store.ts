/** 运行时状态：会话标识与计数。持久化状态归 memory 管，这里只管进程内会话。 */
import { randomUUID } from "node:crypto";

export class RuntimeStore {
	readonly sessionId: string;
	readonly startedAt: string;
	/** 主体自称（第一刀固定，将来可由身份机制接管） */
	name = "Uina";
	private turnCount = 0;

	constructor() {
		this.sessionId = randomUUID();
		this.startedAt = new Date().toISOString();
	}

	nextTurnId(): number {
		return ++this.turnCount;
	}
}
