/**
 * 会话级消费串行锁（设计文档 §2.1）。
 * 同一会话的正文消费动作（qq_read / follow 自动派发 / qq_skip）严格排队：
 * 后到者等前序完全释放后才执行，持锁方负责重读最新书签与单调推进。
 * 锁是纯内存原语：异常照常释放（finally），不持久化、不跨进程。
 */
export class ConversationLocks {
	private readonly tails = new Map<string, Promise<unknown>>();

	/** 在 key 的串行队列尾部执行 fn；返回 fn 的结果，fn 抛错照常向上传播且锁已释放。 */
	async run<T>(conversationRef: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(conversationRef) ?? Promise.resolve();
		const gate = previous.then(
			() => undefined,
			() => undefined,
		);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.tails.set(conversationRef, held);
		try {
			await gate;
			return await fn();
		} finally {
			release();
			if (this.tails.get(conversationRef) === held) this.tails.delete(conversationRef);
		}
	}
}
