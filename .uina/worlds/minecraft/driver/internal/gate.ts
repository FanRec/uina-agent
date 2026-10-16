/**
 * 身体资格（Body Permit）与操作记录：Driver 的写入隔离核心。
 *
 * 设计依据 modules/driver.md §5 与 contracts.md §5.1：
 * - 同一客户端同一时刻最多一个有效身体资格；已撤销的资格永远不能恢复。
 * - 每个可能产生游戏副作用的操作绑定创建时身份，实际写入前重新核验；
 *   旧异步回调迟到时凭创建时资格拒绝，不读取"当前主人"。
 * - 状态机：active → revoking（不可逆）→ quiesced → closed。
 *
 * Runtime 的调用身份/access 核验接缝（HostCallVerifier）由组合根注入；
 * 当前切片（M0–M4，Runtime 未落地）使用默认实现：以 acquire(owner) 的归属为权威，
 * 只做代次与状态核验。接缝形状已固定，M2/M3 Executor 接入时替换实现，不改 Driver 结构。
 */

import type { Ref } from "../../contracts/values.js";
import type { ControlOwner } from "../../contracts/body.js";
import { CallFailureError } from "../../contracts/errors.js";
import { controlInvalid, referenceStale } from "./failure.js";

export type OperationKind =
	| "drive"
	| "feedback"
	| "dig"
	| "attack"
	| "use"
	| "endUse"
	| "interact"
	| "equip"
	| "window"
	| "click"
	| "say";

export type OperationState = "active" | "revoking" | "closed";

export interface OperationRecord {
	readonly ref: Ref;
	readonly kind: OperationKind;
	readonly bodyRef: Ref;
	readonly connectionRef: Ref;
	readonly incarnationRef: Ref;
	/** 操作拥有的资源标签：keys/use/window/timer 等清理凭据。 */
	readonly resources: Set<string>;
	state: OperationState;
	/** 撤销通知：等待中的操作（drive 计步、openContainer 等待）据此立即中止。 */
	onRevoke?: () => void;
}

export type BodyState = "active" | "revoking" | "quiesced" | "closed";

export interface BodyPermit {
	readonly ref: Ref;
	readonly owner: ControlOwner;
	/** 取得时绑定的连接/化身；代次更替后旧资格失效。 */
	readonly connectionRef: Ref;
	readonly incarnationRef: Ref;
	state: BodyState;
}

/**
 * 宿主核验接缝：Runtime 是调用身份、access、存活与委托关系的唯一权威。
 * 组合根注入；M5 前默认实现只核验资格归属本身。
 */
export interface HostCallVerifier {
	/**
	 * 核验一次真实写入的当前调用归属。返回 null 表示允许（默认实现）；
	 * 返回错误信息表示拒绝（如 read 子调用携带旧 act 句柄）。
	 */
	verifyWrite(context: { operation: OperationRecord; permit: BodyPermit }): string | null;
}

export const defaultHostVerifier: HostCallVerifier = {
	verifyWrite: () => null,
};

export class WriteGate {
	#permit: BodyPermit | null = null;
	readonly #operations = new Set<OperationRecord>();
	#verifier: HostCallVerifier;

	constructor(verifier: HostCallVerifier = defaultHostVerifier) {
		this.#verifier = verifier;
	}

	setVerifier(v: HostCallVerifier): void {
		this.#verifier = v;
	}

	get permit(): Readonly<BodyPermit> | null {
		return this.#permit;
	}

	get operations(): ReadonlySet<OperationRecord> {
		return this.#operations;
	}

	/** 建立身体资格；已有资格时冲突（Runtime 未协调的并发申请明确拒绝）。 */
	acquire(owner: ControlOwner, connectionRef: Ref, incarnationRef: Ref, ref: Ref): BodyPermit {
		if (this.#permit && (this.#permit.state === "active" || this.#permit.state === "revoking")) {
			throw new CallFailureError({
				code: "CONTROL_CONFLICT",
				message: "已有有效身体资格；并发 acquire 必须经运行管理协调",
			});
		}
		const permit: BodyPermit = { ref, owner, connectionRef, incarnationRef, state: "active" };
		this.#permit = permit;
		return permit;
	}

	/** 正常释放：先 revoking，调用方完成屏障后调 quiesce→close。 */
	beginRelease(permit: BodyPermit): void {
		if (permit.state === "active") permit.state = "revoking";
	}

	quiesce(permit: BodyPermit): void {
		if (permit.state === "revoking") permit.state = "quiesced";
	}

	close(permit: BodyPermit): void {
		permit.state = "closed";
		if (this.#permit === permit) this.#permit = null;
	}

	/** 连接断开/化身更替/急停：撤销全部资格与操作，不可恢复。 */
	revokeAll(): void {
		if (this.#permit) {
			if (this.#permit.state === "active" || this.#permit.state === "revoking") {
				this.#permit.state = "revoking";
			}
		}
		for (const op of this.#operations) {
			this.revokeOperation(op);
		}
	}

	/** 释放屏障完成：清掉已撤销的操作记录。 */
	settleRevoked(): void {
		for (const op of [...this.#operations]) {
			if (op.state === "revoking") op.state = "closed";
		}
		this.#operations.clear();
		if (this.#permit && (this.#permit.state === "revoking" || this.#permit.state === "quiesced")) {
			this.#permit.state = "closed";
			this.#permit = null;
		}
	}

	createOperation(kind: OperationKind, permit: BodyPermit, ref: Ref): OperationRecord {
		if (permit.state !== "active") {
			throw controlInvalid(`身体资格已失效（${permit.state}），不能创建操作`);
		}
		const op: OperationRecord = {
			ref,
			kind,
			bodyRef: permit.ref,
			connectionRef: permit.connectionRef,
			incarnationRef: permit.incarnationRef,
			resources: new Set(),
			state: "active",
		};
		this.#operations.add(op);
		return op;
	}

	revokeOperation(op: OperationRecord): void {
		if (op.state !== "active") return;
		op.state = "revoking";
		op.onRevoke?.();
	}

	closeOperation(op: OperationRecord): void {
		op.state = "closed";
		this.#operations.delete(op);
	}

	/**
	 * 实际写入前核验：操作状态、资格状态、连接/化身代次、宿主调用归属。
	 * 迟到回调凭创建时身份被拒，不会读到"当前主人"补资格。
	 */
	checkWrite(op: OperationRecord): void {
		const permit = this.#permit;
		if (op.state !== "active") {
			throw controlInvalid(`操作 ${op.kind} 已失效（${op.state}），旧异步后续不能继续写入`);
		}
		if (!permit || permit.ref !== op.bodyRef) {
			throw controlInvalid("身体资格已被释放或更换");
		}
		if (permit.state !== "active") {
			throw controlInvalid(`身体资格状态为 ${permit.state}，写入被拒绝`);
		}
		if (permit.connectionRef !== op.connectionRef) {
			throw referenceStale("连接代次已更替，旧操作的写入被拒绝");
		}
		if (permit.incarnationRef !== op.incarnationRef) {
			throw referenceStale("化身代次已更替，旧操作的写入被拒绝");
		}
		const denial = this.#verifier.verifyWrite({ operation: op, permit });
		if (denial !== null) {
			throw new CallFailureError({ code: "READ_ONLY_VIOLATION", message: denial });
		}
	}
}
