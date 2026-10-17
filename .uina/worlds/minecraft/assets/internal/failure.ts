/**
 * AssetFailure 的运行时实现（contracts/assets.ts 的错误形状）。
 *
 * committedRef 语义（合同）：该确切版本已确认发布但后续步骤失败；
 * 不能当"未保存"重新创建。查询/提交无法核实时返回 STORE_UNAVAILABLE，
 * 不把未知事实转成"操作失败"。
 */

import type { AssetErrorCode, AssetFailure } from "../../contracts/assets.js";
import type { ExactRef } from "../../contracts/values.js";

export class AssetFailureError extends Error implements AssetFailure {
	readonly code: AssetErrorCode;
	readonly committedRef?: ExactRef;

	constructor(code: AssetErrorCode, message: string, committedRef?: ExactRef) {
		super(message);
		this.name = "AssetFailure";
		this.code = code;
		if (committedRef !== undefined) this.committedRef = committedRef;
	}
}

export function assetFailure(code: AssetErrorCode, message: string): never {
	throw new AssetFailureError(code, message);
}
