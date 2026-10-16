/**
 * Driver 内部引用生成：连接、化身、身体、操作、窗口、实体出现代次、证据流。
 *
 * 设计依据 modules/driver.md §4.2：身份是宿主生成的资格或只读引用；
 * 可序列化追踪 ID 本身不授权。这里只负责唯一性与单调代次，不做权限。
 */

import { randomUUID } from "node:crypto";
import type { Ref } from "../../contracts/values.js";

/** 短随机后缀：区分不同 Driver 实例的同序号引用。 */
function shortId(): string {
	return randomUUID().replaceAll("-", "").slice(0, 8);
}

export class RefGenerator {
	private readonly prefix: string;

	constructor(prefix: string) {
		this.prefix = prefix;
	}

	private counters = new Map<string, number>();

	next(kind: string): string {
		const n = (this.counters.get(kind) ?? 0) + 1;
		this.counters.set(kind, n);
		return `${this.prefix}-${kind}-${n}`;
	}
}

export class Identity {
	readonly instance = shortId();
	readonly refs = new RefGenerator(this.instance);

	#connection: Ref;
	#incarnation: Ref;
	#connectionSeq = 0;
	#incarnationSeq = 0;

	constructor() {
		this.#connection = this.refs.next("conn");
		this.#incarnation = this.refs.next("inc");
	}

	get connection(): Ref {
		return this.#connection;
	}

	get incarnation(): Ref {
		return this.#incarnation;
	}

	/** 新连接（客户端重建）：化身一并重置，旧身体/窗口/实体引用全部跨代。 */
	nextConnection(): Ref {
		this.#connectionSeq += 1;
		this.#connection = `${this.refs.next("conn")}r${this.#connectionSeq}`;
		this.#incarnationSeq = 0;
		this.#incarnation = this.refs.next("inc");
		return this.#connection;
	}

	/** 新化身（重生/跨维度/身体上下文重建）：连接不变。 */
	nextIncarnation(): Ref {
		this.#incarnationSeq += 1;
		this.#incarnation = `${this.refs.next("inc")}r${this.#incarnationSeq}`;
		return this.#incarnation;
	}
}
