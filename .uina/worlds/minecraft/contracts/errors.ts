/**
 * 稳定错误码词表（lead 固定合同）。
 *
 * 每个 code 的唯一含义由此处登记；文档与实现一律引用本表，
 * 不得在模块内散落第二份解释。新增 code 必须同时给出唯一含义并经 lead 确认。
 */

import { type CallFailure, type Progress, type Ref } from "./values.js";

/** 跨模块通用领域错误码（AssetErrorCode 另见 assets.ts）。 */
export type CallFailureCode =
	// 派发与参数
	| "INVALID_ARGUMENT"
	| "CALL_UNAVAILABLE"
	| "PROGRAM_ERROR"
	| "UNBOUND_CALL"
	| "AMBIGUOUS_CALL"
	// 控制与资格
	| "CONTROL_CONFLICT"
	| "CONTROL_INVALID"
	| "REFERENCE_STALE"
	| "READ_ONLY_VIOLATION"
	| "BODY_SCOPE_ACTIVE"
	// 目标与效果
	| "TARGET_NOT_MET"
	| "EFFECT_UNCERTAIN"
	// 传感与窗口
	| "SENSOR_UNAVAILABLE"
	| "WINDOW_CHANGED"
	| "WINDOW_GESTURE_ACTIVE"
	| "CURSOR_NOT_EMPTY"
	// 世界查询与存储
	| "SNAPSHOT_INVALIDATED"
	| "SNAPSHOT_EXPIRED"
	| "SOURCE_UNAVAILABLE"
	| "STORE_UNAVAILABLE"
	| "RECORD_CHANGED"
	| "EVIDENCE_UNAVAILABLE"
	// 受理与调度
	| "REPLACE_SCOPE_REQUIRED"
	| "CONTROL_OWNER_CHANGED"
	| "DECISION_STALE"
	| "REQUEST_CONFLICT";

export const CALL_FAILURE_MEANINGS: Readonly<Record<CallFailureCode, string>> = {
	INVALID_ARGUMENT: "参数/schema 不合法，在该调用派发前失败",
	CALL_UNAVAILABLE: "实现不存在或当前环境不支持；错误须说明确切 ref 与原因",
	PROGRAM_ERROR: "程序内未处理的普通 JS 异常",
	UNBOUND_CALL: "固定 bindings 表缺少本次裸名调用所需条目",
	AMBIGUOUS_CALL: "同一名称有多个确切版本可供调用，裸名无法解析",
	CONTROL_CONFLICT: "无协调关系的重叠身体写入；由协调者安排顺序后重试",
	CONTROL_INVALID: "身体/操作资格已失效",
	REFERENCE_STALE: "资源代次已更替，旧引用不可再使用",
	READ_ONLY_VIOLATION: "只读调用试图取得写口或升级权限",
	BODY_SCOPE_ACTIVE: "活动 withBody 作用域内调用了世界 wait；先退出作用域",
	TARGET_NOT_MET: "目标不足且进度有依据；progress 携带已完成量与原因",
	EFFECT_UNCERTAIN: "有相关派发但完成要求尚不能确认；effects 携带效果引用",
	SENSOR_UNAVAILABLE: "所需传感当前不可观察或反馈流无法建立；说明缺口",
	WINDOW_CHANGED: "窗口 revision/槽位/光标与预期不符",
	WINDOW_GESTURE_ACTIVE: "窗口存在未结束手势，无法按普通 close 前置条件关闭",
	CURSOR_NOT_EMPTY: "光标持有物品，普通 close 拒绝；需显式处置",
	SNAPSHOT_INVALIDATED: "查询所依赖的绑定/版本已变化，结果作废",
	SNAPSHOT_EXPIRED: "分页/历史材料超出生命周期或所需版本不可用",
	SOURCE_UNAVAILABLE: "事实源无法对账或已断连",
	STORE_UNAVAILABLE: "当前无法确认相应存储读写事实",
	RECORD_CHANGED: "领域记录 CAS revision 不符",
	EVIDENCE_UNAVAILABLE: "必需证据不能保留（含删除先胜于 retain 的情形）",
	REPLACE_SCOPE_REQUIRED: "无可信 caller 且未给出 targets 的替换请求被拒绝",
	CONTROL_OWNER_CHANGED: "preempt_current 的预期当前 run 与实际不符",
	DECISION_STALE: "决策已被其他请求消费",
	REQUEST_CONFLICT: "同请求键的参数/字节/意图不一致",
};

export class CallFailureError extends Error implements CallFailure {
	readonly code: string;
	readonly dispatch: "not_sent" | "sent" | "unknown";
	readonly progress?: Progress;
	readonly effects: Ref[];
	readonly recoverable: boolean;

	constructor(failure: {
		/** 通用码用 CallFailureCode 词表；能力私有领域码按其合同登记。 */
		code: string;
		message: string;
		dispatch?: "not_sent" | "sent" | "unknown";
		progress?: Progress;
		effects?: Ref[];
		recoverable?: boolean;
	}) {
		super(failure.message);
		this.name = "CallFailure";
		this.code = failure.code;
		this.dispatch = failure.dispatch ?? "not_sent";
		this.progress = failure.progress;
		this.effects = failure.effects ?? [];
		this.recoverable = failure.recoverable ?? false;
	}
}

/** 判断未知值是否携带领域失败形状（桥接还原用）。 */
export function isCallFailure(value: unknown): value is CallFailure {
	return value instanceof Error && typeof (value as CallFailure).code === "string";
}

/** 判断字符串是否为通用错误码词表成员；不是不代表非法（能力可有私有领域码）。 */
export function isCallFailureCode(value: unknown): value is CallFailureCode {
	return typeof value === "string" && Object.hasOwn(CALL_FAILURE_MEANINGS, value);
}
