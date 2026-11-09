/**
 * 失败收口的唯一实现：把已发生的领域进度并进 CallFailure，并只在确有派发证据时
 * 把 not_sent 升级为 sent。此前 window-transfer / smelt / craft / stations 各写一份，
 * 其中 stations 无条件升级，四处口径不同。
 */
import { describe, expect, test } from "vitest";
import { settleFailure } from "../../.uina/worlds/minecraft/capabilities/shared/failure.js";
import type { CallFailure, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";

function failure(dispatch: CallFailure["dispatch"], progress?: Record<string, JsonValue>): CallFailure {
	return callFailure({
		code: "TARGET_NOT_MET",
		source: "capability",
		message: "probe",
		dispatch,
		progress: progress as CallFailure["progress"],
		effects: [],
		recoverable: false,
	});
}

function capture(error: CallFailure): CallFailure {
	return error;
}

describe("失败收口", () => {
	test("确实派发过时把 not_sent 升级为 sent", () => {
		let caught: CallFailure | null = null;
		try {
			settleFailure(failure("not_sent"), { dispatched: true, progress: { moved: 2 } });
		} catch (error) {
			caught = capture(error as CallFailure);
		}
		expect(caught?.dispatch).toBe("sent");
	});

	test("没有派发证据时保持 not_sent", () => {
		let caught: CallFailure | null = null;
		try {
			settleFailure(failure("not_sent"), { dispatched: false, progress: {} });
		} catch (error) {
			caught = capture(error as CallFailure);
		}
		expect(caught?.dispatch).toBe("not_sent");
	});

	test("已 sent / unknown 不被降级", () => {
		for (const dispatch of ["sent", "unknown"] as const) {
			let caught: CallFailure | null = null;
			try {
				settleFailure(failure(dispatch), { dispatched: true, progress: {} });
			} catch (error) {
				caught = capture(error as CallFailure);
			}
			expect(caught?.dispatch).toBe(dispatch);
		}
	});

	test("合入领域进度并保留原有进度", () => {
		let caught: CallFailure | null = null;
		try {
			settleFailure(failure("sent", { kept: 1 }), { dispatched: true, progress: { added: 2 } });
		} catch (error) {
			caught = capture(error as CallFailure);
		}
		expect(caught?.progress).toMatchObject({ kept: 1, added: 2 });
	});

	test("非 CallFailure 原样抛出，不包装", () => {
		const error = new Error("boom");
		expect(() => settleFailure(error, { dispatched: true, progress: {} })).toThrow(error);
	});
});
