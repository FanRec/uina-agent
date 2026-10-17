/**
 * AssetFailure 的运行时实现（contracts/assets.ts 的错误形状）。
 *
 * - committedRef：该确切版本已确认发布但后续步骤失败；不能当"未保存"重新创建。
 * - status：五态边界（assets.md §6.4 取消时点表）；缺省按 failed 解释。
 */

import type { AssetErrorCode, AssetFailure } from "../../contracts/assets.js";
import type { ExactRef } from "../../contracts/values.js";

export class AssetFailureError extends Error implements AssetFailure {
	readonly code: AssetErrorCode;
	readonly committedRef?: ExactRef;
	readonly status: NonNullable<AssetFailure["status"]>;

	constructor(
		code: AssetErrorCode,
		message: string,
		committedRef?: ExactRef,
		status: NonNullable<AssetFailure["status"]> = "failed",
	) {
		super(message);
		this.name = "AssetFailure";
		this.code = code;
		this.status = status;
		if (committedRef !== undefined) this.committedRef = committedRef;
	}
}

export function assetFailure(code: AssetErrorCode, message: string): never {
	throw new AssetFailureError(code, message);
}
