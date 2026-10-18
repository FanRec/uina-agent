/**
 * Runtime 身份发号：per-boot 命名空间下的单调 ref。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §5.1、§5.3。
 * Ref 由宿主生成且不复用；namespace 由组合根每次启动生成（与
 * FactsBinding.streamNamespace 同源约定），使 runtime.db 的
 * record_log(instance, seq) 主键与各身份 ref 跨启动不冲突。
 * 前缀空间：run / seg / call / rec（record）/ comp（completion）/
 * rw（writer 实例）/ stop（停止命令记录）。
 */

import type { Ref } from "../contracts/values.js";

export class RuntimeRefs {
	private readonly counters = new Map<string, number>();

	constructor(readonly namespace: string) {
		if (namespace.length === 0 || namespace.includes(":")) {
			throw new Error("runtime namespace must be a non-empty string without ':'");
		}
	}

	private next(prefix: string): Ref {
		const n = (this.counters.get(prefix) ?? 0) + 1;
		this.counters.set(prefix, n);
		return `${prefix}:${this.namespace}:${n}`;
	}

	run(): Ref {
		return this.next("run");
	}

	segment(): Ref {
		return this.next("seg");
	}

	call(): Ref {
		return this.next("call");
	}

	record(): Ref {
		return this.next("rec");
	}

	completion(): Ref {
		return this.next("comp");
	}

	writerInstance(): Ref {
		return this.next("rw");
	}

	stopIntent(): Ref {
		return this.next("stop");
	}
}
