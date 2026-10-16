/**
 * Driver 内部错误构造：统一走合同 errors.ts 的 CallFailureError 与错误码词表。
 * 不在 Driver 内散落第二份错误码含义。
 */

import { CallFailureError, type CallFailureCode } from "../../contracts/errors.js";
import type { Progress, Ref } from "../../contracts/values.js";

export function controlInvalid(message: string, effects: Ref[] = []): CallFailureError {
	return new CallFailureError({ code: "CONTROL_INVALID" satisfies CallFailureCode, message, effects });
}

export function referenceStale(message: string, effects: Ref[] = []): CallFailureError {
	return new CallFailureError({ code: "REFERENCE_STALE" satisfies CallFailureCode, message, effects });
}

export function controlConflict(message: string, effects: Ref[] = []): CallFailureError {
	return new CallFailureError({ code: "CONTROL_CONFLICT" satisfies CallFailureCode, message, effects });
}

export function invalidArgument(message: string): CallFailureError {
	return new CallFailureError({ code: "INVALID_ARGUMENT" satisfies CallFailureCode, message });
}

export function sensorUnavailable(message: string): CallFailureError {
	return new CallFailureError({ code: "SENSOR_UNAVAILABLE" satisfies CallFailureCode, message });
}

export function windowChanged(message: string): CallFailureError {
	return new CallFailureError({ code: "WINDOW_CHANGED" satisfies CallFailureCode, message });
}

export function cursorNotEmpty(message: string): CallFailureError {
	return new CallFailureError({ code: "CURSOR_NOT_EMPTY" satisfies CallFailureCode, message });
}

export function windowGestureActive(message: string): CallFailureError {
	return new CallFailureError({ code: "WINDOW_GESTURE_ACTIVE" satisfies CallFailureCode, message });
}

export function targetNotMet(message: string, progress?: Progress, effects: Ref[] = []): CallFailureError {
	return new CallFailureError({
		code: "TARGET_NOT_MET" satisfies CallFailureCode,
		message,
		progress,
		effects,
	});
}

export function sourceUnavailable(message: string, effects: Ref[] = []): CallFailureError {
	return new CallFailureError({ code: "SOURCE_UNAVAILABLE" satisfies CallFailureCode, message, effects });
}
